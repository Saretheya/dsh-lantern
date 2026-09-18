/**
 * dsh-lantern — Anthropic Messages API 兼容层（P11，设计方案 §6.2）。
 *
 * 公开 `POST /v1/messages`，让 Claude Code / Cursor 一类只认 Anthropic 协议的客户端
 * 也能使用本机 DSH 的全部模型。
 *
 * 与 OpenAI 通道**共用**同一套能力闸门、附件账本、用量记账与鉴权（由 index.js 统一处理），
 * 本模块只负责两件事：
 *   1. **请求翻译**：Anthropic 请求体 → 内部 `{ system, turns, images, toolSchemas }`；
 *   2. **响应翻译**：DSH StreamChunk → Anthropic SSE 事件序列（或非流式 JSON）。
 *
 * 事件序列（按官方规范，顺序不可乱）：
 * ```
 * message_start
 *   content_block_start (text|tool_use|thinking)
 *     content_block_delta (text_delta|input_json_delta|thinking_delta)
 *   content_block_stop
 * message_delta (stop_reason + usage)
 * message_stop
 * ```
 *
 * @module dsh-lantern/anthropic
 */
import { MAX_MESSAGES, MAX_TEXT_BYTES, parseDataUrl } from './protocol.js'

/** Anthropic SSE 版本（回给客户端的事件里不强制，但错误体建议带）。 */
export const ANTHROPIC_VERSION = '2023-06-01'

/** 支持的 `anthropic-version`（未知版本按最新处理，不强拒——官方客户端会持续升级）。 */
export const SUPPORTED_VERSIONS = ['2023-06-01']

/**
 * Anthropic 错误体。
 * @param message - 面向使用者的说明。
 * @param type - `invalid_request_error` / `authentication_error` / `api_error` …
 * @returns 响应体对象。
 */
export function anthropicError(message, type = 'invalid_request_error') {
  return { type: 'error', error: { type, message } }
}

/**
 * 把 Anthropic 的 `content` 数组拍平成文本，同时收集图片（与 OpenAI 路径同口径）。
 *
 * Anthropic 的 content 块形态：`{type:'text',text}`、`{type:'image',source:{...}}`、
 * `{type:'tool_use',id,name,input}`、`{type:'tool_result',tool_use_id,content}`、
 * `{type:'thinking',thinking}`。
 *
 * @param content - 字符串或块数组。
 * @param images - 收集图片 dataUrl 的数组。
 * @param warnings - 收集告警。
 * @returns 文本。
 */
function flattenAnthropicContent(content, images, warnings) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image': {
        // Anthropic 只支持 base64 来源（URL 来源是新特性，此处不假装支持）。
        const source = block.source
        if (source?.type === 'base64' && typeof source.data === 'string') {
          const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
          images.push(`data:${mediaType};base64,${source.data}`)
        } else {
          warnings.push('忽略了不受支持的图片来源（仅支持 base64）')
        }
        break
      }
      case 'tool_use':
        // 助手历史里的工具调用：文本化以便上游理解上下文。
        try {
          parts.push(`[调用工具 ${String(block.name ?? '')}：${JSON.stringify(block.input ?? {})}]`)
        } catch {
          parts.push(`[调用工具 ${String(block.name ?? '')}]`)
        }
        break
      case 'tool_result': {
        const inner = block.content
        const text = typeof inner === 'string'
          ? inner
          : Array.isArray(inner)
            ? inner.filter((x) => x?.type === 'text').map((x) => x.text).join('\n')
            : ''
        parts.push(`[工具结果]${text}`)
        break
      }
      case 'thinking':
        // 思考内容不回灌给上游（它是模型自己的产物，回灌会干扰判断）。
        break
      default:
        warnings.push(`忽略了不支持的 content 类型：${String(block.type)}`)
    }
  }
  return parts.join('\n')
}

/**
 * Anthropic 工具定义 → **DSH 的 `ToolSchema`**（内部统一口径）。
 *
 * ⚠ 目标结构是 DSH 的**扁平**形态（`dsh-llm/lib/types/types.d.ts`）：
 * ```ts
 * interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }
 * ```
 *
 * 这里**曾产出 OpenAI 的嵌套形态** `{type:'function', function:{…}}`，
 * 传给 `ctx.llm.stream({ tools })` 后 `name` 取不到 →
 * **Anthropic 通道的工具调用完全不生效**（而 OpenAI 通道正常，因为它有自己的
 * `toToolSchemas()` 会拍平）。用户实测的测试报告 §3.4 正是这一现象。
 *
 * Anthropic 输入形态：`{ name, description, input_schema }`
 *
 * @param tools - Anthropic tools 数组。
 * @returns DSH ToolSchema 数组（无有效项时 undefined）。
 */
export function toInternalToolSchemas(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const t of tools) {
    if (t === null || typeof t !== 'object') continue
    // 兼容两种输入：Anthropic 原生（顶层 name）与 OpenAI 包装（function.name）
    const fn = t.type === 'function' && t.function !== null && typeof t.function === 'object' ? t.function : t
    const name = typeof fn.name === 'string' ? fn.name : undefined
    if (name === undefined || name.length === 0) continue
    // Anthropic 用 input_schema；同时兼容 OpenAI 风格的 parameters
    const schema = fn.input_schema ?? fn.parameters
    out.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters:
        schema !== null && schema !== undefined && typeof schema === 'object'
          ? schema
          : { type: 'object', properties: {} },
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * 解析 Anthropic `/v1/messages` 请求体。
 *
 * @param body - 请求体。
 * @returns 与 `parseChatRequest()` **同构**的产物：`{ system, turns, images, toolSchemas, warnings }`。
 *   这样后段的 `buildMessages()`、能力闸门、附件账本全部可以原样复用。
 */
export function parseAnthropicRequest(body) {
  const warnings = []
  const images = []
  const turns = []

  // system 是**顶层字段**（可为字符串或块数组），不是 messages 里的一条
  let system
  if (typeof body?.system === 'string') system = body.system
  else if (Array.isArray(body?.system)) {
    system = body.system
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n\n')
  }

  const rawMessages = Array.isArray(body?.messages) ? body.messages : []
  if (rawMessages.length > MAX_MESSAGES) {
    warnings.push(`messages 条数超过上限 ${MAX_MESSAGES}，仅取前 ${MAX_MESSAGES} 条`)
  }

  for (const message of rawMessages.slice(0, MAX_MESSAGES)) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role
    if (role !== 'user' && role !== 'assistant') {
      warnings.push(`忽略了不支持的消息角色：${String(role)}`)
      continue
    }
    const text = flattenAnthropicContent(message.content, images, warnings)
    if (text.length > MAX_TEXT_BYTES) warnings.push('存在超长消息，已按上限截断')
    if (role === 'user') {
      turns.push({ role: 'user', text: text.slice(0, MAX_TEXT_BYTES) })
    } else {
      // 助手历史里的 tool_use 已文本化，故不填 toolCalls（避免与文本重复）
      turns.push({ role: 'assistant', text: text.slice(0, MAX_TEXT_BYTES), toolCalls: [] })
    }
  }

  return { system, turns, images, toolSchemas: toInternalToolSchemas(body?.tools), warnings }
}

/**
 * Anthropic 的 `stop_reason` 取值。
 *
 * ⚠ key 必须与 **DSH 实际的 `FinishReason.kind`** 对齐（查 `dsh-llm/lib/types/types.d.ts`）：
 * `'stop'` / `'tool-calls'` / `'max-tokens'` / `'aborted'` / `'error'`。
 *
 * 这里曾经写错（用 `length` / `toolUse`），导致 `max-tokens`、`tool-calls`
 * 都**落到默认值 `end_turn`**——于是"输出被截断"被伪装成"正常说完了"，
 * 客户端（Claude Code）因此不会提示"已达上限、正在继续"，用户把半截答案当完整答案。
 * 这是一次真实的静默失真，别再改回旧 key。
 */
const STOP_REASON = {
  stop: 'end_turn',
  'tool-calls': 'tool_use',
  'max-tokens': 'max_tokens',
  // 上游明确报错 / 被中断：都不是"正常说完"，如实映射为 refusal（Anthropic 无 error 枚举）
  // 具体错误另有 `event: error` 承载（见 AnthropicStreamTranslator）。
  error: 'refusal',
  aborted: 'refusal',
}

/**
 * 把内部 finish 原因转成 Anthropic 的 `stop_reason`。
 *
 * 未知 kind 一律落到 `end_turn`（保守，不编造语义），但**已知的
 * `max-tokens` / `tool-calls` / `error` / `aborted` 必须如实映射**。
 *
 * @param reason - DSH 的 finish reason。
 * @returns Anthropic stop_reason 字符串。
 */
export function toStopReason(reason) {
  if (reason === undefined || reason === null) return 'end_turn'
  const kind = reason.kind ?? reason
  return STOP_REASON[kind] ?? 'end_turn'
}

/**
 * 把 DSH 的 TokenUsage 转成 Anthropic usage 口径。
 *
 * ⚠ **口径差异（曾理解错，导致测试报告 §3.2 的"计量失真"）**：
 *
 * | 字段 | DSH | Anthropic |
 * |---|---|---|
 * | `inputTokens` / `input_tokens` | **仅未命中部分**（计数互斥） | **完整输入**（含缓存读写） |
 * | `cacheReadTokens` / `cache_read_input_tokens` | 命中部分 | 完整输入**其中**的命中部分 |
 *
 * 也就是说：**Anthropic 的 `input_tokens` 是"总量"，DSH 的是"分量"**。
 * 直接一对一映射会让 `input_tokens` 少掉缓存那一大块——
 * 实测 12000 字符输入时 DSH 给 `inputTokens=142, cacheReadTokens=5888`，
 * 正确的 Anthropic `input_tokens` 应是 **6030**（142+5888），而错的是 142，
 * 与用户测试报告里 Anthropic 路径"长输入只报 147"的现象完全吻合。
 *
 * 因此这里做**求和**：`input_tokens = inputTokens + cacheReadTokens + cacheWriteTokens`。
 * （与 `protocol.js` 的 `toOpenAiUsage()` 同一口径，那边拼 `prompt_tokens` 也是求和。）
 *
 * @param usage - DSH TokenUsage。
 * @returns Anthropic usage 对象。
 */
export function toAnthropicUsage(usage) {
  if (usage === undefined || usage === null) return undefined
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  const out = {
    // Anthropic 语义：input_tokens = 完整输入（未命中 + 缓存读 + 缓存写）
    input_tokens: (usage.inputTokens ?? 0) + cacheRead + cacheWrite,
    output_tokens: usage.outputTokens ?? 0,
  }
  // 缓存明细：仅在上游确实提供时给出（未提供时省略，不谎报 0）
  if (usage.cacheReadTokens !== undefined) out.cache_read_input_tokens = cacheRead
  if (usage.cacheWriteTokens !== undefined) out.cache_creation_input_tokens = cacheWrite
  return out
}

/**
 * Anthropic 流式翻译器：DSH StreamChunk → Anthropic SSE 事件。
 *
 * 与 OpenAI 翻译器的关键差异：
 * - 必须显式管理**内容块的开/关**（`content_block_start` / `_stop`），
 *   且文本块、思考块、每个工具调用块**各自独立编号**；
 * - 文本与思考不能出现在同一个块里 → 类型切换时要先关旧块再开新块；
 * - 工具入参走 `input_json_delta`（增量 JSON 字符串）。
 */
export class AnthropicStreamTranslator {
  /**
   * @param options - `{ id, model }`。
   */
  constructor({ id, model }) {
    this.id = id
    this.model = model
    this.messageStartSent = false
    this.finished = false
    /** 当前打开的块：`{index, type}` 或 undefined。 */
    this.open = undefined
    this.nextIndex = 0
    /** DSH 工具 index -> 已分配的 Anthropic 块 index。 */
    this.toolBlocks = new Map()
    /** 已见过的工具调用顺序，用于收尾时按序关闭。 */
    this.usage = undefined
    this.failure = undefined
    /** 若上游报错，这里保存 Anthropic 错误事件。 */
    this.errorEvent = undefined
  }

  /**
   * 组一个 SSE 事件。
   * @param type - 事件类型。
   * @param payload - 事件数据（不含 type）。
   * @returns SSE 文本。
   */
  #event(type, payload) {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
  }

  /** 产出 `message_start`（只发一次）。 */
  /**
   * 产出 `message_start`（只发一次）。
   *
   * ⚠ **`message_start.usage` 为什么是 0**（如实说明，不是 bug）：
   * Anthropic 官方在此事件里给出**完整的 prompt token 数**，因为官方自己有 tokenizer、
   * 流开始时就知道输入有多少。而本网关**没有 tokenizer 能力**——DSH 只在上游流结束时
   * 才回传权威 `usage`（且 DSH 未暴露任何 token 估算接口）。
   *
   * 因此这里**如实填 0（未知）**，把权威总量放在 `message_delta`（流末）里给出。
   * 这与 GLM 等 Anthropic 兼容网关的做法一致，也被官方 SDK 正常接受；
   * **绝不编造一个估算值**——那会让客户端把猜测当成真实上下文占用
   * （用户可核对的测试报告里，Anthropic 路径"读不到输入计量"正源于此，
   *  但根源是**本网关无 tokenizer**，属能力边界而非统计错误）。
   *
   * @returns 事件数组。
   */
  #ensureStart() {
    if (this.messageStartSent) return []
    this.messageStartSent = true
    return [
      this.#event('message_start', {
        message: {
          id: this.id,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // 未知即 0：流开始时网关无法知道真实输入量（无 tokenizer）。
          // 权威值在流末的 message_delta 给出。
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ]
  }

  /**
   * 关闭当前打开的块。
   * @returns 事件数组。
   */
  #closeOpen() {
    if (this.open === undefined) return []
    const index = this.open.index
    this.open = undefined
    return [this.#event('content_block_stop', { index })]
  }

  /**
   * 由**调用方**标记一个流式失败（例如 `for await` 抛出、或收到
   * `translator.failure`）。用于兜住"错误不是以 finish chunk 形式到达"的情形——
   * 那种情况下若不显式标记，`end()` 会走正常收尾，客户端又会看到"200 + 正常结束"。
   *
   * @param failure - `{ message, code }`（可为 undefined，用通用文案）。
   */
  markFailed(failure) {
    this.failure = failure ?? { message: '上游模型调用失败' }
    this.errorEvent = this.#event('error', {
      error: {
        type: 'api_error',
        message: this.failure.message ?? '上游模型调用失败',
      },
    })
  }

  /**
   * 打开一个块（必要时先关旧的）。
   * @param type - `text` / `thinking` / `tool_use`。
   * @param extra - 块初始字段（如工具块的 id/name）。
   * @returns `{ events, index }`。
   */
  #openBlock(type, extra = {}) {
    const events = this.#closeOpen()
    const index = this.nextIndex++
    this.open = { index, type }
    events.push(
      this.#event('content_block_start', {
        index,
        content_block: { type, ...extra },
      }),
    )
    return { events, index }
  }

  /**
   * 送入一个 DSH chunk。
   * @param chunk - DSH StreamChunk。
   * @returns SSE 帧数组。
   */
  push(chunk) {
    const frames = [...this.#ensureStart()]

    switch (chunk?.type) {
      case 'text-delta': {
        if (!chunk.text) break
        if (this.open?.type !== 'text') {
          frames.push(...this.#openBlock('text', { text: '' }).events)
        }
        frames.push(
          this.#event('content_block_delta', {
            index: this.open.index,
            delta: { type: 'text_delta', text: chunk.text },
          }),
        )
        break
      }

      case 'reasoning-delta': {
        if (!chunk.text) break
        if (this.open?.type !== 'thinking') {
          frames.push(...this.#openBlock('thinking', { thinking: '' }).events)
        }
        frames.push(
          this.#event('content_block_delta', {
            index: this.open.index,
            delta: { type: 'thinking_delta', thinking: chunk.text },
          }),
        )
        break
      }

      case 'tool-call-delta': {
        let index = this.toolBlocks.get(chunk.index)
        if (index === undefined) {
          // 工具块一旦打开就不再切回文本（Anthropic 允许交错，但保持简单更稳）
          const opened = this.#openBlock('tool_use', {
            ...(chunk.id === undefined ? {} : { id: chunk.id }),
            ...(chunk.name === undefined ? {} : { name: chunk.name }),
          })
          frames.push(...opened.events)
          index = opened.index
          this.toolBlocks.set(chunk.index, index)
        }
        const delta = chunk.argumentsDelta ?? ''
        if (delta.length > 0) {
          frames.push(
            this.#event('content_block_delta', {
              index,
              delta: { type: 'input_json_delta', partial_json: delta },
            }),
          )
        }
        break
      }

      case 'usage':
        this.usage = toAnthropicUsage(chunk.usage)
        break

      case 'finish': {
        this.stopReason = toStopReason(chunk.reason)
        // 只有 DSH **明确报错**（kind:'error'）才产出 error 事件。
        // kind:'aborted' 表示客户端主动断连，此时连接通常已断开、写也无意义，
        // 故不产出 error 事件，但仍通过 stop_reason:'refusal' 与上文的
        // "不编造 end_turn" 保持一致。
        if (chunk.reason?.kind === 'error') {
          this.failure = chunk.reason.failure
          this.errorEvent = this.#event('error', {
            error: {
              type: 'api_error',
              message: chunk.reason.failure?.message ?? '上游模型调用失败',
            },
          })
        }
        break
      }

      default:
        break
    }
    return frames
  }

  /**
   * 结束流。
   *
   * 分两种情况（**这是"如实"与"静默失真"的分界**）：
   *
   * 1. **正常结束**：关块 → `message_delta`（带 stop_reason/usage）→ `message_stop`。
   * 2. **上游报错**（DSH 已感知，以 `finish` chunk 的 `kind:'error'`/`'aborted'` 到达）：
   *    先关掉打开的块保持协议完整，然后发 **`event: error`** 并**终止**——
   *    不再发 `message_delta`/`message_stop`，因为那等于宣称"正常说完了"。
   *
   * ⚠ 为什么必须发 error 事件：HTTP 状态码与响应头在首个 SSE 帧时**已经发出**，
   * 中途出错无法再改状态码（只能 200）。若不发 `error` 事件，客户端只会看到
   * "200 + 空内容 + stop_reason:end_turn"，即**把上游故障伪装成正常空回答**——
   * 这正是设计文档 §6.5.1 铁律 3 明令禁止的"最危险的谎言"。
   *
   * 注意责任边界：这里**只转发 DSH 已感知的错误**。provider 自己的静默行为
   * （静默忽略 max_tokens、静默截断等）本插件不检测、不伪造，原样透传。
   *
   * @returns SSE 帧数组。
   */
  end() {
    const frames = [...this.#ensureStart(), ...this.#closeOpen()]

    if (this.errorEvent !== undefined) {
      // 上游报错：如实发出错误事件后终止
      frames.push(this.errorEvent)
      this.finished = true
      return frames
    }

    frames.push(
      this.#event('message_delta', {
        delta: { stop_reason: this.stopReason ?? 'end_turn', stop_sequence: null },
        ...(this.usage === undefined ? {} : { usage: this.usage }),
      }),
    )
    frames.push(this.#event('message_stop', {}))
    this.finished = true
    return frames
  }
}

/**
 * 非流式聚合器：把 DSH chunk 序列聚成 Anthropic 的 Message 响应体。
 */
export class AnthropicAggregator {
  /**
   * @param options - `{ id, model }`。
   */
  constructor({ id, model }) {
    this.id = id
    this.model = model
    /** @type {Array<object>} 已完成的内容块。 */
    this.blocks = []
    /** 当前块的缓冲。 */
    this.current = undefined
    this.toolBlocks = new Map()
    this.usage = undefined
    this.stopReason = 'end_turn'
    this.failure = undefined
  }

  /** 把当前缓冲落成一个块。 */
  #flush() {
    const cur = this.current
    if (cur === undefined) return
    this.current = undefined
    if (cur.type === 'text' && cur.text.length > 0) {
      this.blocks.push({ type: 'text', text: cur.text })
    } else if (cur.type === 'thinking' && cur.thinking.length > 0) {
      this.blocks.push({ type: 'thinking', thinking: cur.thinking })
    } else if (cur.type === 'tool_use') {
      // 入参必须是**对象**；上游给的不是合法 JSON 时退回空对象并保留原文
      let input = {}
      const raw = cur.partialJson
      if (raw.length > 0) {
        try {
          input = JSON.parse(raw)
        } catch {
          input = {}
        }
      }
      this.blocks.push({
        type: 'tool_use',
        id: cur.id ?? `toolu_${this.blocks.length}`,
        name: cur.name ?? '',
        input,
      })
    }
  }

  /**
   * 送入一个 DSH chunk。
   * @param chunk - DSH StreamChunk。
   */
  push(chunk) {
    switch (chunk?.type) {
      case 'text-delta':
        if (!chunk.text) break
        if (this.current?.type !== 'text') {
          this.#flush()
          this.current = { type: 'text', text: '' }
        }
        this.current.text += chunk.text
        break

      case 'reasoning-delta':
        if (!chunk.text) break
        if (this.current?.type !== 'thinking') {
          this.#flush()
          this.current = { type: 'thinking', thinking: '' }
        }
        this.current.thinking += chunk.text
        break

      case 'tool-call-delta': {
        let cur = this.toolBlocks.get(chunk.index)
        if (cur === undefined) {
          this.#flush()
          cur = { type: 'tool_use', id: chunk.id, name: chunk.name, partialJson: '' }
          this.current = cur
          this.toolBlocks.set(chunk.index, cur)
        }
        cur.partialJson += chunk.argumentsDelta ?? ''
        if (chunk.name !== undefined) cur.name = chunk.name
        if (chunk.id !== undefined) cur.id = chunk.id
        break
      }

      case 'usage':
        this.usage = toAnthropicUsage(chunk.usage)
        break

      case 'finish':
        this.stopReason = toStopReason(chunk.reason)
        if (chunk.reason?.kind === 'error') this.failure = chunk.reason.failure
        break

      default:
        break
    }
  }

  /**
   * 产出最终响应体。
   * @returns Anthropic Message 对象。
   */
  end() {
    this.#flush()
    // 工具调用完成时 stop_reason 应为 tool_use（上游没明确说时按内容推断）
    const hasTool = this.blocks.some((b) => b.type === 'tool_use')
    const stopReason = this.stopReason === 'end_turn' && hasTool ? 'tool_use' : this.stopReason
    return {
      id: this.id,
      type: 'message',
      role: 'assistant',
      model: this.model,
      content: this.blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
    }
  }
}

/**
 * 生成 Anthropic 风格的 message id（`msg_` + 22 位 base64url 风格字符）。
 * @returns 响应 id。
 */
export function newMessageId() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return `msg_${btoa(s).replace(/\+/g, 'A').replace(/\//g, 'B').replace(/=/g, '')}`
}

/**
 * 校验 Anthropic 请求体的必要字段（缺失时给出明确错误，而不是转发后报错）。
 * @param body - 请求体。
 * @returns 错误说明，或 undefined（通过）。
 */
export function validateAnthropicRequest(body) {
  if (body === null || typeof body !== 'object') return '请求体必须是 JSON 对象'
  if (typeof body.model !== 'string' || body.model.length === 0) return '缺少 model 字段'
  if (!Array.isArray(body.messages) || body.messages.length === 0) return '缺少 messages 字段（必须是非空数组）'
  // ⚠ Anthropic 官方**要求 max_tokens 必填**（缺失会被判 400 `max_tokens: Field required`）。
  // 本网关**不因此拒绝**，而是在 `resolveAnthropicMaxTokens()` 里补一个明确来源的默认值，
  // 这样"客户端偷懒"与"上游报错"不会混在一起。
  if (body.max_tokens !== undefined && (typeof body.max_tokens !== 'number' || body.max_tokens <= 0)) {
    return 'max_tokens 必须是正数'
  }
  return undefined
}

/**
 * 决定本次请求真正使用的 `max_tokens`。
 *
 * 角色划分（**用户定案**，"不自定义值"）：
 *   1. **客户端**给的 `max_tokens` —— 不可信输入，受 `limits.maxTokensCap` 封顶；
 *   2. **provider** 声明的 `defaultMaxTokens`（adapter 配置，经 `resolveModelInfo()` 暴露）
 *      —— **可信，原样使用，不再被网关封顶**（封顶它等于替 provider 改主意）；
 *   3. 两者都没有时，返回 `undefined`，**交由 DSH/adapter 自行决定**
 *      （DSH 的 `resolveCallWithInfo()` 本就支持"调用方省略"这条路径）。
 *
 * ⚠ 为什么不"自己拍一个值"：Anthropic 协议要求 `max_tokens` 必填，但那是
 * **客户端→网关**这一跳的要求；网关→DSH 这一跳用的是 DSH 的统一 `GenerateOptions`，
 * `maxTokens` 是可选字段。硬塞一个我们编的数值会**放大消耗**且掩盖真实来源。
 *
 * @param requested - 客户端请求的 max_tokens（可能 undefined）。
 * @param providerDefault - provider 声明的默认输出上限（可能 undefined）。
 * @param cap - 网关对**客户端值**的封顶。
 * @returns `{ value, source }`：`value` 为 undefined 表示"交由 DSH 决定"；
 *   `source` ∈ `client` / `provider` / `unset`。
 */
export function resolveAnthropicMaxTokens(requested, providerDefault, cap) {
  const limit = Number.isFinite(cap) && cap > 0 ? cap : undefined
  // 1) 客户端明确给了值：用它，但按网关上限封顶（只封顶，不放大）
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    return { value: limit === undefined ? requested : Math.min(requested, limit), source: 'client' }
  }
  // 2) provider 声明的默认值：原样采用，**不封顶**
  if (typeof providerDefault === 'number' && Number.isFinite(providerDefault) && providerDefault > 0) {
    return { value: providerDefault, source: 'provider' }
  }
  // 3) 都没有：不编造，交给 DSH/adapter
  return { value: undefined, source: 'unset' }
}
