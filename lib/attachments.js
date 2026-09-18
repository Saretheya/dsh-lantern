/**
 * dsh-lantern — 附件账本（P8）。
 *
 * 背景（设计方案 §7.5，**已查实**）：
 * DSH 的 `~/.dsh/attachments/v1` **没有任何垃圾回收**（官方注释原文：
 * *"may stay unreachable until a future retention policy collects them"*），
 * 且中转请求**不建会话**，因此 LAN 写入的附件是**纯孤儿**——永远没人引用、没人清理。
 * 于是**由本插件承担回收责任**（档 B：转发缓存）。
 *
 * ⚠ 三道防误删（缺一不可，宁可漏删留垃圾，绝不误删破坏本机）：
 *   ① **写入前判定"新建 / 复用"**：对象名 = 内容 sha256，若本机已有同内容对象，
 *      `saveImages()` 会**复用**它（EEXIST 去重）——此时**绝不记账、永不删除**；
 *   ② **删除前扫描 `sessions/`**：本机会话仍在引用该 id → 跳过；
 *   ③ **删除前校验**对象名 == 内容 sha256（防手改/串号）。
 *
 * 另有多重保险：
 *   - 只删**账本内自己新建**的 id，**绝不遍历 objects/ 删未知对象**；
 *   - 延迟回收（默认 5 分钟，覆盖重试与流式响应窗口）；
 *   - 引用计数（并发请求共享同一对象时，等最后一个请求结束再计时）；
 *   - **默认 dry-run**（只记日志不真删），观察期后由用户显式切换；
 *   - 每次回收写审计日志。
 *
 * @module dsh-lantern/attachments
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readJson, writeJson, PATHS } from './storage.js'

/** 对象 id 形态：`sha256:<64 位小写十六进制>`。 */
const ID_PATTERN = /^sha256:([a-f0-9]{64})$/

/**
 * 解析 attachmentId，取出 64 位十六进制摘要。
 * @param attachmentId - 形如 `sha256:abc…`。
 * @returns 摘要，或 undefined（形态非法）。
 */
export function digestOf(attachmentId) {
  const match = ID_PATTERN.exec(String(attachmentId ?? ''))
  return match?.[1]
}

/**
 * DSH 附件对象根目录（与 `dsh-attachment-local` 的规则一致：
 * `DSH_HOME/attachments/v1/objects/<前2位>/<64位>`）。
 * @returns 绝对路径。
 */
export function objectsRoot() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'attachments', 'v1', 'objects')
}

/**
 * 由摘要推出对象绝对路径。
 * @param digest - 64 位十六进制。
 * @returns 绝对路径。
 */
export function objectPathOf(digest) {
  return join(objectsRoot(), digest.slice(0, 2), digest)
}

/**
 * 计算一段字节的内容摘要（与 DSH 的 attachmentId 口径一致）。
 * @param data - 字节。
 * @returns 64 位十六进制。
 */
export function digestOfBytes(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 附件账本。
 */
export class AttachmentLedger {
  /**
   * @param ctx - Host 插件上下文（用于 logger 与 attachments 服务）。
   * @param config - 返回当前配置的函数。
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** @type {Array<{id:string,digest:string,createdAt:number,releasedAt:number|null,refCount:number,reused:boolean,bytes:number}>} */
    this.entries = []
    this.loaded = false
    this.timer = undefined
    this.disposed = false
    /** 审计日志（内存里保留最近若干条，便于诊断页展示）。 */
    this.audit = []
  }

  /** 从磁盘载入。 */
  async load() {
    const doc = await readJson(PATHS.attachmentLedger, { version: 1, entries: [] })
    this.entries = Array.isArray(doc?.entries) ? doc.entries : []
    this.loaded = true
    return this.entries.length
  }

  /** 落盘（只写插件自己的 data/）。 */
  async persist() {
    await writeJson(PATHS.attachmentLedger, {
      version: 1,
      entries: this.entries,
      updatedAt: Date.now(),
    })
  }

  /** 记一条审计。 */
  #audit(message) {
    const line = `${new Date().toISOString()} ${message}`
    this.audit.push(line)
    if (this.audit.length > 500) this.audit.splice(0, this.audit.length - 500)
    this.ctx.logger.info(`[lantern][attachment] ${message}`)
  }

  /**
   * 写入一批图片，并按"新建/复用"分别记账。
   *
   * **关键**：必须在 `saveImages()` **之前**判断对象是否已存在，
   * 据此区分"我们新建的"（可回收）与"复用本机已有的"（永不删）。
   *
   * @param images - `[{ data: Uint8Array, mediaType: string }]`。
   * @returns 图片引用数组。
   */
  async save(images) {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) {
      throw Object.assign(new Error('本机附件服务不可用'), { lanternCode: 'attachments_unavailable' })
    }
    // ① 写入**之前**判定：该内容是否已存在（存在即会被 saveImages 复用）
    const planned = []
    for (const image of images) {
      const digest = digestOfBytes(image.data)
      let existed = false
      try {
        const info = await stat(objectPathOf(digest))
        existed = info.isFile()
      } catch {
        existed = false
      }
      planned.push({ digest, bytes: image.data.byteLength, existed })
    }

    const refs = await attachments.saveImages(images)

    for (const [index, ref] of refs.entries()) {
      const plan = planned[index]
      const digest = digestOf(ref.attachmentId) ?? plan?.digest
      if (digest === undefined) continue
      if (plan?.existed === true) {
        // ② 复用本机已有对象 → **不记账、永不删**（只记审计，便于诊断）
        this.#audit(`borrowed existing object ${digest.slice(0, 12)}…（复用本机的，不回收）`)
        continue
      }
      const existing = this.entries.find((e) => e.digest === digest)
      if (existing !== undefined) {
        existing.refCount += 1
        existing.releasedAt = null
        continue
      }
      this.entries.push({
        id: String(ref.attachmentId),
        digest,
        bytes: plan?.bytes ?? ref.bytes ?? 0,
        createdAt: Date.now(),
        releasedAt: null,
        refCount: 1,
        reused: false,
      })
    }
    await this.persist()
    return refs
  }

  /**
   * 请求结束：引用计数递减，归零才开始计时。
   * @param refs - 本次请求用到的图片引用（`save()` 的返回值）。
   */
  async release(refs) {
    let changed = false
    for (const ref of refs ?? []) {
      const digest = digestOf(ref?.attachmentId)
      if (digest === undefined) continue
      const entry = this.entries.find((e) => e.digest === digest)
      if (entry === undefined || entry.reused === true) continue
      entry.refCount = Math.max(0, entry.refCount - 1)
      if (entry.refCount === 0) entry.releasedAt = Date.now()
      changed = true
    }
    if (changed) await this.persist()
  }

  /**
   * 扫描本机会话日志，判断某 id 是否仍被引用（第②道防护）。
   *
   * 会话文件是**多帧 zstd**，这里做的是"尽力而为"的扫描：
   * 命中即视为被引用（保守），**宁可漏删也不误删**。
   *
   * @param digest - 内容摘要。
   * @returns 是否被任何会话引用。
   */
  async referencedByAnySession(digest) {
    const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
    const sessionsRoot = join(home, 'sessions')
    const needle = `sha256:${digest}`
    const files = []
    const walk = async (dir, depth) => {
      if (depth > 4) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full, depth + 1)
        else if (entry.name.endsWith('.zstd') || entry.name.endsWith('.jsonl')) files.push(full)
      }
    }
    await walk(sessionsRoot, 0)

    const { zstdDecompressSync } = await import('node:zlib')
    for (const file of files) {
      try {
        const buf = await readFile(file)
        let text
        if (file.endsWith('.zstd')) {
          // 多帧：逐个魔数位置尝试解压，任一帧命中即算引用
          try {
            text = zstdDecompressSync(buf).toString('utf8')
          } catch {
            text = ''
          }
          if (!text.includes(needle)) {
            // 逐帧扫描：找 zstd 魔数 28 B5 2F FD
            for (let i = 0; i + 3 < buf.length; i += 1) {
              if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
                try {
                  const frame = zstdDecompressSync(buf.subarray(i)).toString('utf8')
                  if (frame.includes(needle)) return true
                } catch {
                  /* 单帧失败继续 */
                }
              }
            }
          }
        } else {
          text = buf.toString('utf8')
        }
        if (text.includes(needle)) return true
      } catch {
        /* 单文件失败不影响判定（保守：失败时不以"未引用"论处——见下方调用点的处理） */
        this.#audit(`warning: 无法读取会话文件 ${file}，本次回收将保守跳过相关项`)
        return true
      }
    }
    return false
  }

  /**
   * 校验对象存在且其内容 sha256 == 对象名（第③道防护）。
   * @param digest - 内容摘要。
   * @returns 是否校验通过（可安全删除）。
   */
  async verifyDigest(digest) {
    try {
      const buf = await readFile(objectPathOf(digest))
      return digestOfBytes(buf) === digest
    } catch {
      return false
    }
  }

  /**
   * 回收一轮。
   *
   * @param options - `{ dryRun }`（默认取配置 `attachments.dryRun`，默认 true）。
   * @returns `{ scanned, reclaimed, skipped, errors, dryRun }`。
   */
  async sweep({ dryRun } = {}) {
    const cfg = this.config()
    const attCfg = cfg?.attachments ?? {}
    const delayMs = Number.isFinite(attCfg.reclaimDelayMs) ? attCfg.reclaimDelayMs : 5 * 60 * 1000
    const useDryRun = dryRun ?? attCfg.dryRun !== false
    const checkSessions = attCfg.checkSessionRefs !== false

    const now = Date.now()
    const summary = { scanned: 0, reclaimed: 0, skipped: 0, errors: 0, dryRun: useDryRun, details: [] }
    let removedAny = false

    for (const entry of [...this.entries]) {
      summary.scanned += 1
      // 复用本机的对象：**永不删**
      if (entry.reused === true) {
        summary.skipped += 1
        continue
      }
      // 仍在被使用
      if ((entry.refCount ?? 0) > 0) {
        summary.skipped += 1
        continue
      }
      // 未到回收时间
      if (entry.releasedAt === null || entry.releasedAt === undefined || now - entry.releasedAt < delayMs) {
        summary.skipped += 1
        continue
      }
      // ② 会话引用检查
      if (checkSessions) {
        const referenced = await this.referencedByAnySession(entry.digest)
        if (referenced) {
          entry.pinned = true
          summary.skipped += 1
          summary.details.push({ digest: entry.digest, action: 'skip', reason: '本机会话仍引用' })
          this.#audit(`skip ${entry.digest.slice(0, 12)}…：本机会话仍引用（已标记 pinned）`)
          continue
        }
      }
      // ③ 内容校验
      const verified = await this.verifyDigest(entry.digest)
      if (!verified) {
        summary.skipped += 1
        summary.details.push({ digest: entry.digest, action: 'skip', reason: '对象不存在或内容校验失败' })
        this.#audit(`skip ${entry.digest.slice(0, 12)}…：对象缺失或校验失败（保守跳过）`)
        continue
      }

      if (useDryRun) {
        summary.details.push({ digest: entry.digest, action: 'would-reclaim' })
        this.#audit(`[dry-run] would reclaim ${entry.digest.slice(0, 12)}…（${entry.bytes} bytes）`)
        continue
      }

      try {
        await rm(objectPathOf(entry.digest))
        this.entries = this.entries.filter((e) => e !== entry)
        removedAny = true
        summary.reclaimed += 1
        summary.details.push({ digest: entry.digest, action: 'reclaimed' })
        this.#audit(`reclaimed ${entry.digest.slice(0, 12)}…（${entry.bytes} bytes）`)
      } catch (error) {
        summary.errors += 1
        summary.details.push({ digest: entry.digest, action: 'error', reason: String(error?.message ?? error) })
        this.#audit(`error reclaiming ${entry.digest.slice(0, 12)}…：${error?.message}`)
      }
    }

    if (removedAny) await this.persist()
    return summary
  }

  /** 启动定时回收（默认每 5 分钟一轮）。 */
  start() {
    const cfg = this.config()
    const interval = Number.isFinite(cfg?.attachments?.sweepIntervalMs) ? cfg.attachments.sweepIntervalMs : 5 * 60 * 1000
    this.timer = setInterval(() => {
      void this.sweep().catch((error) => {
        this.ctx.logger.warn(`[lantern][attachment] 回收失败：${error?.message}`)
      })
    }, interval)
    this.timer.unref?.()
    return this
  }

  /** 停止定时器。 */
  dispose() {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 诊断快照（设置面板用）。 */
  status() {
    const cfg = this.config()
    const pending = this.entries.filter((e) => (e.refCount ?? 0) === 0 && e.releasedAt !== null)
    return {
      total: this.entries.length,
      inUse: this.entries.filter((e) => (e.refCount ?? 0) > 0).length,
      pendingReclaim: pending.length,
      pinned: this.entries.filter((e) => e.pinned === true).length,
      bytes: this.entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0),
      dryRun: cfg?.attachments?.dryRun !== false,
      reclaimDelayMs: cfg?.attachments?.reclaimDelayMs ?? 5 * 60 * 1000,
      objectsRoot: objectsRoot(),
      recentAudit: this.audit.slice(-20),
    }
  }
}
