/**
 * dsh-lantern — 能力层（P4）。
 *
 * 原则（设计方案 §6.5，三条铁律）：
 * 1. **权威优先**：DSH 已声明的字段**原样透传**，不添加、不推测、不"善意补全"；
 * 2. **未知 ≠ 支持**：DSH 没声明的能力默认公开为 `unknown`，并按"未知即拒绝"处理；
 * 3. **双向如实**：公开"支持"的必须真能用，公开"不支持"的必须明确报错——
 *    **绝不静默忽略参数然后返回一个看起来正常的回答**。
 *
 * 三态取值：`supported` / `unsupported` / `unknown`，且**必带 `source`**：
 *   `dsh`（DSH 权威）/ `declared`（用户手动）/ `profile`（内建推测）
 *   / `learned`（运行时负能力学习）/ `probe`（主动探测）/ `null`（无依据）
 *
 * 覆盖优先级（§6.5.3b，用户已定案）：
 *   用户手动覆盖 > 负担学习 > 主动探测 > 内建画像 > DSH 权威自动判定
 *   —— 但 DSH 权威项（图片/推理/上下文）默认照填，用户可以推翻它，
 *      推翻后标 `declared` 并显示"已被手动修改（原始权威值：X）"。
 *
 * @module dsh-lantern/capabilities
 */
import { readJson, writeJson, PATHS } from './storage.js'
import { deflateSync } from 'node:zlib'

/** 三态。 */
export const VALUE = Object.freeze({
  supported: 'supported',
  unsupported: 'unsupported',
  unknown: 'unknown',
})

/** 能力键。 */
export const KEYS = Object.freeze([
  'text',
  'image',
  'reasoning',
  'tools',
  'parallelTools',
  'jsonMode',
  'temperature',
  'stop',
  'streaming',
])

/** 人类可读名称（UI 用）。 */
export const LABELS = Object.freeze({
  text: '文本输入',
  image: '图片输入',
  reasoning: '推理能力',
  tools: '工具调用',
  parallelTools: '并行工具调用',
  jsonMode: 'JSON 模式',
  temperature: '温度参数',
  stop: '停止序列',
  streaming: '流式输出',
})

/**
 * 内建画像（档 B 第 2 层）：按 provider 给**推测性**默认。
 *
 * ⚠ 这些只是默认值，**属推测**（`source: 'profile'`），可被用户覆盖，
 * 且落地前应逐条实测确认。本机已知的真实 provider 才预置。
 */
export const BUILTIN_PROFILES = Object.freeze({
  // DeepSeek 系（官方 + 腾讯/国际版中转）：均支持工具调用与温度
  'deepseek-official': { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported },
  buddy: { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported },
  workbuddy: { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported },
  codearts: { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported },
  // cmdgo 走 CLI 私有网关，参数支持面较窄 → 保守标未知（不用 supported 赌）
  commandcode: { temperature: VALUE.unknown, stop: VALUE.unknown },
  // 硅基流动 OpenAI 兼容，常规参数齐备
  siliconflow: { tools: VALUE.supported, temperature: VALUE.supported, stop: VALUE.supported },
})

/**
 * 从上游错误文本里识别"不支持某能力"（档 C：运行时负能力学习）。
 *
 * 只在错误**明确指向该能力**时才记录，避免把"网络错误"误判成"不支持"。
 */
const NEGATIVE_PATTERNS = Object.freeze({
  tools: [/tool[s]?[ _-]?(?:is|are|not)?[ _-]?not[ _-]?support/i, /does not support tool/i, /no tool call support/i, /function calling[^.]{0,20}not support/i, /tools?[^.]{0,20}unsupported/i],
  jsonMode: [/response_format[^.]{0,30}not support/i, /json[ _-]?mode[^.]{0,20}not support/i, /structured output[^.]{0,20}not support/i],
  temperature: [/temperature[^.]{0,30}not support/i, /unsupported[^.]{0,20}temperature/i, /`?temperature`?[^.]{0,20}invalid/i],
  stop: [/stop[ _-]?sequence/i, /`?stop`?[^.]{0,30}not support/i],
  image: [/image[^.]{0,30}not support/i, /does not support image/i, /vision[^.]{0,20}not support/i],
  reasoning: [/reasoning[ _-]?effort[^.]{0,30}not support/i, /unsupported[^.]{0,20}reasoning/i],
  parallelTools: [/parallel[ _-]?tool[^.]{0,30}not support/i],
})

/**
 * 从一段错误文本识别它指向哪个能力（没有命中则返回 undefined）。
 * @param message - 上游错误原文。
 * @returns 能力键，或 undefined。
 */
export function detectNegativeCapability(message) {
  const text = String(message ?? '')
  if (text.length === 0) return undefined
  for (const [key, patterns] of Object.entries(NEGATIVE_PATTERNS)) {
    for (const re of patterns) {
      if (re.test(text)) return key
    }
  }
  return undefined
}

/**
 * 手写一个 24×12 的 PNG：**左半纯红、右半纯蓝**。
 *
 * 用途：图片能力探测的输入。它必须"有明确的、可校验的内容"，
 * 否则无法判断模型是否**真的读出了图**（用户明确要求）。
 * 只有约 100 字节，手写避免引入任何图像库依赖。
 *
 * @returns PNG 字节。
 */
export function buildProbePng() {
  const width = 24
  const height = 12
  // 扫描线：每行 = 过滤器字节(0) + width 个 RGB 三元组
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0 // filter: None
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3
      const leftHalf = x < width / 2
      raw[p] = leftHalf ? 255 : 0 // R
      raw[p + 1] = 0 // G
      raw[p + 2] = leftHalf ? 0 : 255 // B
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** PNG CRC32 查表（延迟构建一次）。 */
let crcTable
/**
 * 计算 PNG 分块所需的 CRC32。
 * @param buf - 待校验字节。
 * @returns 无符号 32 位 CRC。
 */
function crc32(buf) {
  if (crcTable === undefined) {
    crcTable = []
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 组一个 PNG 分块（长度 + 类型 + 数据 + CRC）。
 * @param type - 4 字符类型（如 `IHDR`）。
 * @param data - 分块数据。
 * @returns 完整分块字节。
 */
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([len, typed, crc])
}

/**
 * 构造一个能力结论。
 * @param value - 三态之一。
 * @param source - 来源标签。
 * @param extra - 附加字段（note / efforts / 数值等）。
 * @returns 结论对象。
 */
function cap(value, source, extra = {}) {
  return { value, source, ...extra }
}

/**
 * 能力解析器：管理权威透传、手动覆盖、画像、学习结果与缓存。
 */
export class CapabilityResolver {
  /**
   * @param ctx - Host 插件上下文（需要 llm 服务）。
   * @param config - 返回当前配置的函数。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** 用户手动覆盖：`"provider\u0000model\u0000key"` -> { value, at } */
    this.overrides = new Map()
    /** 运行时学习：同键 -> { value, evidence, at } */
    this.learned = new Map()
    /** 权威元数据缓存：`"provider\u0000model\u0000generation"` -> caps */
    this.authoritative = new Map()
    /** 能力缓存代次（收到 adapters-updated 时递增，使权威缓存失效，§6.5.7） */
    this.generation = 0
    this.loaded = false
    /**
     * 用量记账回调（P9）：`(usage, item) => void`。
     * 探测会真实调用模型，因此这些消耗也要进账本（记为 `kind: 'test'`）。
     * @type {((usage: object|undefined, item: string) => void)|undefined}
     */
    this.onUsage = undefined
  }

  /** 从磁盘载入覆盖与学习结果（`data/capabilities.json`）。 */
  async load() {
    const doc = await readJson(PATHS.capabilities, { version: 1, overrides: {}, learned: {} })
    this.overrides = new Map(Object.entries(doc?.overrides ?? {}))
    this.learned = new Map(Object.entries(doc?.learned ?? {}))
    this.loaded = true
    return { overrides: this.overrides.size, learned: this.learned.size }
  }

  /** 落盘（只写插件自己的 data/）。 */
  async persist() {
    await writeJson(PATHS.capabilities, {
      version: 1,
      overrides: Object.fromEntries(this.overrides),
      learned: Object.fromEntries(this.learned),
      updatedAt: Date.now(),
    })
  }

  /** 缓存键。 */
  #key(provider, model, field) {
    return `${provider}\u0000${model}\u0000${field}`
  }

  /**
   * 使权威缓存失效（provider 拓扑变化时调用）。
   * 理由：像 cmdgo 这类 adapter 会在目录刷新时 `registration.replace()`，
   * 同一 provider 的能力可能在运行中改变（§6.5.7）。
   */
  invalidate() {
    this.generation += 1
    this.authoritative.clear()
  }

  /**
   * 取 DSH 权威能力（档 A，**只读透传**）。
   * @param provider - provider 路由 id。
   * @param model - 模型 id。
   * @returns 权威能力对象；查询失败返回 undefined。
   */
  async authoritativeOf(provider, model) {
    const cacheKey = `${provider}\u0000${model}\u0000${this.generation}`
    const cached = this.authoritative.get(cacheKey)
    if (cached !== undefined) return cached

    let info
    try {
      info = await this.ctx.llm.resolveModelInfo(provider, model)
    } catch {
      return undefined
    }
    // ⚠ 语义要点：字段缺失 = 未知；字段存在但不含 = 明确不支持
    const mods = info.inputModalities
    const textCap =
      mods === undefined
        ? cap(VALUE.unknown, 'dsh')
        : cap(mods.includes('text') ? VALUE.supported : VALUE.unsupported, 'dsh')
    const imageCap =
      mods === undefined
        ? cap(VALUE.unknown, 'dsh', { note: '该模型未声明输入模态，故图片能力未知' })
        : mods.includes('image')
          ? cap(VALUE.supported, 'dsh')
          : cap(VALUE.unsupported, 'dsh', { note: 'inputModalities 显式不含 image（明确不支持）' })

    const reasoningCap =
      info.reasoning !== undefined && info.reasoning.efforts.length > 0
        ? cap(VALUE.supported, 'dsh', {
            efforts: info.reasoning.efforts.map((e) => e.id),
            ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
          })
        : cap(VALUE.unknown, 'dsh', { note: '未声明 reasoning 元数据' })

    const result = {
      text: textCap,
      image: imageCap,
      reasoning: reasoningCap,
      // 上下文与输出上限是**数值型**能力
      contextWindow: info.context !== undefined ? { value: info.context.contextWindow, source: 'dsh' } : cap(VALUE.unknown, 'dsh'),
      maxOutputTokens:
        info.defaultMaxTokens !== undefined ? { value: info.defaultMaxTokens, source: 'dsh' } : cap(VALUE.unknown, 'dsh'),
      systemPromptUpdate:
        info.systemPromptUpdate !== undefined
          ? { value: info.systemPromptUpdate, source: 'dsh' }
          : cap(VALUE.unknown, 'dsh'),
      // 结构上恒为流式（内核统一暴露 AsyncIterable）
      streaming: cap(VALUE.supported, 'dsh', { note: '内核恒为 AsyncIterable 流式' }),
      // 展示字段
      name: info.name,
      ...(info.description === undefined ? {} : { description: info.description }),
      ...(mods === undefined ? {} : { inputModalities: [...mods] }),
    }
    this.authoritative.set(cacheKey, result)
    return result
  }

  /**
   * 解析某个档 B 能力（四层优先级）。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param field - 能力键（如 'tools'）。
   * @returns 能力结论。
   */
  resolveField(provider, model, field) {
    const key = this.#key(provider, model, field)

    // 1) 用户手动覆盖（最高优先）
    const override = this.overrides.get(key)
    if (override !== undefined) {
      return cap(override.value, 'declared', { at: override.at, ...(override.note === undefined ? {} : { note: override.note }) })
    }

    // 2) 运行时负能力学习
    const learned = this.learned.get(key)
    if (learned !== undefined) {
      return cap(learned.value, 'learned', {
        at: learned.at,
        ...(learned.evidence === undefined ? {} : { evidence: learned.evidence }),
      })
    }

    // 3) 内建画像（**推测**，标 profile）
    const profile = BUILTIN_PROFILES[provider]?.[field]
    if (profile !== undefined) {
      return cap(profile, 'profile', { note: '内建画像推测，非 DSH 权威声明；可用「测试」按钮实测确认' })
    }

    // 4) 都没有 → 未知（**不是** supported）
    return cap(VALUE.unknown, null)
  }

  /**
   * 汇总某模型的完整能力视图。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @returns 能力对象（权威 + 档 B 四层解析）。
   */
  async describe(provider, model) {
    const auth = (await this.authoritativeOf(provider, model)) ?? {}
    const fields = {}
    for (const key of ['tools', 'parallelTools', 'jsonMode', 'temperature', 'stop']) {
      fields[key] = this.resolveField(provider, model, key)
    }

    /**
     * 可被人工覆盖的字段（§6.5.3b：用户改过就以用户为准）。
     *
     * ⚠ **必须优先取 `resolveField`，`auth` 只作兜底**。
     * 这些字段原先直接返回 `auth.*`，导致 `setOverride` 写入了覆盖、
     * `describe` 却永远读不出来 —— 界面表现是"点了复选框没反应"
     *（用户实测：文本输入 / 图片输入 / 推理能力 三项无法手动修改）。
     *
     * `resolveField` 的优先级链已包含"用户覆盖 > 学习 > 画像 > 未知"，
     * 但它的最后一层是 `unknown`，而权威值（来自 DSH）比"未知"更有信息量，
     * 因此这里做：**有覆盖/学习/画像 → 用它；否则 → 用权威值**。
     *
     * @param field - 能力键。
     * @param fallback - 权威值（`auth[field]` 或 undefined）。
     * @returns 能力描述对象。
     */
    const preferOverride = (field, fallback) => {
      const resolved = this.resolveField(provider, model, field)
      // 解析出"未知且无依据"时，说明没有覆盖/学习/画像命中 → 用权威值
      if (resolved?.value === VALUE.unknown && resolved?.source === null) {
        return fallback ?? resolved
      }
      return resolved
    }

    return {
      // 档 A/B 混合：人工可覆盖，未覆盖时用权威值
      text: preferOverride('text', auth.text),
      image: preferOverride('image', auth.image),
      reasoning: preferOverride('reasoning', auth.reasoning),
      streaming: preferOverride('streaming', auth.streaming),
      // 上下文窗口 / 最大输出是**数值**，不适用三态覆盖，仍走权威透传
      contextWindow: auth.contextWindow ?? cap(VALUE.unknown, 'dsh'),
      maxOutputTokens: auth.maxOutputTokens ?? cap(VALUE.unknown, 'dsh'),
      systemPromptUpdate: auth.systemPromptUpdate ?? cap(VALUE.unknown, 'dsh'),
      // 档 B：四层解析
      tools: fields.tools,
      parallelTools: fields.parallelTools,
      jsonMode: fields.jsonMode,
      temperature: fields.temperature,
      stop: fields.stop,
      // 原始权威值（供 UI 显示"被手动修改前的原值"）
      authoritativeRaw: {
        text: auth.text?.value ?? VALUE.unknown,
        image: auth.image?.value ?? VALUE.unknown,
        reasoning: auth.reasoning?.value ?? VALUE.unknown,
        contextWindow: auth.contextWindow?.value ?? VALUE.unknown,
        maxOutputTokens: auth.maxOutputTokens?.value ?? VALUE.unknown,
      },
      ...(auth.name === undefined ? {} : { name: auth.name }),
      ...(auth.description === undefined ? {} : { description: auth.description }),
    }
  }

  /**
   * 用户手动设置某能力（§6.5.3b：改过就以用户为准）。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param field - 能力键。
   * @param value - 三态值（传 null 表示清除覆盖、恢复权威值）。
   * @returns 是否成功。
   */
  async setOverride(provider, model, field, value) {
    const key = this.#key(provider, model, field)
    if (value === null || value === undefined) {
      this.overrides.delete(key)
    } else if (value === VALUE.supported || value === VALUE.unsupported || value === VALUE.unknown) {
      this.overrides.set(key, { value, at: Date.now() })
    } else {
      return false
    }
    await this.persist()
    return true
  }

  /**
   * 记录一次负能力学习（档 C）。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param field - 能力键。
   * @param evidence - 上游错误原文（脱敏后）。
   * @returns 是否记录了新结论。
   */
  async learnNegative(provider, model, field, evidence) {
    const key = this.#key(provider, model, field)
    // 用户手动覆盖优先：不覆盖用户的判断
    if (this.overrides.has(key)) return false
    const existing = this.learned.get(key)
    if (existing?.value === VALUE.unsupported) return false
    this.learned.set(key, { value: VALUE.unsupported, evidence: String(evidence ?? '').slice(0, 400), at: Date.now() })
    await this.persist()
    return true
  }

  /**
   * 能力测试（§6.5.10）：**逐项真实调用**，用于发现模型隐藏/未声明的能力。
   *
   * ⚠ **测试结果不会自动回填**（用户决定）：它只呈现给你看，
   * 不写入能力结论、也不会改写你已有的声明（见 `test()` 内的说明）。
   *
   * 注意成本：每一项都是一次真实模型调用，会消耗上游额度。
   *
   * @param options - `{ provider, model, items, perItemTimeoutMs, onProgress }`。
   * @returns 逐项结果数组。
   */
  async test({ provider, model, items, perItemTimeoutMs = 30_000, onProgress }) {
    const results = []
    const emit = (item, result) => {
      results.push(result)
      try {
        onProgress?.(item, result)
      } catch {
        /* 进度回调失败不影响测试 */
      }
    }

    // 先刷新权威项（零成本，纯读）
    const auth = await this.authoritativeOf(provider, model)
    if (auth !== undefined) {
      emit('authoritative', {
        item: 'authoritative',
        ok: true,
        image: auth.image?.value ?? VALUE.unknown,
        reasoning: auth.reasoning?.value ?? VALUE.unknown,
        contextWindow: auth.contextWindow?.value ?? VALUE.unknown,
        maxOutputTokens: auth.maxOutputTokens?.value ?? VALUE.unknown,
        systemPromptUpdate: auth.systemPromptUpdate?.value ?? VALUE.unknown,
      })
    }

    const wanted = Array.isArray(items) && items.length > 0 ? items : ['connectivity', 'tools', 'temperature', 'jsonMode', 'stop', 'image']

    for (const item of wanted) {
      if (item === 'authoritative') continue
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), perItemTimeoutMs)
      const started = Date.now()
      try {
        const probe = await this.#probeOne(item, provider, model, ac.signal)
        clearTimeout(timer)
        emit(item, { item, ms: Date.now() - started, ...probe })
        // ⚠ **不再从测试结果"回填"负能力**（用户决定移除）。
        //
        // 原实现在这里调用 `learnNegative()` 把"不支持"写进 `learned`，
        // 但该机制实际作用极小：
        //   · `resolveField` 的优先级是 **用户声明 > learned > 画像**，
        //     所以只要用户声明过，测试结果永远进不去；
        //   · 初始化时已从 DSH 取到权威值，绝大多数能力**根本不缺结论**；
        //   · 只有"用户没声明过、且画像也没覆盖"的少数组合才会用到它。
        // 代价却是真实的：一个**临时的上游故障**（限流/超时被误判）会被
        // 持久化成"该能力不支持"，且用户看不出它是怎么来的。
        //
        // 因此测试结果**仅供用户参考**，不再自动改写任何能力结论。
        // 唯一保留的自动学习是**档 C**（`index.js` 的 `learnFromFailure`）：
        // 它由**真实转发失败**触发、有明确错误依据，与"测试"无关。
      } catch (error) {
        clearTimeout(timer)
        emit(item, {
          item,
          ms: Date.now() - started,
          value: VALUE.unknown,
          error: String(error?.message ?? error).slice(0, 300),
        })
      }
    }
    return results
  }

  /**
   * 单项探测（真实调用一次）。
   * @param item - 能力键。
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param signal - 取消信号。
   * @returns `{ value, evidence? }`。
   */
  async #probeOne(item, provider, model, signal) {
    const { createSystemMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const messages = [
      createSystemMessage('你是一个测试对象。严格按要求回答，不要解释。', 'dsh-lantern-captest'),
      createUserMessage({
        content: [{ type: 'text', text: item === 'tools' ? '请调用 echo 工具，参数 text 设为 ok。' : '请只回复：ok' }],
      }),
    ]

    /** @type {Record<string, unknown>} */
    const options = { provider, model, messages, maxTokens: 64, signal }
    if (item === 'tools') {
      options.tools = [
        {
          name: 'echo',
          description: '回显测试工具',
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        },
      ]
    }
    if (item === 'temperature') options.temperature = 0
    if (item === 'stop') options.stop = ['\n\n']
    if (item === 'jsonMode') {
      // DSH 语义层没有 response_format；这里只探测"上游是否报错"，
      // 因此不真的加字段（加了也没人转发），统一记为 unknown 并说明。
      return {
        value: VALUE.unknown,
        note: 'DSH 适配层未暴露 response_format 透传路径，无法在此探测（语义层不存在该字段）',
      }
    }
    if (item === 'image') {
      return await this.#probeImage(provider, model, signal)
    }

    let sawToolCall = false
    let sawText = false
    let failure
    let probeUsage
    for await (const chunk of this.ctx.llm.stream(options)) {
      if (chunk.type === 'tool-call-delta') sawToolCall = true
      else if (chunk.type === 'text-delta' && String(chunk.text).trim().length > 0) sawText = true
      else if (chunk.type === 'usage') probeUsage = chunk.usage
      else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
        failure = chunk.reason.failure
      }
    }
    // 探测是真实调用，消耗要进账本（记为测试用量）
    try {
      this.onUsage?.(probeUsage, item, { provider, model })
    } catch {
      /* 记账失败不影响测试 */
    }

    if (failure !== undefined) {
      const msg = String(failure.message ?? '')
      // 只有明确指向该能力的错误才算 unsupported
      const detected = detectNegativeCapability(msg)
      if (item === 'connectivity') {
        return { value: VALUE.unsupported, evidence: msg.slice(0, 300), note: '基础连通性失败' }
      }
      return detected === item
        ? { value: VALUE.unsupported, evidence: msg.slice(0, 300) }
        : { value: VALUE.unknown, error: msg.slice(0, 300), note: '失败原因与该能力无明确关联，记为未知' }
    }

    if (item === 'tools') {
      return sawToolCall
        ? { value: VALUE.supported, note: '模型确实发起了 tool-call' }
        : { value: VALUE.unknown, note: '未发起工具调用，但也没有报错 → 不足以判定为支持' }
    }
    if (item === 'connectivity') {
      return sawText ? { value: VALUE.supported } : { value: VALUE.unknown, note: '有响应但无文本增量' }
    }
    // temperature / stop：能正常返回即视为"已通过"（DSH 会把它透传给 adapter）。
    //
    // ⚠ 措辞说明（用户反馈"带该参数调用成功"对非专业用户不可读）：
    // 1. note 写**各项自己的**人话，而不是共用一句 —— 原先两项共用
    //    '带该参数调用成功'，UI 的"相同 note 合并"逻辑就把它显示成
    //    「（2 项一致）」，用户看不懂这个"2 项"从哪来；
    // 2. 判据只是"**请求没报错**"，并不证明参数真的生效 ——
    //    所以措辞用"已通过"而非"支持"，如实反映验证强度（方案 2）。
    if (item === 'temperature') {
      return { value: VALUE.supported, note: '实测：带上温度参数请求，模型正常返回（不报错即视为通过）' }
    }
    if (item === 'stop') {
      return { value: VALUE.supported, note: '实测：带上停止序列请求，模型正常返回（不报错即视为通过）' }
    }
    return { value: VALUE.supported, note: '实测：带上该参数请求，模型正常返回' }
  }

  /**
   * 探测图片能力：**生成一张带确定可验证内容的极小图片**，要求模型读出它，
   * 并**校验答案**——而不是"不报错就算支持"。
   *
   * 为什么必须这样（用户明确要求）：
   * 上游可能"声明支持图片"但实际**读不出内容**（例如把图片当透明占位、
   * 或在网关侧被丢弃）。只发一张 1×1 图并看是否报错，**发现不了这种情况**。
   * 因此这里发一张有明确图案（左半纯红、右半纯蓝）的小图，
   * 提问"左边和右边各是什么颜色"，再用**关键词校验**回答是否真的读出了内容。
   *
   * @param provider - provider id。
   * @param model - 模型 id。
   * @param signal - 取消信号。
   * @returns 能力结论（含 answers / verified 等证据字段）。
   */
  async #probeImage(provider, model, signal) {
    const cfg = this.config()
    if (cfg?.allowImageInput !== true) {
      return {
        value: VALUE.unknown,
        note: '网关未开启图片输入（allowImageInput=false），跳过图片探测以免落盘；这不是"模型不支持"',
      }
    }
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      return { value: VALUE.unknown, note: '本机附件服务不可用，无法探测图片能力' }
    }

    // 生成"左红右蓝"的 24×12 PNG（约 100 字节级，极小但有可读内容）
    const png = buildProbePng()
    const { createSystemMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const [ref] = await attachments.saveImages([{ data: png, mediaType: 'image/png' }])
    if (ref === undefined) return { value: VALUE.unknown, note: '图片入库失败' }

    const messages = [
      createSystemMessage(
        '你是图像识别测试对象。只回答被问的内容，不要解释，不要客套。',
        'dsh-lantern-captest',
      ),
      createUserMessage({
        content: [
          { type: 'text', text: '这张图被竖着分成两半。请只回答两个词：左半部分的主色、右半部分的主色。' },
          { type: 'image', attachment: ref },
        ],
      }),
    ]

    let text = ''
    let failure
    let imageUsage
    for await (const chunk of this.ctx.llm.stream({ provider, model, messages, maxTokens: 64, signal })) {
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk.type === 'usage') imageUsage = chunk.usage
      else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
        failure = chunk.reason.failure
      }
    }
    // 图片探测同样是真实调用（含图片 token），必须进账本
    try {
      this.onUsage?.(imageUsage, 'image', { provider, model })
    } catch {
      /* 记账失败不影响测试 */
    }

    if (failure !== undefined) {
      const msg = String(failure.message ?? '')
      return detectNegativeCapability(msg) === 'image'
        ? { value: VALUE.unsupported, evidence: msg.slice(0, 300) }
        : { value: VALUE.unknown, error: msg.slice(0, 300), note: '失败原因与图片无明确关联，记为未知' }
    }

    // 关键词校验：必须同时读出"红"与"蓝"（允许中英文）
    const answer = text.trim()
    const sawRed = /红|red/i.test(answer)
    const sawBlue = /蓝|blue/i.test(answer)
    const verified = sawRed && sawBlue

    if (verified) {
      return {
        value: VALUE.supported,
        note: '图片内容实测读出（左红右蓝均答对）',
        answers: answer.slice(0, 120),
        verified: true,
      }
    }
    // 明确答错 → 上游多半只是"声明"支持图片，实际读不出内容
    if (answer.length > 0) {
      return {
        value: VALUE.unsupported,
        note: `模型未能读出图片内容（期望"左红右蓝"，实际回答："${answer.slice(0, 80)}"）——可能只声明了图片能力但实际读不出`,
        answers: answer.slice(0, 120),
        verified: false,
      }
    }
    return {
      value: VALUE.unknown,
      note: '模型对图片没有给出任何文本回答，无法判定是否真的读出了内容',
      answers: '',
      verified: false,
    }
  }

  /**
   * 按能力结论决定"用户请求的参数"是否放行（§6.5.5）。
   *
   * 策略：**硬能力拒绝、软参数标注**。
   * - 硬能力（tools / image / jsonMode / reasoning）：不支持或未知 → 拒绝（400）
   * - 软参数（temperature / stop）：不支持或未知 → 忽略 + 响应头标注
   *
   * @param caps - `describe()` 的结果。
   * @param request - 客户端请求中的参数存在性描述。
   * @returns `{ reject?: {capability, message}, ignored: string[], headers: Record<string,string> }`。
   */
  enforce(caps, request) {
    const ignored = []
    const headers = {}

    const check = (capability, present, label) => {
      if (!present) return undefined
      const c = caps[capability]
      const value = c?.value ?? VALUE.unknown
      if (value === VALUE.supported) return undefined
      return { capability, label, value, source: c?.source ?? null }
    }

    // 硬能力：不支持/未知 → 拒绝
    const hard = [
      check('tools', request.hasTools === true, '工具调用'),
      check('jsonMode', request.hasJsonMode === true, 'JSON 模式'),
    ].filter(Boolean)
    // 图片单独判定（图片同时受"模型能力"与"网关开关"两层约束，见下）
    if (request.hasImage === true) {
      const c = caps.image ?? { value: VALUE.unknown }
      if (c.value !== VALUE.supported) {
        hard.push({ capability: 'image', label: '图片输入', value: c.value, source: c.source ?? null })
      }
    }
    // 推理档位：客户端显式点名该能力，不支持/未知 → 拒绝
    if (request.hasReasoningEffort === true) {
      const c = caps.reasoning ?? { value: VALUE.unknown }
      if (c.value !== VALUE.supported) {
        hard.push({ capability: 'reasoning', label: '推理档位', value: c.value, source: c.source ?? null })
      }
    }

    if (hard.length > 0) {
      const first = hard[0]
      const reason =
        first.value === VALUE.unsupported
          ? `该模型不支持${first.label}（来源：${first.source ?? '未知'}）`
          : `${first.label}的能力未知（DSH 未声明、且未经人工确认）——按"未知即拒绝"处理`
      return {
        reject: {
          capability: first.capability,
          label: first.label,
          value: first.value,
          source: first.source,
          message: `${reason}。可在 设置 → LANtern → 该 provider 页用「测试」按钮实测确认，或手动勾选声明。`,
          all: hard,
        },
        ignored,
        headers,
      }
    }

    // 软参数：不支持/未知 → 忽略 + 响应头标注
    for (const [field, present, label] of [
      ['temperature', request.hasTemperature === true, 'temperature'],
      ['stop', request.hasStop === true, 'stop'],
    ]) {
      if (!present) continue
      const c = caps[field]
      const value = c?.value ?? VALUE.unknown
      if (value !== VALUE.supported) ignored.push(label)
    }
    if (ignored.length > 0) headers['X-Lantern-Ignored-Params'] = ignored.join(',')

    return { ignored, headers }
  }
}
