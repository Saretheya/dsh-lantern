/**
 * dsh-lantern — 模型目录层（Host 半部内部模块）。
 *
 * 职责：
 * 1. **全量枚举** DSH 已注册的 provider 与其模型（只读，不触碰任何状态）；
 * 2. **动态跟随** provider 增删：订阅 `llm/adapters-updated`，去抖后重建；
 * 3. **全名制命名**：公开名一律 `<model>@<slug(provider)>`（设计方案 §5，
 *    唯一提供者也不省略后缀）→ 名字只依赖 (model, provider)，**永不漂移**；
 * 4. **显示规则**（§4.4，官方与第三方**完全统一**）：
 *    未注册 / 无模型 / 被过滤 → 对局域网隐藏；**不做凭据探测**，
 *    缺 key 由上游在调用时报 MISSING_CREDENTIAL，经错误原样呈现如实告知。
 *
 * 全部为只读查询：listProviders / listModels / resolveModelInfo。
 *
 * @module dsh-lantern/directory
 */

/** 去抖：合并突发变化。 */
const REFRESH_DEBOUNCE_MS = 250
/** 最短刷新间隔：防抖风暴。 */
const REFRESH_MIN_INTERVAL_MS = 1000
/** 兜底轮询：事件可能被漏（消费者失败被隔离），低频保险。 */
const FALLBACK_POLL_MS = 60_000

/**
 * provider 路由 id → slug。
 * 只保留 `[a-z0-9-]`，小写化，超长截断到 24 字符。
 * @param providerId - provider 路由 id。
 * @returns 稳定且只含安全字符的 slug。
 */
export function slugOf(providerId) {
  const cleaned = String(providerId)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return (cleaned.length > 0 ? cleaned : 'provider').slice(0, 24)
}

/**
 * 模型公开名（全名制）。模型名含 `@` 时转义为 `@@`。
 * @param modelId - 上游模型 id。
 * @param providerId - provider 路由 id。
 * @returns `<model>@<slug>` 形式的公开名。
 */
export function publicNameOf(modelId, providerId) {
  return `${String(modelId).replace(/@/g, '@@')}@${slugOf(providerId)}`
}

/**
 * 从公开名反解出 slug（宽松路由用，§4.3）。
 * @param publicName - 客户端传来的 model 字段。
 * @returns `{ model, slug }`，无法解析时返回 undefined。
 */
export function parsePublicName(publicName) {
  const text = String(publicName)
  const at = text.lastIndexOf('@')
  if (at <= 0 || at === text.length - 1) return undefined
  const model = text.slice(0, at).replace(/@@/g, '@')
  const slug = text.slice(at + 1)
  if (!/^[a-z0-9-]+$/.test(slug)) return undefined
  return { model, slug }
}

/**
 * 模型目录：枚举 + 动态刷新 + 全名制映射 + 显示规则。
 */
export class ModelDirectory {
  /**
   * @param ctx - Host 插件上下文（需要 `llm` 服务）。
   * @param config - 配置读取器（返回当前配置快照的函数）。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** 公开名 → { provider, model } */
    this.byPublic = new Map()
    /** provider → 被隐藏的原因（对局域网隐藏，但对管理员可见，§4.4.2） */
    this.hidden = new Map()
    /** provider → 模型条目数（诊断用） */
    this.counts = new Map()
    this.lastRefreshAt = 0
    this.refreshing = undefined
    this.timer = undefined
    this.debounceTimer = undefined
    this.disposed = false
  }

  /** 启动订阅与兜底轮询。 */
  start() {
    // ★ 动态发现：provider 增删/替换都会触发（含 registration.replace()）
    this.ctx.on('llm/adapters-updated', () => this.schedule())
    this.timer = setInterval(() => this.schedule(), FALLBACK_POLL_MS)
    this.timer.unref?.()
    return this.refresh()
  }

  /** 去抖 + 最短间隔地安排一次刷新。 */
  schedule() {
    if (this.disposed) return
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
    const since = Date.now() - this.lastRefreshAt
    const delay = Math.max(REFRESH_DEBOUNCE_MS, REFRESH_MIN_INTERVAL_MS - since)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.refresh()
    }, delay)
    this.debounceTimer.unref?.()
  }

  /** 释放定时器与监听。 */
  dispose() {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.debounceTimer !== undefined) clearTimeout(this.debounceTimer)
    this.timer = undefined
    this.debounceTimer = undefined
  }

  /**
   * 重建目录：枚举 → 应用显示规则 → 构建全名映射。
   * 单个 provider 拉取失败只标记降级，**不影响其它 provider**。
   * @returns 目录条目数组。
   */
  async refresh() {
    if (this.refreshing !== undefined) return this.refreshing
    this.refreshing = this.#refreshInner().finally(() => {
      this.refreshing = undefined
      this.lastRefreshAt = Date.now()
    })
    return this.refreshing
  }

  async #refreshInner() {
    const cfg = this.config()
    const excludedProviders = new Set(cfg?.filters?.providers ?? [])
    // 模型过滤（P16，设计方案 §4.4 + §7.3）：
    //   excludedModels  —— 黑名单，命中即不公开
    //   allowedModels   —— 白名单，**非空时只公开其中的**（空 = 全部）
    // 两者可叠加：先过白名单，再过黑名单（黑名单优先，避免"白名单里误留"）。
    const excludedModels = new Set(cfg?.filters?.models ?? [])
    const allowedModels = new Set(cfg?.filters?.allowedModels ?? [])
    const useAllowList = allowedModels.size > 0
    const hiddenModels = new Map()
    const providers = this.ctx.llm.listProviders()
    const hidden = new Map()
    const counts = new Map()
    const byPublic = new Map()
    const entries = []

    const settled = await Promise.allSettled(
      providers.map(async (provider) => {
        const models = await this.ctx.llm.listModels(provider.id)
        return { provider, models }
      }),
    )

    for (const [index, result] of settled.entries()) {
      const provider = providers[index]
      // 显示规则（§4.4，官方与第三方统一）：三项只读判定，不做凭据探测。
      if (excludedProviders.has(provider.id)) {
        hidden.set(provider.id, 'filtered')
        continue
      }
      if (result.status !== 'fulfilled') {
        // 拉取失败：不谎报为空，标记降级但仍尽量列出（下一次刷新会自愈）
        hidden.set(provider.id, `list_failed: ${result.reason?.message ?? 'unknown'}`)
        counts.set(provider.id, 0)
        continue
      }
      const allModels = result.value.models ?? []
      // 过滤后再判断"是否为空"，避免"全被过滤掉"的 provider 仍显示为空分组
      const models = allModels.filter((model) => {
        const publicName = publicNameOf(model.id, provider.id)
        // 白名单非空时，只允许其中的；两种写法都认（公开名 或 裸模型名）
        if (useAllowList && !allowedModels.has(publicName) && !allowedModels.has(model.id)) {
          hiddenModels.set(publicName, 'not_in_allowlist')
          return false
        }
        if (excludedModels.has(publicName) || excludedModels.has(model.id)) {
          hiddenModels.set(publicName, 'excluded')
          return false
        }
        return true
      })
      counts.set(provider.id, models.length)
      if (models.length === 0) {
        hidden.set(provider.id, allModels.length === 0 ? 'no_models' : 'all_models_filtered')
        continue
      }
      for (const model of models) {
        const publicName = publicNameOf(model.id, provider.id)
        const entry = {
          publicName,
          provider: provider.id,
          providerName: provider.name ?? provider.id,
          slug: slugOf(provider.id),
          model: model.id,
          name: model.name ?? model.id,
          description: model.description,
          inputModalities: model.inputModalities,
        }
        byPublic.set(publicName, entry)
        entries.push(entry)
      }
    }

    this.byPublic = byPublic
    this.hidden = hidden
    this.hiddenModels = hiddenModels
    this.counts = counts
    this.entries = entries
    return entries
  }

  /**
   * 列出当前所有公开条目。
   * @returns 条目数组（已按 provider 与模型名排序，输出稳定）。
   */
  list() {
    return [...(this.entries ?? [])].sort((a, b) =>
      a.provider === b.provider
        ? a.model.localeCompare(b.model)
        : a.provider.localeCompare(b.provider),
    )
  }

  /**
   * 某个 (provider, model) 是否**允许公开**（P16 过滤判定）。
   *
   * 用途：`resolveModel()` 的**宽松回退路径**也要过这一关——
   * 否则被过滤的模型虽然不出现在 `/v1/models`，仍能被直接调用，
   * 过滤就只剩"看不见"而达不到"不能用"的设计目的（§7.3）。
   *
   * 语义：黑名单命中 → false；白名单非空且不在其中 → false；否则 true。
   *
   * @param providerId - provider id。
   * @param modelId - 裸模型 id。
   * @returns 是否允许公开。
   */
  isPubliclyAllowed(providerId, modelId) {
    const cfg = this.config()
    const publicName = publicNameOf(modelId, providerId)
    const excludedProviders = cfg?.filters?.providers ?? []
    if (excludedProviders.includes(providerId)) return false
    const excludedModels = cfg?.filters?.models ?? []
    if (excludedModels.includes(publicName) || excludedModels.includes(modelId)) return false
    const allowed = cfg?.filters?.allowedModels ?? []
    if (allowed.length > 0 && !allowed.includes(publicName) && !allowed.includes(modelId)) return false
    return true
  }

  /**
   * 公开名 → 路由（严格命中目录；宽松拆解在路由层处理，§4.3）。
   * @param publicName - 客户端传来的 model 字段。
   * @returns 条目，或 undefined。
   */
  resolve(publicName) {
    return this.byPublic.get(String(publicName))
  }

  /**
   * 严格校验：目标 provider 当前是否仍注册着。
   * 这是"删除 Provider 后不能再使用"的硬保证，不依赖目录刷新速度。
   * @param providerId - provider 路由 id。
   * @returns 是否仍注册。
   */
  isProviderLive(providerId) {
    return this.ctx.llm.listProviders().some((p) => p.id === providerId)
  }

  /**
   * 由 slug 反查 provider id（宽松路由用）。
   * @param slug - 公开名里的 slug 部分。
   * @returns provider id，或 undefined。
   */
  providerBySlug(slug) {
    const hit = this.ctx.llm.listProviders().find((p) => slugOf(p.id) === slug)
    return hit?.id
  }

  /** 供 `/v1/lantern/health` 与设置面板使用的诊断快照。 */
  diagnostics() {
    const providers = this.ctx.llm.listProviders()
    const rows = providers.map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      slug: slugOf(p.id),
      visible: !this.hidden.has(p.id),
      hiddenReason: this.hidden.get(p.id),
      modelCount: this.counts.get(p.id) ?? 0,
    }))
    return {
      // 可见的（对局域网公开）——设置面板左栏导航用它
      providers: rows.filter((r) => r.visible),
      // 全部（含被隐藏的）——面板用它显示"为什么某个 provider 不见了"
      allProviders: rows,
      publicCount: this.byPublic.size,
      hiddenCount: this.hidden.size,
      // P16：被过滤掉的模型（面板显示"哪些被排除了及原因"，避免"配了过滤器却看不出效果"）
      hiddenModels: [...(this.hiddenModels ?? new Map()).entries()].map(([publicName, reason]) => ({
        publicName,
        reason,
      })),
      hiddenModelCount: (this.hiddenModels ?? new Map()).size,
      lastRefreshAt: this.lastRefreshAt,
    }
  }
}
