/**
 * dsh-lantern — 协议翻译层（Host 半部内部模块）。
 *
 * 两个方向：
 * 1. **入站**：OpenAI `/v1/chat/completions` 请求体 → DSH `Message[]` + `ToolSchema[]`
 * 2. **出站**：DSH `StreamChunk` → OpenAI SSE 帧 / 非流式聚合响应
 *
 * 口径依据（已查实）：
 * - `dsh-llm/lib/types/types.d.ts` 的 `TokenUsage`：计数**互斥**，
 *   `inputTokens` 不含缓存（adapter 已从 provider 的 prompt_tokens 里减掉缓存命中）；
 * - `StreamChunk` 联合：block-start / text-delta / reasoning-delta / tool-call-delta /
 *   block-end / usage / finish。
 *
 * @module dsh-lantern/protocol
 */
import { randomUUID } from 'node:crypto'

/** 一次 Chat Completions 请求的最大消息条数。 */
export const MAX_MESSAGES = 500
/** 单条文本消息长度上限（字节）。 */
export const MAX_TEXT_BYTES = 512 * 1024

/**
 * 把 OpenAI 的 content（字符串或分片数组）拍平成文本 + 图片引用收集。
 * @param content - OpenAI 的 content 字段。
 * @param images - 收集到的图片 data URL（就地追加）。
 * @returns 文本内容。
 */
function flattenContent(content, images) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url.length > 0) images.push(url)
    }
  }
  return parts.join('\n')
}

/**
 * 解析一个 data URL 图片。
 * @param dataUrl - 形如 `data:image/png;base64,....`。
 * @returns `{ mediaType, data }`，非图片或格式不支持时返回 undefined。
 */
export function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl).trim())
  if (!match) return undefined
  return { mediaType: match[1].toLowerCase(), data: Buffer.from(match[2], 'base64') }
}

/**
 * 把 OpenAI 的 tools 定义转成 DSH 的 ToolSchema。
 * @param tools - OpenAI tools 数组。
 * @returns DSH ToolSchema 数组（无效项跳过）。
 */
export function toToolSchemas(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue
    const fn = tool.type === 'function' ? tool.function : tool
    if (fn === null || typeof fn !== 'object') continue
    if (typeof fn.name !== 'string' || fn.name.length === 0) continue
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters:
        fn.parameters !== null && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 把 OpenAI 请求体转成中立的「待构造消息」描述。
 *
 * 这里**不直接构造 DSH Message**（那需要 message.js 的工厂函数与 brand 类型），
 * 而是产出与 DSH 结构等价的纯数据，由调用方用官方工厂函数实例化。
 *
 * @param body - OpenAI 请求体（已 JSON.parse）。
 * @returns `{ system, turns, images, toolSchemas, warnings }`。
 */
export function parseChatRequest(body) {
  const warnings = []
  const images = []
  const turns = []
  let system

  const rawMessages = Array.isArray(body?.messages) ? body.messages : []
  if (rawMessages.length > MAX_MESSAGES) {
    warnings.push(`messages 条数超过上限 ${MAX_MESSAGES}，仅取前 ${MAX_MESSAGES} 条`)
  }

  for (const message of rawMessages.slice(0, MAX_MESSAGES)) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role

    if (role === 'system' || role === 'developer') {
      const text = flattenContent(message.content, images)
      system = system === undefined ? text : `${system}\n\n${text}`
      continue
    }

    if (role === 'user') {
      const text = flattenContent(message.content, images)
      if (text.length > MAX_TEXT_BYTES) {
        warnings.push('存在超长消息，已按上限截断')
      }
      turns.push({ role: 'user', text: text.slice(0, MAX_TEXT_BYTES) })
      continue
    }

    if (role === 'assistant') {
      const text = flattenContent(message.content, images)
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      turns.push({
        role: 'assistant',
        text,
        toolCalls: toolCalls
          .filter((c) => c !== null && typeof c === 'object')
          .map((c, index) => ({
            id: typeof c.id === 'string' && c.id.length > 0 ? c.id : `call_${index}`,
            name: typeof c.function?.name === 'string' ? c.function.name : '',
            arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : '{}',
          })),
      })
      continue
    }

    if (role === 'tool') {
      turns.push({
        role: 'tool',
        callId: typeof message.tool_call_id === 'string' ? message.tool_call_id : '',
        text: typeof message.content === 'string' ? message.content : flattenContent(message.content, []),
      })
      continue
    }

    warnings.push(`忽略了不支持的消息角色：${String(role)}`)
  }

  return {
    system,
    turns,
    images,
    toolSchemas: toToolSchemas(body?.tools),
    warnings,
  }
}

/**
 * 把 DSH 的 TokenUsage 转成 OpenAI usage 口径。
 *
 * ⚠ 官方语义：计数**互斥**，`billed input = inputTokens + cacheReadTokens + cacheWriteTokens`。
 * 而 OpenAI 的 `prompt_tokens` 是**总量**（含缓存）→ 必须相加。
 *
 * @param usage - DSH TokenUsage。
 * @returns OpenAI usage 对象。
 */
export function toOpenAiUsage(usage) {
  if (usage === undefined || usage === null) return undefined
  const cached = usage.cacheReadTokens ?? 0
  const written = usage.cacheWriteTokens ?? 0
  const prompt = (usage.inputTokens ?? 0) + cached + written
  const completion = usage.outputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
    ...(cached > 0 || written > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: cached,
            ...(written > 0 ? { cache_write_tokens: written } : {}),
          },
        }
      : {}),
    ...(usage.reasoningTokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {}),
  }
}

/** 把 DSH finish 原因映射为 OpenAI 的 finish_reason。 */
const FINISH_MAP = {
  stop: 'stop',
  'tool-calls': 'tool_calls',
  'max-tokens': 'length',
  aborted: 'stop',
  error: 'stop',
}

/**
 * 把 DSH 的 finish 原因转成 OpenAI 的 finish_reason。
 * @param reason - DSH FinishReason。
 * @returns OpenAI finish_reason 字符串。
 */
export function toFinishReason(reason) {
  return FINISH_MAP[reason?.kind] ?? 'stop'
}

/**
 * 流式翻译器：把 DSH StreamChunk 序列转成 OpenAI SSE 帧。
 *
 * 用法：
 * ```js
 * const tr = new OpenAiStreamTranslator({ id, model, includeUsage: true })
 * for await (const chunk of ctx.llm.stream(...)) {
 *   for (const frame of tr.push(chunk)) res.write(frame)
 * }
 * for (const frame of tr.end()) res.write(frame)
 * ```
 */
export class OpenAiStreamTranslator {
  /**
   * @param options - 响应 id、公开模型名、是否在末尾带 usage。
   */
  constructor({ id, model, includeUsage = true, created = Math.floor(Date.now() / 1000) }) {
    this.id = id
    this.model = model
    this.created = created
    this.includeUsage = includeUsage
    this.started = false
    this.usage = undefined
    this.finishReason = 'stop'
    this.toolIndexes = new Map()
    this.nextToolIndex = 0
    this.errorFrame = undefined
  }

  /** 首帧：带上 role（OpenAI 客户端依赖它初始化消息）。 */
  #firstFrame() {
    if (this.started) return ''
    this.started = true
    return this.#frame({ role: 'assistant', content: '' })
  }

  /**
   * 组一个 SSE 帧。
   * @param delta - choices[0].delta。
   * @param extra - 附加到 choices[0] 的字段。
   * @returns SSE 文本。
   */
  #frame(delta, extra = {}) {
    return `data: ${JSON.stringify({
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, ...extra }],
    })}\n\n`
  }

  /**
   * 送入一个 DSH chunk，返回要写出的 SSE 帧（可能为空数组）。
   * @param chunk - DSH StreamChunk。
   * @returns SSE 帧数组。
   */
  push(chunk) {
    const frames = []
    const head = this.#firstFrame()
    if (head.length > 0) frames.push(head)

    switch (chunk?.type) {
      case 'text-delta':
        if (chunk.text) frames.push(this.#frame({ content: chunk.text }))
        break

      case 'reasoning-delta':
        // DeepSeek 惯例字段；非标但主流客户端认（设计文档 §6.1）
        if (chunk.text) frames.push(this.#frame({ reasoning_content: chunk.text }))
        break

      case 'tool-call-delta': {
        // 按 DSH 的 index 聚合，映射到 OpenAI 的连续 tool_calls 索引
        let index = this.toolIndexes.get(chunk.index)
        if (index === undefined) {
          index = this.nextToolIndex++
          this.toolIndexes.set(chunk.index, index)
        }
        const call = {
          index,
          ...(chunk.id ? { id: chunk.id } : {}),
          type: 'function',
          function: {
            ...(chunk.name !== undefined ? { name: chunk.name } : {}),
            arguments: chunk.argumentsDelta ?? '',
          },
        }
        frames.push(this.#frame({ tool_calls: [call] }))
        break
      }

      case 'usage':
        this.usage = toOpenAiUsage(chunk.usage)
        break

      case 'finish':
        this.finishReason = toFinishReason(chunk.reason)
        if (chunk.reason?.kind === 'error') {
          this.errorFrame = {
            error: {
              message: chunk.reason.failure?.message ?? '上游模型调用失败',
              type: 'upstream_error',
              code: chunk.reason.failure?.code ?? 'upstream_error',
            },
          }
        }
        break

      default:
        break
    }
    return frames
  }

  /**
   * 结束流。
   *
   * 分两种情况（**"如实"与"静默失真"的分界**）：
   *
   * 1. **正常结束**：`finish_reason` 帧 → `[DONE]`。
   * 2. **上游报错**（DSH 已感知的 `kind:'error'`）：先发一个带 `error` 对象的帧，
   *    再发 `[DONE]`。
   *
   * ⚠ 为什么必须带 `error` 对象：HTTP 状态码在首个 SSE 帧时**已发出**（只能是 200），
   * 中途出错无法改状态码。若只发一个 `finish_reason:"stop"` 就结束，客户端会看到
   * "200 + 空内容 + 正常结束"——把上游故障**伪装成正常空回答**。OpenAI 兼容客户端
   * 普遍识别 data 帧里的 `error` 字段，据此报错而不是当成功。
   *
   * 责任边界：只转发 **DSH 已感知**的错误；provider 自己的静默行为（静默截断、
   * 静默忽略参数）本插件不检测、不伪造，原样透传。
   *
   * @returns SSE 帧数组。
   */
  end() {
    const frames = []
    const head = this.#firstFrame()
    if (head.length > 0) frames.push(head)

    if (this.errorFrame !== undefined) {
      // 如实发出错误帧后收尾（仍发 [DONE]，让客户端正常结束读取循环）
      frames.push(`data: ${JSON.stringify(this.errorFrame)}\n\n`)
      frames.push('data: [DONE]\n\n')
      return frames
    }

    const tail = { finish_reason: this.finishReason }
    if (this.includeUsage && this.usage !== undefined) tail.usage = this.usage
    frames.push(this.#frame({}, tail))
    frames.push('data: [DONE]\n\n')
    return frames
  }

  /** 若上游报错，取出待发或已发的错误信息。 */
  get error() {
    return this.errorFrame
  }

  /**
   * 由**调用方**标记一个流式失败（例如 `for await` 抛出）。
   *
   * 用于兜住"错误不是以 finish chunk 形式到达"的情形——否则 `end()` 会走正常收尾，
   * 客户端只会看到 "200 + 正常结束 + 空内容"，即把上游故障伪装成正常空回答。
   *
   * @param failure - `{ message, code }`（可为 undefined，用通用文案）。
   */
  markFailed(failure) {
    this.errorFrame = {
      error: {
        message: failure?.message ?? '上游模型调用失败',
        type: 'upstream_error',
        code: failure?.code ?? 'upstream_error',
      },
    }
  }
}

/**
 * 非流式聚合器：把 DSH chunk 序列聚成一个完整响应体。
 */
export class OpenAiAggregator {
  /**
   * @param options - 响应 id 与公开模型名。
   */
  constructor({ id, model, created = Math.floor(Date.now() / 1000) }) {
    this.id = id
    this.model = model
    this.created = created
    this.text = ''
    this.reasoning = ''
    /** @type {Map<number, {id?:string,name?:string,args:string}>} */
    this.tools = new Map()
    this.usage = undefined
    this.finishReason = 'stop'
    this.failure = undefined
  }

  /**
   * 送入一个 chunk。
   * @param chunk - DSH StreamChunk。
   */
  push(chunk) {
    switch (chunk?.type) {
      case 'text-delta':
        this.text += chunk.text ?? ''
        break
      case 'reasoning-delta':
        this.reasoning += chunk.text ?? ''
        break
      case 'tool-call-delta': {
        const current = this.tools.get(chunk.index) ?? { args: '' }
        if (chunk.id) current.id = chunk.id
        if (chunk.name !== undefined) current.name = chunk.name
        current.args += chunk.argumentsDelta ?? ''
        this.tools.set(chunk.index, current)
        break
      }
      case 'usage':
        this.usage = toOpenAiUsage(chunk.usage)
        break
      case 'finish':
        this.finishReason = toFinishReason(chunk.reason)
        if (chunk.reason?.kind === 'error') this.failure = chunk.reason.failure
        break
      default:
        break
    }
  }

  /**
   * 结束：产出完整 OpenAI ChatCompletion 响应体。
   * @returns 响应对象。
   */
  end() {
    const toolCalls = [...this.tools.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value], index) => ({
        id: value.id ?? `call_${index}`,
        type: 'function',
        function: { name: value.name ?? '', arguments: value.args || '{}' },
      }))

    return {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: this.text.length > 0 ? this.text : null,
            ...(this.reasoning.length > 0 ? { reasoning_content: this.reasoning } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: this.finishReason,
        },
      ],
      ...(this.usage === undefined ? {} : { usage: this.usage }),
    }
  }
}

/**
 * 生成一个 OpenAI 风格的响应 id。
 * @returns 形如 `chatcmpl-xxxx` 的 id。
 */
export function newCompletionId() {
  return `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`
}

/**
 * 组一个 OpenAI 风格错误体（**绝不含上游原始错误里的敏感信息**，
 * 调用方负责先脱敏）。
 * @param message - 已脱敏的消息。
 * @param type - 错误类型。
 * @param code - 机器码。
 * @param extra - 附加字段（如 available 候选列表）。
 * @returns 错误响应对象。
 */
export function errorBody(message, type, code, extra = {}) {
  return { error: { message, type, code, ...extra } }
}
