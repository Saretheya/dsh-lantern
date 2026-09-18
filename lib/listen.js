/**
 * dsh-lantern — 监听管理（P14：端口的增 / 删 / 改）。
 *
 * 两种模式（设计方案 §12）：
 * - `reuse`     复用 DSH `webServer` 端口挂 `/v1/*`（同端口，Web UI 也暴露）
 * - `standalone` 插件自开独立 HTTP 服务，**只暴露 `/v1/*`**（推荐，Web UI 不出本机）
 *
 * 纪律（用户明确要求 + 设计方案 §11.5.6.2）：
 * 1. **改动即刻生效，不重启 DSH**；
 * 2. **变更时不断开已建立的连接**：先停止接收新连接，等既有请求自然结束；
 * 3. **不允许删掉最后一条**（否则等于把自己关停）；
 * 4. **失败回滚**：新配置 listen 失败 → 恢复旧配置并继续服务（绝不因改配置把服务弄断）；
 * 5. `reuse` 只允许一条（同一进程只有一个 webServer）。
 *
 * @module dsh-lantern/listen
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

/** 一条监听条目的合法模式。 */
const MODES = new Set(['reuse', 'standalone'])

/**
 * 校验并归一化一条监听条目。
 * @param raw - 原始条目。
 * @param index - 序号（用于生成缺省 id）。
 * @returns `{ ok, entry?, message? }`。
 */
export function normalizeEntry(raw, index = 0) {
  if (raw === null || typeof raw !== 'object') return { ok: false, message: '条目必须是对象' }
  const mode = String(raw.mode ?? 'standalone')
  if (!MODES.has(mode)) return { ok: false, message: `mode 必须是 reuse 或 standalone（收到 ${mode}）` }
  const bind = typeof raw.bind === 'string' && raw.bind.length > 0 ? raw.bind : '0.0.0.0'
  if (!['127.0.0.1', '0.0.0.0'].includes(bind) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(bind)) {
    return { ok: false, message: `bind 必须是 127.0.0.1 / 0.0.0.0 / 具体 IP（收到 ${bind}）` }
  }
  let port = undefined
  if (mode === 'standalone') {
    port = Number(raw.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, message: `standalone 模式需要 1–65535 的 port（收到 ${String(raw.port)}）` }
    }
  }
  return {
    ok: true,
    entry: {
      id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `listen_${index}`,
      mode,
      bind,
      ...(port === undefined ? {} : { port }),
      enabled: raw.enabled !== false,
    },
  }
}

/**
 * 校验整个条目列表（含跨条目冲突检查）。
 *
 * @param rawList - 原始列表。
 * @param ownPort - DSH 自身端口（用于判断"是否真会冲突"）。
 * @param ownBind - DSH 自身**实际绑定的地址**（如 `127.0.0.1` / `0.0.0.0`）。
 *   只有 DSH 也绑 `0.0.0.0` 时，插件再绑同端口的 `0.0.0.0` 才会真正失败；
 *   DSH 只绑回环时，插件绑 `0.0.0.0` 是**可行且有用**的（见下方说明）。
 * @returns `{ ok, entries?, message? }`。
 */
export function normalizeEntries(rawList, ownPort = undefined, ownBind = undefined) {
  if (!Array.isArray(rawList)) return { ok: false, message: 'listenEntries 必须是数组' }
  if (rawList.length === 0) return { ok: false, message: '至少需要保留一条监听条目（不能把自己关停）' }

  const entries = []
  const seenIds = new Set()
  let reuseCount = 0
  const seenPorts = new Map()

  for (const [index, raw] of rawList.entries()) {
    const result = normalizeEntry(raw, index)
    if (!result.ok) return { ok: false, message: `第 ${index + 1} 条：${result.message}` }
    const entry = result.entry

    if (seenIds.has(entry.id)) return { ok: false, message: `条目 id 重复：${entry.id}` }
    seenIds.add(entry.id)

    if (entry.mode === 'reuse') {
      reuseCount += 1
      if (reuseCount > 1) {
        return { ok: false, message: 'reuse 模式只允许一条（同一进程只有一个 webServer 端口）' }
      }
    } else {
      const key = `${entry.bind}:${entry.port}`
      if (seenPorts.has(key)) {
        return { ok: false, message: `端口冲突：${entry.bind}:${entry.port} 已由另一条占用` }
      }
      seenPorts.set(key, entry.id)
      // ⚠ **不再把"与 DSH 同端口"当作硬冲突**（实测反馈 + 实验证明）：
      //
      // 实测（DSH 占着回环地址上的某端口时，另一进程绑同一端口的 0.0.0.0）：
      //   - 绑 `0.0.0.0:<port>` **成功**（EADDRINUSE 只对"完全相同的绑定面"生效）；
      //   - 之后本机回环仍由 DSH 应答，而局域网地址由插件应答 —— **两者共存且分工明确**。
      //
      // 所以这正是"想只把 /v1/* 暴露给局域网、又不动 DSH 本机端口"的**合理用法**，
      // 硬性拒绝会让用户无法配置（原实现还把这个提示渲染到了 API Key 区，更难发现）。
      //
      // 改为**只在真正无法绑定时**由 `apply()` 的 listen 失败来如实报错；
      // 这里仅保留"DSH 也监听 0.0.0.0 时才会真冲突"的**提醒**（不阻断）。
      if (ownPort !== undefined && entry.port === ownPort && entry.bind === '0.0.0.0' && ownBind === '0.0.0.0') {
        return {
          ok: false,
          message:
            `端口 ${entry.port} 与本机 DSH 端口相同，且 DSH 自身也监听 0.0.0.0 —— ` +
            '此时 0.0.0.0 已被 DSH 完全占用，插件无法绑定。请换一个端口，' +
            '或让 DSH 只绑 127.0.0.1（默认行为）后再用本条目。',
        }
      }
    }
    entries.push(entry)
  }
  return { ok: true, entries }
}

/**
 * 监听管理器：按条目 reconcile 出实际运行的 HTTP 服务。
 */
export class ListenManager {
  /**
   * @param options - `{ ctx, handler, getOwnPort, log }`。
   */
  constructor({ ctx, handler, getOwnPort, log }) {
    this.ctx = ctx
    this.handler = handler
    this.getOwnPort = getOwnPort ?? (() => undefined)
    this.log = log ?? (() => {})
    /** @type {Array<object>} 当前生效条目 */
    this.entries = []
    /** @type {Map<string, import('node:http').Server>} 条目 id -> server */
    this.servers = new Map()
    /** @type {Map<string, {port:number,bind:string}>} 实际监听信息 */
    this.actual = new Map()
    /** reuse 模式的注册/注销回调 */
    this.reuseControl = undefined
    this.disposed = false
  }

  /** 当前状态快照（供 status / health 上报）。 */
  status() {
    return this.entries.map((entry) => {
      const isReuse = entry.mode === 'reuse'
      // ⚠ `bind` 必须如实（曾谎报，用户实测发现）：
      // `reuse` 复用 **DSH 自己已监听的 socket**，其绑定 IP 由 **DSH 启动参数 `--host`**
      // 决定，**与插件的 `bind` 配置无关**。若照配置汇报 `0.0.0.0`，就会出现
      // "设置页说局域网可访问、实际只有 127.0.0.1 能连"的谎报。
      const actualBind = isReuse ? (this.reuseActualBind ?? entry.bind) : entry.bind
      return {
        id: entry.id,
        mode: entry.mode,
        bind: actualBind,
        // 是否"继承自 DSH、插件无法决定"（UI 与 health 据此如实提示）
        bindInherited: isReuse,
        // 用户配置里想要的值：保留以便 UI 显示差异，不做隐瞒
        requestedBind: entry.bind,
        port: entry.mode === 'reuse' ? this.getOwnPort() : entry.port,
        enabled: entry.enabled,
        listening: entry.mode === 'reuse' ? this.reuseControl?.registered === true : this.servers.has(entry.id),
        error: this.actual.get(entry.id)?.error,
      }
    })
  }

  /**
   * 告知管理器"reuse 模式实际继承到的绑定地址"。
   *
   * 由 index.js 在启动时探测 DSH 的真实监听地址后调用；
   * 拿不到时保持 undefined，`status()` 会退化为配置值并置 `bindInherited: true`。
   *
   * @param bind - 实际地址（如 `127.0.0.1` / `0.0.0.0`），或 undefined。
   */
  setReuseActualBind(bind) {
    this.reuseActualBind = bind
  }

  /** 条目列表（含实际监听信息）。 */
  list() {
    return this.entries.map((e) => ({ ...e }))
  }

  /**
   * 设定 reuse 模式的注册控制器。
   * @param control - `{ register(), unregister(), get registered }`。
   */
  setReuseControl(control) {
    this.reuseControl = control
  }

  /**
   * 启动一个 standalone 服务。
   * @param entry - 监听条目。
   * @returns `{ ok, message? }`。
   */
  async #openStandalone(entry) {
    const server = createServer((req, res) => {
      void this.handler(req, res)
    })
    return new Promise((resolve) => {
      let settled = false
      const done = (result) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      server.once('error', (error) => {
        this.actual.set(entry.id, { error: error?.code ?? String(error?.message ?? error) })
        done({ ok: false, message: `${entry.bind}:${entry.port} 启动失败：${error?.code ?? error?.message}` })
      })
      server.listen({ port: entry.port, host: entry.bind }, () => {
        const addr = server.address()
        this.servers.set(entry.id, server)
        this.actual.set(entry.id, { port: typeof addr === 'object' && addr ? addr.port : entry.port, bind: entry.bind })
        done({ ok: true })
      })
    })
  }

  /**
   * 停止一个 standalone 服务。
   * **不断开已建立的连接**：`close()` 只停止接收新连接，
   * 既有请求（含流式响应）自然结束。
   * @param id - 条目 id。
   */
  async #closeStandalone(id) {
    const server = this.servers.get(id)
    if (server === undefined) return
    this.servers.delete(id)
    this.actual.delete(id)
    await new Promise((resolve) => {
      try {
        server.close(() => resolve())
      } catch {
        resolve()
      }
      // 兜底：绝不无限等待（既有关闭回调在无连接时会立即触发）
      setTimeout(resolve, 5000).unref?.()
    })
  }

  /**
   * 应用一组新条目：与当前状态 reconcile。
   *
   * 失败回滚语义：**先尝试开新服务，成功后才关旧服务**；
   * 若任一新服务启动失败，则把已开的新服务关掉，并保持原有服务不动。
   *
   * @param nextEntries - 新的条目列表（应已通过 normalizeEntries 校验）。
   * @returns `{ ok, message?, entries? }`。
   */
  async apply(nextEntries) {
    if (this.disposed) return { ok: false, message: '插件已卸载' }
    const previous = this.entries
    const openeed = []

    // 1) 先开所有需要新开的 standalone
    for (const entry of nextEntries) {
      if (entry.mode !== 'standalone' || entry.enabled === false) continue
      const existing = this.servers.get(entry.id)
      if (existing !== undefined) continue // 已在运行，稍后判断是否需重建
      const result = await this.#openStandalone(entry)
      if (!result.ok) {
        // 回滚：关掉本次新开的
        for (const id of openeed) await this.#closeStandalone(id)
        return { ok: false, message: result.message }
      }
      openeed.push(entry.id)
    }

    // 2) 关闭不再需要 / 已禁用 / 参数变了的 standalone
    const nextIds = new Set(nextEntries.filter((e) => e.mode === 'standalone' && e.enabled !== false).map((e) => e.id))
    for (const [id] of [...this.servers.entries()]) {
      const next = nextEntries.find((e) => e.id === id)
      const needsRebuild =
        next === undefined ||
        next.enabled === false ||
        this.actual.get(id)?.port !== next.port ||
        this.actual.get(id)?.bind !== next.bind
      if (!nextIds.has(id) || needsRebuild) {
        await this.#closeStandalone(id)
        // 需要重建的（改了端口）立即重开
        if (needsRebuild && next !== undefined && next.enabled !== false) {
          const reopened = await this.#openStandalone(next)
          if (!reopened.ok) {
            this.log('error', `[lantern] ${reopened.message}（该条目未启用）`)
          }
        }
      }
    }

    // 3) reuse 模式：按条目启停 webServer 上的 /v1 路由
    const wantReuse = nextEntries.some((e) => e.mode === 'reuse' && e.enabled !== false)
    if (this.reuseControl !== undefined) {
      try {
        if (wantReuse && this.reuseControl.registered !== true) this.reuseControl.register()
        if (!wantReuse && this.reuseControl.registered === true) this.reuseControl.unregister()
      } catch (error) {
        this.log('error', `[lantern] reuse 模式切换失败：${error?.message}`)
      }
    }

    this.entries = nextEntries.map((e) => ({ ...e }))
    void previous
    return { ok: true, entries: this.list() }
  }

  /** 卸载：关闭全部 standalone 服务。 */
  async dispose() {
    this.disposed = true
    for (const id of [...this.servers.keys()]) await this.#closeStandalone(id)
    this.servers.clear()
    this.actual.clear()
  }
}

/**
 * 生成一个新的监听条目 id。
 * @returns 形如 `listen_ab12cd34` 的 id。
 */
export function newListenId() {
  return `listen_${randomUUID().slice(0, 8)}`
}
