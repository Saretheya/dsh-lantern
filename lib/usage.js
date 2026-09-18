/**
 * dsh-lantern — 用量记账与报告（P9）。
 *
 * 设计要点（设计方案 §11.6）：
 * 1. **只统计"经由本插件"的调用**，不碰 DSH 自己的 token 统计（口径不同）；
 * 2. 账本是插件目录内的 JSONL，追加式，滚动保留；
 * 3. 报告是**自包含单文件 HTML**（内联 CSS/SVG，零 CDN），可用默认浏览器打开；
 * 4. 区分**每个 API Key** 的用量（显示名称 + 指纹），并单列**测试用量**；
 * 5. 命中率口径（已查实，DSH 计数是**互斥**的）：
 *    `输入(未命中) = inputTokens`、`输入(命中) = cacheReadTokens`，
 *    `合计 = 未命中 + 命中 + 缓存写 + 输出`；
 *    命中率 = `Σ命中 / Σ(未命中 + 命中)`，**加权而非行平均**；
 *    无缓存数据的 provider 显示 `—`（不是 0%）。
 *
 * @module dsh-lantern/usage
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendJsonl, readJsonlStreaming, PATHS } from './storage.js'

/** 一天/一周/一月/一年的毫秒数（用于分桶）。 */
const DAY_MS = 24 * 60 * 60 * 1000
/** 单位换算：1 M token。 */
export const MILLION = 1_000_000

/**
 * 把一次调用记入账本。
 *
 * 记录形态（字段名刻意用 inMiss/inHit，让"未命中/命中"一眼可辨）：
 *   { ts, provider, model, publicName, keyId, keyLabel, keyPrint,
 *     kind: 'inference'|'test'|'perf', status, ms, usage:{inMiss,inHit,cacheWrite,out,reasoning,total} }
 *
 * @param entry - 一条记录（见上）。
 * @returns Promise<void>。
 */
export async function recordUsage(entry) {
  await appendJsonl(PATHS.usage, entry)
}

/**
 * 把 DSH 的 TokenUsage 转成账本口径（互斥计数，口径见模块注释）。
 * @param usage - DSH TokenUsage（可能是 undefined）。
 * @returns 账本 usage 对象，或 undefined（没有用量数据）。
 */
export function toLedgerUsage(usage) {
  if (usage === undefined || usage === null) return undefined
  const inMiss = usage.inputTokens ?? 0
  const inHit = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens
  const out = usage.outputTokens ?? 0
  const reasoning = usage.reasoningTokens
  const total = inMiss + inHit + (cacheWrite ?? 0) + out
  return {
    inMiss,
    inHit,
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    out,
    ...(reasoning === undefined ? {} : { reasoning }),
    total,
  }
}

/** 本地时区的日键 `YYYY-MM-DD`。 */
function dayKey(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地时区的月键 `YYYY-MM`。 */
function monthKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 本地时区的年键 `YYYY`。 */
function yearKey(ts) {
  return String(new Date(ts).getFullYear())
}

/**
 * ISO 8601 周键 `YYYY-Www`（**周一起算**，跨年周按 ISO 规则归属）。
 * 这样避免"12/31 算哪一年"的歧义。
 * @param ts - 时间戳。
 * @returns ISO 周键。
 */
function isoWeekKey(ts) {
  const d = new Date(ts)
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = target.getUTCDay() === 0 ? 7 : target.getUTCDay() // 周一=1 … 周日=7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum) // 移到本周四
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((target - yearStart) / DAY_MS + 1) / 7)
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * 一个聚合桶：累计 token 与请求数。
 * @returns 空桶。
 */
function emptyBucket() {
  return { inMiss: 0, inHit: 0, cacheWrite: 0, out: 0, reasoning: 0, total: 0, calls: 0, failed: 0, hasCacheData: false }
}

/**
 * 把一条记录累加进桶。
 * @param bucket - 目标桶。
 * @param u - 账本 usage。
 */
function addToBucket(bucket, u) {
  if (u === undefined) return
  bucket.inMiss += u.inMiss ?? 0
  bucket.inHit += u.inHit ?? 0
  bucket.cacheWrite += u.cacheWrite ?? 0
  bucket.out += u.out ?? 0
  bucket.reasoning += u.reasoning ?? 0
  bucket.total += u.total ?? 0
  // 只要 provider 提供过 cacheRead/cacheWrite 字段，就算"有缓存数据"
  if ((u.inHit ?? 0) > 0 || (u.cacheWrite ?? 0) > 0) bucket.hasCacheData = true
}

/**
 * 加权命中率（`Σ命中 / Σ(未命中+命中)`），**不是行平均**。
 * @param bucket - 桶。
 * @returns 命中率 0–1，或 null（无缓存数据 → 显示 `—`）。
 */
export function hitRateOf(bucket) {
  const denom = bucket.inMiss + bucket.inHit
  if (!bucket.hasCacheData || denom <= 0) return null
  return bucket.inHit / denom
}

/**
 * 读数账本并做多维度聚合。
 *
 * 维度：时间粒度（日/周/月/年）× provider × model × **API Key** × **调用类型**。
 *
 * @param options - `{ granularity, sinceMs, nowMs }`。
 * @returns `{ buckets, totals, keys, providers, models, kinds, range }`。
 */
export async function aggregate({ granularity = 'daily', nowMs = Date.now() } = {}) {
  const keyOf = { daily: dayKey, weekly: isoWeekKey, monthly: monthKey, yearly: yearKey }[granularity] ?? dayKey

  /** @type {Map<string, {bucket:object, dims:{provider:string,model:string,keyId:string,kind:string}}>} */
  const cells = new Map()
  /** 全局合计。 */
  const totals = emptyBucket()
  /** 按 key 汇总。 */
  const byKey = new Map()
  /** 按 provider 汇总。 */
  const byProvider = new Map()
  /** 按模型（provider:model）汇总。 */
  const byModel = new Map()
  /** 按调用类型汇总（推理 / 测试 / 性能测试）。 */
  const byKind = new Map()
  /** 各粒度的桶集合（用于柱状图）。 */
  const bucketOrder = new Set()
  let earliest = null
  let latest = null
  let lines = 0

  const getCell = (bucketKey, provider, model, keyId, kind) => {
    const k = `${bucketKey}\u0000${provider}\u0000${model}\u0000${keyId}\u0000${kind}`
    let cell = cells.get(k)
    if (cell === undefined) {
      cell = { bucketKey, bucket: emptyBucket(), provider, model, keyId, kind }
      cells.set(k, cell)
    }
    return cell
  }
  const bump = (map, key, u) => {
    let b = map.get(key)
    if (b === undefined) {
      b = emptyBucket()
      map.set(key, b)
    }
    addToBucket(b, u)
    return b
  }

  await readJsonlStreaming(PATHS.usage, (rec) => {
    if (rec === null || typeof rec !== 'object') return
    const ts = Number(rec.ts)
    if (!Number.isFinite(ts)) return
    lines += 1
    if (earliest === null || ts < earliest) earliest = ts
    if (latest === null || ts > latest) latest = ts

    const provider = String(rec.provider ?? 'unknown')
    const model = String(rec.model ?? 'unknown')
    const keyId = String(rec.keyId ?? 'anonymous')
    const kind = String(rec.kind ?? 'inference')
    const u = rec.usage
    const bk = keyOf(ts)
    bucketOrder.add(bk)

    const hasUsage = u !== undefined && u !== null
    if (hasUsage) {
      const cell = getCell(bk, provider, model, keyId, kind)
      addToBucket(cell.bucket, u)
      cell.bucket.calls += 1
      addToBucket(totals, u)
    }
    // 每一行都算一次调用（含没有 usage 的失败行）
    totals.calls += 1
    // 各维度汇总：token 累加（有 usage 时）+ 调用计数（总是）
    const kb = bump(byKey, keyId, u)
    kb.calls += 1
    const pb = bump(byProvider, provider, u)
    pb.calls += 1
    const mb = bump(byModel, `${provider}\u0000${model}`, u)
    mb.calls += 1
    const kd = bump(byKind, kind, u)
    kd.calls += 1
    // 失败：不计 token，但**每个维度都要计失败次数**（漏掉会让"按类型"表的失败列恒为 0）
    if (rec.status !== 'ok') {
      if (hasUsage) getCell(bk, provider, model, keyId, kind).bucket.failed += 1
      kb.failed += 1
      pb.failed += 1
      mb.failed += 1
      kd.failed += 1
      totals.failed += 1
    }
  })

  return {
    granularity,
    bucketKeys: [...bucketOrder].sort(),
    cells: [...cells.values()].map((c) => ({
      bucketKey: c.bucketKey,
      provider: c.provider,
      model: c.model,
      keyId: c.keyId,
      kind: c.kind,
      ...c.bucket,
      hitRate: hitRateOf(c.bucket),
    })),
    totals: { ...totals, hitRate: hitRateOf(totals), lines },
    keys: [...byKey.entries()].map(([id, b]) => ({ id, ...b, hitRate: hitRateOf(b) })),
    providers: [...byProvider.entries()].map(([id, b]) => ({ id, ...b, hitRate: hitRateOf(b) })),
    models: [...byModel.entries()].map(([id, b]) => {
      const [provider, model] = id.split('\u0000')
      return { provider, model, ...b, hitRate: hitRateOf(b) }
    }),
    kinds: [...byKind.entries()].map(([id, b]) => ({ id, ...b, hitRate: hitRateOf(b) })),
    range: { earliest, latest },
  }
}

/** 把 token 数格式化为 M（保留 3 位小数）。 */
export function fmtM(n) {
  return (Number(n ?? 0) / MILLION).toFixed(3)
}

/** 把命中率格式化为百分数，无数据显示 `—`。 */
export function fmtRate(r) {
  return r === null || r === undefined ? '—' : `${(r * 100).toFixed(1)}%`
}

/** HTML 转义（报告里所有来自数据的文本都要过一遍）。 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 调用类型的中文标签。 */
const KIND_LABEL = { inference: '推理调用', test: '功能测试', perf: '性能测试' }

/**
 * 生成自包含的用量报告 HTML。
 *
 * 零外部依赖：内联 CSS + 手写 SVG 柱状图 + 少量 JS（仅用于切换视图）。
 *
 * @param options - `{ keyLabels, timezone, nowMs }`。
 *   `keyLabels` 为 `keyId -> { label, fingerprint }`，用于显示 Key 名称与指纹。
 * @returns HTML 字符串。
 */
export async function buildReportHtml({ keyLabels = new Map(), timezone = 'local', nowMs = Date.now() } = {}) {
  const views = ['daily', 'weekly', 'monthly', 'yearly']
  const data = {}
  for (const g of views) data[g] = await aggregate({ granularity: g, nowMs })

  const tzName = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      return timezone
    }
  })()

  const keyNameOf = (id) => {
    const info = keyLabels.get(id)
    if (info !== undefined) return { label: info.label ?? id, print: info.fingerprint ?? '' }
    if (id === 'anonymous') return { label: '（匿名访问）', print: '—' }
    if (id === 'unknown') return { label: '（未知来源）', print: '—' }
    return { label: id, print: '' }
  }

  /** 渲染一个视图的明细表 + 柱状图。 */
  const renderView = (g) => {
    const d = data[g]
    const isYear = g === 'yearly'
    const yearNote = isYear && d.range.latest !== null
      ? `<div class="note">当年统计截至 ${esc(dayKey(d.range.latest))}（并非完整年度）</div>`
      : ''

    // 按桶 → provider → 模型 分组
    const byBucket = new Map()
    for (const c of d.cells) {
      if (!byBucket.has(c.bucketKey)) byBucket.set(c.bucketKey, [])
      byBucket.get(c.bucketKey).push(c)
    }
    // 只列 total > 0 的模型
    let zeroModels = 0
    const rows = []
    for (const bk of d.bucketKeys.slice().reverse()) {
      const cells = byBucket.get(bk) ?? []
      const real = cells.filter((c) => c.total > 0)
      zeroModels += cells.filter((c) => c.total === 0).length
      if (real.length === 0) continue
      const providers = new Map()
      for (const c of real) {
        if (!providers.has(c.provider)) providers.set(c.provider, [])
        providers.get(c.provider).push(c)
      }
      const bucketSum = real.reduce((a, c) => a + c.total, 0)
      const bucketInMiss = real.reduce((a, c) => a + c.inMiss, 0)
      const bucketInHit = real.reduce((a, c) => a + c.inHit, 0)
      const bucketCW = real.reduce((a, c) => a + c.cacheWrite, 0)
      const bucketOut = real.reduce((a, c) => a + c.out, 0)
      const bucketHasCache = real.some((c) => c.inHit > 0 || c.cacheWrite > 0)
      const bucketRate = bucketHasCache ? bucketInHit / (bucketInMiss + bucketInHit || 1) : null

      // ⚠ 列数必须与表头严格一致（8 列），否则整行右移、表格错位。
      // 时间桶分隔行：首列放桶名，其余 7 列用 colspan 合并。
      rows.push(
        `<tr class="bucket"><td>${esc(bk)}</td><td colspan="7"></td></tr>`,
      )
      for (const [provider, list] of providers) {
        const pSum = list.reduce((a, c) => a + c.total, 0)
        const pInMiss = list.reduce((a, c) => a + c.inMiss, 0)
        const pInHit = list.reduce((a, c) => a + c.inHit, 0)
        const pCW = list.reduce((a, c) => a + c.cacheWrite, 0)
        const pOut = list.reduce((a, c) => a + c.out, 0)
        const pHas = list.some((c) => c.inHit > 0 || c.cacheWrite > 0)
        // provider 小计行：**必须凑满 8 个 <td>**（标签 + Key 占位 + 未命中 + 命中 + 缓存写 + 输出 + 合计 + 命中率）
        rows.push(
          `<tr class="prov"><td>  ${esc(provider)}</td><td></td><td class="num">${fmtM(pInMiss)}</td><td class="num">${fmtM(pInHit)}</td><td class="num">${fmtM(pCW)}</td><td class="num">${fmtM(pOut)}</td><td class="num">${fmtM(pSum)}</td><td class="num">${fmtRate(pHas ? pInHit / (pInMiss + pInHit || 1) : null)}</td></tr>`,
        )
        for (const c of list) {
          const kn = keyNameOf(c.keyId)
          const kindLabel = KIND_LABEL[c.kind] ?? c.kind
          const kindTag = c.kind === 'inference' ? '' : ` <span class="tag">${esc(kindLabel)}</span>`
          rows.push(
            `<tr><td class="cell">    ${esc(c.model)}${kindTag}</td>` +
              `<td class="cell">${esc(kn.label)} <span class="fp">${esc(kn.print)}</span></td>` +
              `<td class="num">${fmtM(c.inMiss)}</td><td class="num">${fmtM(c.inHit)}</td>` +
              `<td class="num">${fmtM(c.cacheWrite)}</td><td class="num">${fmtM(c.out)}</td>` +
              `<td class="num strong">${fmtM(c.total)}</td><td class="num">${fmtRate(c.hitRate)}</td></tr>`,
          )
        }
      }
      rows.push(
        `<tr class="sum"><td colspan="2">★ 小计</td><td class="num">${fmtM(bucketInMiss)}</td><td class="num">${fmtM(bucketInHit)}</td><td class="num">${fmtM(bucketCW)}</td><td class="num">${fmtM(bucketOut)}</td><td class="num strong">${fmtM(bucketSum)}</td><td class="num">${fmtRate(bucketRate)}</td></tr>`,
      )
    }

    // 柱状图（按 provider 分色的堆叠柱）
    const providerColors = new Map()
    const palette = ['#1677ff', '#389e0d', '#d46b08', '#722ed1', '#13c2c2', '#eb2f96', '#faad14', '#2f54eb']
    let ci = 0
    for (const p of d.providers) {
      if (!providerColors.has(p.id)) {
        providerColors.set(p.id, palette[ci % palette.length])
        ci += 1
      }
    }
    const bars = d.bucketKeys.slice(-30).map((bk) => {
      const cells = (byBucket.get(bk) ?? []).filter((c) => c.total > 0)
      const perProvider = new Map()
      for (const c of cells) perProvider.set(c.provider, (perProvider.get(c.provider) ?? 0) + c.total)
      const total = [...perProvider.values()].reduce((a, b) => a + b, 0)
      return { bucketKey: bk, perProvider, total }
    })
    const maxTotal = Math.max(1, ...bars.map((b) => b.total))
    const chartH = 160
    const barW = bars.length > 0 ? Math.max(6, Math.min(40, Math.floor(760 / bars.length) - 6)) : 20
    let x = 40
    let svgBars = ''
    for (const b of bars) {
      let y = chartH
      for (const [p, v] of b.perProvider) {
        const h = Math.max(1, Math.round((v / maxTotal) * (chartH - 20)))
        y -= h
        svgBars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${providerColors.get(p) ?? '#888'}"><title>${esc(b.bucketKey)} ${esc(p)}: ${fmtM(v)} M</title></rect>`
      }
      svgBars += `<text x="${x + barW / 2}" y="${chartH + 14}" font-size="9" text-anchor="middle" fill="#8a8f99">${esc(b.bucketKey.slice(-5))}</text>`
      svgBars += `<text x="${x + barW / 2}" y="${y - 4}" font-size="9" text-anchor="middle" fill="#555">${(b.total / MILLION).toFixed(1)}</text>`
      x += barW + 6
    }
    const legend = [...providerColors.entries()]
      .map(([p, col]) => `<span class="lg"><i style="background:${col}"></i>${esc(p)}</span>`)
      .join(' ')
    const svgW = Math.max(780, x + 20)

    return `<section class="view" data-view="${g}">
  <h2>${({ daily: '每日', weekly: '每周', monthly: '每月', yearly: '每年' })[g]}</h2>
  ${yearNote}
  <div class="chartWrap">
    <div class="legend">${legend}</div>
    <svg viewBox="0 0 ${svgW} ${chartH + 30}" width="100%" height="${chartH + 30}">
      <line x1="30" y1="${chartH}" x2="${svgW - 10}" y2="${chartH}" stroke="#e5e7eb"/>
      ${svgBars}
    </svg>
  </div>
  <table>
    <thead><tr><th>时间桶 / 模型</th><th>API Key</th><th>输入(未命中)</th><th>输入(命中)</th><th>缓存写</th><th>输出</th><th>合计 (M)</th><th>命中率</th></tr></thead>
    <tbody>${rows.join('\n') || '<tr><td colspan="8" class="empty">该视图暂无用量</td></tr>'}</tbody>
  </table>
  ${zeroModels > 0 ? `<div class="note">另有 ${zeroModels} 个模型/Key 组合本期用量为 0（已折叠，不表示漏统计）</div>` : ''}
</section>`
  }

  const t = data.daily.totals
  const w = data.weekly.totals
  const m = data.monthly.totals
  const y = data.yearly.totals
  const allRate = t.hitRate ?? w.hitRate ?? m.hitRate ?? y.hitRate

  // 按 Key 汇总表（用户要求：显示名称与指纹）
  // ⚠ 必须含有「缓存写」「输出」两列：否则"未命中 + 命中"看起来对不上「合计」
  //（合计 = 未命中 + 命中 + 缓存写 + 输出，缺列会让读者以为统计错了）。
  const keyRows = data.monthly.keys
    .filter((k) => k.calls > 0)
    .sort((a, b) => b.total - a.total)
    .map((k) => {
      const kn = keyNameOf(k.id)
      return `<tr><td>${esc(kn.label)}</td><td class="fp">${esc(kn.print)}</td><td class="num">${k.calls}</td><td class="num">${k.failed}</td><td class="num">${fmtM(k.inMiss)}</td><td class="num">${fmtM(k.inHit)}</td><td class="num">${fmtM(k.cacheWrite)}</td><td class="num">${fmtM(k.out)}</td><td class="num strong">${fmtM(k.total)}</td><td class="num">${fmtRate(k.hitRate)}</td></tr>`
    })
    .join('\n')

  // 调用类型汇总（区分推理 / 功能测试 / 性能测试）
  const kindRows = data.monthly.kinds
    .filter((k) => k.calls > 0)
    .sort((a, b) => b.total - a.total)
    .map(
      (k) =>
        `<tr><td>${esc(KIND_LABEL[k.id] ?? k.id)}</td><td class="num">${k.calls}</td><td class="num">${k.failed}</td><td class="num">${fmtM(k.inMiss)}</td><td class="num">${fmtM(k.inHit)}</td><td class="num">${fmtM(k.cacheWrite)}</td><td class="num">${fmtM(k.out)}</td><td class="num strong">${fmtM(k.total)}</td><td class="num">${fmtRate(k.hitRate)}</td></tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>LANtern · Token 用量报告</title>
<style>
:root{--fg:#1a1a1a;--fg2:#555;--fg3:#8a8f99;--bd:#e5e7eb;--bd2:#eef0f3;--bg:#fff;--accent:#1677ff;--ok:#389e0d;--bad:#d4380d}
@media (prefers-color-scheme: dark){:root{--fg:#e8eaed;--fg2:#b8bcc4;--fg3:#8a8f99;--bd:#3c4043;--bd2:#2a2d31;--bg:#1f1f1f}}
*{box-sizing:border-box}
body{margin:0;padding:24px 28px 60px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg)}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:15px;margin:22px 0 8px;color:var(--fg)}
.sub{color:var(--fg2);font-size:12.5px;margin-bottom:16px}
.cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.card{border:1px solid var(--bd2);border-radius:12px;padding:10px 14px;min-width:132px}
.card .k{font-size:11.5px;color:var(--fg3)}
.card .v{font-size:19px;font-weight:640;margin-top:2px}
.card .v small{font-size:11px;font-weight:400;color:var(--fg3)}
.tabs{display:flex;gap:6px;margin:16px 0 4px;flex-wrap:wrap}
.tabs button{border:1px solid var(--bd);background:transparent;color:var(--fg2);border-radius:8px;padding:5px 14px;cursor:pointer;font:inherit;font-size:13px}
.tabs button[aria-pressed=true]{border-color:var(--accent);color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
.view{display:none}.view.on{display:block}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:8px}
th{text-align:left;font-weight:600;color:var(--fg2);border-bottom:1px solid var(--bd);padding:6px 8px;white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid var(--bd2)}
.num{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,Consolas,monospace}
.strong{font-weight:640}
tr.bucket td{background:color-mix(in srgb,var(--accent) 5%,transparent);font-weight:600;border-bottom:1px solid var(--bd)}
tr.prov td{color:var(--fg2);font-weight:600}
tr.sum td{background:color-mix(in srgb,var(--ok) 6%,transparent);font-weight:640}
.cell{white-space:pre}
.fp{color:var(--fg3);font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
.tag{display:inline-block;font-size:10.5px;padding:0 6px;border:1px solid var(--bd);border-radius:999px;color:var(--fg3)}
.note{color:var(--fg3);font-size:12px;margin-top:8px}
.chartWrap{border:1px solid var(--bd2);border-radius:12px;padding:10px 12px;margin-top:6px}
.legend{font-size:11.5px;color:var(--fg2);margin-bottom:4px}
.lg{display:inline-flex;align-items:center;gap:4px;margin-right:12px}
.lg i{width:9px;height:9px;border-radius:2px;display:inline-block}
.empty{color:var(--fg3);text-align:center;padding:18px}
footer{margin-top:26px;color:var(--fg3);font-size:11.5px;border-top:1px solid var(--bd2);padding-top:12px}
footer ul{margin:6px 0 0;padding-left:18px}
</style></head>
<body>
<h1>LANtern · Token 用量报告</h1>
<div class="sub">
  统计范围：<b>经由本插件的调用</b>（不含本机 DSH 自身对话）·
  生成时间：${esc(new Date(nowMs).toLocaleString())} · 时区：${esc(tzName)} ·
  数据行数：${t.lines}
  ${data.daily.range.latest === null ? ' · <b>账本为空</b>' : ` · 数据区间：${esc(dayKey(data.daily.range.earliest))} ~ ${esc(dayKey(data.daily.range.latest))}`}
</div>

<div class="cards">
  <div class="card"><div class="k">今日</div><div class="v">${fmtM(t.total)}<small> M</small></div></div>
  <div class="card"><div class="k">本周</div><div class="v">${fmtM(w.total)}<small> M</small></div></div>
  <div class="card"><div class="k">本月</div><div class="v">${fmtM(m.total)}<small> M</small></div></div>
  <div class="card"><div class="k">今年</div><div class="v">${fmtM(y.total)}<small> M</small></div></div>
  <div class="card"><div class="k">缓存命中率（加权）</div><div class="v">${fmtRate(allRate)}</div></div>
  <div class="card"><div class="k">失败请求</div><div class="v">${t.failed}<small> 次</small></div></div>
</div>

<h2>按 API Key 汇总（本月）</h2>
<table>
  <thead><tr><th>Key 名称</th><th>指纹</th><th>请求数</th><th>失败</th><th>输入(未命中)</th><th>输入(命中)</th><th>缓存写</th><th>输出</th><th>合计 (M)</th><th>命中率</th></tr></thead>
  <tbody>${keyRows || '<tr><td colspan="10" class="empty">本月暂无调用</td></tr>'}</tbody>
</table>

<h2>按调用类型（本月）</h2>
<table>
  <thead><tr><th>类型</th><th>请求数</th><th>失败</th><th>输入(未命中)</th><th>输入(命中)</th><th>缓存写</th><th>输出</th><th>合计 (M)</th><th>命中率</th></tr></thead>
  <tbody>${kindRows || '<tr><td colspan="9" class="empty">本月暂无调用</td></tr>'}</tbody>
</table>

<div class="tabs" role="tablist">
  ${views.map((g, i) => `<button role="tab" data-g="${g}" aria-pressed="${i === 0}">${({ daily: '每日', weekly: '每周', monthly: '每月', yearly: '每年' })[g]}</button>`).join('')}
</div>
${views.map(renderView).join('\n')}

<footer>
  口径说明
  <ul>
    <li>单位 <b>M token</b> = 1,000,000 tokens，保留 3 位小数；悬停柱状图可见精确值。</li>
    <li><b>输入(未命中)</b> = DSH 的 <code>inputTokens</code>；<b>输入(命中)</b> = <code>cacheReadTokens</code>。</li>
    <li><b>合计</b> = 未命中 + 命中 + 缓存写入 + 输出（与 DSH 官方"互斥计数"口径一致）。</li>
    <li><b>推理 token 已包含在输出内</b>，不重复计入合计。</li>
    <li>命中率 = 命中 ÷（未命中 + 命中），分组汇总为<b>加权</b>而非行平均；<code>—</code> 表示该来源未提供缓存数据（不是 0%）。</li>
    <li>周按 <b>ISO 8601</b>（周一起算）；当年视图为"截至今日"，并非完整年度。</li>
    <li>失败请求<b>不计入</b> token 合计，但计入失败次数。</li>
    <li>仅统计通过本插件的调用；本机 DSH 自身对话不计入。</li>
  </ul>
</footer>

<script>
(function(){
  var tabs=[].slice.call(document.querySelectorAll('.tabs button'));
  var views=[].slice.call(document.querySelectorAll('.view'));
  function show(g){
    tabs.forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.g===g));});
    views.forEach(function(v){v.classList.toggle('on',v.dataset.view===g);});
  }
  tabs.forEach(function(b){b.addEventListener('click',function(){show(b.dataset.g);});});
  if(tabs.length) show(tabs[0].dataset.g);
})();
</script>
</body></html>`
}

/**
 * 报告目录里按时间排序的文件列表（新的在前）。
 * @returns 文件路径数组。
 */
export function listReports() {
  try {
    return readdirSync(PATHS.reports)
      .filter((n) => n.endsWith('.html'))
      .map((n) => join(PATHS.reports, n))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs
        } catch {
          return 0
        }
      })
  } catch {
    return []
  }
}

/**
 * 滚动清理旧报告（只保留最近 keep 份）。
 * @param keep - 保留份数。
 * @returns 删除的份数。
 */
export function pruneReports(keep = 20) {
  const files = listReports()
  let removed = 0
  for (const f of files.slice(Math.max(0, keep))) {
    try {
      unlinkSync(f)
      removed += 1
    } catch {
      /* 单个失败不影响其余 */
    }
  }
  return removed
}

/**
 * 写出一份报告，并按需要回收旧报告（含"一分钟内复用同一份"）。
 *
 * @param options - `{ keyLabels, reuseWithinMs, keep, nowMs }`。
 * @returns `{ path, reused, summary }`。
 */
export async function writeReport({ keyLabels = new Map(), reuseWithinMs = 60_000, keep = 20, nowMs = Date.now() } = {}) {
  mkdirSync(PATHS.reports, { recursive: true })
  // 一分钟内重复点击 → 复用同一份（不重复生成、不重复弹窗）
  if (reuseWithinMs > 0) {
    const latest = listReports()[0]
    if (latest !== undefined) {
      try {
        const age = nowMs - statSync(latest).mtimeMs
        if (age < reuseWithinMs) {
          return { path: latest, reused: true }
        }
      } catch {
        /* 忽略，继续生成新的 */
      }
    }
  }
  const html = await buildReportHtml({ keyLabels, nowMs })
  const d = new Date(nowMs)
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const file = join(PATHS.reports, `usage-${stamp}.html`)
  writeFileSync(file, html, 'utf8')
  pruneReports(keep)
  return { path: file, reused: false }
}

/**
 * 账本是否存在且非空。
 * @returns 是否为空。
 */
export function ledgerIsEmpty() {
  try {
    return statSync(PATHS.usage).size === 0
  } catch {
    return !existsSync(PATHS.usage)
  }
}
