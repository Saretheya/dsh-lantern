/**
 * dsh-lantern — 鉴权层（Host 半部内部模块）。
 *
 * 设计要点（设计方案 §8、§11.5.6.3、§11.5.6.3a）：
 * 1. **只存哈希**：`data/keys.json` 内绝无明文 key，只存 sha256 + 尾部指纹；
 * 2. **明文只显示一次**：生成时返回，之后无法再查看；
 * 3. **服务端不依赖前缀**：校验只算 sha256 比对，故切换 `format` 不会让旧 key 失效；
 * 4. **`timingSafeEqual` 先比长度**：不等长入参会抛错，必须处理
 *    （否则"key 打错"会变成 500 而不是 401）；
 * 5. **默认无匿名放行**：没有任何 key 时，拒绝一切局域网请求。
 *
 * key 格式（默认 `sk`，对齐 DeepSeek / 硅基流动 / OpenAI）：
 *   sk-<43 位 base64url>        总长 46
 *   sk-<32 位十六进制>          sk-hex，与 DeepSeek 完全同构
 *   sk-lantern-<43 位 base64url> sk-lantern，抗密钥扫描误报
 *
 * @module dsh-lantern/auth
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readJson, writeJson, PATHS } from './storage.js'

/** key 格式预设。 */
export const KEY_FORMATS = Object.freeze({
  /** 默认：`sk-` + 43 位 base64url（与主流 provider 同形态）。 */
  sk: { prefix: 'sk-', kind: 'base64url', length: 43 },
  /** 与 DeepSeek 完全同构：`sk-` + 32 位十六进制。 */
  'sk-hex': { prefix: 'sk-', kind: 'hex', length: 32 },
  /** 带品牌段，抗密钥扫描误报。 */
  'sk-lantern': { prefix: 'sk-lantern-', kind: 'base64url', length: 43 },
})

/** 当前默认格式。 */
export const DEFAULT_FORMAT = 'sk'

/**
 * 生成一个 base64url 字符串（无填充）。
 * @param bytes - 随机字节数。
 * @returns URL 安全的 base64 字符串。
 */
function base64url(bytes) {
  return randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 按指定格式生成一个明文 key。
 * @param format - `sk` | `sk-hex` | `sk-lantern`。
 * @returns 明文 key。
 */
export function generateKey(format = DEFAULT_FORMAT) {
  const preset = KEY_FORMATS[format] ?? KEY_FORMATS[DEFAULT_FORMAT]
  if (preset.kind === 'hex') {
    // 32 位十六进制 = 16 字节 = 128 bit 熵（与 DeepSeek 同构）
    return `${preset.prefix}${randomBytes(Math.ceil(preset.length / 2)).toString('hex').slice(0, preset.length)}`
  }
  // base64url：32 字节 = 256 bit 熵；无填充时正好 43 字符
  const body = base64url(32)
  return `${preset.prefix}${preset.length === body.length ? body : body.slice(0, preset.length)}`
}

/**
 * 计算 key 的 sha256（十六进制）。
 * @param plaintext - 明文 key。
 * @returns 64 字符十六进制摘要。
 */
export function hashKey(plaintext) {
  return createHash('sha256').update(String(plaintext), 'utf8').digest('hex')
}

/**
 * 显示用**指纹**：从 `sha256` 派生的 8 位十六进制，形如 `1f3c9a02`。
 *
 * ⚠ 语义说明（"指纹"是**派生**，不是另行分配的编号）：
 * 指纹必须能由原数据**确定性重算**，因此这里直接从已有的 `sha256` 取前 8 位 ——
 * 与 TLS 证书指纹、SSH 主机密钥指纹同一种思路。
 *
 * 为什么不再从明文截取（原 `head`/`tail` 方案已删除）：
 * 1. **前缀污染**：`sk-lantern-` 长 11 字符，`slice(0,8)` 全落在固定前缀里，
 *    指纹退化成常量（实测空间仅 64 种）；
 * 2. **必须占满列宽**：`head…tail` 共 8 字符且内容不可控，
 *    在 ~390px 的表格里会挤压「创建时间 / 最近使用」等列（截图已证实）；
 * 3. **无法重算**：一旦改为独立字段就得维护去重表，且算法变更后旧记录永远对不上。
 *
 * `sha256` 每条记录都有、与密钥一一对应，因此**零新增字段、零迁移、随时可重算**。
 *
 * 碰撞概率（生日问题，空间 16^8 = 4.29e9）：
 * - 10 个 Key：约 1.0e-8（1 亿分之一）
 * - 20 个 Key：约 4.4e-8（2300 万分之一）
 * - 50 个 Key：约 2.8e-7（350 万分之一）
 * 日常（几十个 Key）几乎不会相同；且即便相同，列表另有**标签**列可区分。
 *
 * @param record - key 记录（需含 `sha256`）。
 * @returns 8 位十六进制指纹；无 `sha256` 时返回 `—`。
 */
export function fingerprintOf(record) {
  const hash = String(record?.sha256 ?? '')
  if (hash.length < 8) return '—'
  return hash.slice(0, 8)
}

/**
 * 定时安全比较两个字符串（先比长度）。
 * `timingSafeEqual` 对不等长入参会抛错，这里显式处理。
 * @param a - 一侧字符串。
 * @param b - 另一侧字符串。
 * @returns 是否相等。
 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Key 仓库：加载 / 生成 / 校验 / 增删改 / 轮换。
 * 全部落在 `data/keys.json`（只存哈希）。
 */
export class KeyStore {
  /**
   * @param config - 返回当前配置的函数（读取 auth.format 等）。
   */
  constructor(config) {
    this.config = config
    /** @type {Array<object>} */
    this.records = []
    this.loaded = false
  }

  /** 从磁盘载入（不存在则视为空）。 */
  async load() {
    const doc = await readJson(PATHS.keys, { version: 1, keys: [] })
    this.records = Array.isArray(doc?.keys) ? doc.keys : []
    this.loaded = true
    return this.records
  }

  /** 原子写回磁盘。 */
  async persist() {
    await writeJson(PATHS.keys, { version: 1, keys: this.records })
  }

  /** 对外的安全视图：绝不含明文，也不含完整哈希之外的敏感信息。 */
  list() {
    return this.records.map((r) => ({
      id: r.id,
      label: r.label,
      fingerprint: fingerprintOf(r),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? null,
      enabled: r.enabled !== false,
      limits: r.limits ?? null,
      expiresAt: r.expiresAt ?? null,
    }))
  }

  /** 当前是否一个可用 key 都没有（用于"默认拒绝一切"判定）。 */
  get isEmpty() {
    return this.records.filter((r) => r.enabled !== false).length === 0
  }

  /**
   * 生成一个新 key。
   * @param options - 标签与专属限额。
   * @returns `{ record, plaintext }` —— **plaintext 只在此刻出现一次**。
   */
  async create({ label = '', limits = null, format = undefined } = {}) {
    const cfg = this.config()
    const useFormat = format ?? cfg?.auth?.format ?? DEFAULT_FORMAT
    const plaintext = generateKey(useFormat)
    const record = {
      id: `key_${randomUUID().slice(0, 8)}`,
      label: String(label || '未命名'),
      sha256: hashKey(plaintext),
      // 不再存 `head`/`tail`：它们只服务于旧的显示指纹，属于可从 `sha256`
      // 重算的冗余数据（已确认不参与鉴权、不对外暴露）。指纹现由 `fingerprintOf()`
      // 直接取 `sha256` 前 8 位得出 —— 零冗余、零迁移、随时可重算。
      format: useFormat,
      createdAt: Date.now(),
      lastUsedAt: null,
      enabled: true,
      limits: limits ?? null,
    }
    this.records.push(record)
    await this.persist()
    return { record: { ...record, sha256: undefined }, plaintext }
  }

  /**
   * 校验一个明文 key。
   * @param presented - 客户端提交的 key。
   * @returns 命中的记录，或 undefined。
   */
  verify(presented) {
    if (typeof presented !== 'string' || presented.length === 0) return undefined
    const digest = hashKey(presented)
    for (const record of this.records) {
      if (record.enabled === false) continue
      if (record.expiresAt !== undefined && record.expiresAt !== null && Date.now() > record.expiresAt) continue
      // 先做定时安全比较（长度一致的十六进制摘要）
      if (safeEqual(record.sha256, digest)) return record
    }
    return undefined
  }

  /**
   * 记录一次使用（只写时间戳，不记 IP，减少隐私面）。
   * @param record - 命中的记录。
   */
  async touch(record) {
    const target = this.records.find((r) => r.id === record.id)
    if (target === undefined) return
    target.lastUsedAt = Date.now()
    // 频率限制：最多每分钟落盘一次，避免每个请求都写磁盘
    const now = Date.now()
    if (this._lastTouchPersist === undefined || now - this._lastTouchPersist > 60_000) {
      this._lastTouchPersist = now
      await this.persist().catch(() => {})
    }
  }

  /**
   * 修改标签 / 启停 / 专属限额。
   * @param id - key id。
   * @param patch - 要改的字段。
   * @returns 是否命中。
   */
  async update(id, patch = {}) {
    const record = this.records.find((r) => r.id === id)
    if (record === undefined) return false
    if (typeof patch.label === 'string') record.label = patch.label
    if (typeof patch.enabled === 'boolean') record.enabled = patch.enabled
    if (patch.limits === null || (typeof patch.limits === 'object' && patch.limits !== undefined)) {
      record.limits = patch.limits
    }
    await this.persist()
    return true
  }

  /**
   * 删除一个 key（不可恢复）。
   * @param id - key id。
   * @returns 是否命中。
   */
  async remove(id) {
    const before = this.records.length
    this.records = this.records.filter((r) => r.id !== id)
    if (this.records.length === before) return false
    await this.persist()
    return true
  }

  /**
   * 轮换：生成新 key，旧 key 保留一段过渡期（默认 24h，0 = 立即失效）。
   * @param id - 要轮换的旧 key。
   * @param graceHours - 过渡期小时数。
   * @returns `{ plaintext, newId, oldExpiresAt }`。
   */
  async rotate(id, graceHours = 24) {
    const old = this.records.find((r) => r.id === id)
    if (old === undefined) return undefined
    const label = old.label
    const limits = old.limits ?? null
    const format = old.format
    if (graceHours <= 0) {
      await this.remove(id)
    } else {
      old.expiresAt = Date.now() + graceHours * 3600_000
      await this.persist()
    }
    const created = await this.create({ label: `${label}（轮换）`, limits, format })
    return { plaintext: created.plaintext, newId: created.record.id, oldExpiresAt: old.expiresAt ?? null }
  }
}

/**
 * 从请求中提取 Bearer / x-api-key 凭据。
 * @param headers - Node 请求头（小写键）。
 * @returns 提交的 key，或 undefined。
 */
export function extractCredential(headers) {
  const auth = headers.authorization ?? headers.Authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match) return match[1].trim()
  }
  const xApiKey = headers['x-api-key']
  if (typeof xApiKey === 'string' && xApiKey.trim().length > 0) return xApiKey.trim()
  return undefined
}
