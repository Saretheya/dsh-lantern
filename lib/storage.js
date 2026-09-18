/**
 * dsh-lantern — 本地存储层（Host 半部内部模块）。
 *
 * 隔离纪律（设计方案 §7.6，用户明确要求）：
 * 1. **唯一写入位置**是本插件自己的 `<插件根>/data/`；
 * 2. **不写** settings.yaml（故不使用 ctx.settings.installSection）、
 *    不写 sessions/ storages/ .credentials.yaml、不碰 npm 安装树；
 * 3. 运行期临时文件也放 `data/tmp/`，**不使用 os.tmpdir()**；
 * 4. 写入一律 tmp + rename 原子替换，避免半截文件。
 *
 * 目录布局：
 *   data/config.json              全局配置（开关/限额/端口/过滤…）
 *   data/keys.json                局域网访问 key（只存 sha256，绝无明文）
 *   data/capabilities.json        能力缓存/覆盖/测试结果
 *   data/usage.jsonl              用量账本（追加式 JSONL）
 *   data/usage-archive-<year>.jsonl 归档
 *   data/reports/usage-<ts>.html  用量报告
 *   data/logs/*.log               运行日志
 *   data/tmp/                     运行期临时文件
 *
 * @module dsh-lantern/storage
 */
import { mkdir, readFile, rename, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录（本文件位于 <root>/lib/storage.js）。 */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 插件自有数据目录——本插件**唯一**的写入位置。 */
export const DATA_DIR = join(PACKAGE_ROOT, 'data')

export const PATHS = Object.freeze({
  data: DATA_DIR,
  tmp: join(DATA_DIR, 'tmp'),
  logs: join(DATA_DIR, 'logs'),
  reports: join(DATA_DIR, 'reports'),
  config: join(DATA_DIR, 'config.json'),
  keys: join(DATA_DIR, 'keys.json'),
  capabilities: join(DATA_DIR, 'capabilities.json'),
  usage: join(DATA_DIR, 'usage.jsonl'),
  attachmentLedger: join(DATA_DIR, 'attachment-ledger.json'),
  diagnostics: join(DATA_DIR, 'diagnostics.json'),
})

/** 所有需要预先存在的目录（启动时一次性建好）。 */
const REQUIRED_DIRS = [DATA_DIR, PATHS.tmp, PATHS.logs, PATHS.reports]

/**
 * 建好插件自有的目录树。
 * 只创建目录，不写任何外部路径。
 * @returns 数据目录的绝对路径。
 */
export async function ensureDirs() {
  for (const dir of REQUIRED_DIRS) await mkdir(dir, { recursive: true })
  return DATA_DIR
}

/**
 * 读一个 JSON 文件；不存在或损坏时返回兜底值（不抛错，避免拖垮插件加载）。
 * @param file - 绝对路径。
 * @param fallback - 读取失败时的返回值。
 * @returns 解析后的对象，或兜底值。
 */
export async function readJson(file, fallback = undefined) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 原子写一个 JSON 文件（tmp + rename），并确保父目录存在。
 * 全程只落在插件自己的 data/ 内。
 *
 * 临时文件放在 `data/tmp/`（而不是目标文件旁边）：
 * 这样即使进程被强杀留下半截文件，也会被启动时的 `sweepTmp()` 清掉，
 * 不会污染 `data/` 根目录（本机实测踩过：强杀后残留 `*.tmp-<pid>-<ts>`）。
 *
 * @param file - 目标绝对路径。
 * @param value - 可 JSON 序列化的值。
 */
export async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await mkdir(PATHS.tmp, { recursive: true })
  const tmp = join(PATHS.tmp, `tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * 追加一行 JSONL（用量账本用）。
 * @param file - 目标绝对路径。
 * @param record - 一行记录。
 */
export async function appendJsonl(file, record) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
}

/**
 * 流式逐行读 JSONL，边读边归约——账本可能很大，避免一次性载入内存。
 * 单行解析失败只跳过该行，不中断整轮。
 * @param file - 目标绝对路径。
 * @param onRecord - 每行的回调（同步）。
 * @returns 成功解析的行数。
 */
export async function readJsonlStreaming(file, onRecord) {
  let handle
  try {
    const { open } = await import('node:fs/promises')
    handle = await open(file, 'r')
  } catch {
    return 0
  }
  let count = 0
  let carry = ''
  try {
    const stream = handle.createReadStream({ encoding: 'utf8' })
    for await (const chunk of stream) {
      carry += chunk
      let index = carry.indexOf('\n')
      while (index >= 0) {
        const line = carry.slice(0, index).trim()
        carry = carry.slice(index + 1)
        if (line.length > 0) {
          try {
            onRecord(JSON.parse(line))
            count += 1
          } catch {
            /* 跳过损坏行 */
          }
        }
        index = carry.indexOf('\n')
      }
    }
    const tail = carry.trim()
    if (tail.length > 0) {
      try {
        onRecord(JSON.parse(tail))
        count += 1
      } catch {
        /* 跳过损坏行 */
      }
    }
  } finally {
    await handle.close().catch(() => {})
  }
  return count
}

/**
 * 启动时清理 data/tmp/ 里的残留临时文件（进程崩溃遗留）。
 * 只清插件自己的临时目录。
 * @param maxAgeMs - 超过该年龄的文件才删（默认 1 小时，避免误删正在写的）。
 * @returns 清理掉的文件数。
 */
export async function sweepTmp(maxAgeMs = 3600_000) {
  let removed = 0
  try {
    const entries = await readdir(PATHS.tmp)
    const now = Date.now()
    for (const entry of entries) {
      const full = join(PATHS.tmp, entry)
      try {
        const info = await stat(full)
        if (info.isFile() && now - info.mtimeMs > maxAgeMs) {
          await unlink(full)
          removed += 1
        }
      } catch {
        /* 单个文件失败不影响其它 */
      }
    }
  } catch {
    /* 目录不存在等情况忽略 */
  }
  return removed
}
