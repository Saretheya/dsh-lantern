/**
 * dsh-lantern — LANtern（局域网模型灯塔）Host 半部。
 *
 * 把本机 DSH 已注册的**全部** AI 模型，以 OpenAI 兼容接口公开给局域网。
 *
 * 本阶段（P0/P1）实现：
 * 1. `GET /v1/models`           全量模型目录（全名制 `<model>@<slug>`）
 * 2. `GET /v1/lantern/health`   插件自检 + provider 可见性诊断
 *
 * 隔离纪律（设计方案 §7.6）：
 * - 只读复用 `ctx.llm`（listProviders/listModels），**不建会话、不注册工具**；
 * - 唯一写入位置是插件自己的 `data/`；
 * - **不用 `ctx.settings.installSection`**（会把命名空间段写进共享的 settings.yaml
 *   并在卸载后永久残留）；
 * - 默认 `enabled: false`，开启后才注册路由。
 *
 * 装配方式：插件自带 `cordis.patch.yml`（`dsh.bundle.patch`），
 * 因此 `dsh plugin remove` 一条命令即可彻底卸载，不留悬空装配行。
 *
 * @module dsh-lantern
 */
import { ModelDirectory, parsePublicName, publicNameOf } from './directory.js'
import { PATHS, appendJsonl, ensureDirs, readJson, sweepTmp, writeJson } from './storage.js'
import { KeyStore, extractCredential } from './auth.js'
import { buildMessages, maskSecrets } from './messages.js'
import { ListenManager, newListenId, normalizeEntries } from './listen.js'
import { installManagementRpc, probePort } from './rpc.js'
import { CapabilityResolver, VALUE, detectNegativeCapability } from './capabilities.js'
import { AttachmentLedger } from './attachments.js'
import { Breaker, createReservedGate, isRateLimitFailure } from './breaker.js'
import { recordUsage, toLedgerUsage } from './usage.js'
import { fingerprintOf } from './auth.js'
import {
  OpenAiAggregator,
  OpenAiStreamTranslator,
  errorBody,
  newCompletionId,
  parseChatRequest,
} from './protocol.js'
import {
  AnthropicAggregator,
  AnthropicStreamTranslator,
  anthropicError,
  newMessageId,
  parseAnthropicRequest,
  resolveAnthropicMaxTokens,
  validateAnthropicRequest,
} from './anthropic.js'

export const name = 'dsh-lantern'

/** llm 是硬依赖；webServer / attachments 按需注入。 */
export const inject = ['llm']

/**
 * 默认监听条目：`reuse` 模式（复用 DSH 端口）。
 * 首次运行时写入 `data/config.json`，可在 设置 → LANtern → 状态与安全 里增删改。
 */
const DEFAULT_LISTEN_ENTRIES = Object.freeze([
  { id: 'listen_reuse', mode: 'reuse', bind: '0.0.0.0', enabled: true },
])

/** 默认配置（首次运行时写入 data/config.json）。 */
const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  listenEntries: DEFAULT_LISTEN_ENTRIES,
  // 过滤（P16 / §4.4 + §7.3）：
  //   providers / models —— 黑名单（命中即不公开）
  //   allowedModels      —— 白名单（**非空时只公开其中的**；空 = 全部）
  filters: { providers: [], models: [], allowedModels: [] },
  protocol: { openai: true, anthropic: false },
  auth: {
    format: 'sk',
    allowAnonymous: false,
    rotateGraceHours: 24,
  },
  limits: {
    maxConcurrent: 2,
    perKeyRpm: 30,
    // 每分钟**输出 token** 上限（P12）：并发与 RPM 拦不住"单个请求就很贵"
    perKeyTpm: 60_000,
    maxTokensCap: 8192,
    maxBodyBytes: 4 * 1024 * 1024,
    requestTimeoutMs: 600_000,
    // 为本机 DSH 保留的并发槽（§7.3 第 7 条：本机优先）
    reserveForLocal: 1,
    // 熔断（§7.3 第 8 条）：上游连续限流 → 暂停 LAN 通道，保护本机
    breaker: {
      enabled: true,
      consecutiveRateLimits: 3,
      cooldownSec: 60,
    },
  },
  allowImageInput: false,
  // 用量记账（P9）：只统计"经由本插件"的调用，落在插件自己的 data/usage.jsonl。
  usage: {
    enabled: true,
    // 报告重复点击的复用窗口（1 分钟，避免连点生成一堆报告）
    reuseWithinSec: 60,
    // 报告保留份数
    keepReports: 20,
    // 单文件超过此大小则滚动归档（字节）
    maxLedgerBytes: 16 * 1024 * 1024,
  },
  // 能力相关（P4）。测试默认**完整项、不减项**（设计文档 §6.5.10 已定案：
  // 该按钮本来也不常点，宁可测全）。
  capabilities: {
    expose: true,
    profiles: 'use-builtin',
    learnNegative: true,
    test: {
      items: ['connectivity', 'tools', 'temperature', 'jsonMode', 'stop', 'image'],
      perItemTimeoutMs: 30_000,
    },
  },
  perfTest: { timeoutMs: 20_000 },
  // 附件账本（P8，设计文档 §7.5 档 B）。
  // ⚠ `dryRun` 默认 **true**：只记日志不真删，观察期后由用户显式关掉。
  attachments: {
    dryRun: true,
    reclaimDelayMs: 5 * 60 * 1000,
    sweepIntervalMs: 5 * 60 * 1000,
    checkSessionRefs: true,
  },
})

/**
 * 合并用户配置与默认值（浅层 + 已知嵌套键，避免深合并的意外覆盖）。
 * @param raw - 磁盘上的配置对象。
 * @returns 生效配置。
 */
function withDefaults(raw) {
  const base = DEFAULT_CONFIG
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return {
      ...base,
      listenEntries: base.listenEntries.map((e) => ({ ...e })),
      filters: { ...base.filters },
      protocol: { ...base.protocol },
      auth: { ...base.auth },
      limits: { ...base.limits },
      usage: { ...base.usage },
      capabilities: { ...base.capabilities, test: { ...base.capabilities.test, items: [...base.capabilities.test.items] } },
      attachments: { ...base.attachments },
      // limits 里有嵌套对象（breaker），必须深合并一层，否则用户只改
      // breaker.cooldownSec 会把整个 breaker 段覆盖掉、丢掉 enabled/threshold。
      limits: { ...base.limits, breaker: { ...base.limits.breaker } },
    }
  }
  // 兼容早期只写 listen 对象的版本（迁移为 listenEntries）
  const migrated = Array.isArray(raw.listenEntries)
    ? raw.listenEntries
    : raw.listen !== undefined && typeof raw.listen === 'object'
      ? [{ id: 'listen_reuse', mode: raw.listen.mode ?? 'reuse', bind: raw.listen.bind ?? '0.0.0.0', ...(raw.listen.mode === 'standalone' ? { port: raw.listen.port } : {}), enabled: true }]
      : DEFAULT_LISTEN_ENTRIES
  return {
    ...base,
    ...raw,
    listenEntries: migrated.map((e) => ({ ...e })),
    filters: { ...base.filters, ...(raw.filters ?? {}) },
    protocol: { ...base.protocol, ...(raw.protocol ?? {}) },
    auth: { ...base.auth, ...(raw.auth ?? {}) },
    limits: {
      ...base.limits,
      ...(raw.limits ?? {}),
      // breaker 深合并一层（见上）
      breaker: { ...base.limits.breaker, ...(raw.limits?.breaker ?? {}) },
    },
    usage: { ...base.usage, ...(raw.usage ?? {}) },
    capabilities: {
      ...base.capabilities,
      ...(raw.capabilities ?? {}),
      test: {
        ...base.capabilities.test,
        ...(raw.capabilities?.test ?? {}),
        ...(Array.isArray(raw.capabilities?.test?.items)
          ? { items: raw.capabilities.test.items }
          : { items: [...base.capabilities.test.items] }),
      },
    },
    perfTest: { ...base.perfTest, ...(raw.perfTest ?? {}) },
    attachments: { ...base.attachments, ...(raw.attachments ?? {}) },
  }
}

/**
 * 本机信任围墙：只接受回环地址、且非跨站的请求。
 * 与 harness 自带闸门同一判据（有 `connection` 服务时优先用它）。
 * @param headers - Node 请求头（小写键）。
 * @returns 拒绝时的 HTTP 状态码；放行时 undefined。
 */
export function browserTrustRejection(headers) {
  const host = headers.host
  if (typeof host !== 'string' || host.length === 0) return 403
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return 403
  }
  const h = hostUrl.hostname
  const loopback =
    h === 'localhost' || h === '::1' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  if (!loopback) return 403
  if (headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== hostUrl.host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

/**
 * 发送 JSON 响应。
 * @param res - Node 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 可 JSON 序列化的响应体。
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * 读取请求体（有体积上限，超限即拒绝——不无界缓冲）。
 * @param req - Node 请求对象。
 * @param maxBytes - 上限字节数。
 * @returns `{ ok, body?, reason? }`。
 */
async function readBody(req, maxBytes) {
  const chunks = []
  let size = 0
  let overflow = false
  await new Promise((resolve) => {
    req.on('data', (chunk) => {
      size += chunk?.length ?? 0
      if (size > maxBytes) {
        overflow = true
        return // 继续消费但不再累积，避免破坏连接
      }
      if (chunk !== undefined) chunks.push(chunk)
    })
    req.on('end', resolve)
    req.on('error', resolve)
  })
  if (overflow) return { ok: false, reason: 'too_large' }
  if (chunks.length === 0) return { ok: true, body: {} }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'not_object' }
    }
    return { ok: true, body: parsed }
  } catch {
    return { ok: false, reason: 'bad_json' }
  }
}

/**
 * 解析模型公开名 → 目录条目。
 * 严格命中目录；未命中时用 `<model>@<slug>` 拆解做宽松兜底（§4.3）。
 * @param directory - 模型目录。
 * @param name - 客户端提交的 model 字段。
 * @returns 条目，或 `{ error }`。
 */
function resolveModel(directory, name) {
  const strict = directory.resolve(name)
  if (strict !== undefined) return strict

  const parsed = parsePublicName(name)
  if (parsed !== undefined) {
    const providerId = directory.providerBySlug(parsed.slug)
    // ⚠ 回退路径也**必须过过滤**（P16）：
    // 否则被排除的模型虽然不出现在 /v1/models，却仍能被直接调用——
    // 过滤就只剩"看不见"，而设计目的（§7.3）是"不能用"
    // （排除关键账号所在的 provider、只公开便宜/不怕刷的模型）。
    if (
      providerId !== undefined &&
      directory.isProviderLive(providerId) &&
      directory.isPubliclyAllowed?.(providerId, parsed.model) !== false
    ) {
      return {
        publicName: name,
        provider: providerId,
        providerName: providerId,
        slug: parsed.slug,
        model: parsed.model,
        name: parsed.model,
      }
    }
  }
  return { error: 'model_not_found' }
}

/**
 * 有并发上限的 map：按序返回结果，顺序与输入一致。
 * 用途：`/v1/models` 要逐模型查能力元数据，150+ 个模型不能同时打上游。
 * @param items - 输入数组。
 * @param limit - 并发上限（至少 1）。
 * @param fn - 异步映射函数。
 * @returns 与输入等长的结果数组。
 */
async function mapWithConcurrency(items, limit, fn) {
  const size = Math.max(1, Math.min(limit, items.length))
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 组一个 OpenAI 兼容的模型对象（§5.4）。
 * 标准字段严格合规，插件信息放 `x-lantern.*` 扩展字段
 * （含 `capabilities`：能力的**三态 + 来源**，客户端忽略即不影响兼容）。
 * @param entry - 目录条目。
 * @param caps - 可选的能力视图（`CapabilityResolver.describe()` 的结果）。
 * @returns OpenAI `/v1/models` 条目。
 */
function toOpenAiModel(entry, caps) {
  return {
    id: entry.publicName,
    object: 'model',
    created: 0,
    owned_by: entry.provider,
    root: entry.model,
    'x-lantern': {
      provider: entry.provider,
      providerName: entry.providerName,
      model: entry.model,
      display: `${entry.model}（${entry.providerName}）`,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.inputModalities === undefined ? {} : { inputModalities: entry.inputModalities }),
      ...(caps === undefined ? {} : { capabilities: caps }),
    },
  }
}

/**
 * 插件入口。
 * @param ctx - Host 插件上下文。
 * @param config - 组合层传入的配置（本插件以 data/config.json 为准）。
 */
export function apply(ctx, config) {
  // --- 配置与存储：全部落在插件自己的 data/ ---
  let current = withDefaults(config)
  const cfg = () => current

  const directory = new ModelDirectory(ctx, cfg)
  const keyStore = new KeyStore(cfg)
  const capabilities = new CapabilityResolver(ctx, cfg)
  const ledger = new AttachmentLedger(ctx, cfg)
  // 功能测试会真实调用模型 → 其消耗也要进账本（kind='test'，UI 上单列一项）。
  // 目标由探测方在回调里给出，避免依赖任何"临时字段"。
  capabilities.onUsage = (usage, item, where) => {
    void recordCall(
      {
        current: () => current,
        log: (level, message) => (level === 'error' ? ctx.logger.error(message) : ctx.logger.info(message)),
      },
      { provider: where?.provider ?? 'unknown', model: where?.model ?? 'unknown', publicName: where?.publicName ?? 'unknown' },
      { usage, kind: 'test', status: 'ok', protocol: 'internal', testItem: item },
    )
  }
  /**
   * 并发与速率闸门（§7.3）。
   *
   * ⚠ 并发闸门是**动态重建**的：`limits.maxConcurrent` 与 `reserveForLocal`
   * 可在设置面板随时改，所以每次 acquire 时按当前配置取。见 `currentGate()`。
   */
  let slotGate = createReservedGate(current.limits?.maxConcurrent ?? 2, current.limits?.reserveForLocal ?? 0)
  let slotGateKey = `${current.limits?.maxConcurrent ?? 2}:${current.limits?.reserveForLocal ?? 0}`

  /**
   * 取当前生效的并发闸门；配置变了就重建（在飞计数沿用，避免丢计数）。
   * @returns 保留槽闸门。
   */
  function currentGate() {
    const max = current.limits?.maxConcurrent ?? 2
    const reserve = current.limits?.reserveForLocal ?? 0
    const key = `${max}:${reserve}`
    if (key !== slotGateKey) {
      const next = createReservedGate(max, reserve)
      slotGateKey = key
      slotGate = next
    }
    return slotGate
  }

  /** 熔断器（P12）：上游连续限流 → 暂停 LAN 通道，保护本机。 */
  const breaker = new Breaker(() => current)

  /** 速率窗口（RPM 与 token 计量）。 */
  const gate = {
    /** @type {Map<string, number[]>} keyId -> 最近请求时间戳 */
    rps: new Map(),
  }

  /** 推理处理器（由 webServer 注入回调赋值，供 standalone 服务复用）。 */
  let inferenceHandler

  /**
   * 探测 DSH 自身 HTTP 服务**实际**监听的地址。
   *
   * 为什么需要它（用户实测发现）：`reuse` 模式复用 DSH 已监听的 socket，
   * 其绑定 IP 由 **DSH 启动参数 `--host`** 决定，**与插件的 bind 配置无关**。
   * 若插件照自己的配置汇报 `0.0.0.0`，就会出现"设置页说局域网可访问、
   * 实际只有 127.0.0.1 能连"的**谎报**——违反"如实公开"原则。
   *
   * 探测顺序（都拿不到就返回 undefined，由 `status()` 退化为配置值并标 inherited）：
   *   1. `webServer` 暴露的 server/socket 的 `address()`（最权威）；
   *   2. `webServer.host` / `webServer.address`（若 DSH 直接暴露字符串）。
   *
   * @returns 实际地址字符串（如 `127.0.0.1` / `0.0.0.0`），或 undefined。
   */
  function detectActualBind() {
    try {
      const webServer = ctx.get('webServer')
      if (webServer === undefined) return undefined
      // 1) 从活的 socket 取（最可靠）
      const server = webServer.server ?? webServer.httpServer ?? webServer._server
      const addr = typeof server?.address === 'function' ? server.address() : undefined
      if (addr !== null && addr !== undefined && typeof addr === 'object' && typeof addr.address === 'string') {
        return addr.address
      }
      // 2) DSH 若直接暴露 host 字段
      for (const key of ['host', 'hostname', 'address', 'bind']) {
        const v = webServer[key]
        if (typeof v === 'string' && v.length > 0) return v
      }
    } catch (error) {
      ctx.logger.warn(`[lantern] 探测 DSH 实际绑定地址失败（不影响功能）：${error?.message}`)
    }
    return undefined
  }

  /** 监听管理器（P14：端口增删改）。 */
  const listenManager = new ListenManager({
    ctx,
    handler: (req, res) => {
      if (inferenceHandler === undefined) {
        sendJson(res, 503, errorBody('LANtern 尚未就绪', 'service_disabled', 'lantern_not_ready'))
        return
      }
      return inferenceHandler(req, res)
    },
    getOwnPort: () => ctx.get('webServer')?.port,
    log: (level, message) => {
      if (level === 'error') ctx.logger.error(message)
      else ctx.logger.info(message)
    },
  })

  /**
   * 把配置补丁写回磁盘并立即生效（浅合并，只覆盖给定键）。
   * @param patch - 要改的配置键。
   */
  async function patchConfig(patch) {
    const nextConfig = withDefaults({
      ...current,
      ...patch,
      filters: { ...current.filters, ...(patch.filters ?? {}) },
      protocol: { ...current.protocol, ...(patch.protocol ?? {}) },
      auth: { ...current.auth, ...(patch.auth ?? {}) },
      limits: {
        ...current.limits,
        ...(patch.limits ?? {}),
        // breaker 深合并（只改 cooldownSec 时不该丢掉 enabled/threshold）
        ...(patch.limits?.breaker === undefined
          ? {}
          : { breaker: { ...current.limits.breaker, ...patch.limits.breaker } }),
      },
      usage: { ...current.usage, ...(patch.usage ?? {}) },
    })
    current = nextConfig
    await writeJson(PATHS.config, current)

    // 监听条目变化 → reconcile 实际服务
    if (patch.listenEntries !== undefined) {
      const ownPort = ctx.get('webServer')?.port
      const normalized = normalizeEntries(current.listenEntries, ownPort, detectActualBind())
      if (!normalized.ok) return { ok: false, message: normalized.message }
      const applied = await listenManager.apply(normalized.entries)
      if (!applied.ok) {
        ctx.logger.warn(`[lantern] 监听变更未生效：${applied.message}`)
        return applied
      }
    }
    return { ok: true }
  }

  /** RPC 依赖集合（管理通道用）。 */
  const rpcDeps = {
    current: () => current,
    keyStore,
    directory,
    capabilities,
    ledger,
    patchConfig,
    /**
     * 恢复出厂默认设置（P16 危险操作）。
     * **不碰** `data/keys.json` 与 `data/usage.jsonl`——用户数据不该被"复位设置"带走。
     * @param keepKeys - 传 false 表示连 Key 一并清空（当前 UI 不暴露该入口，保留能力）。
     * @returns `{ ok }`。
     */
    resetConfig: async (keepKeys = true) => {
      try {
        current = withDefaults({})
        await writeJson(PATHS.config, current)
        if (keepKeys === false) {
          keyStore.records = []
          await keyStore.persist().catch(() => {})
        }
        // 配置变了 → 让目录按新配置重建，面板能立刻看到结果
        await directory.refresh().catch(() => {})
        return { ok: true }
      } catch (error) {
        ctx.logger.error(`[lantern] 配置复位失败：${error?.message}`)
        return { ok: false, message: error?.message ?? '复位失败' }
      }
    },
    listenList: () => listenManager.list(),
    listenStatus: () => listenManager.status(),
    inflight: () => currentGate().inflight,
    breaker,
    concurrencyStatus: () => currentGate().status(),
    /**
     * 性能测试（§6.5.10-b）：一次最短调用，返回延迟 / 首字 / token 速度。
     *
     * 三态呈现（用户要求）：
     * - 正常 → 绿字（latencyMs / ttftMs / tokPerSec）
     * - 超时 → `kind: 'timeout'`（前端红字 `time out`）
     * - 其它错误 → **原样**返回上游消息（**先脱敏**，红线见 §6.5.10-b）
     *
     * @param options - `{ provider, model, timeoutMs }`。
     * @returns 结果对象。
     */
    perfTest: async ({ provider, model, timeoutMs }) => {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      const started = Date.now()
      let ttftMs
      let outputTokens = 0
      let failure
      try {
        const { createSystemMessage, createUserMessage } = await import('@deepseek-ai/dsh-llm')
        const messages = [
          createSystemMessage('只回复一个字。', 'dsh-lantern-perftest'),
          createUserMessage({ content: [{ type: 'text', text: 'ping' }] }),
        ]
        for await (const chunk of ctx.llm.stream({ provider, model, messages, maxTokens: 8, signal: ac.signal })) {
          if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
            if (ttftMs === undefined) ttftMs = Date.now() - started
          } else if (chunk.type === 'usage') {
            outputTokens = chunk.usage?.outputTokens ?? 0
          } else if (chunk.type === 'finish') {
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason.failure
          }
        }
      } catch (error) {
        failure = { message: error?.message ?? String(error), code: error?.code ?? 'transport' }
      } finally {
        clearTimeout(timer)
      }

      const latencyMs = Date.now() - started
      if (ac.signal.aborted) return { ok: false, kind: 'timeout', timeoutMs, latencyMs }
      if (failure !== undefined) {
        return {
          ok: false,
          kind: 'upstream',
          latencyMs,
          // 原样返回上游消息，但**先脱敏**（可能含 key / 邮箱 / 端点）
          raw: maskSecrets(failure.message),
          code: failure.code,
          ...(failure.status === undefined ? {} : { status: failure.status }),
        }
      }
      const seconds = Math.max((latencyMs - (ttftMs ?? 0)) / 1000, 0.001)
      return {
        ok: true,
        latencyMs,
        ttftMs: ttftMs ?? null,
        outputTokens,
        tokPerSec: outputTokens > 0 ? Number((outputTokens / seconds).toFixed(1)) : null,
      }
    },
    /**
     * 端口的增 / 删 / 改（P14）。
     * @param payload - `{ action, entry, id }`。
     * @returns `{ ok, value?, code?, message? }`。
     */
    listenUpdate: async (payload) => {
      const action = String(payload.action ?? '')
      const list = listenManager.list()
      const ownPort = ctx.get('webServer')?.port

      if (action === 'add') {
        const candidate = { id: newListenId(), enabled: true, ...payload.entry }
        const next = [...list, candidate]
        const normalized = normalizeEntries(next, ownPort, detectActualBind())
        if (!normalized.ok) return { ok: false, code: 'invalid_entry', message: normalized.message }
        // 试听（standalone 才需要）
        //
        // ⚠ **必须用条目自己的 bind 去探**，不能硬编码 127.0.0.1：
        // 实测（DSH 已占着回环地址的某端口时）`probe(127.0.0.1, port)` 报 EADDRINUSE，
        // 而 `probe(0.0.0.0, port)` 是**可用的**。若这里探回环、UI「试听」按 bind 探，
        // 就会出现"试听说通过、确认却失败"的自相矛盾（实测反馈）。
        const target = normalized.entries.find((e) => e.id === candidate.id)
        if (target?.mode === 'standalone') {
          const probe = await probePort(target.port, target.bind ?? '127.0.0.1')
          if (!probe.available) {
            return { ok: false, code: 'port_unavailable', message: `端口 ${target.port} 不可用：${probe.reason}` }
          }
        }
        const applied = await patchConfig({ listenEntries: normalized.entries })
        return applied.ok
          ? { ok: true, value: { entries: listenManager.list(), active: listenManager.status() } }
          : { ok: false, code: 'apply_failed', message: applied.message }
      }

      if (action === 'update') {
        const id = String(payload.id ?? '')
        if (list.every((e) => e.id !== id)) return { ok: false, code: 'not_found', message: '条目不存在' }
        const next = list.map((e) => (e.id === id ? { ...e, ...payload.entry, id } : e))
        const normalized = normalizeEntries(next, ownPort, detectActualBind())
        if (!normalized.ok) return { ok: false, code: 'invalid_entry', message: normalized.message }
        const target = normalized.entries.find((e) => e.id === id)
        if (target?.mode === 'standalone' && target.enabled !== false) {
          // 同 add：必须按条目自己的 bind 探测（硬编码 127.0.0.1 会与 UI 试听判定不一致）
          const probe = await probePort(target.port, target.bind ?? '127.0.0.1')
          if (!probe.available) {
            return { ok: false, code: 'port_unavailable', message: `端口 ${target.port} 不可用：${probe.reason}` }
          }
        }
        const applied = await patchConfig({ listenEntries: normalized.entries })
        return applied.ok
          ? { ok: true, value: { entries: listenManager.list(), active: listenManager.status() } }
          : { ok: false, code: 'apply_failed', message: applied.message }
      }

      if (action === 'remove') {
        const id = String(payload.id ?? '')
        const next = list.filter((e) => e.id !== id)
        if (next.length === list.length) return { ok: false, code: 'not_found', message: '条目不存在' }
        if (next.length === 0) {
          return { ok: false, code: 'last_entry', message: '不能删除最后一条监听条目（否则等于把自己关停）' }
        }
        const normalized = normalizeEntries(next, ownPort, detectActualBind())
        if (!normalized.ok) return { ok: false, code: 'invalid_entry', message: normalized.message }
        const applied = await patchConfig({ listenEntries: normalized.entries })
        return applied.ok
          ? { ok: true, value: { entries: listenManager.list(), active: listenManager.status() } }
          : { ok: false, code: 'apply_failed', message: applied.message }
      }

      return { ok: false, code: 'unknown_action', message: `未知操作：${action}` }
    },
  }

  /** 卸载时释放监听服务。 */
  ctx.effect(() => () => {
    void listenManager.dispose()
  })

  /**
   * 尝试占用一个并发槽。
   * @returns 是否成功。
   */
  function acquireSlot() {
    return currentGate().acquire()
  }

  /** 释放并发槽。 */
  function releaseSlot() {
    currentGate().release()
  }

  /**
   * 每 Key 每分钟请求数限流（滑动窗口）。
   * @param keyId - key 标识（匿名请求用 `__anon__`）。
   * @param limit - 该 key 的每分钟上限。
   * @returns 是否放行。
   */
  function allowRate(keyId, limit) {
    const now = Date.now()
    const windowStart = now - 60_000
    const hits = (gate.rps.get(keyId) ?? []).filter((t) => t > windowStart)
    if (hits.length >= limit) {
      gate.rps.set(keyId, hits)
      return false
    }
    hits.push(now)
    gate.rps.set(keyId, hits)
    return true
  }

  // 启动：建目录、清临时文件、载入配置与 key、开始枚举。
  // 全部包在 try/catch 内 —— 插件自身出问题**不得**拖垮 DSH 启动（§7.2）。
  //
  // ⚠ 这里有一个**必须处理的竞态**（用户实测踩到）：
  // `ctx.inject(['webServer'], …)` 是**同步**触发的，而它的回调里会
  // `normalizeEntries(current.listenEntries, …)` 并开始监听。
  // 若读盘（异步）尚未完成，`current` 还是 `apply(config)` 拿到的**初值**，
  // 于是监听按"默认配置"启动、**磁盘上的真实配置被完全忽略**——
  // 表现为"用户改成 standalone 某端口，重启后仍是 reuse 的 DSH 端口，新端口从未监听"。
  //
  // 解法：`configReady` 在配置载入后 resolve；监听启动前 **await 它**，
  // 保证一定按磁盘配置启动。
  let markConfigReady
  const configReady = new Promise((resolve) => {
    markConfigReady = resolve
  })

  void (async () => {
    try {
      await ensureDirs()
      const swept = await sweepTmp()
      if (swept > 0) ctx.logger.info(`[lantern] 清理了 ${swept} 个残留临时文件`)
      const disk = await readJson(PATHS.config, undefined)
      if (disk === undefined) {
        await writeJson(PATHS.config, current)
        ctx.logger.info(`[lantern] 已生成初始配置 data/config.json（enabled=${current.enabled}）`)
      } else {
        current = withDefaults(disk)
      }
      // ★ 配置已就位：放行"监听启动"（它在 inject 回调里 await 这个 Promise）
      markConfigReady()
      const keys = await keyStore.load()
      const capInfo = await capabilities.load()
      const ledgerCount = await ledger.load()
      const entries = await directory.start()
      ctx.logger.info(
        `[lantern] 目录就绪：${ctx.llm.listProviders().length} 个 provider / ` +
          `${entries.length} 个公开模型（enabled=${current.enabled}，keys=${keys.length}，` +
          `能力覆盖=${capInfo.overrides}，学习=${capInfo.learned}，附件账本=${ledgerCount}）`,
      )
      if (current.enabled && keyStore.isEmpty) {
        ctx.logger.warn(
          '[lantern] ⚠ 已启用但尚无任何 API Key —— 局域网请求将一律被拒。' +
            '请在 设置 → LANtern → 状态与安全 中生成一个 Key。',
        )
      }
      // 拓扑变化时使权威能力缓存失效（§6.5.7：adapter 代次可能改变同一 provider 的能力）
      ctx.on('llm/adapters-updated', () => capabilities.invalidate())
      // reuse 模式的绑定地址由 DSH 的 `--host` 决定，**插件无权决定**。
      // 这里如实探测，供 status/health/UI 汇报真实值（避免"设置说 0.0.0.0、实际只有回环"的谎报）。
      const actualBind = detectActualBind()
      listenManager.setReuseActualBind(actualBind)
      if (actualBind !== undefined && actualBind !== '0.0.0.0' && actualBind !== '::') {
        const reuseEntry = current.listenEntries?.find((e) => e.mode === 'reuse' && e.enabled !== false)
        if (reuseEntry !== undefined && reuseEntry.bind === '0.0.0.0') {
          ctx.logger.warn(
            `[lantern] ⚠ reuse 条目配置为 0.0.0.0，但 DSH 自身只监听 ${actualBind}（由 DSH 启动参数 --host 决定）。` +
              '局域网当前无法访问。要真正暴露到局域网，请重启 DSH 时加 --host 0.0.0.0，' +
              '或改用 standalone 模式（插件自开端口，只暴露 /v1/*）。',
          )
        }
      }
      // P8：启动附件账本定时回收（默认 dry-run，只记日志不真删）
      ledger.start()
      if (current.attachments?.dryRun !== false) {
        ctx.logger.warn(
          '[lantern] 附件回收处于 dry-run（只记日志、不真删）。' +
            '观察一段时间确认无误后，可在 设置 → LANtern 中关闭 dry-run。',
        )
      }
    } catch (error) {
      ctx.logger.error('[lantern] 初始化失败（插件保持静默，不影响 DSH）')
      ctx.logger.error(error)
    } finally {
      // ★ 无论成功失败都必须放行：否则监听启动会**永久等待**这个 Promise。
      // （初始化失败时 current 保持 apply 的初值，监听按初值启动，属可接受的降级。）
      markConfigReady()
    }
  })()

  // 卸载时释放定时器（隐藏的兜底轮询与去抖定时器 + 附件回收）。
  ctx.effect(() => () => directory.dispose())
  ctx.effect(() => () => ledger.dispose())

  // --- HTTP 路由：只有 enabled 时才注册（默认关闭）---
  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.get('webServer')
    if (webServer === undefined) {
      ctx.logger.warn('[lantern] webServer 服务缺席')
      ctx.logger.warn('[lantern] 未找到 webServer 服务，/v1/* 路由未注册')
      return
    }
    ctx.logger.info(`[lantern] webServer 就绪（port=${webServer.port}）`)

    /**
     * `/v1` 前缀路由：OpenAI 兼容端点。
     * 只读目录、不发起任何模型调用。
     */
    const route = {
      kind: 'prefix',
      path: '/v1',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const pathname = url.pathname.replace(/\/+$/, '') || '/'

          // 自检端点：始终可用（不依赖 enabled），便于管理员确认插件已加载。
          if (req.method === 'GET' && pathname === '/v1/lantern/health') {
            sendJson(res, 200, {
              ok: true,
              plugin: name,
              enabled: current.enabled,
              listen: listenManager.status(),
              auth: {
                keyCount: keyStore.records.length,
                usable: keyStore.records.filter((r) => r.enabled !== false).length,
                allowAnonymous: current.auth?.allowAnonymous === true,
                format: current.auth?.format ?? 'sk',
              },
              inflight: currentGate().inflight,
              // P12：熔断与并发/保留槽状态，便于管理员判断"是不是被限流保护了"
              breaker: breaker.status(),
              concurrency: currentGate().status(),
              directory: directory.diagnostics(),
            })
            return
          }

          // --- 协议判定（决定"入口级错误"用哪种形状） ---
          // `/v1/messages` 是 Anthropic 专属路径，据此决定错误体形状：
          // Anthropic 官方 SDK 只认 `{type:'error', error:{type,message}}`，
          // 回 OpenAI 形状会让它抛一个笼统异常、看不出真实原因（已实测踩到）。
          const isAnthropicPath = pathname === '/v1/messages'
          /**
           * 入口级错误（未启用 / 鉴权失败）：形状与请求协议一致。
           *
           * @param status - HTTP 状态码。
           * @param message - 面向使用者的说明。
           * @param openAiType - OpenAI 形状的 `error.type`。
           * @param code - OpenAI 形状的 `error.code`。
           * @param anthropicType - Anthropic 形状的 `error.type`。
           */
          const entryError = (status, message, openAiType, code, anthropicType = 'invalid_request_error') => {
            if (isAnthropicPath) sendJson(res, status, anthropicError(message, anthropicType))
            else sendJson(res, status, errorBody(message, openAiType, code))
          }

          if (!current.enabled) {
            entryError(
              503,
              'LANtern 未启用：请在 设置 → LANtern → 状态与安全 中打开开关',
              'service_disabled',
              'lantern_disabled',
              'api_error',
            )
            return
          }

          // --- 鉴权闸门（§8）---
          // 默认拒绝一切未鉴权请求；不提供"无鉴权模式"（除非显式开启 allowAnonymous）。
          const presented = extractCredential(req.headers)
          const record = presented === undefined ? undefined : keyStore.verify(presented)
          if (record === undefined) {
            if (!(presented === undefined && current.auth?.allowAnonymous === true)) {
              const noKeys = keyStore.isEmpty
              entryError(
                401,
                noKeys
                  ? '尚未生成任何 API Key：请到 设置 → LANtern → 状态与安全 生成一个后再连接'
                  : 'API Key 无效、已停用或已过期',
                'invalid_request_error',
                'invalid_api_key',
                'authentication_error',
              )
              return
            }
          } else {
            void keyStore.touch(record)
          }

          if (req.method === 'GET' && pathname === '/v1/models') {
            const providerFilter = url.searchParams.get('provider')
            const includeCaps = url.searchParams.get('capabilities') !== '0'
            const selected = directory
              .list()
              .filter((e) => providerFilter === null || e.provider === providerFilter)
            // 能力是按模型逐个查询的（resolveModelInfo）；并行但有上限，
            // 避免 150+ 个模型同时打向上游元数据查询。
            const models = includeCaps
              ? await mapWithConcurrency(selected, 8, async (entry) => {
                  try {
                    return toOpenAiModel(entry, await capabilities.describe(entry.provider, entry.model))
                  } catch {
                    // 能力查询失败不应让目录整体失败：退回不带 capabilities 的条目
                    return toOpenAiModel(entry)
                  }
                })
              : selected.map((entry) => toOpenAiModel(entry))
            sendJson(res, 200, { object: 'list', data: models })
            return
          }

          // 单模型详情（OpenAI 亦有该端点，§6.5.4）
          if (req.method === 'GET' && pathname.startsWith('/v1/models/')) {
            const id = decodeURIComponent(pathname.slice('/v1/models/'.length))
            const entry = directory.resolve(id)
            if (entry === undefined) {
              sendJson(res, 404, errorBody(`模型未找到：${id}`, 'invalid_request_error', 'model_not_found', {
                hint: '公开名格式为 <model>@<provider>；不带 @ 后缀一律不解析（§5）',
                available: directory.list().map((e) => e.publicName).slice(0, 50),
              }))
              return
            }
            let caps
            try {
              caps = await capabilities.describe(entry.provider, entry.model)
            } catch {
              caps = undefined
            }
            sendJson(res, 200, toOpenAiModel(entry, caps))
            return
          }

          // --- 对话转发（P2 核心）---
          const forwardDeps = {
            directory,
            keyStore,
            capabilities,
            ledger,
            breaker,
            cfg,
            current: () => current,
            acquireSlot,
            releaseSlot,
            allowRate,
            record,
            log: (level, message) => {
              if (level === 'error') ctx.logger.error(message)
              else ctx.logger.info(message)
            },
          }
          if (req.method === 'POST' && pathname === '/v1/chat/completions') {
            await handleChatCompletions(ctx, req, res, forwardDeps)
            return
          }

          // --- Anthropic 兼容通道（P11，§6.2）---
          if (req.method === 'POST' && pathname === '/v1/messages') {
            if (current.protocol?.anthropic !== true) {
              // 关闭时明确说明"这是网关开关"，与"上游不支持"区分开（铁律 3）
              sendJson(res, 404, anthropicError(
                'Anthropic 兼容端点未启用（protocol.anthropic=false）。' +
                  '这与"模型不支持"是两件事——如需使用，请在 设置 → LANtern → 状态与安全 中开启。',
                'invalid_request_error',
              ))
              return
            }
            await handleAnthropicMessages(ctx, req, res, forwardDeps)
            return
          }

          sendJson(res, 404, errorBody(`未知端点：${req.method} ${pathname}`, 'invalid_request_error', 'unknown_endpoint'))
        } catch (error) {
          ctx.logger.error('[lantern] 请求处理异常')
          ctx.logger.error(error)
          if (!res.headersSent) {
            // 不把内部细节回给客户端（可能含路径与栈）；细节只写本机日志。
            sendJson(res, 500, errorBody('LANtern 内部错误（详情见插件日志）', 'internal_error', 'lantern_internal'))
          }
        }
      },
    }

    // 保存 handler 供 ListenManager 复用（standalone 服务用同一个处理器）
    inferenceHandler = route.handler

    // reuse 模式的注册控制器：允许运行中动态挂载/卸载，而不必重启插件。
    let reuseRegistered = false
    const reuseDisposer = { current: undefined }
    listenManager.setReuseControl({
      get registered() {
        return reuseRegistered
      },
      register() {
        if (reuseRegistered) return
        reuseDisposer.current = webServer.register(route)
        reuseRegistered = true
        ctx.logger.info('[lantern] 已在 DSH 端口上挂载 /v1/*（reuse 模式）')
      },
      unregister() {
        if (!reuseRegistered) return
        try {
          reuseDisposer.current?.()
        } catch {
          /* ignore */
        }
        reuseDisposer.current = undefined
        reuseRegistered = false
        ctx.logger.info('[lantern] 已从 DSH 端口卸载 /v1/*（reuse 模式停用）')
      },
    })

    // 管理通道（/api/lantern）在**独立的 connection 注入作用域**内注册。
    //
    // ⚠ 两个必须遵守的点（均已实测）：
    // 1. **必须用 `connection.fetch.register`，不能用 `webServer.register`**：
    //    client 的 `ctx.connection.rpc.call` 走 DSH 的 RPC 信封协议
    //    （`{type:'client-request', rpcId, method, payload}`），只有 connection.fetch
    //    认领它；用 webServer 会表现为「面板点不动」。
    // 2. **必须在 `ctx.inject(['connection'], …)` 回调内取 connection**：
    //    直接 `ctx.get('connection')` 会抛
    //    `cannot get property "connection" without inject`（本机实测），
    //    进而中断后面的注册逻辑（曾导致自检端点也一起 404）。
    ctx.inject(['connection'], (cctx) => {
      try {
        const connection = cctx.get('connection')
        if (connection === undefined) {
          ctx.logger.warn('[lantern] connection 为 undefined')
          ctx.logger.warn('[lantern] connection 服务不可用，设置面板将无法读写')
          return
        }
        const managed = installManagementRpc(ctx, { ...rpcDeps, connection }, 'lantern')
        if (managed.installed) {
          ctx.logger.info('[lantern] 已注册管理通道 /api/lantern')
          ctx.logger.info('[lantern] 已注册管理通道 /api/lantern')
          cctx.effect(() => managed.dispose)
        } else {
          ctx.logger.warn('[lantern] connection.fetch 不可用，管理通道未安装')
        }
      } catch (error) {
        // 管理通道失败**不得**阻断自检端点注册（否则 health 会 404，
        // 让"插件是否加载"变得不可判断）。
        ctx.logger.warn(`[lantern] 管理通道注册失败：${error?.message}`)
        ctx.logger.warn(`[lantern] 管理通道注册失败：${error?.message}`)
      }
    })

    // 卸载时撤销 reuse 路由。
    sctx.effect(() => () => {
      try {
        reuseDisposer.current?.()
      } catch {
        /* ignore */
      }
      reuseDisposer.current = undefined
      reuseRegistered = false
    })

    // 自检端点：**独立注册、始终可用**（不依赖 enabled，也不依赖 reuse 条目是否启用）。
    // 理由（设计方案 §6.5.4）：health 的作用是"让管理员确认插件已加载"，
    // 若它也随 enabled 消失，就失去了自检的意义（本机实测踩到过：未启用时 404，
    // 被误判成"插件加载失败"）。
    const healthRoute = {
      kind: 'exact',
      path: '/v1/lantern/health',
      handler: (req, res) => {
        try {
          sendJson(res, 200, {
            ok: true,
            plugin: name,
            enabled: current.enabled,
            listen: listenManager.status(),
            auth: {
              keyCount: keyStore.records.length,
              usable: keyStore.records.filter((r) => r.enabled !== false).length,
              allowAnonymous: current.auth?.allowAnonymous === true,
              format: current.auth?.format ?? 'sk',
            },
            inflight: currentGate().inflight,
            // P12：熔断与并发/保留槽状态。
            // ⚠ 这里是 **exact 路由**，按 DSH 的路由规则（exact 优先于最长前缀）
            // 它是实际生效的那一个——所以字段必须加在这里，否则 /v1 前缀里那份是死代码。
            breaker: breaker.status(),
            concurrency: currentGate().status(),
            directory: directory.diagnostics(),
          })
        } catch (error) {
          ctx.logger.error('[lantern] health 处理异常')
          ctx.logger.error(error)
          sendJson(res, 500, errorBody('health 失败', 'internal_error', 'lantern_internal'))
        }
      },
    }
    sctx.effect(() => webServer.register(healthRoute))
    ctx.logger.info('[lantern] 已注册自检端点 /v1/lantern/health')
    ctx.logger.info(`[lantern] 已注册自检端点 ${healthRoute.path}（始终可用）`)

    // 按当前配置开始监听（reuse 立即挂载；standalone 依次尝试开启）。
    //
    // ⚠ **必须先 `await configReady`**：本回调是同步触发的，而配置是异步读入的。
    // 不等它就会用"apply 初值"去决定监听模式 —— 磁盘配置被忽略（实测：
    // 改成 standalone 某端口，却始终按 reuse 的 DSH 端口启动，新端口从未监听）。
    void (async () => {
      await configReady
      const normalized = normalizeEntries(current.listenEntries, webServer.port, detectActualBind())
      if (normalized.ok) {
        const applied = await listenManager.apply(normalized.entries)
        if (!applied.ok) ctx.logger.warn(`[lantern] 监听初始化未完全成功：${applied.message}`)
        else {
          const modes = normalized.entries
            .filter((e) => e.enabled !== false)
            .map((e) => (e.mode === 'reuse' ? `reuse:${webServer.port}` : `standalone:${e.port}/${e.bind}`))
            .join('、')
          ctx.logger.info(`[lantern] 监听已按磁盘配置启动：${modes}`)
        }
      } else {
        ctx.logger.warn(`[lantern] 监听配置无效：${normalized.message}`)
      }
    })()
  })
}

export { ModelDirectory, parsePublicName, publicNameOf }

/**
 * 档 C：从上游失败中学习"不支持某能力"。
 *
 * 只在错误**明确指向某能力**时记录（`detectNegativeCapability` 判断），
 * 避免把网络错误/限流误判成"不支持"。记录后 `/v1/models` 会立刻改口。
 *
 * @param deps - 转发依赖（需要 capabilities）。
 * @param target - 目标模型条目。
 * @param failure - DSH 的 LlmFailure。
 */
async function learnFromFailure(deps, target, failure) {
  if (deps.capabilities === undefined) return
  const message = String(failure?.message ?? '')
  const field = detectNegativeCapability(message)
  if (field === undefined) return
  try {
    const learned = await deps.capabilities.learnNegative(target.provider, target.model, field, maskSecrets(message))
    if (learned) {
      deps.log?.(
        'info',
        `[lantern] 负能力学习：${target.publicName} 的 ${field} 记为不支持（上游报错原文已脱敏记录）`,
      )
    }
  } catch (error) {
    deps.log?.('error', `[lantern] 负能力学习写入失败：${error?.message}`)
  }
}

/**
 * 记一次调用到用量账本（P9）。
 *
 * 只在 `usage.enabled` 打开时写；任何异常都**不能影响转发**（记账失败只是少一条统计）。
 * `auth` 提供 key 标识（用于按 Key 区分用量）。
 *
 * @param deps - 转发依赖。
 * @param target - 目标模型条目。
 * @param options - `{ usage, status, ms, protocol, kind, errorCode, auth }`。
 */
async function recordCall(deps, target, options = {}) {
  // 熔断与 token 计量（P12）：放在**唯一的收口处**，两条协议与所有路径都覆盖。
  // 注意这里先于 `usage.enabled` 判断——即使账本关闭，保护本机的熔断也要工作。
  try {
    const keyId = (options.key ?? deps.record)?.id ?? '__anonymous__'
    if (options.status === 'ok') {
      deps.breaker?.recordSuccess(keyId, options.usage?.outputTokens ?? 0)
    } else {
      deps.breaker?.recordFailure({
        code: options.errorCode,
        status: options.errorStatus,
        message: options.errorMessage,
      })
    }
  } catch (error) {
    deps.log?.('error', `[lantern][breaker] 状态记录失败（不影响转发）：${error?.message}`)
  }

  try {
    const cfg = deps.current()
    if (cfg?.usage?.enabled === false) return
    // key 记录由鉴权闸门给出（deps.record），匿名访问时为 undefined。
    // 注意：指纹不是 record 的字段，要用 fingerprintOf() 由 head/tail 算出。
    const key = options.key ?? deps.record
    await recordUsage({
      ts: Date.now(),
      provider: target.provider,
      model: target.model,
      publicName: target.publicName,
      keyId: key?.id ?? 'anonymous',
      keyLabel: key?.label ?? null,
      keyPrint: key === undefined ? null : fingerprintOf(key),
      kind: options.kind ?? 'inference',
      status: options.status ?? 'ok',
      ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
      protocol: options.protocol ?? 'openai',
      ms: options.ms,
      ...(options.imageCount === undefined ? {} : { imageCount: options.imageCount }),
      usage: toLedgerUsage(options.usage),
    })
  } catch (error) {
    deps.log?.('error', `[lantern][usage] 记账失败（不影响转发）：${error?.message}`)
  }
}

/**
 * 共用能力闸门（P4 策略，**两条协议必须走同一份**）。
 *
 * 之所以抽出来：OpenAI 与 Anthropic 两条通道若各写一份闸门，
 * 迟早分叉成"一条严、一条松"——那正是设计文档 §6.5 最反对的静默降级。
 *
 * @param deps - 转发依赖（需要 capabilities）。
 * @param target - 目标模型条目。
 * @param request - `{ hasTools, hasImage, hasJsonMode, hasReasoningEffort, hasTemperature, hasStop }`。
 * @returns `{ reject, ignored, headers, capsView }`（查询失败时全放行并记日志）。
 */
async function enforceCapabilityGate(deps, target, request) {
  let capsView
  let enforceResult = { ignored: [], headers: {} }
  if (deps.capabilities === undefined) return { enforceResult, capsView }
  try {
    capsView = await deps.capabilities.describe(target.provider, target.model)
    enforceResult = deps.capabilities.enforce(capsView, request)
  } catch (error) {
    deps.log?.('error', `[lantern] 能力查询失败，跳过能力闸门：${error?.message}`)
  }
  return { enforceResult, capsView }
}

/**
 * 网关级图片开关（与"模型是否支持图片"是两件事，文案必须区分——§6.5.1 铁律 3）。
 *
 * 判据用 `parsed.images.length`（协议无关），不依赖某一种 content 形状。
 *
 * @param cfg - 当前配置。
 * @param wantsImage - 本次请求是否包含图片。
 * @returns 错误说明，或 undefined（放行）。
 */
function imageGateMessage(cfg, wantsImage) {
  if (!wantsImage || cfg.allowImageInput === true) return undefined
  return (
    '网关未开启图片输入（allowImageInput=false）。' +
    '这与"该模型不支持图片"是两件事——如需使用图片，请在 设置 → LANtern → 状态与安全 中开启。'
  )
}

/**
 * 处理 `POST /v1/chat/completions`。
 *
 * 关键纪律（设计文档 §6.1、§7.3）：
 * - **客户端断连必须 abort** 上游调用，否则泄漏并白烧额度；
 * - 只做一次独立的 `ctx.llm.stream()`，**不建会话、不进 agent loop**；
 * - 上游错误**脱敏后**原样呈现，不美化、不吞错。
 *
 * @param sctx - 已注入 webServer 的作用域上下文。
 * @param req - Node 请求。
 * @param res - Node 响应。
 * @param deps - 依赖集合（目录、key 仓库、闸门、配置读取器）。
 */
async function handleChatCompletions(sctx, req, res, deps) {
  const cfg = deps.current()
  const limits = cfg.limits ?? {}

  // --- 限流：每 Key 每分钟请求数（专属限额可覆盖全局） ---
  const perKeyRpm = deps.record?.limits?.perKeyRpm ?? limits.perKeyRpm ?? 30
  const keyId = deps.record?.id ?? '__anonymous__'
  if (!deps.allowRate(keyId, perKeyRpm)) {
    res.setHeader('Retry-After', '60')
    sendJson(res, 429, errorBody(
      `超出速率上限（每 Key 每分钟 ${perKeyRpm} 次请求）`,
      'rate_limit_error',
      'rate_limit_exceeded',
    ))
    return
  }

  // --- 读体（有上限） ---
  const maxBodyBytes = limits.maxBodyBytes ?? 4 * 1024 * 1024
  const read = await readBody(req, maxBodyBytes)
  if (!read.ok) {
    if (read.reason === 'too_large') {
      sendJson(res, 413, errorBody(
        `请求体超过上限（${Math.round(maxBodyBytes / 1024 / 1024)} MB）。` +
          '带图的长会话因每次重发全部历史图片而容易超限，建议开新会话继续。',
        'invalid_request_error',
        'payload_too_large',
      ))
      return
    }
    sendJson(res, 400, errorBody('请求体不是合法 JSON 对象', 'invalid_request_error', 'bad_request'))
    return
  }
  const body = read.body

  // --- 解析模型 ---
  const target = resolveModel(deps.directory, body.model)
  if (target.error !== undefined || target.provider === undefined) {
    sendJson(res, 404, errorBody(
      `模型未找到：${String(body.model ?? '(空)')}`,
      'invalid_request_error',
      'model_not_found',
      {
        hint: '公开名格式为 <model>@<provider>；不带 @ 后缀一律不解析（§5）',
        available: deps.directory.list().map((e) => e.publicName).slice(0, 50),
      },
    ))
    return
  }
  // 硬校验：provider 仍注册着（"删除 Provider 后不能再使用"的保证）
  if (!deps.directory.isProviderLive(target.provider)) {
    sendJson(res, 404, errorBody(
      `provider「${target.provider}」当前未注册（可能已被移除）`,
      'invalid_request_error',
      'model_not_found',
      { available: deps.directory.list().map((e) => e.publicName).slice(0, 50) },
    ))
    return
  }

  // --- 能力闸门（§6.5.5：硬能力拒绝、软参数标注）---
  // 铁律 3：绝不静默忽略参数然后返回一个看起来正常的回答。
  // 与 Anthropic 通道**共用同一份实现**，避免两条协议分叉（这是刻意的）。
  const wantsImage = Array.isArray(body.messages)
    ? body.messages.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'image_url'))
    : false
  const { enforceResult } = await enforceCapabilityGate(deps, target, {
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    hasImage: wantsImage,
    hasJsonMode: body.response_format !== undefined,
    hasReasoningEffort: body.reasoning_effort !== undefined,
    hasTemperature: body.temperature !== undefined,
    hasStop: body.stop !== undefined,
  })

  // 网关级图片开关（与"模型是否支持图片"是两件事，错误文案必须区分开）
  const imageGate = imageGateMessage(deps.current(), wantsImage)
  if (imageGate !== undefined) {
    sendJson(res, 400, errorBody(imageGate, 'invalid_request_error', 'image_not_allowed'))
    return
  }

  if (enforceResult.reject !== undefined) {
    const r = enforceResult.reject
    sendJson(res, 400, errorBody(r.message, 'invalid_request_error', 'capability_unsupported', {
      capability: r.capability,
      capability_value: r.value,
      capability_source: r.source,
      all_unsupported: r.all,
    }))
    return
  }

  // --- 熔断闸门（P12）：上游连续限流时暂停 LAN 通道，保护本机 ---
  // 放在并发闸门**之前**：冷却期内连槽都不该占，更不能打向上游。
  const admit = deps.breaker?.admit(deps.record?.id ?? '__anonymous__') ?? { ok: true }
  if (!admit.ok) {
    res.setHeader('Retry-After', String(admit.retryAfterSec ?? 60))
    // 状态码要**匹配语义**，否则客户端会误判：
    //   token 超限 = 限流 → 429（客户端据此退避重试）
    //   熔断中    = 服务暂不可用 → 503
    const status = admit.code === 'circuit_open' ? 503 : 429
    sendJson(res, status, errorBody(admit.message, 'rate_limit_error', admit.code))
    return
  }

  // --- 并发闸门（§7.3：不与本机抢并发） ---
  if (!deps.acquireSlot()) {
    res.setHeader('Retry-After', '5')
    sendJson(res, 429, errorBody(
      `网关并发已满（上限 ${limits.maxConcurrent ?? 2}），请稍后重试`,
      'rate_limit_error',
      'concurrency_limit_exceeded',
    ))
    return
  }

  const abort = new AbortController()
  let finished = false
  /** 请求开始时间（记账算耗时）。 */
  const callStarted = Date.now()
  /** 本次请求写入的图片引用（供 finally 释放引用计数，P8）。 */
  let builtRefs = []
  const onClose = () => {
    if (!finished) abort.abort()
  }
  req.on('close', onClose)

  try {
    // --- 构造消息（图片需要 attachments 服务） ---
    const parsed = parseChatRequest(body)
    const attachments = sctx.get('attachments')
    let built
    try {
      built = await buildMessages(parsed, attachments, {
        allowImage: cfg.allowImageInput === true,
        // P8：图片经附件账本写入（区分新建/复用，只回收自己新建的）
        ledger: deps.ledger,
      })
    } catch (error) {
      const code = error?.lanternCode ?? 'invalid_request'
      const status = code === 'image_not_allowed' || code === 'attachments_unavailable' ? 400 : 400
      sendJson(res, status, errorBody(maskSecrets(error?.message ?? '请求无法处理'), 'invalid_request_error', code))
      return
    }
    builtRefs = built.imageRefs ?? []

    const maxTokensCap = limits.maxTokensCap ?? 8192
    const requestedMax = typeof body.max_tokens === 'number' ? body.max_tokens : undefined
    const maxTokens = requestedMax === undefined ? undefined : Math.min(requestedMax, maxTokensCap)

    /** @type {import('@deepseek-ai/dsh-llm').GenerateOptions} */
    const options = {
      provider: target.provider,
      model: target.model,
      messages: built.messages,
      ...(built.tools === undefined && parsed.toolSchemas === undefined
        ? {}
        : { tools: parsed.toolSchemas }),
      // 被判定为"不支持/未知"的软参数：**不传**（并在上面的响应头里标注已忽略）
      ...(typeof body.temperature === 'number' && !enforceResult.ignored.includes('temperature')
        ? { temperature: body.temperature }
        : {}),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(Array.isArray(body.stop) && !enforceResult.ignored.includes('stop') ? { stop: body.stop } : {}),
      signal: abort.signal,
    }

    const completionId = newCompletionId()
    const isStream = body.stream === true

    // 软参数被忽略时**必须显式标注**（§6.5.5：降级永远可见，不可静默）
    for (const [name, valueOf] of Object.entries(enforceResult.headers ?? {})) {
      res.setHeader(name, valueOf)
    }

    if (isStream) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders?.()
      // 心跳：防中间设备掐连接
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n')
      }, 15_000)
      heartbeat.unref?.()

      const translator = new OpenAiStreamTranslator({
        id: completionId,
        model: target.publicName,
      })
      let streamFailure
      // 记账要的是 **DSH 原口径**（inputTokens/cacheReadTokens…），
      // 而 protocol 层保存的是已转换的 OpenAI 口径（prompt_tokens…），
      // 所以这里直接捕获原始 usage chunk，不依赖协议层内部字段。
      let rawUsage
      try {
        for await (const chunk of sctx.llm.stream(options)) {
          if (abort.signal.aborted) break
          if (chunk.type === 'usage') rawUsage = chunk.usage
          for (const frame of translator.push(chunk)) res.write(frame)
        }
      } catch (error) {
        deps.log?.('error', `[lantern] 流式转发异常：${error?.message}`)
        streamFailure = { message: error?.message, code: error?.code }
      } finally {
        clearInterval(heartbeat)
        if (streamFailure === undefined && translator.error !== undefined) {
          streamFailure = translator.error.error ?? {}
        }
        // 兜住"错误不是以 finish chunk 形式到达"的情形（如 for await 抛出）：
        // 必须显式标记，否则 end() 会走正常收尾，客户端只看到
        // "200 + finish_reason:stop + 空内容"，即把上游故障伪装成正常空回答。
        if (streamFailure !== undefined && translator.error === undefined) {
          translator.markFailed(streamFailure)
        }
        for (const frame of translator.end()) res.write(frame)
        if (!res.writableEnded) res.end()
      }
      // 流式路径的失败同样参与负能力学习（流已开始，无法再改状态码）
      if (streamFailure !== undefined) await learnFromFailure(deps, target, streamFailure)
      await recordCall(deps, target, {
        usage: rawUsage,
        status: streamFailure === undefined ? 'ok' : 'error',
        ...(streamFailure === undefined ? {} : { errorCode: streamFailure.code ?? 'upstream_error' }),
        ms: Date.now() - callStarted,
        protocol: 'openai',
        imageCount: builtRefs.length,
      })
      return
    }

    // 非流式
    const aggregator = new OpenAiAggregator({ id: completionId, model: target.publicName })
    let aggUsage
    try {
      for await (const chunk of sctx.llm.stream(options)) {
        if (abort.signal.aborted) break
        if (chunk.type === 'usage') aggUsage = chunk.usage
        aggregator.push(chunk)
      }
    } catch (error) {
      await recordCall(deps, target, {
        usage: aggUsage,
        status: 'error',
        ms: Date.now() - callStarted,
        protocol: 'openai',
        errorCode: 'transport',
      })
      sendJson(res, 502, errorBody(maskSecrets(error?.message ?? '上游调用失败'), 'upstream_error', 'upstream_error'))
      return
    }
    if (aggregator.failure !== undefined) {
      // 档 C：负能力学习 —— 上游明确报"不支持某能力"时记录，之后 /v1/models 会改口
      await learnFromFailure(deps, target, aggregator.failure)
      await recordCall(deps, target, {
        usage: aggUsage,
        status: 'error',
        ms: Date.now() - callStarted,
        protocol: 'openai',
        errorCode: aggregator.failure.code ?? 'upstream_error',
      })
      sendJson(res, 502, errorBody(
        maskSecrets(aggregator.failure.message),
        'upstream_error',
        aggregator.failure.code ?? 'upstream_error',
        {
          ...(aggregator.failure.status === undefined ? {} : { status: aggregator.failure.status }),
          ...(aggregator.failure.requestId === undefined ? {} : { request_id: aggregator.failure.requestId }),
        },
      ))
      return
    }
    sendJson(res, 200, aggregator.end())
    await recordCall(deps, target, {
      usage: aggUsage,
      status: 'ok',
      ms: Date.now() - callStarted,
      protocol: 'openai',
      imageCount: builtRefs.length,
    })
  } finally {
    finished = true
    req.off?.('close', onClose)
    deps.releaseSlot()
    // P8：请求结束 → 引用计数递减；归零后由账本按延迟窗口回收。
    if (deps.ledger !== undefined && builtRefs.length > 0) {
      await deps.ledger.release(builtRefs).catch((error) => {
        deps.log?.('error', `[lantern][attachment] release 失败：${error?.message}`)
      })
    }
  }
}

/**
 * 处理 `POST /v1/messages`（Anthropic 兼容，P11 / §6.2）。
 *
 * 与 OpenAI 通道**共用**：限流、读体、模型解析、能力闸门、图片闸门、
 * 并发闸门、附件账本、用量记账、负能力学习。
 * 本函数只负责协议差异：请求解析、响应翻译、错误体形状。
 *
 * 错误体形状必须**符合 Anthropic 规范**（`{type:'error', error:{type,message}}`），
 * 否则官方 SDK 无法解析错误、只会抛一个笼统的异常。
 *
 * @param sctx - 已注入 webServer 的作用域上下文。
 * @param req - Node 请求。
 * @param res - Node 响应。
 * @param deps - 依赖集合。
 */
async function handleAnthropicMessages(sctx, req, res, deps) {
  const cfg = deps.current()
  const limits = cfg.limits ?? {}

  /** Anthropic 形状的错误响应。 */
  const fail = (status, message, type = 'invalid_request_error') => {
    sendJson(res, status, anthropicError(maskSecrets(message), type))
  }

  // --- 限流（与 OpenAI 通道同一套计数） ---
  const perKeyRpm = deps.record?.limits?.perKeyRpm ?? limits.perKeyRpm ?? 30
  const keyId = deps.record?.id ?? '__anonymous__'
  if (!deps.allowRate(keyId, perKeyRpm)) {
    res.setHeader('Retry-After', '60')
    fail(429, `超出速率上限（每 Key 每分钟 ${perKeyRpm} 次请求）`, 'rate_limit_error')
    return
  }

  // --- 读体 ---
  const maxBodyBytes = limits.maxBodyBytes ?? 4 * 1024 * 1024
  const read = await readBody(req, maxBodyBytes)
  if (!read.ok) {
    if (read.reason === 'too_large') {
      fail(413, `请求体超过上限（${Math.round(maxBodyBytes / 1024 / 1024)} MB）。带图的长会话易超限，建议开新会话。`)
      return
    }
    fail(400, '请求体不是合法 JSON 对象')
    return
  }
  const body = read.body

  const invalid = validateAnthropicRequest(body)
  if (invalid !== undefined) {
    fail(400, invalid)
    return
  }

  // --- 解析模型（全名制，与 OpenAI 通道同语义） ---
  const target = resolveModel(deps.directory, body.model)
  if (target.error !== undefined || target.provider === undefined) {
    fail(404, `模型未找到：${String(body.model ?? '(空)')}。公开名格式为 <model>@<provider>。`)
    return
  }
  if (!deps.directory.isProviderLive(target.provider)) {
    fail(404, `provider「${target.provider}」当前未注册（可能已被移除）`)
    return
  }

  // --- 解析请求（Anthropic 形状 → 内部同构产物） ---
  const parsed = parseAnthropicRequest(body)
  const wantsImage = parsed.images.length > 0

  // --- 能力闸门（与 OpenAI 通道同一份实现） ---
  const { enforceResult, capsView } = await enforceCapabilityGate(deps, target, {
    hasTools: Array.isArray(parsed.toolSchemas) && parsed.toolSchemas.length > 0,
    hasImage: wantsImage,
    // Anthropic 没有 response_format；但其 tools 是硬能力，已在上一行覆盖。
    hasJsonMode: false,
    hasReasoningEffort: body.thinking !== undefined,
    hasTemperature: body.temperature !== undefined,
    hasStop: Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0,
  })

  const imageGate = imageGateMessage(cfg, wantsImage)
  if (imageGate !== undefined) {
    fail(400, imageGate)
    return
  }
  if (enforceResult.reject !== undefined) {
    const r = enforceResult.reject
    // Anthropic 客户端看 message；细节放 error.details，便于排障又不破坏规范
    sendJson(res, 400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: r.message,
        details: {
          capability: r.capability,
          capability_value: r.value,
          capability_source: r.source,
          all_unsupported: r.all,
        },
      },
    })
    return
  }

  // --- 熔断闸门（P12）：与 OpenAI 通道同一份实现，避免两条通道保护强度不一致 ---
  const admit = deps.breaker?.admit(deps.record?.id ?? '__anonymous__') ?? { ok: true }
  if (!admit.ok) {
    res.setHeader('Retry-After', String(admit.retryAfterSec ?? 60))
    // 与 OpenAI 通道同一判据：token 超限 → 429；熔断中 → 503
    const status = admit.code === 'circuit_open' ? 503 : 429
    fail(status, admit.message, admit.code === 'circuit_open' ? 'overloaded_error' : 'rate_limit_error')
    return
  }

  // --- 并发闸门 ---
  if (!deps.acquireSlot()) {
    res.setHeader('Retry-After', '5')
    fail(429, `网关并发已满（上限 ${limits.maxConcurrent ?? 2}），请稍后重试`, 'rate_limit_error')
    return
  }

  const abort = new AbortController()
  let finished = false
  const callStarted = Date.now()
  let builtRefs = []
  const onClose = () => {
    if (!finished) abort.abort()
  }
  req.on('close', onClose)

  try {
    // --- 构造消息（图片走附件账本，P8） ---
    const attachments = sctx.get('attachments')
    let built
    try {
      built = await buildMessages(parsed, attachments, {
        allowImage: cfg.allowImageInput === true,
        ledger: deps.ledger,
      })
    } catch (error) {
      const code = error?.lanternCode ?? 'invalid_request'
      fail(400, error?.message ?? '请求无法处理')
      deps.log?.('error', `[lantern][anthropic] 构造消息失败（${code}）：${error?.message}`)
      return
    }
    builtRefs = built.imageRefs ?? []

    // --- max_tokens：Anthropic 协议必填，但**绝不自定义数值**（用户定案） ---
    // 角色划分：
    //   · 客户端给的 → 不可信，按网关上限封顶（只封顶不放大）；
    //   · provider 声明的 defaultMaxTokens（adapter 配置）→ **可信，原样使用**；
    //   · 都没有 → **不传**，交由 DSH/adapter 自行决定
    //     （DSH 的 resolveCallWithInfo() 本就支持"调用方省略 maxTokens"）。
    const providerDefault = capsView?.maxOutputTokens?.value
    const resolvedMax = resolveAnthropicMaxTokens(
      body.max_tokens,
      typeof providerDefault === 'number' ? providerDefault : undefined,
      limits.maxTokensCap,
    )

    /** @type {import('@deepseek-ai/dsh-llm').GenerateOptions} */
    const options = {
      provider: target.provider,
      model: target.model,
      messages: built.messages,
      ...(built.tools === undefined && parsed.toolSchemas === undefined
        ? {}
        : { tools: parsed.toolSchemas }),
      ...(typeof body.temperature === 'number' && !enforceResult.ignored.includes('temperature')
        ? { temperature: body.temperature }
        : {}),
      // **只在解析出值时传**（unset 时交给 DSH 自己决定，不替 provider 拍板）
      ...(resolvedMax.value === undefined ? {} : { maxTokens: resolvedMax.value }),
      ...(Array.isArray(body.stop_sequences) && !enforceResult.ignored.includes('stop')
        ? { stop: body.stop_sequences }
        : {}),
      signal: abort.signal,
    }

    const messageId = newMessageId()

    // 软参数被忽略时必须显式标注（§6.5.5）
    for (const [name, valueOf] of Object.entries(enforceResult.headers ?? {})) {
      res.setHeader(name, valueOf)
    }
    // 如实告知本次 max_tokens 的处理方式（不做暗箱）：
    //   client   —— 用了客户端给的值（可能被网关封顶）
    //   provider —— 用了 provider 声明的默认值（原样，未封顶）
    //   unset    —— 两者都没有，交由 DSH/adapter 自行决定
    res.setHeader('X-Lantern-Max-Tokens-Source', resolvedMax.source)
    if (resolvedMax.value !== undefined) {
      res.setHeader('X-Lantern-Max-Tokens', String(resolvedMax.value))
    }

    if (body.stream === true) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
      res.flushHeaders?.()
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n')
      }, 15_000)
      heartbeat.unref?.()

      const translator = new AnthropicStreamTranslator({ id: messageId, model: target.publicName })
      let streamFailure
      let rawUsage
      try {
        for await (const chunk of sctx.llm.stream(options)) {
          if (abort.signal.aborted) break
          if (chunk.type === 'usage') rawUsage = chunk.usage
          for (const frame of translator.push(chunk)) res.write(frame)
        }
      } catch (error) {
        deps.log?.('error', `[lantern][anthropic] 流式转发异常：${error?.message}`)
        streamFailure = { message: error?.message, code: error?.code }
      } finally {
        clearInterval(heartbeat)
        if (streamFailure === undefined && translator.failure !== undefined) {
          streamFailure = translator.failure
        }
        // 兜住"错误不是以 finish chunk 形式到达"的情形（如 for await 抛出）：
        // 必须显式标记，否则 end() 会走正常收尾，客户端只看到
        // "200 + stop_reason:end_turn + 空内容"，即把上游故障伪装成正常空回答。
        if (streamFailure !== undefined && translator.errorEvent === undefined) {
          translator.markFailed(streamFailure)
        }
        for (const frame of translator.end()) res.write(frame)
        if (!res.writableEnded) res.end()
      }
      if (streamFailure !== undefined) await learnFromFailure(deps, target, streamFailure)
      await recordCall(deps, target, {
        usage: rawUsage,
        status: streamFailure === undefined ? 'ok' : 'error',
        ...(streamFailure === undefined ? {} : { errorCode: streamFailure.code ?? 'upstream_error' }),
        ms: Date.now() - callStarted,
        protocol: 'anthropic',
        imageCount: builtRefs.length,
      })
      return
    }

    // --- 非流式 ---
    const aggregator = new AnthropicAggregator({ id: messageId, model: target.publicName })
    let aggUsage
    try {
      for await (const chunk of sctx.llm.stream(options)) {
        if (abort.signal.aborted) break
        if (chunk.type === 'usage') aggUsage = chunk.usage
        aggregator.push(chunk)
      }
    } catch (error) {
      await recordCall(deps, target, {
        usage: aggUsage,
        status: 'error',
        ms: Date.now() - callStarted,
        protocol: 'anthropic',
        errorCode: 'transport',
      })
      fail(502, error?.message ?? '上游调用失败', 'api_error')
      return
    }
    if (aggregator.failure !== undefined) {
      await learnFromFailure(deps, target, aggregator.failure)
      await recordCall(deps, target, {
        usage: aggUsage,
        status: 'error',
        ms: Date.now() - callStarted,
        protocol: 'anthropic',
        errorCode: aggregator.failure.code ?? 'upstream_error',
      })
      fail(502, aggregator.failure.message ?? '上游调用失败', 'api_error')
      return
    }
    sendJson(res, 200, aggregator.end())
    await recordCall(deps, target, {
      usage: aggUsage,
      status: 'ok',
      ms: Date.now() - callStarted,
      protocol: 'anthropic',
      imageCount: builtRefs.length,
    })
  } finally {
    finished = true
    req.off?.('close', onClose)
    deps.releaseSlot()
    if (deps.ledger !== undefined && builtRefs.length > 0) {
      await deps.ledger.release(builtRefs).catch((error) => {
        deps.log?.('error', `[lantern][attachment] release 失败：${error?.message}`)
      })
    }
  }
}
