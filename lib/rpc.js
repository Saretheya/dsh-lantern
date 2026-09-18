/**
 * dsh-lantern — 管理 RPC 层（Host 半部内部模块）。
 *
 * 两条通道**彻底隔离**（设计方案 §11.5.4）：
 *   `/api/lantern`  ← 本机浏览器会话的管理通道（本文件）
 *   `/v1/*`         ← 局域网推理通道（index.js 路由）
 * 管理通道经 DSH 自身 `connection` 闸门（或本机最小围墙），
 * **局域网客户端无法访问**（也拿不到 key、改不了配置）。
 *
 * 方法集见设计方案 §11.5.6.5。全部写入落在插件自己的 `data/`。
 *
 * @module dsh-lantern/rpc
 */
import { fingerprintOf } from './auth.js'
import { writeJson, PATHS } from './storage.js'
import { LABELS as LABELS_OF_CAPABILITY } from './capabilities.js'
import { aggregate, writeReport } from './usage.js'
import { spawn } from 'node:child_process'

/**
 * 把 keyId 映射为 `{ label, fingerprint }`（用量报告与 UI 都要显示"名称 + 指纹"）。
 * 已删除的 Key 会退化成"已删除的 Key（历史用量）"，不让历史数据失去归属。
 *
 * @param deps - RPC 依赖集合。
 * @returns `Map<keyId, { label, fingerprint }>`。
 */
function keyLabelMap(deps) {
  /** @type {Map<string, {label:string, fingerprint:string}>} */
  const map = new Map()
  try {
    for (const k of deps.keyStore.list()) {
      map.set(k.id, { label: k.label ?? '(未命名)', fingerprint: k.fingerprint ?? '' })
    }
  } catch {
    /* keyStore 异常不应影响用量查询 */
  }
  return map
}

/**
 * 取某个 keyId 的显示名与指纹。
 * @param id - 账本里的 keyId。
 * @param map - `keyLabelMap()` 的结果。
 * @returns `{ label, fingerprint, deleted? }`。
 *
 * ⚠ `deleted` **必须是独立字段**，不能把"已删除"写进 `label`：
 * UI 要据此把整行置灰、并在名称旁放一个 ⓘ 图标（悬停才显示注释）。
 * 若把说明写进 label，那一长串文字会把用量表挤得很难看（用户实测发现）。
 */
function keyNameOf(id, map) {
  const hit = map.get(id)
  if (hit !== undefined) return hit
  if (id === 'anonymous') return { label: '（匿名访问）', fingerprint: '' }
  if (id === 'unknown') return { label: '（未知来源）', fingerprint: '' }
  // 已删除的 Key：名称保持简短，删除状态用 `deleted` 标记（UI 渲染为灰行 + ⓘ）
  return { label: id, fingerprint: '', deleted: true }
}

/**
 * 能力测试的**进行中状态**（进程内存，不落盘）。
 *
 * 为什么需要它：管理 RPC 是"一次请求 → 一次响应"，**无法在响应中途推送进度**；
 * 而能力测试要逐项真实调用模型，可能持续几十秒（图片项最长 30s）。
 * 因此把进度记在这里，由客户端**轮询 `model/testProgress`** 取回，
 * 这样用户能看到"正在测第几项"，而不是干等。
 *
 * 同一时刻只允许一个测试在跑（`running` 为 true 时拒绝新请求），
 * 所以单份状态就够，不需要按 provider/model 建表。
 *
 * @type {{ running: boolean, provider: string, model: string, items: string[], done: string[], total: number, startedAt: number, current: string|null, finishedAt: number|null }}
 */
const testProgress = {
  running: false,
  provider: '',
  model: '',
  /** 本次要测的全部项（用于显示总数）。 */
  items: [],
  /** 已完成的项 id（按完成顺序）。 */
  done: [],
  total: 0,
  startedAt: 0,
  /** 正在进行的项 id（回调触发前的"当前项"）。 */
  current: null,
  finishedAt: null,
}

/**
 * 取当前测试进度快照（供客户端轮询）。
 * @returns 可安全序列化的进度对象。
 */
export function currentTestProgress() {
  return {
    running: testProgress.running,
    provider: testProgress.provider,
    model: testProgress.model,
    total: testProgress.total,
    doneCount: testProgress.done.length,
    done: [...testProgress.done],
    current: testProgress.current,
    elapsedMs: testProgress.startedAt > 0 ? Date.now() - testProgress.startedAt : 0,
    finishedAt: testProgress.finishedAt,
  }
}

/**
 * 用系统默认程序打开一个本地文件（用量报告）。
 *
 * 只在**本机管理通道**被调用（局域网客户端够不到 `/api/lantern`），
 * 且路径由插件自己生成，不接受外部传入——避免变成任意程序执行入口。
 *
 * @param filePath - 报告绝对路径。
 * @returns `{ ok, reason? }`。
 */
function openInBrowser(filePath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, reason: `当前平台（${process.platform}）不支持自动打开` })
      return
    }
    try {
      // cmd /c start "" "<file>" —— 空标题参数是必须的，否则含空格的路径会被当成标题
      const child = spawn('cmd.exe', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', (error) => resolve({ ok: false, reason: error?.message ?? '启动失败' }))
      child.on('spawn', () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch (error) {
      resolve({ ok: false, reason: error?.message ?? '启动失败' })
    }
  })
}

/** RPC 端点路径（client 半部按同路径读写）。 */
export const RPC_PATH = '/api/lantern'

/** 请求体上限（管理请求都很小）。 */
const MAX_BODY = 256 * 1024

/**
 * 本机信任围墙：只接受回环地址、且非跨站的请求。
 * 与 harness 自带闸门同一判据（有 `connection` 服务时优先用它）。
 * @param headers - Node 请求头（小写键）。
 * @returns 拒绝时的 HTTP 状态码；放行时 undefined。
 */
export function localOnlyRejection(headers) {
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
 * 读 JSON 请求体。
 * @param req - Node 请求。
 * @returns 解析后的对象（失败返回 `{}`）。
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  await new Promise((resolve) => {
    req.on('data', (chunk) => {
      size += chunk?.length ?? 0
      if (size <= MAX_BODY && chunk !== undefined) chunks.push(chunk)
    })
    req.on('end', resolve)
    req.on('error', resolve)
  })
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 发一个 JSON 响应。
 * @param res - Node 响应。
 * @param status - HTTP 状态码。
 * @param body - 响应体。
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * RPC 成功响应包装（client 半部按 `ok/value` 解包）。
 * @param value - 返回值。
 * @returns 包装对象。
 */
function okEnvelope(value) {
  return { ok: true, value }
}

/**
 * RPC 失败响应包装。
 *
 * ⚠ 纪律（本机踩过）：必须返回**规范的 RPC 错误响应**而不是裸 500 文本，
 * 否则 client 半部的 unwrapRpcResult 无法识别，界面表现为"点击无反应"。
 *
 * @param code - 机器码。
 * @param message - 人话消息。
 * @returns 包装对象。
 */
function errEnvelope(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * 探测端口是否可用（短暂 listen 后立即释放 —— 只读探测，不留占用）。
 * @param port - 待测端口。
 * @param bind - 绑定地址。
 * @returns `{ available, reason? }`。
 */
export async function probePort(port, bind = '127.0.0.1') {
  const { createServer } = await import('node:net')
  return new Promise((resolve) => {
    const server = createServer()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        server.close()
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    server.once('error', (error) => {
      const code = error?.code
      finish({
        available: false,
        reason:
          code === 'EADDRINUSE'
            ? '端口已被占用'
            : code === 'EACCES'
              ? '无权限绑定该端口'
              : `绑定失败：${code ?? error?.message ?? 'unknown'}`,
      })
    })
    server.once('listening', () => finish({ available: true }))
    try {
      server.listen({ port, host: bind === '0.0.0.0' ? undefined : bind })
    } catch (error) {
      finish({ available: false, reason: `绑定失败：${error?.message ?? 'unknown'}` })
    }
  })
}

/**
 * 构造管理方法分发器。
 * @param ctx - Host 插件上下文（用于 logger）。
 * @param deps - 依赖集合：配置读写、key 仓库、目录、性能测试等。
 * @returns `(method, payload) => Promise<envelope>`。
 */
export function buildDispatcher(ctx, deps) {
  /**
   * 处理一个 RPC 调用。
   * @param method - 方法名。
   * @param payload - 参数。
   * @returns 包装后的响应。
   */
  return async function dispatch(method, payload) {
    const cfg = deps.current()

    switch (method) {
      // ---------- 状态 ----------
      case 'status': {
        return okEnvelope({
          plugin: 'dsh-lantern',
          enabled: cfg.enabled === true,
          config: cfg,
          auth: {
            keyCount: deps.keyStore.records.length,
            usable: deps.keyStore.records.filter((r) => r.enabled !== false).length,
            allowAnonymous: cfg.auth?.allowAnonymous === true,
            format: cfg.auth?.format ?? 'sk',
          },
          listen: deps.listenStatus(),
          inflight: deps.inflight(),
          directory: deps.directory.diagnostics(),
        })
      }

      // ---------- 配置 ----------
      case 'config/get':
        return okEnvelope(cfg)

      case 'config/set': {
        const patch = payload?.config
        if (patch === null || typeof patch !== 'object') {
          return errEnvelope('bad_request', 'config 必须是一个对象')
        }
        await deps.patchConfig(patch)
        return okEnvelope({ config: deps.current() })
      }

      // ---------- 监听端口（P14：增删改） ----------
      case 'listen/list':
        return okEnvelope({ entries: deps.listenList(), active: deps.listenStatus() })

      case 'listen/probe': {
        const port = Number(payload?.port)
        const bind = typeof payload?.bind === 'string' ? payload.bind : '127.0.0.1'
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return errEnvelope('bad_request', 'port 必须是 1–65535 的整数')
        }
        return okEnvelope(await probePort(port, bind))
      }

      case 'listen/update': {
        const result = await deps.listenUpdate(payload ?? {})
        return result.ok ? okEnvelope(result.value) : errEnvelope(result.code, result.message)
      }

      // ---------- API Key（P15：增删改） ----------
      case 'keys/list':
        return okEnvelope({
          keys: deps.keyStore.list(),
          format: cfg.auth?.format ?? 'sk',
          allowAnonymous: cfg.auth?.allowAnonymous === true,
        })

      case 'keys/create': {
        const created = await deps.keyStore.create({
          label: typeof payload?.label === 'string' ? payload.label : '',
          limits: payload?.limits ?? null,
        })
        // ⚠ 明文只在此刻返回一次；之后无法再查看
        return okEnvelope({
          id: created.record.id,
          label: created.record.label,
          fingerprint: fingerprintOf(created.record),
          plaintext: created.plaintext,
          warning: '明文只显示这一次，请立即保存；之后只能看到指纹，无法再查看。',
        })
      }

      case 'keys/update': {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id.length === 0) return errEnvelope('bad_request', '缺少 id')
        const changed = await deps.keyStore.update(id, {
          ...(typeof payload?.label === 'string' ? { label: payload.label } : {}),
          ...(typeof payload?.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
          ...(payload?.limits === null || typeof payload?.limits === 'object' ? { limits: payload.limits } : {}),
        })
        return changed ? okEnvelope({ keys: deps.keyStore.list() }) : errEnvelope('not_found', '该 Key 不存在')
      }

      case 'keys/remove': {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id.length === 0) return errEnvelope('bad_request', '缺少 id')
        const removed = await deps.keyStore.remove(id)
        return removed ? okEnvelope({ keys: deps.keyStore.list() }) : errEnvelope('not_found', '该 Key 不存在')
      }

      case 'keys/rotate': {
        const id = typeof payload?.id === 'string' ? payload.id : ''
        if (id.length === 0) return errEnvelope('bad_request', '缺少 id')
        const grace = Number.isFinite(payload?.graceHours)
          ? Number(payload.graceHours)
          : (cfg.auth?.rotateGraceHours ?? 24)
        const rotated = await deps.keyStore.rotate(id, grace)
        if (rotated === undefined) return errEnvelope('not_found', '该 Key 不存在')
        return okEnvelope({
          ...rotated,
          keys: deps.keyStore.list(),
          warning: `旧 Key 将在 ${grace} 小时后失效；新 Key 明文只显示这一次。`,
        })
      }

      case 'keys/setAnonymous': {
        const allow = payload?.allow === true
        await deps.patchConfig({ auth: { allowAnonymous: allow } })
        return okEnvelope({
          allowAnonymous: allow,
          warning: allow ? '⚠ 已允许匿名访问：同网段任何人都能使用本机模型额度。' : undefined,
        })
      }

      // ---------- 能力（P4） ----------
      case 'model/capabilities': {
        const providerId = typeof payload?.provider === 'string' ? payload.provider : ''
        const modelId = typeof payload?.model === 'string' ? payload.model : ''
        if (providerId.length === 0 || modelId.length === 0) {
          return errEnvelope('bad_request', '缺少 provider 或 model')
        }
        if (deps.capabilities === undefined) return errEnvelope('unavailable', '能力层未就绪')
        return okEnvelope({
          capabilities: await deps.capabilities.describe(providerId, modelId),
          labels: LABELS_OF_CAPABILITY,
        })
      }

      case 'model/capability/set': {
        const providerId = typeof payload?.provider === 'string' ? payload.provider : ''
        const modelId = typeof payload?.model === 'string' ? payload.model : ''
        const field = typeof payload?.field === 'string' ? payload.field : ''
        if (providerId.length === 0 || modelId.length === 0 || field.length === 0) {
          return errEnvelope('bad_request', '缺少 provider / model / field')
        }
        if (deps.capabilities === undefined) return errEnvelope('unavailable', '能力层未就绪')
        // value 传 null 表示"恢复权威值"（清除人工覆盖）
        const value = payload?.value ?? null
        const done = await deps.capabilities.setOverride(providerId, modelId, field, value)
        if (!done) return errEnvelope('bad_request', 'value 必须是 supported / unsupported / unknown 或 null')
        return okEnvelope({ capabilities: await deps.capabilities.describe(providerId, modelId) })
      }

      case 'model/test': {
        const providerId = typeof payload?.provider === 'string' ? payload.provider : ''
        const modelId = typeof payload?.model === 'string' ? payload.model : ''
        if (providerId.length === 0 || modelId.length === 0) {
          return errEnvelope('bad_request', '缺少 provider 或 model')
        }
        if (deps.capabilities === undefined) return errEnvelope('unavailable', '能力层未就绪')
        // 同一时刻只允许一个测试：否则进度状态会被两个测试互相覆盖，
        // 且会并发消耗上游额度。
        if (testProgress.running) {
          return errEnvelope('busy', `已有测试正在进行（${testProgress.model || '未知模型'}），请等它结束`)
        }
        const testCfg = cfg.capabilities?.test ?? {}
        const items = Array.isArray(payload?.items) ? payload.items : testCfg.items
        const itemList = Array.isArray(items) ? items : []
        // 初始化进度（客户端据此显示"第几项 / 共几项"）
        testProgress.running = true
        testProgress.provider = providerId
        testProgress.model = modelId
        testProgress.items = itemList
        testProgress.total = itemList.length
        testProgress.done = []
        testProgress.current = itemList[0] ?? null
        testProgress.startedAt = Date.now()
        testProgress.finishedAt = null
        try {
          const results = await deps.capabilities.test({
            provider: providerId,
            model: modelId,
            items,
            perItemTimeoutMs: Number.isFinite(testCfg.perItemTimeoutMs) ? testCfg.perItemTimeoutMs : 30_000,
            // ⚠ 逐项回调：每完成一项就记录，客户端轮询可见。
            // （之前 RPC 没转发这个回调，导致进度永远停在"第 1 项"。）
            onProgress: (item) => {
              // ⚠ **必须排除 `authoritative`**：它是零成本的"权威值刷新"前置步骤，
              // 由 capabilities.test() 在正式项之前额外 emit 一次，**不在 itemList 里**。
              // 若把它计入 done，就会出现 done=7 / total=6 的荒谬显示（用户实测反馈）。
              if (typeof item === 'string' && item !== 'authoritative') testProgress.done.push(item)
              // 把"当前项"推进到下一个尚未完成的
              const next = itemList.find((x) => !testProgress.done.includes(x))
              testProgress.current = next ?? null
            },
          })
          return okEnvelope({
            results,
            capabilities: await deps.capabilities.describe(providerId, modelId),
            note: '「测试」会真实调用模型（消耗上游额度）',
          })
        } finally {
          testProgress.running = false
          testProgress.current = null
          testProgress.finishedAt = Date.now()
        }
      }

      /** 轮询能力测试进度（配合 model/test 使用，见 testProgress 注释）。 */
      case 'model/testProgress': {
        return okEnvelope(currentTestProgress())
      }

      // ---------- provider / 模型 ----------
      case 'models/list': {
        const providerId = typeof payload?.provider === 'string' ? payload.provider : ''
        if (providerId.length === 0) return errEnvelope('bad_request', '缺少 provider')
        const models = deps.directory.list().filter((m) => m.provider === providerId)
        return okEnvelope({
          provider: providerId,
          models: models.map((m) => ({
            publicName: m.publicName,
            model: m.model,
            name: m.name,
            description: m.description,
            inputModalities: m.inputModalities,
          })),
        })
      }

      // ---------- 性能测试（§6.5.10-b） ----------
      case 'model/perf': {
        const providerId = typeof payload?.provider === 'string' ? payload.provider : ''
        const modelId = typeof payload?.model === 'string' ? payload.model : ''
        if (providerId.length === 0 || modelId.length === 0) {
          return errEnvelope('bad_request', '缺少 provider 或 model')
        }
        const perfCfg = cfg.perfTest ?? {}
        const timeoutMs = Number.isFinite(perfCfg.timeoutMs) ? perfCfg.timeoutMs : 20_000
        const result = await deps.perfTest({ provider: providerId, model: modelId, timeoutMs })
        return okEnvelope(result)
      }

      // ---------- 配置复位（P16 危险操作） ----------
      case 'config/reset': {
        // 恢复出厂默认设置。**不动 API Key 与用量账本**（用户数据不该被"复位设置"带走）。
        const keepKeys = payload?.keepKeys !== false
        const reset = await deps.resetConfig?.(keepKeys)
        if (reset === undefined) return errEnvelope('unavailable', '复位不可用')
        if (!reset.ok) return errEnvelope('apply_failed', reset.message ?? '复位失败')
        return okEnvelope({
          config: deps.current(),
          keptKeys: keepKeys ? deps.keyStore.records.length : 0,
          note: keepKeys
            ? '已恢复出厂默认设置；API Key 与用量账本未动。'
            : '已恢复出厂默认设置。',
        })
      }

      // ---------- 过滤（P16 / §4.4 + §7.3） ----------
      case 'filters/get': {
        const f = deps.current()?.filters ?? {}
        const diag = deps.directory.diagnostics()
        return okEnvelope({
          filters: {
            providers: f.providers ?? [],
            models: f.models ?? [],
            allowedModels: f.allowedModels ?? [],
          },
          // 实际生效的结果：让人一眼看出"过滤器真的起作用了没有"
          publicCount: diag.publicCount,
          hiddenModelCount: diag.hiddenModelCount,
          hiddenModels: diag.hiddenModels.slice(0, 200),
          hiddenProviders: diag.allProviders.filter((p) => !p.visible).map((p) => ({ id: p.id, reason: p.hiddenReason })),
          note:
            'providers / models 是黑名单（命中即不公开）；allowedModels 是白名单' +
            '（非空时只公开其中的，空 = 全部）。两种写法都认：公开名 <模型>@<provider> 或裸模型名。',
        })
      }

      case 'filters/set': {
        const patch = {}
        for (const key of ['providers', 'models', 'allowedModels']) {
          if (payload?.[key] !== undefined) {
            if (!Array.isArray(payload[key])) return errEnvelope('bad_request', `${key} 必须是数组`)
            patch[key] = payload[key].map((x) => String(x)).filter((x) => x.length > 0)
          }
        }
        if (Object.keys(patch).length === 0) return errEnvelope('bad_request', '没有要修改的字段')
        const applied = await deps.patchConfig({ filters: patch })
        if (!applied?.ok) return errEnvelope('apply_failed', applied?.message ?? '写入失败')
        // 立即刷新目录，让过滤结果当场可见（不必等下一次轮询）
        await deps.directory.refresh()
        const diag = deps.directory.diagnostics()
        return okEnvelope({
          filters: deps.current()?.filters ?? {},
          publicCount: diag.publicCount,
          hiddenModelCount: diag.hiddenModelCount,
        })
      }

      // ---------- 熔断与并发（P12） ----------
      case 'breaker/status':
        if (deps.breaker === undefined) return errEnvelope('unavailable', '熔断器未就绪')
        return okEnvelope({
          ...deps.breaker.status(),
          concurrency: deps.concurrencyStatus?.() ?? null,
          note:
            '熔断只在上游连续限流时触发，用于保护本机 DSH 不被局域网刷量拖垮。' +
            '冷却期内 LAN 请求立即被拒（不消耗上游额度）；本机自己的对话不受影响。',
        })

      case 'breaker/reset': {
        if (deps.breaker === undefined) return errEnvelope('unavailable', '熔断器未就绪')
        const before = deps.breaker.status()
        deps.breaker.reset()
        return okEnvelope({
          before: { open: before.open, remainingSec: before.remainingSec },
          after: deps.breaker.status(),
          note: '已手动解除熔断（清空连续限流计数）。若上游仍在限流，很快会再次触发。',
        })
      }

      // ---------- 用量（P9） ----------
      case 'usage/summary': {
        const granularity = typeof payload?.granularity === 'string' ? payload.granularity : 'monthly'
        const agg = await aggregate({ granularity })
        const keyLabels = keyLabelMap(deps)
        return okEnvelope({
          granularity,
          totals: agg.totals,
          keys: agg.keys.map((k) => ({ ...k, ...keyNameOf(k.id, keyLabels) })),
          providers: agg.providers,
          kinds: agg.kinds,
          range: agg.range,
          empty: agg.totals.lines === 0,
        })
      }

      case 'usage/report': {
        const cfgNow = deps.current()
        const reuseWithinMs = Math.max(0, Number(cfgNow?.usage?.reuseWithinSec ?? 60) * 1000)
        const keep = Number(cfgNow?.usage?.keepReports ?? 20)
        const result = await writeReport({ keyLabels: keyLabelMap(deps), reuseWithinMs, keep })
        return okEnvelope({
          path: result.path,
          reused: result.reused,
          note: result.reused ? '一分钟内已生成过报告，直接复用（避免连点生成多份）' : '已生成新报告',
        })
      }

      case 'usage/open': {
        const cfgNow = deps.current()
        const reuseWithinMs = Math.max(0, Number(cfgNow?.usage?.reuseWithinSec ?? 60) * 1000)
        const keep = Number(cfgNow?.usage?.keepReports ?? 20)
        const result = await writeReport({ keyLabels: keyLabelMap(deps), reuseWithinMs, keep })
        const opened = await openInBrowser(result.path)
        return okEnvelope({
          path: result.path,
          reused: result.reused,
          opened: opened.ok,
          ...(opened.ok ? {} : { openError: opened.reason }),
        })
      }

      case 'usage/setEnabled': {
        const value = payload?.value === true
        const applied = await deps.patchConfig({ usage: { enabled: value } })
        if (!applied?.ok) return errEnvelope('apply_failed', applied?.message ?? '写入失败')
        return okEnvelope({ enabled: value })
      }

      // ---------- 附件账本（P8） ----------
      case 'attachments/status':
        if (deps.ledger === undefined) return errEnvelope('unavailable', '附件账本未就绪')
        return okEnvelope({
          ...deps.ledger.status(),
          note:
            'dry-run 时只记日志不真删。三道防误删：①复用本机对象绝不记账 ②删除前扫会话引用 ③删除前校验内容 sha256。',
        })

      case 'attachments/sweep': {
        if (deps.ledger === undefined) return errEnvelope('unavailable', '附件账本未就绪')
        const dryRun = payload?.dryRun
        const summary = await deps.ledger.sweep(
          typeof dryRun === 'boolean' ? { dryRun } : undefined,
        )
        return okEnvelope(summary)
      }

      case 'attachments/setDryRun': {
        const value = payload?.value === true
        if (deps.patchConfig === undefined) return errEnvelope('unavailable', '配置不可写')
        const applied = await deps.patchConfig({ attachments: { dryRun: value } })
        if (!applied?.ok) return errEnvelope('apply_failed', applied?.message ?? '写入失败')
        return okEnvelope({
          dryRun: value,
          warning: value
            ? undefined
            : '⚠ 已关闭 dry-run：账本将真的删除自己新建且无人引用的附件对象（复用本机对象仍永不删除）。',
        })
      }

      // ---------- 诊断 ----------
      case 'diagnostics/export': {
        // 脱敏：不含 key、不含 prompt 正文
        const report = {
          generatedAt: new Date().toISOString(),
          plugin: 'dsh-lantern',
          config: cfg,
          directory: deps.directory.diagnostics(),
          auth: {
            keyCount: deps.keyStore.records.length,
            usable: deps.keyStore.records.filter((r) => r.enabled !== false).length,
            keys: deps.keyStore.list(), // 只含指纹，无明文
          },
          listen: deps.listenStatus(),
          node: process.version,
          platform: process.platform,
        }
        await writeJson(PATHS.diagnostics, report)
        return okEnvelope({ path: PATHS.diagnostics, report })
      }

      default:
        return errEnvelope('unknown_method', `未知方法：${String(method)}`)
    }
  }
}

/**
 * 安装管理通道。
 *
 * ⚠ **必须用 `connection.fetch.register`，不能用 `webServer.register`**：
 * client 半部的 `ctx.connection.rpc.call('/api', endpoint, …)` 走的是
 * DSH 自身的 RPC 信封协议（`{type:'client-request', rpcId, method, payload}`），
 * 由 `connection.fetch.register` 认领；用 webServer 注册会拿不到该信封，
 * 表现为「面板点不动 / 无反应」（本机 jet-hub 同款实现可证）。
 *
 * @param ctx - Host 插件上下文。
 * @param deps - 依赖集合。
 * @param rpcMethod - RPC endpoint 名（client 侧一致）。
 * @returns `{ installed, dispose }`。
 */
export function installManagementRpc(ctx, deps, rpcMethod = 'lantern') {
  // ⚠ 只能读已经注入的服务：`ctx.get('connection')` 在未声明 inject 时会抛
  //   "cannot get property \"connection\" without inject"（本机实测）。
  //   因此本函数由调用方在已 `ctx.inject(['connection'], …)` 的作用域内调用，
  //   或直接接收 connection 对象。
  const connection = deps.connection
  if (connection === undefined || typeof connection.fetch?.register !== 'function') {
    ctx.logger.warn('[lantern] connection.fetch 不可用，管理通道未注册（设置面板将无法读写）')
    return { installed: false, dispose: () => {} }
  }

  /**
   * 构造带 rpcId 的**规范**响应 JSON。
   *
   * ⚠ 必须包含 `type: 'server-response'`（本机实测踩坑）：
   * 缺了它，client 侧抛 `connection: invalid server-response envelope`，
   * 界面表现为**永远卡在"读取中…"**（而不是报错），极难排查。
   * 参考实现：`dsh-codearts-auth/lib/jet-hub-rpc.js` 的 reply()。
   * @param rpcId - 对应请求 id。
   * @param result - `{ ok: true, value }` 或 `{ ok: false, error }`。
   * @returns Response。
   */
  const reply = (rpcId, result) => {
    const value =
      result !== null && typeof result === 'object' && result.ok === false
        ? { ...result, error: { ...result.error, details: {} } }
        : result
    return new Response(JSON.stringify({ type: 'server-response', rpcId, result: value }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const registration = connection.fetch.register({
    path: RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message.payload
      if (
        message.type !== 'client-request' ||
        typeof message.rpcId !== 'string' ||
        message.method !== rpcMethod ||
        !call ||
        typeof call.method !== 'string' ||
        !Object.prototype.hasOwnProperty.call(call, 'payload')
      ) {
        return reply(rpcId, { ok: false, error: { code: 'bad-request', message: 'Invalid LANtern management request.' } })
      }
      try {
        const result = await dispatchMethod(ctx, deps, call.method, call.payload)
        return reply(rpcId, result)
      } catch (error) {
        // 必须返回**规范的 RPC 错误响应**（不是裸 500 文本），
        // 否则 client 的 unwrap 无法识别，界面表现为"点击无反应"。
        const message2 = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[lantern] ${String(call.method)} failed: ${message2}`)
        return reply(rpcId, { ok: false, error: { code: 'handler-failed', message: maskForClient(message2) } })
      }
    },
  })

  return {
    installed: true,
    dispose: () => {
      try {
        registration?.()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * 分发一个管理方法（供 `connection.fetch` 通道使用）。
 * @param ctx - Host 上下文。
 * @param deps - 依赖集合。
 * @param method - 方法名。
 * @param payload - 参数。
 * @returns `{ ok, value }` 或 `{ ok:false, error }`。
 */
export async function dispatchMethod(ctx, deps, method, payload) {
  return buildDispatcher(ctx, deps)(method, payload)
}

/**
 * 脱敏一段可能含密钥的消息（管理通道用）。
 * @param message - 原始消息。
 * @returns 脱敏后的消息。
 */
function maskForClient(message) {
  return String(message ?? 'internal error')
    .replace(/\b(sk|npm|ghp|xoxb|glm|hf)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***')
}
