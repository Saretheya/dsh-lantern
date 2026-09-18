/**
 * dsh-lantern — 熔断与限额闸门（P12，设计方案 §7.3 第 2/8 条）。
 *
 * 目的：**保护本机 DSH 不被局域网刷量拖垮**。
 * 局域网客户端可能高速重试，若上游开始限流（`RATE_LIMIT`），
 * 继续放大流量只会让**本机自己的 AI 也变慢或不可用**。
 *
 * 两条独立机制：
 *
 * 1. **每分钟输出 token 上限**（`perKeyTpm`，默认 60k）
 *    —— 并发与 RPM 都拦不住"一个请求就很贵"的情形，故按**实际输出 token** 计量。
 * 2. **熔断器**（circuit breaker）
 *    —— 上游连续报 `RATE_LIMIT` 达阈值 → **暂停 LAN 通道 N 秒**（默认 60s），
 *    冷却期内的请求立即得到 503 + `Retry-After`，**不再打向上游**。
 *    冷却结束后自动半开（放一个请求试探）。
 *
 * 设计纪律：
 * - **只影响 LAN 通道**，本机 DSH 自己的调用完全不受影响（本模块只被网关转发层调用）；
 * - 状态**只在内存**，不写盘（重启即清零，避免把"上次的冷却"带到新进程）；
 * - 冷却期**不消耗上游额度**（在打向上游之前就拒绝）。
 *
 * @module dsh-lantern/breaker
 */

/** 触发熔断的上游错误码（大小写不敏感匹配）。 */
const RATE_LIMIT_CODES = ['rate_limit', 'rate_limit_exceeded', 'rate_limited', 'too_many_requests', '429']

/**
 * 判断一个上游失败是否属于"限流"。
 *
 * @param failure - `{ code, status, message }`（任一字段可有）。
 * @returns 是否计为限流。
 */
export function isRateLimitFailure(failure) {
  if (failure === undefined || failure === null) return false
  const code = String(failure.code ?? '').toLowerCase()
  if (RATE_LIMIT_CODES.includes(code)) return true
  if (Number(failure.status) === 429) return true
  // 兜底：有些 adapter 只在 message 里带 429 / rate limit
  const msg = String(failure.message ?? '').toLowerCase()
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit')
}

/**
 * 熔断器 + 输出 token 限速。
 */
export class Breaker {
  /**
   * @param config - 返回当前配置的函数。
   * @param now - 可注入的时钟（测试用）。
   */
  constructor(config, now = () => Date.now()) {
    this.config = config
    this.now = now
    /** 连续限流计数（成功即清零）。 */
    this.streak = 0
    /** 冷却截止时间戳（0 表示未熔断）。 */
    this.openUntil = 0
    /** 最近一次熔断的原因（供 UI 与 health 展示）。 */
    this.lastOpenReason = undefined
    /** 熔断历史（最近若干次，便于诊断）。 */
    this.history = []
    /** 输出 token 窗口：`keyId -> [{ at, tokens }]`。 */
    this.tokenWindows = new Map()
    /** 累计统计。 */
    this.stats = { opened: 0, rejected: 0, rateLimitHits: 0, tpmRejections: 0 }
  }

  /** 熔断参数（读配置，带保守默认）。 */
  #cfg() {
    const b = this.config()?.limits?.breaker ?? {}
    return {
      enabled: b.enabled !== false,
      threshold: Number.isFinite(b.consecutiveRateLimits) && b.consecutiveRateLimits > 0 ? b.consecutiveRateLimits : 3,
      cooldownMs: Number.isFinite(b.cooldownSec) && b.cooldownSec > 0 ? b.cooldownSec * 1000 : 60_000,
    }
  }

  /**
   * 当前是否处于熔断冷却中。
   * @returns 剩余毫秒数（0 表示未熔断）。
   */
  remainingMs() {
    if (this.openUntil === 0) return 0
    const left = this.openUntil - this.now()
    if (left <= 0) {
      // 冷却结束：半开（清零计数，放行试探）
      this.openUntil = 0
      this.streak = 0
      return 0
    }
    return left
  }

  /**
   * 请求进入前的检查。
   *
   * @param keyId - 用于 token 计量的 key 标识。
   * @returns `{ ok: true }` 或 `{ ok: false, code, message, retryAfterSec }`。
   */
  admit(keyId = '__anonymous__') {
    const left = this.remainingMs()
    if (left > 0) {
      this.stats.rejected += 1
      return {
        ok: false,
        code: 'circuit_open',
        retryAfterSec: Math.max(1, Math.ceil(left / 1000)),
        message:
          `LANtern 已因上游连续限流而临时暂停（剩余约 ${Math.max(1, Math.ceil(left / 1000))} 秒）。` +
          '这是为了保护本机 DSH 不被刷量拖垮；本机自己的对话不受影响。',
      }
    }

    // 每分钟输出 token 上限
    const tpm = this.config()?.limits?.perKeyTpm
    if (Number.isFinite(tpm) && tpm > 0) {
      const used = this.outputTokensInWindow(keyId)
      if (used >= tpm) {
        this.stats.tpmRejections += 1
        return {
          ok: false,
          code: 'token_rate_limit_exceeded',
          retryAfterSec: 60,
          message:
            `该 Key 本分钟输出 token 已达上限（${tpm}，已用 ${used}）。` +
            '请稍后重试，或在 设置 → LANtern → 限额与并发 中调整。',
        }
      }
    }
    return { ok: true }
  }

  /**
   * 统计某 key 在最近 60 秒内的输出 token。
   * @param keyId - key 标识。
   * @returns 已用 token 数。
   */
  outputTokensInWindow(keyId) {
    const cutoff = this.now() - 60_000
    const list = (this.tokenWindows.get(keyId) ?? []).filter((x) => x.at > cutoff)
    if (list.length === 0) {
      this.tokenWindows.delete(keyId)
      return 0
    }
    this.tokenWindows.set(keyId, list)
    return list.reduce((sum, x) => sum + x.tokens, 0)
  }

  /**
   * 记录一次**成功**调用（用于 token 计量与失败计数清零）。
   *
   * @param keyId - key 标识。
   * @param outputTokens - 本次输出 token（可为 0/undefined）。
   */
  recordSuccess(keyId = '__anonymous__', outputTokens = 0) {
    this.streak = 0
    this.lastOpenReason = undefined
    if (Number.isFinite(outputTokens) && outputTokens > 0) {
      const list = this.tokenWindows.get(keyId) ?? []
      list.push({ at: this.now(), tokens: outputTokens })
      this.tokenWindows.set(keyId, list)
    }
  }

  /**
   * 记录一次**失败**；若属限流且连续达阈值，则打开熔断。
   *
   * @param failure - `{ code, status, message }`。
   * @returns `{ opened, streak, openUntil }`。
   */
  recordFailure(failure) {
    if (!isRateLimitFailure(failure)) {
      // 非限流错误不累加（网络抖动/模型报错不该触发熔断）
      return { opened: false, streak: this.streak, openUntil: this.openUntil }
    }
    this.stats.rateLimitHits += 1
    this.streak += 1
    const cfg = this.#cfg()
    if (!cfg.enabled || this.streak < cfg.threshold) {
      return { opened: false, streak: this.streak, openUntil: this.openUntil }
    }
    // 打开熔断
    this.openUntil = this.now() + cfg.cooldownMs
    this.stats.opened += 1
    this.lastOpenReason =
      `上游连续 ${this.streak} 次限流（最近原因：${String(failure?.message ?? failure?.code ?? '未知').slice(0, 120)}）`
    this.history.push({ at: this.now(), streak: this.streak, reason: this.lastOpenReason, until: this.openUntil })
    if (this.history.length > 20) this.history.shift()
    this.streak = 0
    return { opened: true, streak: cfg.threshold, openUntil: this.openUntil, reason: this.lastOpenReason }
  }

  /** 手动解除熔断（危险操作里的"立即恢复"）。 */
  reset() {
    this.openUntil = 0
    this.streak = 0
    this.lastOpenReason = undefined
    return { ok: true }
  }

  /** 状态快照（health 与设置面板用）。 */
  status() {
    const left = this.remainingMs()
    const cfg = this.#cfg()
    return {
      open: left > 0,
      remainingMs: left,
      remainingSec: Math.ceil(left / 1000),
      consecutiveRateLimits: this.streak,
      threshold: cfg.threshold,
      cooldownSec: Math.round(cfg.cooldownMs / 1000),
      enabled: cfg.enabled,
      lastOpenReason: this.lastOpenReason,
      // token 窗口（供 UI 显示"本分钟已用"）
      tokenWindows: [...this.tokenWindows.entries()].map(([id, list]) => ({
        keyId: id,
        used: this.outputTokensInWindow(id),
        limit: this.config()?.limits?.perKeyTpm ?? null,
      })),
      stats: { ...this.stats },
      recent: this.history.slice(-5),
    }
  }
}

/**
 * 一个**保留槽**并发闸门：保证本机 DSH 永远有并发可用。
 *
 * 设计（§7.3 第 7 条）：总并发 `total`，其中 `reserved` 个**只留给本机**；
 * LAN 通道最多用 `total - reserved` 个。这样 LAN 刷满时本机仍能立即对话。
 *
 * ⚠ 本机与 LAN 共用同一个 Node 进程，插件**无法**真正区分"本机请求"，
 * 因此这里的实现是：LAN 侧计数器**上限设为 `total - reserved`**，
 * 而 DSH 本机自身的调用**根本不经过本插件**（它是直接调 `ctx.llm`），
 * 所以只要 LAN 侧不超过 `total - reserved`，本机就始终有 `reserved` 个槽可用。
 *
 * @param total - 总并发上限。
 * @param reserved - 为本机保留的槽数。
 * @returns `{ acquire, release, status, inflight }` 形态的闸门。
 */
export function createReservedGate(total, reserved) {
  const max = Math.max(1, Number(total) || 2)
  // 保留数不能吃光全部（否则 LAN 完全不可用）
  const keep = Math.max(0, Math.min(Number(reserved) || 0, max - 1))
  const lanMax = max - keep
  let inflight = 0
  return {
    /** LAN 侧允许的最大并发。 */
    lanMax,
    /** 本机保留的槽数。 */
    reserved: keep,
    /** 尝试占用一个 LAN 槽。 */
    acquire() {
      if (inflight >= lanMax) return false
      inflight += 1
      return true
    },
    /** 释放一个槽。 */
    release() {
      if (inflight > 0) inflight -= 1
    },
    /** 当前在飞请求数。 */
    get inflight() {
      return inflight
    },
    /** 状态快照。 */
    status() {
      return { inflight, lanMax, reserved: keep, total: max }
    },
  }
}
