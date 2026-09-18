window.__ModuleLoader__.load({
  id: 'dsh-lantern',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    // ────────────────────────────── 常量与工具 ──────────────────────────────

    const ENDPOINT = 'lantern'
    const RPC_PATH = '/api/lantern'

    /** 把管理 RPC 的 `{ok,value}` 信封解包成值或抛错。 */
    function unwrap(result) {
      if (result && result.ok === true) return result.value
      if (result && result.ok === false) {
        const error = new Error(result.error && result.error.message ? result.error.message : 'LANtern 请求失败')
        error.code = result.error && result.error.code
        throw error
      }
      return result
    }

    /** 生成一个 class 名（统一前缀 .dim-lt-）。 */
    const cx = (...names) => names.filter(Boolean).map((n) => `dim-lt-${n}`).join(' ')

    /** 格式化时间戳为本地可读。 */
    function fmtTime(ts) {
      if (ts === null || ts === undefined) return '—'
      try {
        return new Date(ts).toLocaleString()
      } catch {
        return String(ts)
      }
    }

    // ────────────────────────────── 样式 ──────────────────────────────

    const STYLES = `
.dim-lt-page { display: flex; flex-direction: column; height: 100%; font-family: var(--dsw-font-family); }
.dim-lt-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px 24px; border-bottom: 1px solid var(--dsw-alias-border-default, #e5e5e5); }
.dim-lt-brandName { font-size: 18px; font-weight: 640; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dim-lt-brandDesc { font-size: 13px; color: var(--dsw-alias-label-secondary, #555); margin: 3px 0 0; }
.dim-lt-headerActions { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.dim-lt-layout { display: flex; flex: 1; overflow: hidden; }
/* 左栏宽度自适应：设置窗口在本机只有 ~800px，固定 208px 会把右栏压到 ~340px，
   长文案必然把表格挤变形（实测：绑定单元格被撑到 215px 高）。
   这里用 clamp 让它随可用宽度收缩，右栏因此拿到更多空间。 */
.dim-lt-rail { width: clamp(124px, 26%, 176px); flex-shrink: 0; border-right: 1px solid var(--dsw-alias-border-default, #e5e5e5); padding: 8px; overflow-y: auto; display: grid; align-content: start; gap: 6px; }
.dim-lt-railDivider { height: 1px; background: var(--dsw-alias-border-l2, #eef0f3); margin: 6px 4px; }
.dim-lt-railFoot { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); padding: 6px 10px 2px; }
.dim-lt-nav { width: 100%; min-height: 42px; display: grid; grid-template-columns: 26px minmax(0,1fr) auto; align-items: center; gap: 9px; padding: 7px 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 12px; color: inherit; background: var(--dsw-alias-bg-layer-3, #fff); font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, background .16s ease; }
.dim-lt-nav:hover { border-color: color-mix(in srgb, #1677ff 25%, var(--dsw-alias-border-l2, #eef0f3)); }
.dim-lt-nav[aria-selected="true"] { border-color: color-mix(in srgb, #1677ff 43%, var(--dsw-alias-border-l2, #dfe1e5)); color: #1677ff; background: color-mix(in srgb, #1677ff 10%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-lt-navIcon { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 8px; background: color-mix(in srgb, #1677ff 10%, transparent); font-size: 13px; }
.dim-lt-navLabel { min-width: 0; display: grid; }
/* 名称与 slug **都必须省略号截断**：
   只给 strong 加省略号时，slug（如 deepseek-official）会换行成两行，
   把该按钮撑得比其它按钮高、整列高度参差（用户实测发现）。 */
.dim-lt-navLabel strong { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-lt-navLabel span { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dim-lt-navCount { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.dim-lt-panel { flex: 1; overflow-y: auto; padding: 16px 16px 40px; min-width: 0; }
.dim-lt-section { border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; padding: 14px 16px; margin-bottom: 14px; background: var(--dsw-alias-bg-layer-3, #fff); }
.dim-lt-sectionTitle { font-size: 14px; font-weight: 640; color: var(--dsw-alias-label-primary, #1a1a1a); margin: 0 0 4px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dim-lt-sectionHint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f99); margin: 0 0 10px; line-height: 1.55; }
.dim-lt-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dim-lt-field { display: grid; gap: 4px; }
.dim-lt-fieldLabel { font-size: 12px; color: var(--dsw-alias-label-secondary, #555); }
.dim-lt-input, .dim-lt-select { height: 30px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff); color: inherit; font: inherit; font-size: 13px; }
.dim-lt-input:focus, .dim-lt-select:focus { outline: none; border-color: #1677ff; }
.dim-lt-input[type="number"] { width: 92px; }
.dim-lt-btn { font-size: 12px; line-height: 18px; padding: 4px 11px; border: 1px solid var(--dsw-alias-border-l2, #dfe1e5); border-radius: 8px; background: var(--dsw-alias-bg-layer-3, #fff); color: inherit; cursor: pointer; font-family: inherit; transition: border-color .15s ease, background .15s ease; }
.dim-lt-btn:hover:not(:disabled) { border-color: color-mix(in srgb, #1677ff 45%, var(--dsw-alias-border-l2, #dfe1e5)); background: color-mix(in srgb, #1677ff 5%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-lt-btn:disabled { opacity: .45; cursor: not-allowed; }
.dim-lt-btnPrimary { border-color: #1677ff; color: #1677ff; background: color-mix(in srgb, #1677ff 8%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-lt-btnDanger { border-color: color-mix(in srgb, #d4380d 45%, var(--dsw-alias-border-l2, #dfe1e5)); color: #d4380d; }
.dim-lt-btnDanger:hover:not(:disabled) { background: color-mix(in srgb, #d4380d 6%, var(--dsw-alias-bg-layer-3, #fff)); }
.dim-lt-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.dim-lt-table th { text-align: left; font-weight: 600; color: var(--dsw-alias-label-secondary, #555); padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l2, #eef0f3); white-space: nowrap; }
/* td 允许长 token 换行（IP、模型名等），避免把表格撑宽/撑高 */
.dim-lt-table td { padding: 7px 8px; border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2, #eef0f3) 60%, transparent); vertical-align: middle; overflow-wrap: anywhere; }
.dim-lt-table tr:last-child td { border-bottom: none; }
/* 单行省略号截断（配合 title 悬停显示全文） */
.dim-lt-ellipsis { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Key 名称单元格：名称截断 + 可选 ⓘ 图标同一行 */
.dim-lt-keyNameCell { display: flex; align-items: center; gap: 4px; min-width: 0; }
.dim-lt-keyNameCell .dim-lt-ellipsis { min-width: 0; }
/* 「已删除」的 Key 行整体置灰（不删除数据，只是视觉降级） */
.dim-lt-rowDeleted td { color: var(--dsw-alias-label-tertiary, #8a8f99); }
.dim-lt-rowDeleted .dim-lt-mono { color: var(--dsw-alias-label-tertiary, #8a8f99); }
/* ⓘ 注释图标：悬停显示 title（原生 tooltip，不占版面） */
.dim-lt-infoIcon { flex-shrink: 0; cursor: help; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
/* 绑定地址单元格：地址 + ⓘ 同一行，避免说明文字把这一列撑高 */
.dim-lt-bindCell { display: flex; align-items: center; gap: 4px; }
/* 状态列（含「运行中」药丸）保持一行：曾因列宽被挤压成"运行/中"两行（#5）。
   设为 nowrap 并给最小宽度，宁可让"绑定"列换行，也不让状态药丸断行。 */
.dim-lt-statusCell { white-space: nowrap; }
.dim-lt-statusCell .dim-lt-pill { white-space: nowrap; }
.dim-lt-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
/* 药丸**不可被压缩**：否则同行出现长文本时（如"未配置凭据，请先登录"），
   flex 会把药丸挤成竖排单字（实测："未知"竖成两行、"不支持"竖成三行）。 */
.dim-lt-pill { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); color: var(--dsw-alias-label-secondary, #555); flex-shrink: 0; white-space: nowrap; }
/* 能力/结果行的首列标签（如"工具调用"）同样不可压缩 */
.dim-lt-cap > span:first-child { flex-shrink: 0; }
.dim-lt-pillOn { border-color: color-mix(in srgb, #389e0d 45%, transparent); color: #389e0d; background: color-mix(in srgb, #389e0d 8%, transparent); }
.dim-lt-pillOff { border-color: color-mix(in srgb, #8a8f99 40%, transparent); color: #8a8f99; }
.dim-lt-pillWarn { border-color: color-mix(in srgb, #d46b08 45%, transparent); color: #d46b08; background: color-mix(in srgb, #d46b08 8%, transparent); }
.dim-lt-notice { padding: 9px 12px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); font-size: 12.5px; line-height: 1.6; margin-bottom: 10px; }
.dim-lt-noticeInfo { border-color: color-mix(in srgb, #1677ff 32%, transparent); background: color-mix(in srgb, #1677ff 6%, transparent); }
.dim-lt-noticeWarn { border-color: color-mix(in srgb, #d46b08 38%, transparent); background: color-mix(in srgb, #d46b08 7%, transparent); color: #d46b08; }
.dim-lt-noticeError { border-color: color-mix(in srgb, #d4380d 38%, transparent); background: color-mix(in srgb, #d4380d 6%, transparent); color: #d4380d; }
.dim-lt-noticeOk { border-color: color-mix(in srgb, #389e0d 38%, transparent); background: color-mix(in srgb, #389e0d 6%, transparent); color: #389e0d; }
/* 就地反馈行（放在产生操作的位置下方，而不是页面顶部） */
.dim-lt-inline { font-size: 12.5px; line-height: 1.6; margin-top: 8px; }
.dim-lt-inlineOk { color: #389e0d; }
.dim-lt-inlineErr { color: #d4380d; word-break: break-word; }
.dim-lt-inlineWarn { color: #d46b08; }
/* 操作行：在对应条目下方均匀分布 */
.dim-lt-actions { display: flex; gap: 8px; }
.dim-lt-actions > .dim-lt-btn { flex: 1 1 0; text-align: center; }
/* 临时弹窗（自建遮罩层；DSH 无原生 modal 插槽） */
.dim-lt-modalMask { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; background: rgb(0 0 0 / 32%); padding: 24px; }
.dim-lt-modalCard { width: min(560px, 100%); max-height: 80vh; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 14px; background: var(--dsw-alias-bg-layer-3, #fff); box-shadow: 0 18px 48px rgb(0 0 0 / 18%); padding: 18px 20px; }
.dim-lt-modalTitle { margin: 0 0 6px; font-size: 15px; font-weight: 640; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dim-lt-modalHint { margin: 0 0 12px; font-size: 12.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #555); }
.dim-lt-modalFoot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
.dim-lt-keyBox { display: flex; gap: 8px; align-items: center; }
/* 用量概览小卡片 */
.dim-lt-miniStat { border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 10px; padding: 6px 12px; min-width: 96px; }
.dim-lt-miniStatK { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.dim-lt-miniStatV { font-size: 16px; font-weight: 640; margin-top: 1px; font-variant-numeric: tabular-nums; }
.dim-lt-keyBox > .dim-lt-input { flex: 1; min-width: 0; }
.dim-lt-model { border: 1px solid var(--dsw-alias-border-l2, #eef0f3); border-radius: 10px; margin-bottom: 8px; overflow: hidden; }
.dim-lt-modelHead { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; background: none; border: none; font: inherit; font-size: 13px; color: inherit; cursor: pointer; text-align: left; }
.dim-lt-modelHead:hover { background: color-mix(in srgb, #1677ff 4%, transparent); }
/* 模型名与「展开/收起」互不让位：#8 的"▾ 展开"曾被挤成"▾ 展 / 开"两行。
   让主标题可收缩换行，右侧动作按钮保持一行。 */
.dim-lt-modelHead > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.dim-lt-modelTitle { min-width: 0; overflow-wrap: anywhere; }
.dim-lt-nowrap { white-space: nowrap; }
.dim-lt-modelBody { padding: 10px 12px 12px; border-top: 1px solid var(--dsw-alias-border-l2, #eef0f3); }
.dim-lt-caps { display: grid; gap: 6px; margin-bottom: 12px; }
.dim-lt-cap { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
/* 说明文本可换行、可在长 token 内断行，避免撑破容器 */
.dim-lt-capSrc { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f99); overflow-wrap: anywhere; }
.dim-lt-checkbox { accent-color: #1677ff; }
.dim-lt-green { color: #389e0d; font-size: 12.5px; }
.dim-lt-red { color: #d4380d; font-size: 12.5px; word-break: break-all; }
.dim-lt-muted { color: var(--dsw-alias-label-tertiary, #8a8f99); font-size: 12px; }
.dim-lt-spin { display: inline-block; width: 11px; height: 11px; border: 2px solid color-mix(in srgb, #1677ff 30%, transparent); border-top-color: #1677ff; border-radius: 50%; animation: dim-lt-rot .7s linear infinite; vertical-align: -1px; margin-right: 6px; }
@keyframes dim-lt-rot { to { transform: rotate(360deg); } }
.dim-lt-empty { padding: 26px 16px; text-align: center; color: var(--dsw-alias-label-tertiary, #8a8f99); font-size: 13px; }
.dim-lt-kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12.5px; }
.dim-lt-kv dt { color: var(--dsw-alias-label-secondary, #555); }
.dim-lt-kv dd { margin: 0; }
.dim-lt-ext { font-size: 10px; line-height: 1; margin-left: 3px; vertical-align: 2px; }
`

    /** 只安装一次样式表。 */
    let stylesInstalled = false
    function installStyles() {
      if (stylesInstalled) return () => {}
      const tagId = 'dsh-lantern/styles'
      if (document.querySelector(`style[data-plugin-style="${tagId}"]`) !== null) {
        stylesInstalled = true
        return () => {}
      }
      const style = document.createElement('style')
      style.dataset.pluginStyle = tagId
      style.textContent = STYLES
      document.head.appendChild(style)
      stylesInstalled = true
      return () => {
        style.remove()
        stylesInstalled = false
      }
    }

    // ────────────────────────────── 小组件 ──────────────────────────────

    const h = React.createElement

    /** 一条键值展示。 */
    function Kv(props) {
      return h('div', { className: cx('kv') }, [
        h('dt', { key: 'k' }, props.label),
        h('dd', { key: 'v' }, props.children),
      ])
    }

    /** 状态药丸。 */
    function Pill(props) {
      const tone = props.tone === 'on' ? 'pillOn' : props.tone === 'warn' ? 'pillWarn' : props.tone === 'off' ? 'pillOff' : ''
      return h('span', { className: cx('pill', tone) }, props.children)
    }

    /** token 数 → M（3 位小数）。 */
    const fmtMTokens = (n) => (Number(n ?? 0) / 1_000_000).toFixed(3)

    /** 调用类型标签（与报告口径一致）。 */
    const KIND_LABEL = { inference: '推理调用', test: '功能测试', perf: '性能测试' }

    /** 概览小卡片。`raw=true` 时直接显示字符串（如命中率）。 */
    function MiniStat(props) {
      const { label, value, raw = false } = props
      return h(
        'div',
        { className: cx('miniStat') },
        h('div', { className: cx('miniStatK') }, label),
        h('div', { className: cx('miniStatV') }, raw ? value : `${value}`),
      )
    }

    /** 提示条。 */
    function Notice(props) {      if (!props.children) return null
      const tone =
        props.tone === 'warn' ? 'noticeWarn' : props.tone === 'error' ? 'noticeError' : props.tone === 'ok' ? 'noticeOk' : 'noticeInfo'
      return h('div', { className: cx('notice', tone) }, props.children)
    }

    /**
     * 就地反馈行：显示在**产生操作的位置下方**，而不是页面顶部。
     * 顶部反馈在长页面里几乎看不到（用户实测反馈），故统一改成就地显示。
     * @param props - `{ notice }`，notice 为 `{ tone, text }` 或 null。
     */
    function Inline(props) {
      const notice = props.notice
      if (!notice || !notice.text) return null
      const tone = notice.tone === 'error' ? 'inlineErr' : notice.tone === 'warn' ? 'inlineWarn' : 'inlineOk'
      return h('div', { className: cx('inline', tone) }, notice.text)
    }

    /**
     * 临时弹窗（自建遮罩层）。
     *
     * DSH 没有原生 modal 插槽（已查：`settings.*` 插槽只有 section/item/tab 等），
     * 因此这里用 `position: fixed` 的遮罩 + 卡片自行实现，效果与设置窗口同层。
     * 用途：展示"只显示一次"的 API Key（顶部反馈看不见，用户实测反馈）。
     *
     * @param props - `{ title, hint, children, footer, onClose }`。
     */
    function Modal(props) {
      const { title, hint, children, footer, onClose } = props
      // Esc 关闭
      React.useEffect(() => {
        const onKey = (e) => {
          if (e.key === 'Escape') onClose?.()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      return h(
        'div',
        {
          className: cx('modalMask'),
          role: 'dialog',
          'aria-modal': 'true',
          onClick: (e) => {
            if (e.target === e.currentTarget) onClose?.()
          },
        },
        h(
          'div',
          { className: cx('modalCard') },
          title ? h('h3', { className: cx('modalTitle') }, title) : null,
          hint ? h('p', { className: cx('modalHint') }, hint) : null,
          children,
          h(
            'div',
            { className: cx('modalFoot') },
            footer ?? h('button', { className: cx('btn'), onClick: onClose }, '关闭'),
          ),
        ),
      )
    }

    // ────────────────────────────── 状态与安全页 ──────────────────────────────

    function StatusPage(props) {
      const { rpc } = props
      const [status, setStatus] = React.useState(null)
      const [keys, setKeys] = React.useState([])
      const [listens, setListens] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [newKey, setNewKey] = React.useState(null)
      const [keyLabel, setKeyLabel] = React.useState('')
      const [draft, setDraft] = React.useState(null)
      const [usage, setUsage] = React.useState(null)
      const [breaker, setBreaker] = React.useState(null)
      const [filters, setFilters] = React.useState(null)
      const [filterDraft, setFilterDraft] = React.useState({ providers: '', models: '', allowedModels: '' })

      // `rpc` 每次渲染都是新引用 → 用 ref 稳定，避免 effect 反复重跑。
      const rpcRef = React.useRef(rpc)
      rpcRef.current = rpc

      /** 读熔断状态（P12）：冷却剩余时间在 UI 里要能实时看到。 */
      const loadBreaker = React.useCallback(async () => {
        try {
          const r = await rpcRef.current('breaker/status', {})
          setBreaker(r)
        } catch {
          /* 面板仍可用 */
        }
      }, [])

      /** 读过滤配置与"实际生效"的结果（P16）。 */
      const loadFilters = React.useCallback(async () => {
        try {
          const r = await rpcRef.current('filters/get', {})
          setFilters(r)
          setFilterDraft({
            providers: (r.filters?.providers ?? []).join('\n'),
            models: (r.filters?.models ?? []).join('\n'),
            allowedModels: (r.filters?.allowedModels ?? []).join('\n'),
          })
        } catch {
          /* 面板仍可用 */
        }
      }, [])

      /** 读用量概览（卡片 + 按 Key + 按类型）。 */
      const loadUsage = React.useCallback(async () => {
        try {
          const u = await rpcRef.current('usage/summary', { granularity: 'monthly' })
          const daily = await rpcRef.current('usage/summary', { granularity: 'daily' })
          const yearly = await rpcRef.current('usage/summary', { granularity: 'yearly' })
          const weekly = await rpcRef.current('usage/summary', { granularity: 'weekly' })
          const M = (n) => (Number(n ?? 0) / 1_000_000).toFixed(3)
          setUsage({
            totals: u.totals,
            keys: u.keys ?? [],
            kinds: u.kinds ?? [],
            empty: u.empty,
            cards: {
              today: M(daily.totals.total),
              week: M(weekly.totals.total),
              month: M(u.totals.total),
              year: M(yearly.totals.total),
              hitRate: u.totals.hitRate === null ? '—' : `${(u.totals.hitRate * 100).toFixed(1)}%`,
            },
          })
        } catch (error) {
          setNotice({ tone: 'error', text: `读取用量失败：${error.message}` })
        }
      }, [])

      const refresh = React.useCallback(async () => {
        try {
          const s = await rpcRef.current('status', {})
          setStatus(s)
          const k = await rpcRef.current('keys/list', {})
          setKeys(k.keys ?? [])
          const l = await rpcRef.current('listen/list', {})
          setListens(l.entries ?? [])
          // 注意：**不清空 draft** —— 否则用户正在编辑的端口表单会被刷新冲掉。
        } catch (error) {
          setNotice({ tone: 'error', text: `读取状态失败：${error.message}` })
        }
      }, [])

      React.useEffect(() => {
        void refresh()
        void loadUsage()
        void loadBreaker()
        void loadFilters()
        // 熔断状态每 5 秒刷一次（冷却倒计时要实时）
        const t = setInterval(() => void loadBreaker(), 5000)
        return () => clearInterval(t)
      }, [refresh, loadUsage, loadBreaker, loadFilters])

      /**
       * 统一包装一次操作：忙态 + **就地提示** + 刷新。
       * `where` 决定反馈显示在哪个分组下方（顶部反馈在长页面里看不见）。
       * @param where - `'svc' | 'listen' | 'keys' | 'limits' | 'diag' | 'image'`。
       */
      const run = async (fn, okText, where = 'keys') => {
        setBusy(true)
        setNotice(null)
        try {
          await fn()
          if (okText) setNotice({ tone: 'ok', text: okText, where })
          await refresh()
        } catch (error) {
          setNotice({ tone: 'error', text: error.message, where })
        } finally {
          setBusy(false)
        }
      }

      /** 取某分组绑定的就近提示。 */
      const noticeAt = (where) => (notice && notice.where === where ? notice : null)

      if (status === null) {
        return h('div', { className: cx('empty') }, h('span', { className: cx('spin') }), '读取中…')
      }

      const cfg = status.config ?? {}
      const limits = cfg.limits ?? {}
      const auth = cfg.auth ?? {}

      return h('div', null, [
        // ── 「只显示一次」的 API Key：用临时弹窗展示（顶部/内联都容易被忽略）──
        newKey
          ? h(
              Modal,
              {
                key: 'newkey',
                title: '⚠ 新 API Key（只显示这一次）',
                hint: newKey.warning,
                onClose: () => setNewKey(null),
                footer: h(
                  'div',
                  { style: { display: 'flex', gap: '8px' } },
                  h(
                    'button',
                    {
                      className: cx('btn', 'btnPrimary'),
                      onClick: () => {
                        void navigator.clipboard?.writeText(newKey.plaintext)
                        setNotice({ tone: 'ok', text: '已复制到剪贴板', where: 'keys' })
                      },
                    },
                    '复制',
                  ),
                  h('button', { className: cx('btn'), onClick: () => setNewKey(null) }, '我已保存，关闭'),
                ),
              },
              h(
                'div',
                { className: cx('keyBox') },
                h('input', {
                  className: cx('input', 'mono'),
                  readOnly: true,
                  value: newKey.plaintext,
                  onFocus: (e) => e.target.select(),
                }),
              ),
            )
          : null,

        // 服务开关
        h(
          'div',
          { key: 'svc', className: cx('section') },
          h(
            'h3',
            { className: cx('sectionTitle') },
            '服务开关',
            h(Pill, { tone: cfg.enabled ? 'on' : 'off' }, cfg.enabled ? '运行中' : '已停止'),
          ),
          h(
            'p',
            { className: cx('sectionHint') },
            '关闭后所有局域网请求返回 503，且不消耗任何上游额度。插件默认关闭。',
          ),
          h(
            'div',
            { className: cx('row') },
            h(
              'button',
              {
                className: cx('btn', 'btnPrimary'),
                disabled: busy,
                onClick: () =>
                  run(
                    () => rpc('config/set', { config: { enabled: !cfg.enabled } }),
                    cfg.enabled ? '已停止服务' : '已启用服务',
                    'svc',
                  ),
              },
              cfg.enabled ? '停止服务' : '启用服务',
            ),
            h('span', { className: cx('muted') }, `当前并发 ${status.inflight} / ${limits.maxConcurrent ?? 2}`),
          ),
          h(Inline, { notice: noticeAt('svc') }),
        ),

        // 监听与端口
        h(
          'div',
          { key: 'listen', className: cx('section') },
          h(
            'h3',
            { className: cx('sectionTitle') },
            '监听与端口',
            h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                onClick: () => {
                  const first = listens[0]
                  setDraft({
                    mode: 'standalone',
                    bind: '0.0.0.0',
                    port: 3081,
                    // reuse 只能有一条：已有 reuse 时默认仍给 standalone
                    allowReuse: !listens.some((e) => e.mode === 'reuse'),
                    basedOn: first ? first.id : null,
                  })
                },
              },
              '+ 添加端口',
            ),
          ),
          h(
            'p',
            { className: cx('sectionHint') },
            'standalone：绑定地址由插件决定（推荐）。reuse：复用 DSH 端口，地址由 DSH 的 --host 决定。',
          ),
          listens.length === 0
            ? h('div', { className: cx('empty') }, '暂无监听条目')
            : h(
                'table',
                { className: cx('table') },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, '模式'),
                    h('th', null, '绑定'),
                    h('th', null, '端口'),
                    h('th', null, '状态'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  listens.flatMap((entry) => {
                    const active = (status.listen ?? []).find((x) => x.id === entry.id)
                    // 第 1 行：信息 + 状态（状态独占末列，空间充足，不再被按钮挤成竖排）
                    const infoRow = h(
                      'tr',
                      { key: `${entry.id}-info` },
                      h('td', null, entry.mode === 'reuse' ? 'reuse' : 'standalone'),
                      // 绑定地址：显示**实际生效**的地址（而非配置值）。
                      // reuse 下该地址由 DSH 的 --host 决定、插件无权修改
                      //（曾误显示配置值 0.0.0.0 → 用户以为局域网可访问，实际只有回环）。
                      //
                      // ⚠ 说明一律走 ⓘ 图标 + 悬停（同"已删除 Key"的做法）：
                      // 曾经把"继承自 DSH（配置的 0.0.0.0 未生效）"整行写在地址下方，
                      // 会把本该很短的地址列撑高、挤占版面（用户实测反馈）。
                      h(
                        'td',
                        { className: cx('mono', 'bindCell') },
                        h('span', { className: cx('nowrap') }, active?.bind ?? entry.bind),
                        active?.bindInherited
                          ? h(
                              'span',
                              {
                                className: cx('infoIcon'),
                                title:
                                  `继承自 DSH：reuse 复用 DSH 的监听端口，绑定地址由 DSH 启动参数 --host 决定，本插件无权修改。\n` +
                                  (active?.requestedBind && active.requestedBind !== active.bind
                                    ? `插件里配置的是 ${active.requestedBind}，实际生效的是 ${active.bind}。\n`
                                    : '') +
                                  '要自定义绑定地址：改用 standalone 模式，或让 DSH 以 --host 0.0.0.0 启动。',
                                'aria-label': '继承自 DSH（悬停查看说明）',
                              },
                              'ⓘ',
                            )
                          : null,
                      ),
                      h('td', { className: cx('mono', 'nowrap') }, String(entry.mode === 'reuse' ? (active?.port ?? '—') : entry.port)),
                      h(
                        'td',
                        { className: cx('statusCell') },
                        active?.listening
                          ? h(Pill, { tone: 'on' }, '运行中')
                          : h(Pill, { tone: entry.enabled === false ? 'off' : 'warn' }, entry.enabled === false ? '已停用' : '未启动'),
                        active?.error ? h('div', { className: cx('muted') }, active.error) : null,
                      ),
                    )
                    // 第 2 行：三个操作按钮横跨整行、均匀分布
                    const actionRow = h(
                      'tr',
                      { key: `${entry.id}-actions`, className: cx('actionRow') },
                      h(
                        'td',
                        { colSpan: 4 },
                        h(
                          'div',
                          { className: cx('actions') },
                          h(
                            'button',
                            {
                              className: cx('btn'),
                              disabled: busy,
                              onClick: () => setDraft({ ...entry, editing: true }),
                            },
                            '编辑',
                          ),
                          h(
                            'button',
                            {
                              className: cx('btn'),
                              disabled: busy,
                              onClick: () =>
                                run(
                                  () => rpc('listen/update', { action: 'update', id: entry.id, entry: { enabled: entry.enabled === false } }),
                                  entry.enabled === false ? '已启用该条目' : '已停用该条目',
                                  'listen',
                                ),
                            },
                            entry.enabled === false ? '启用' : '停用',
                          ),
                          h(
                            'button',
                            {
                              className: cx('btn', 'btnDanger'),
                              disabled: busy || listens.length <= 1,
                              title: listens.length <= 1 ? '不能删除最后一条（否则等于把自己关停）' : '',
                              onClick: () => {
                                if (!window.confirm('删除该监听条目？删除后该端口立即停止服务。')) return
                                void run(() => rpc('listen/update', { action: 'remove', id: entry.id }), '已删除', 'listen')
                              },
                            },
                            '删除',
                          ),
                        ),
                      ),
                    )
                    return [infoRow, actionRow]
                  }),
                ),
              ),
          h(Inline, { notice: noticeAt('listen') }),
        ),

        // 端口编辑表单
        draft
          ? h(
              'div',
              { key: 'draft', className: cx('section'), style: { borderColor: '#1677ff' } },
              h('h3', { className: cx('sectionTitle') }, draft.editing ? '编辑监听条目' : '新增监听条目'),
              h(
                'div',
                { className: cx('row') },
                h(
                  'label',
                  { className: cx('field') },
                  h('span', { className: cx('fieldLabel') }, '模式'),
                  h(
                    'select',
                    {
                      className: cx('select'),
                      value: draft.mode,
                      onChange: (e) => setDraft({ ...draft, mode: e.target.value }),
                    },
                    h('option', { value: 'standalone' }, 'standalone（推荐）'),
                    draft.editing || draft.allowReuse ? h('option', { value: 'reuse' }, 'reuse（复用 DSH 端口）') : null,
                  ),
                ),
                h(
                  'label',
                  { className: cx('field') },
                  h('span', { className: cx('fieldLabel') }, '绑定地址'),
                  h(
                    'select',
                    {
                      className: cx('select'),
                      value: draft.bind,
                      // reuse 模式下这个值**不参与实际绑定**（地址继承自 DSH），
                      // 因此禁用它，避免用户以为"选了 0.0.0.0 就真的暴露到局域网了"。
                      disabled: draft.mode === 'reuse',
                      title:
                        draft.mode === 'reuse'
                          ? 'reuse 模式的绑定地址由 DSH 启动参数 --host 决定，本插件无权修改'
                          : '',
                      onChange: (e) => setDraft({ ...draft, bind: e.target.value }),
                    },
                    h('option', { value: '0.0.0.0' }, '0.0.0.0（局域网可访问）'),
                    h('option', { value: '127.0.0.1' }, '127.0.0.1（仅本机）'),
                  ),
                  draft.mode === 'reuse'
                    ? h('span', { className: cx('capSrc') }, '⚠ reuse 下此项不生效')
                    : null,
                ),
                draft.mode === 'standalone'
                  ? h(
                      'label',
                      { className: cx('field') },
                      h('span', { className: cx('fieldLabel') }, '端口'),
                      h('input', {
                        className: cx('input'),
                        type: 'number',
                        min: 1,
                        max: 65535,
                        value: draft.port ?? 3081,
                        onChange: (e) => setDraft({ ...draft, port: Number(e.target.value) }),
                      }),
                    )
                  : null,
              ),
              // 「试听」单独一行（原来与端口输入框同行会错位），结果**在其下方**就地显示
              draft.mode === 'standalone'
                ? h(
                    'div',
                    { style: { marginTop: '10px' } },
                    h(
                      'button',
                      {
                        className: cx('btn'),
                        disabled: busy,
                        onClick: async () => {
                          setBusy(true)
                          setNotice(null)
                          try {
                            const probe = await rpc('listen/probe', { port: draft.port, bind: draft.bind })
                            setNotice(
                              probe.available
                                ? { tone: 'ok', text: `端口 ${draft.port} 可用`, where: 'probe' }
                                : { tone: 'warn', text: `端口 ${draft.port} 不可用：${probe.reason}`, where: 'probe' },
                            )
                          } catch (error) {
                            setNotice({ tone: 'error', text: error.message, where: 'probe' })
                          } finally {
                            setBusy(false)
                          }
                        },
                      },
                      '试听',
                    ),
                    h(Inline, { notice: noticeAt('probe') }),
                  )
                : null,
              h(
                'div',
                { className: cx('row'), style: { marginTop: '10px' } },
                h(
                  'button',
                  {
                    className: cx('btn', 'btnPrimary'),
                    disabled: busy,
                    onClick: () =>
                      run(async () => {
                        const entry = { mode: draft.mode, bind: draft.bind }
                        if (draft.mode === 'standalone') entry.port = draft.port
                        if (draft.enabled !== undefined) entry.enabled = draft.enabled
                        if (draft.editing) await rpc('listen/update', { action: 'update', id: draft.id, entry })
                        else await rpc('listen/update', { action: 'add', entry })
                        // ⚠ 必须显式传 where：`run()` 的默认值是 `'keys'`，
                        // 不传就会把"端口冲突"这类**监听相关**的错误渲染进 API Key 框体里，
                        // 用户根本看不到（实测发现）。
                      }, draft.editing ? '已更新' : '已添加', 'draft'),
                  },
                  draft.editing ? '保存' : '添加',
                ),
                h('button', { className: cx('btn'), disabled: busy, onClick: () => setDraft(null) }, '取消'),
              ),
              // 监听条目的提交结果（含"端口冲突"等错误）**就地显示在表单下方**
              h(Inline, { notice: noticeAt('draft') }),
            )
          : null,

        // API Key 管理
        h(
          'div',
          { key: 'keys', className: cx('section') },
          h(
            'h3',
            { className: cx('sectionTitle') },
            'API Key 管理',
            h(
              'div',
              { className: cx('row') },
              h('input', {
                className: cx('input'),
                placeholder: '标签（如：书房台式机）',
                value: keyLabel,
                onChange: (e) => setKeyLabel(e.target.value),
              }),
              h(
                'button',
                {
                  className: cx('btn', 'btnPrimary'),
                  disabled: busy,
                  onClick: () =>
                    run(async () => {
                      const created = await rpc('keys/create', { label: keyLabel })
                      setNewKey(created)
                      setKeyLabel('')
                    }, null),
                },
                '+ 生成 Key',
              ),
            ),
          ),
          h(
            'p',
            { className: cx('sectionHint') },
            `key 格式：${auth.format === 'sk-hex' ? 'sk-<32位十六进制>（与 DeepSeek 同构）' : auth.format === 'sk-lantern' ? 'sk-lantern-<43位>' : 'sk-<43位 base64url>'}。` +
              '明文只在生成时显示一次，之后只存 sha256，无法再查看。',
          ),
          keys.length === 0
            ? h(Notice, { tone: 'warn' }, '尚无任何 API Key —— 局域网请求将一律被拒。请先生成一个。')
            : h(
                'table',
                { className: cx('table') },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, '标签'),
                    h('th', null, '指纹'),
                    h('th', null, '创建时间'),
                    h('th', null, '最近使用'),
                    h('th', null, '状态'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  keys.flatMap((k) => {
                    // 第 1 行：信息 + 状态（状态独占末列，不再与按钮挤在一格）
                    const infoRow = h(
                      'tr',
                      { key: `${k.id}-info` },
                      h('td', null, k.label),
                      h('td', { className: cx('mono', 'nowrap') }, k.fingerprint),
                      h('td', { className: cx('muted') }, fmtTime(k.createdAt)),
                      h('td', { className: cx('muted') }, k.lastUsedAt ? fmtTime(k.lastUsedAt) : '未使用'),
                      h('td', { className: cx('statusCell') }, k.enabled ? h(Pill, { tone: 'on' }, '启用') : h(Pill, { tone: 'off' }, '停用')),
                    )
                    // 第 2 行：三个按钮横跨整行、均匀分布
                    const actionRow = h(
                      'tr',
                      { key: `${k.id}-actions`, className: cx('actionRow') },
                      h(
                        'td',
                        { colSpan: 5 },
                        h(
                          'div',
                          { className: cx('actions') },
                          h(
                            'button',
                            {
                              className: cx('btn'),
                              disabled: busy,
                              onClick: () =>
                                run(
                                  () => rpc('keys/update', { id: k.id, enabled: !k.enabled }),
                                  k.enabled ? '已停用' : '已启用',
                                  'keys',
                                ),
                            },
                            k.enabled ? '停用' : '启用',
                          ),
                          h(
                            'button',
                            {
                              className: cx('btn'),
                              disabled: busy,
                              // 悬停说明写全（用户建议）："轮换"含义少见，
                              // 且用户需要知道过渡期默认多久、想改去哪儿改。
                              title:
                                '轮换 Key：生成一个新的 Key，旧 Key 不立即失效，而是保留一段过渡期。\n' +
                                '\n' +
                                `· 过渡期默认 ${status?.config?.auth?.rotateGraceHours ?? 24} 小时（可在 data/config.json 的 auth.rotateGraceHours 修改；0 = 立即失效）\n` +
                                '· 过渡期内新旧 Key 都能用 —— 方便你先在客户端换好新 Key，不会中断服务\n' +
                                '· 过渡期结束后旧 Key 自动失效\n' +
                                '· 新 Key 的明文只在生成时显示一次，请立刻复制保存',
                              onClick: () =>
                                run(async () => {
                                  const r = await rpc('keys/rotate', { id: k.id })
                                  setNewKey({ plaintext: r.plaintext, warning: r.warning })
                                }, null, 'keys'),
                            },
                            '轮换',
                          ),
                          h(
                            'button',
                            {
                              className: cx('btn', 'btnDanger'),
                              disabled: busy,
                              onClick: () => {
                                if (!window.confirm(`删除 Key「${k.label}」？删除后使用该 Key 的客户端将立即断开。`)) return
                                void run(() => rpc('keys/remove', { id: k.id }), '已删除', 'keys')
                              },
                            },
                            '删除',
                          ),
                        ),
                      ),
                    )
                    return [infoRow, actionRow]
                  }),
                ),
              ),
          h(Inline, { notice: noticeAt('keys') }),
          h(
            'div',
            { className: cx('row'), style: { marginTop: '10px' } },
            h(
              'label',
              { className: cx('cap') },
              h('input', {
                className: cx('checkbox'),
                type: 'checkbox',
                checked: auth.allowAnonymous === true,
                disabled: busy,
                onChange: (e) => {
                  if (e.target.checked && !window.confirm('⚠ 允许匿名访问意味着同网段任何人都能使用本机模型额度，且无法按设备追踪。确定开启？')) return
                  void run(() => rpc('keys/setAnonymous', { allow: e.target.checked }), e.target.checked ? '⚠ 已开启匿名访问' : '已关闭匿名访问')
                },
              }),
              '允许匿名访问（不推荐）',
            ),
          ),
        ),

        // 限额
        h(
          'div',
          { key: 'limits', className: cx('section') },
          h('h3', { className: cx('sectionTitle') }, '限额与并发'),
          h(
            'p',
            { className: cx('sectionHint') },
            '局域网请求与本机共用同一批上游账号额度。这些限额用于保护本机不被拖慢（宁可局域网慢一点）。',
          ),
          h(
            'div',
            { className: cx('row') },
            ...[
              ['maxConcurrent', '最大并发', 1, 64],
              ['perKeyRpm', '每Key每分钟请求', 1, 100000],
              ['perKeyTpm', '每Key每分钟输出 token', 100, 10000000],
              ['maxTokensCap', '单次 max_tokens 上限', 1, 1000000],
              ['reserveForLocal', '为本机保留并发槽', 0, 63],
            ].map(([field, label, min, max]) =>
              h(
                'label',
                { className: cx('field'), key: field },
                h('span', { className: cx('fieldLabel') }, label),
                h('input', {
                  className: cx('input'),
                  type: 'number',
                  min,
                  max,
                  value: limits[field] ?? '',
                  onChange: (e) =>
                    run(() => rpc('config/set', { config: { limits: { [field]: Number(e.target.value) } } }), null, 'limits'),
                }),
              ),
            ),
          ),

          // ── 熔断（P12）：保护本机不被局域网刷量拖垮 ──
          h('div', { style: { marginTop: '12px' } },
            h('div', { className: cx('muted'), style: { marginBottom: '4px' } }, '熔断保护'),
            h(
              'p',
              { className: cx('sectionHint') },
              '上游连续限流时自动暂停局域网通道（冷却期内的请求立即拒绝、不消耗上游额度），' +
                '等本机缓过来再恢复。本机自己的对话始终不受影响。',
            ),
            // 状态用**行内药丸**表达（#6）：原来是一整行的绿色文本块，
            // 在"熔断保护"标题下孤零零占一行、看起来像排版错误。
            breaker && breaker.open
              ? h('div', { className: cx('row'), style: { marginBottom: '6px' } },
                  h(Pill, { tone: 'warn' }, `已熔断 ${breaker.remainingSec}s`),
                  h('span', { className: cx('capSrc') }, breaker.lastOpenReason ?? ''),
                )
              : h('div', { className: cx('row'), style: { marginBottom: '6px' } },
                  h(Pill, { tone: 'on' }, '正常'),
                  breaker && breaker.consecutiveRateLimits > 0
                    ? h('span', { className: cx('capSrc') }, `当前连续限流 ${breaker.consecutiveRateLimits}/${breaker.threshold}`)
                    : h('span', { className: cx('capSrc') }, '未触发熔断'),
                ),
            h(
              'div',
              { className: cx('row'), style: { marginTop: '6px' } },
              ...([
                ['enabled', '启用熔断', 'checkbox'],
              ]).map(([field, label]) =>
                h('label', { className: cx('cap'), key: field },
                  h('input', {
                    className: cx('checkbox'),
                    type: 'checkbox',
                    checked: limits.breaker?.[field] !== false,
                    disabled: busy,
                    onChange: (e) => run(() => rpc('config/set', { config: { limits: { breaker: { [field]: e.target.checked } } } }), null, 'limits'),
                  }),
                  label,
                ),
              ),
              h('label', { className: cx('field') },
                h('span', { className: cx('fieldLabel') }, '连续限流阈值'),
                h('input', {
                  className: cx('input'),
                  type: 'number',
                  min: 1,
                  max: 20,
                  value: limits.breaker?.consecutiveRateLimits ?? 3,
                  disabled: busy,
                  onChange: (e) => run(() => rpc('config/set', { config: { limits: { breaker: { consecutiveRateLimits: Number(e.target.value) } } } }), null, 'limits'),
                }),
              ),
              h('label', { className: cx('field') },
                h('span', { className: cx('fieldLabel') }, '冷却秒数'),
                h('input', {
                  className: cx('input'),
                  type: 'number',
                  min: 5,
                  max: 3600,
                  value: limits.breaker?.cooldownSec ?? 60,
                  disabled: busy,
                  onChange: (e) => run(() => rpc('config/set', { config: { limits: { breaker: { cooldownSec: Number(e.target.value) } } } }), null, 'limits'),
                }),
              ),
              breaker && breaker.open
                ? h('button', {
                    className: cx('btn'),
                    disabled: busy,
                    onClick: () => run(async () => {
                      const r = await rpc('breaker/reset', {})
                      setBreaker(r.after)
                    }, '已解除熔断', 'limits'),
                  }, '立即解除熔断')
                : null,
            ),
            h(Inline, { notice: noticeAt('limits') }),
          ),
        ),

        // 模型与来源过滤（P16 / §4.4 + §7.3）
        h(
          'div',
          { key: 'filters', className: cx('section') },
          h('h3', { className: cx('sectionTitle') }, '模型与来源过滤'),
          h(
            'p',
            { className: cx('sectionHint') },
            '黑名单命中即不公开；白名单非空时只公开其中的（空 = 全部）。每行一项，' +
              '可写公开名（如 deepseek-v4-pro@buddy）或裸模型名（如 deepseek-v4-pro）。',
          ),
          h(
            'div',
            { className: cx('row'), style: { alignItems: 'flex-start' } },
            ...[
              ['providers', '排除 provider（黑名单）', '每行一个 provider id'],
              ['models', '排除模型（黑名单）', '每行一个模型'],
              ['allowedModels', '只公开这些模型（白名单）', '留空 = 全部'],
            ].map(([field, label, hint]) =>
              h(
                'label',
                { className: cx('field'), key: field, style: { flex: '1 1 200px' } },
                h('span', { className: cx('fieldLabel') }, label),
                h('textarea', {
                  className: cx('input'),
                  rows: 4,
                  placeholder: hint,
                  value: filterDraft[field],
                  disabled: busy,
                  onChange: (e) => setFilterDraft({ ...filterDraft, [field]: e.target.value }),
                  style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px' },
                }),
              ),
            ),
          ),
          h(
            'div',
            { className: cx('row'), style: { marginTop: '8px' } },
            h(
              'button',
              {
                className: cx('btn', 'btnPrimary'),
                disabled: busy,
                onClick: () =>
                  run(async () => {
                    const toList = (s) => String(s).split('\n').map((x) => x.trim()).filter((x) => x.length > 0)
                    const r = await rpc('filters/set', {
                      providers: toList(filterDraft.providers),
                      models: toList(filterDraft.models),
                      allowedModels: toList(filterDraft.allowedModels),
                    })
                    await loadFilters()
                    await refresh()
                    setNotice({
                      tone: 'ok',
                      text: `已应用：当前公开 ${r.publicCount} 个模型，过滤掉 ${r.hiddenModelCount} 个`,
                      where: 'filters',
                    })
                  }, null, 'filters'),
              },
              '应用过滤',
            ),
            filters
              ? h('span', { className: cx('muted') },
                  `当前公开 ${filters.publicCount} 个模型` +
                    (filters.hiddenModelCount > 0 ? `，过滤掉 ${filters.hiddenModelCount} 个` : '') +
                    (filters.hiddenProviders?.length > 0 ? `，隐藏 ${filters.hiddenProviders.length} 个 provider` : ''))
              : null,
          ),
          // 实际生效明细：避免"配了过滤器却看不出效果"（设计文档 §4.4.2 的精神）
          filters && filters.hiddenModels?.length > 0
            ? h('details', { style: { marginTop: '6px' } },
                h('summary', { className: cx('muted'), style: { cursor: 'pointer' } },
                  `查看被过滤的 ${filters.hiddenModelCount} 个模型`),
                h('div', { className: cx('caps'), style: { marginTop: '4px' } },
                  filters.hiddenModels.slice(0, 50).map((m) =>
                    h('div', { key: m.publicName, className: cx('cap') },
                      h('span', { className: cx('mono') }, m.publicName),
                      h('span', { className: cx('capSrc') }, m.reason === 'excluded' ? '· 在黑名单' : '· 不在白名单'),
                    ),
                  ),
                  filters.hiddenModelCount > 50
                    ? h('div', { className: cx('muted') }, `… 另有 ${filters.hiddenModelCount - 50} 个`)
                    : null,
                ),
              )
            : null,
          h(Inline, { notice: noticeAt('filters') }),
        ),

        // 协议通道
        h(
          'div',
          { key: 'proto', className: cx('section') },
          h('h3', { className: cx('sectionTitle') }, '协议通道'),
          h(
            'p',
            { className: cx('sectionHint') },
            'OpenAI 兼容端点 POST /v1/chat/completions（始终开启）；' +
              'Anthropic 兼容端点 POST /v1/messages（可选，供 Claude Code、Cursor 等只认 Anthropic 协议的客户端使用）。',
          ),
          h(
            'label',
            { className: cx('cap') },
            h('input', {
              className: cx('checkbox'),
              type: 'checkbox',
              checked: cfg.protocol?.anthropic === true,
              disabled: busy,
              onChange: (e) =>
                run(
                  () => rpc('config/set', { config: { protocol: { anthropic: e.target.checked } } }),
                  e.target.checked ? '已开启 Anthropic 兼容端点' : '已关闭 Anthropic 兼容端点',
                  'proto',
                ),
            }),
            '启用 Anthropic 兼容端点（/v1/messages）',
          ),
          h(
            'p',
            { className: cx('sectionHint'), style: { marginTop: '6px' } },
            '该端点与 OpenAI 端点共用鉴权、限额、能力闸门与用量记账；' +
              '客户端用 x-api-key 头传 Key 即可（也接受 Authorization: Bearer）。',
          ),
          h(Inline, { notice: noticeAt('proto') }),
        ),

        // 图片
        h(
          'div',
          { key: 'img', className: cx('section') },
          h('h3', { className: cx('sectionTitle') }, '图片输入'),
          h(
            'p',
            { className: cx('sectionHint') },
            '图片字节会短暂写入本机附件目录，5 分钟后由插件账本回收。',
          ),
          h(
            'label',
            { className: cx('cap') },
            h('input', {
              className: cx('checkbox'),
              type: 'checkbox',
              checked: cfg.allowImageInput === true,
              disabled: busy,
              onChange: (e) => {
                if (e.target.checked && !window.confirm('开启后局域网图片会短暂经过本机磁盘（5 分钟后回收）。继续？')) return
                void run(
                  () => rpc('config/set', { config: { allowImageInput: e.target.checked } }),
                  e.target.checked ? '已开启图片输入' : '已关闭图片输入',
                  'image',
                )
              },
            }),
            '接受图片',
          ),
          // 关闭时的行为等细节放 README；这里只留一行说明
          h('p', { className: cx('sectionHint'), style: { marginTop: '6px' } }, '关闭时（默认）图片请求直接返回 400，且零落盘。'),
          h(Inline, { notice: noticeAt('image') }),
        ),

        // 用量统计（P9）
        // ⚠ 这一段必须留在 StatusPage 内：它用的 `usage` / `loadUsage` / `noticeAt('usage')`
        // 都是本组件的状态。曾一度被误放进 ProviderPage，导致点开任意 provider 就抛
        // `ReferenceError: usage is not defined`，React 卸载整棵子树 → **整个面板空白**
        // （用户实测：加/删 provider 黑名单后点左侧 provider 即触发；刷新后回到本页又正常）。
        h(
          'div',
          { key: 'usage', className: cx('section') },
          h('h3', { className: cx('sectionTitle') }, '用量统计'),
          h(
            'p',
            { className: cx('sectionHint') },
            '只统计经由本插件的调用（不含本机 DSH 自身对话）。功能区分为推理调用、功能测试、性能测试三类，并按每个 API Key 分别统计。',
          ),
          usage === null
            ? h('div', { className: cx('empty') }, h('span', { className: cx('spin') }), '读取用量中…')
            : usage.empty
              ? h(Notice, { tone: 'info' }, '账本还是空的——局域网客户端调用过、或点过「功能测试」之后，这里会出现数据。')
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: cx('row'), style: { flexWrap: 'wrap', gap: '8px' } },
                    h(MiniStat, { label: '今日', value: usage.cards.today }),
                    h(MiniStat, { label: '本周', value: usage.cards.week }),
                    h(MiniStat, { label: '本月', value: usage.cards.month }),
                    h(MiniStat, { label: '今年', value: usage.cards.year }),
                    h(MiniStat, { label: '命中率（加权）', value: usage.cards.hitRate, raw: true }),
                    h(MiniStat, { label: '失败', value: String(usage.totals.failed), raw: true }),
                  ),
                  usage.keys.length > 0
                    ? h(
                        'div',
                        { style: { marginTop: '10px' } },
                        h('div', { className: cx('muted'), style: { marginBottom: '4px' } }, '按 API Key（本月）'),
                        h(
                          'table',
                          { className: cx('table') },
                          h('thead', null, h('tr', null,
                            h('th', null, 'Key 名称'),
                            h('th', null, '指纹'),
                            h('th', null, '调用'),
                            h('th', null, '合计 (M)'),
                            h('th', null, '命中率'),
                          )),
                          h('tbody', null, usage.keys.filter((k) => k.calls > 0).map((k) =>
                            h('tr', { key: k.id, className: cx(k.deleted ? 'rowDeleted' : null) },
                              h(
                                'td',
                                { className: cx('keyNameCell') },
                                // Key 名过长时省略号截断 + title 悬停看全名（不再撑宽表格）
                                h('span', { className: cx('ellipsis'), title: k.label }, k.label),
                                // 已删除的 Key：名称旁放一个 ⓘ，悬停才显示注释。
                                // 把"已删除"直接写进名称会撑宽整行（用户实测），故改为图标。
                                k.deleted
                                  ? h('span', {
                                      className: cx('infoIcon'),
                                      title: '该 Key 已删除，此处仅保留其历史用量记录',
                                      'aria-label': '该 Key 已删除',
                                    }, 'ⓘ')
                                  : null,
                              ),
                              h('td', { className: cx('mono', 'nowrap') }, k.fingerprint || '—'),
                              h('td', { className: cx('mono') }, String(k.calls)),
                              h('td', { className: cx('mono') }, fmtMTokens(k.total)),
                              h('td', { className: cx('mono') }, k.hitRate === null ? '—' : `${(k.hitRate * 100).toFixed(1)}%`),
                            ),
                          )),
                        ),
                      )
                    : null,
                  usage.kinds.length > 0
                    ? h(
                        'div',
                        { style: { marginTop: '10px' } },
                        h('div', { className: cx('muted'), style: { marginBottom: '4px' } }, '按调用类型（本月）'),
                        h(
                          'table',
                          { className: cx('table') },
                          h('thead', null, h('tr', null,
                            h('th', null, '类型'),
                            h('th', null, '调用'),
                            h('th', null, '合计 (M)'),
                          )),
                          h('tbody', null, usage.kinds.filter((k) => k.calls > 0).map((k) =>
                            h('tr', { key: k.id },
                              h('td', null, KIND_LABEL[k.id] ?? k.id),
                              h('td', { className: cx('mono') }, String(k.calls)),
                              h('td', { className: cx('mono') }, fmtMTokens(k.total)),
                            ),
                          )),
                        ),
                      )
                    : null,
                ),
          h(
            'div',
            { className: cx('row'), style: { marginTop: '10px' } },
            h(
              'button',
              {
                className: cx('btn', 'btnPrimary'),
                disabled: busy,
                onClick: () =>
                  run(
                    async () => {
                      const r = await rpc('usage/open', {})
                      setNotice({
                        tone: r.opened ? 'ok' : 'warn',
                        text: r.opened
                          ? `已在默认浏览器打开报告${r.reused ? '（复用一分钟内的同一份）' : ''}`
                          : `报告已生成（${r.path}），但自动打开失败：${r.openError ?? '未知原因'}`,
                        where: 'usage',
                      })
                      await loadUsage()
                    },
                    null,
                    'usage',
                  ),
              },
              '查看用量报告',
              h('span', { className: cx('ext') }, '↗'),
            ),
            h(
              'label',
              { className: cx('cap') },
              h('input', {
                className: cx('checkbox'),
                type: 'checkbox',
                checked: cfg.usage?.enabled !== false,
                disabled: busy,
                onChange: (e) =>
                  run(() => rpc('usage/setEnabled', { value: e.target.checked }), e.target.checked ? '已启用用量记账' : '已停止用量记账', 'usage'),
              }),
              '记录用量',
            ),
          ),
          h(Inline, { notice: noticeAt('usage') }),
        ),

        // 诊断
        h(
          'div',
          { key: 'diag', className: cx('section') },
          h('h3', { className: cx('sectionTitle') }, '诊断'),
          h(
            'div',
            { className: cx('row') },
            h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                onClick: () =>
                  run(
                    async () => {
                      const r = await rpc('diagnostics/export', {})
                      setNotice({ tone: 'ok', text: `已导出脱敏诊断到：${r.path}`, where: 'diag' })
                    },
                    null,
                    'diag',
                  ),
              },
              '导出诊断信息',
            ),
            h('span', { className: cx('muted') }, '不含 key 明文、不含 prompt 正文'),
          ),
          // 运行时摘要：一眼看清"网关当前是否健康"
          h(
            'div',
            { className: cx('caps'), style: { marginTop: '8px' } },
            h('div', { className: cx('cap') },
              h('span', { style: { minWidth: '92px' } }, '在飞请求'),
              h('span', { className: cx('mono') }, String(breaker?.concurrency?.inflight ?? status.inflight ?? 0)),
              breaker?.concurrency
                ? h('span', { className: cx('capSrc') },
                    `· LAN 上限 ${breaker.concurrency.lanMax}（本机保留 ${breaker.concurrency.reserved}）`)
                : null,
            ),
            h('div', { className: cx('cap') },
              h('span', { style: { minWidth: '92px' } }, '熔断'),
              breaker?.open
                ? h(Pill, { tone: 'warn' }, `已熔断 ${breaker.remainingSec}s`)
                : h(Pill, { tone: 'on' }, '正常'),
              h('span', { className: cx('capSrc') },
                breaker
                  ? `· 累计触发 ${breaker.stats?.opened ?? 0} 次 / 拒绝 ${breaker.stats?.rejected ?? 0} 次 / 命中限流 ${breaker.stats?.rateLimitHits ?? 0} 次`
                  : '· 状态读取中'),
            ),
          ),
          h(Inline, { notice: noticeAt('diag') }),
        ),

        // 危险操作（P16）：集中放置、二次确认，与普通设置分开
        h(
          'div',
          { key: 'danger', className: cx('section'), style: { borderColor: '#ffa39e' } },
          h('h3', { className: cx('sectionTitle') }, '⚠ 危险操作'),
          h(
            'p',
            { className: cx('sectionHint') },
            '这些操作会立即影响局域网服务或丢弃运行状态，均需二次确认。',
          ),
          h(
            'div',
            { className: cx('row') },
            h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                onClick: () => {
                  if (!window.confirm('解除熔断？若上游仍在限流，很快会再次触发。')) return
                  void run(async () => {
                    const r = await rpc('breaker/reset', {})
                    setBreaker(r.after)
                  }, '已解除熔断', 'danger')
                },
              },
              '解除熔断',
            ),
            h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                title: '把所有配置恢复为出厂默认（不影响已生成的 API Key 与用量账本）',
                onClick: () => {
                  if (!window.confirm('把所有设置恢复为出厂默认？\n\n不会删除 API Key 与用量账本。')) return
                  void run(async () => {
                    await rpc('config/reset', { keepKeys: true })
                    await refresh()
                    await loadFilters()
                    await loadBreaker()
                  }, '已恢复出厂默认设置', 'danger')
                },
              },
              '恢复出厂默认设置',
            ),
            h(
              'button',
              {
                className: cx('btn', 'btnDanger'),
                disabled: busy || listens.length > 0 === false,
                title: '停止全部监听并关闭服务（不会卸载插件）',
                onClick: () => {
                  if (!window.confirm('停止全部监听并关闭服务？\n\n局域网将立刻无法访问，可随时重新启用。')) return
                  void run(async () => {
                    await rpc('config/set', { config: { enabled: false } })
                    await refresh()
                  }, '已停止服务并关闭全部监听', 'danger')
                },
              },
              '立即停止服务',
            ),
          ),
          h(Inline, { notice: noticeAt('danger') }),
        ),
      ])
    }

    // ────────────────────────────── provider 页 ──────────────────────────────

    function ProviderPage(props) {
      const { rpc, provider } = props
      const [models, setModels] = React.useState(null)
      const [openId, setOpenId] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [perf, setPerf] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      // ⚠ `rpc` 每次渲染都是新函数引用；若把它放进依赖数组，
      //    effect 会无限重跑并把 openId 重置为 null，表现为"模型点不开"（本机实测）。
      //    因此用 ref 持有最新 rpc，依赖只留 provider.id。
      const rpcRef = React.useRef(rpc)
      rpcRef.current = rpc

      React.useEffect(() => {
        let cancelled = false
        setModels(null)
        setOpenId(null)
        setPerf(null)
        setNotice(null)
        void (async () => {
          try {
            const r = await rpcRef.current('models/list', { provider: provider.id })
            if (!cancelled) setModels(r.models ?? [])
          } catch (error) {
            if (!cancelled) setNotice({ tone: 'error', text: error.message })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [provider.id])

      if (notice && models === null) return h(Notice, { tone: notice.tone }, notice.text)
      if (models === null) return h('div', { className: cx('empty') }, h('span', { className: cx('spin') }), '读取模型中…')
      if (models.length === 0) return h('div', { className: cx('empty') }, '该 provider 当前没有公开模型')

      return h(
        'div',
        null,
        h(Notice, { tone: 'info' }, `provider「${provider.name}」共 ${models.length} 个模型。模型公开名为 <模型>@${provider.slug}。`),
        notice ? h(Notice, { tone: notice.tone }, notice.text) : null,
        models.map((m) =>
          h(
            'div',
            { key: m.publicName, className: cx('model') },
            h(
              'button',
              { className: cx('modelHead'), onClick: () => setOpenId(openId === m.publicName ? null : m.publicName) },
              h(
                'span',
                { className: cx('modelTitle') },
                h('span', { className: cx('mono') }, m.publicName),
                m.description ? h('div', { className: cx('muted') }, m.description) : null,
              ),
              h('span', { className: cx('muted', 'nowrap') }, openId === m.publicName ? '▴ 收起' : '▾ 展开'),
            ),
            openId === m.publicName
              ? h(
                  'div',
                  { className: cx('modelBody') },
                  h(CapabilityPanel, { rpc, provider: provider.id, model: m.model, onNotice: setNotice, onBusy: setBusy }),
                  h(
                    'div',
                    { className: cx('row'), style: { marginTop: '10px' } },
                    h(
                      'button',
                      {
                        className: cx('btn', 'btnPrimary'),
                        disabled: busy,
                        onClick: async () => {
                          setBusy(true)
                          setPerf(null)
                          setNotice(null)
                          try {
                            const r = await rpc('model/perf', { provider: provider.id, model: m.model })
                            setPerf(r)
                          } catch (error) {
                            setNotice({ tone: 'error', text: error.message })
                          } finally {
                            setBusy(false)
                          }
                        },
                      },
                      '性能测试',
                    ),
                    h('span', { className: cx('muted') }, '一次最短调用，测延迟 / 首字 / 速度'),
                  ),
                  perf
                    ? perf.ok
                      ? h('div', { className: cx('green'), style: { marginTop: '8px' } },
                          `✅ 延迟 ${perf.latencyMs} ms · 首字 ${perf.ttftMs ?? '—'} ms · ${perf.tokPerSec ?? '—'} tok/s`)
                      : perf.kind === 'timeout'
                        ? h('div', { className: cx('red'), style: { marginTop: '8px' } }, `time out（${perf.timeoutMs}ms）`)
                        : h('div', { className: cx('red'), style: { marginTop: '8px' } }, `上游错误：${perf.raw ?? perf.message}`)
                    : null,
                )
              : null,
          ),
        ),
      )
    }

    // ────────────────────────────── 能力面板（P4） ──────────────────────────────

    /** 三态 → 复选框视觉与文案。 */
    const VALUE_META = {
      supported: { tone: 'on', text: '支持' },
      unsupported: { tone: 'off', text: '不支持' },
      unknown: { tone: 'warn', text: '未知' },
    }

    const SOURCE_LABEL = {
      dsh: '来自 DSH',
      declared: '已手动修改',
      profile: '推测',
      learned: '上游报错学习',
      probe: '已测试',
    }

    /** 功能测试项的中文名（结果列表用）。 */
    const CAP_ITEM_LABEL = {
      authoritative: '权威值刷新',
      connectivity: '基础连通',
      tools: '工具调用',
      temperature: '温度参数',
      jsonMode: 'JSON 模式',
      stop: '停止序列',
      image: '图片输入',
      parallelTools: '并行工具调用',
    }

    /** 一行能力：三态复选框 + 来源标注 + 可选"恢复权威值"。 */
    function CapRow(props) {
      const { label, field, cap, authoritative, busy, onChange, onReset } = props
      const value = cap?.value ?? 'unknown'
      const src = cap?.source ?? null
      const meta = VALUE_META[value] ?? VALUE_META.unknown
      const overridden = src === 'declared'
      // `conflict`（与权威值不一致）**不再用于渲染**：见下方说明 —— 由「恢复默认」按钮表达。
      // 保留计算仅用于注释说明；若将来需要在别处提示冲突可复用。

      // 用 indeterminate 表达"未知"（原生属性，无需自造视觉）
      const boxRef = React.useRef(null)
      React.useEffect(() => {
        if (boxRef.current !== null) boxRef.current.indeterminate = value === 'unknown'
      }, [value])

      return h(
        'div',
        { className: cx('cap') },
        h('input', {
          ref: boxRef,
          className: cx('checkbox'),
          type: 'checkbox',
          checked: value === 'supported',
          disabled: busy,
          onChange: (e) => onChange(field, e.target.checked ? 'supported' : 'unsupported'),
        }),
        h('span', { style: { minWidth: '92px' } }, label),
        h(Pill, { tone: meta.tone }, meta.text),
        src ? h('span', { className: cx('capSrc') }, `· ${SOURCE_LABEL[src] ?? src}`) : h('span', { className: cx('capSrc') }, '· 无依据'),
        // ⚠ 这里**刻意不再显示**"（DSH 记录的原值：X）"与"⚠ 与 DSH 记录不一致"。
        //
        // 用户指出：**「恢复默认」按钮的存在本身**已经表达了"当前值是你改过的、
        // 与默认（权威）值不同"这层含义，再在两侧各挂一长串注释是冗余的，
        // 而且会让**有权威值的项（图片/推理）比其它项多一段文字**，
        // 视觉上参差不齐（各项声明行应当外观一致）。
        // 需要看原值时，悬停「恢复默认」即可（title 里有）。
        overridden
          ? h(
              'button',
              {
                className: cx('btn'),
                disabled: busy,
                title:
                  authoritative != null
                    ? `按 DSH 记录的权威值重置（当前值由你手动声明；权威值：${VALUE_META[authoritative]?.text ?? authoritative}）`
                    : '按 DSH 记录的权威值重置（当前值由你手动声明）',
                onClick: () => onReset(field),
              },
              '恢复默认',
            )
          : null,
        cap?.note ? h('span', { className: cx('capSrc'), title: cap.note }, 'ⓘ') : null,
      )
    }

    /** 能力面板：权威项 + 档 B 项 + 测试按钮。 */
    function CapabilityPanel(props) {
      const { rpc, provider, model, onNotice, onBusy } = props
      const [caps, setCaps] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [testResult, setTestResult] = React.useState(null)
      /** 测试进度：`{elapsed, expect, done, current}` 或 null。 */
      const [progress, setProgress] = React.useState(null)
      /**
       * 当前测试轮次号。用于**作废在途的轮询回调**：
       * `clearInterval` 拦不住"已发出、尚未返回"的那次请求，它落地后会
       * 把已清空的进度又写回来（实测导致进度行永久残留）。
       * 每次测试递增；回调落地时若发现轮次已变，直接丢弃。
       */
      const myRunId = React.useRef(0)
      /** 本次将测试的项（用于显示总项数）。 */
      const testItems = ['connectivity', 'tools', 'temperature', 'jsonMode', 'stop', 'image']

      // 同上：`rpc`/`onNotice` 每次渲染都是新引用，用 ref 持有，依赖只留模型标识。
      const rpcRef = React.useRef(rpc)
      rpcRef.current = rpc
      const noticeRef = React.useRef(onNotice)
      noticeRef.current = onNotice

      const load = React.useCallback(async () => {
        try {
          const r = await rpcRef.current('model/capabilities', { provider, model })
          setCaps(r.capabilities)
        } catch (error) {
          setCaps(undefined)
          noticeRef.current?.({ tone: 'error', text: `读取能力失败：${error.message}` })
        }
      }, [provider, model])

      React.useEffect(() => {
        void load()
      }, [load])

      const setField = async (field, value) => {
        setBusy(true)
        onBusy?.(true)
        try {
          const r = await rpc('model/capability/set', { provider, model, field, value })
          setCaps(r.capabilities)
          onNotice?.({ tone: 'ok', text: `已把「${field}」声明为 ${VALUE_META[value]?.text ?? value}（以你的判断为准）` })
        } catch (error) {
          onNotice?.({ tone: 'error', text: error.message })
        } finally {
          setBusy(false)
          onBusy?.(false)
        }
      }

      const runTest = async () => {
        setBusy(true)
        onBusy?.(true)
        setTestResult(null)
        // 逐项进度。设计要点（两次实测踩坑后定型）：
        //
        // ① **本地计时优先，绝不依赖轮询才开始显示**。
        //    原先只在轮询成功时才 setProgress，一旦轮询拿不到数据（超时/被丢弃），
        //    用户在整个测试过程中**看不到任何反馈**，结束后才突然出现一行
        //    （实测：11 秒的测试全程无进度）。
        //    现在：进入测试立刻显示进度行，本地计时每秒自走；
        //    服务端数据到了只作**补充**（更精确的项数/当前项）。
        //
        // ② **用 runId 作废在途轮询**。
        //    `clearInterval` 只阻止"未来"的轮询，挡不住"已在飞行中"的那一次；
        //    它返回后仍会 setProgress，把 finally 里清掉的行**又写回来** →
        //    进度行永久残留（实测：测试完成后一直显示"已测 6/6 项 · 已用 11 秒"）。
        //    每次测试分配唯一 runId，回调落地时先校验，不是当前轮次就直接丢弃。
        const POLL_MS = 300
        const expectCount = testItems?.length ?? 7
        const startedAt = Date.now()
        myRunId.current += 1
        const runId = myRunId.current
        // 立即显示（visible 恒为 true，不再有"要不要显示"的启发式）
        setProgress({ elapsed: 0, expect: expectCount, done: 0, current: null })
        const tick = setInterval(() => {
          // ① 先本地推进计时（不依赖任何 IO）
          if (myRunId.current !== runId) return
          setProgress((prev) => (prev === null ? null : { ...prev, elapsed: Math.round((Date.now() - startedAt) / 1000) }))
          // ② 再尝试取服务端的精确进度（拿不到也不影响上面的计时）
          void (async () => {
            try {
              const p = await rpc('model/testProgress', {})
              // ★ 关键：本次测试已结束（或被新测试取代）→ 丢弃这个在途结果
              if (myRunId.current !== runId) return
              const total = p?.total > 0 ? p.total : expectCount
              setProgress((prev) => (prev === null ? null : {
                ...prev,
                elapsed: Math.round((Date.now() - startedAt) / 1000),
                expect: total,
                // 服务端的 done 已排除 authoritative；此处再钳一次作防御
                done: Math.min(p?.doneCount ?? 0, total),
                current: CAP_ITEM_LABEL[p?.current] ?? p?.current ?? null,
              }))
            } catch {
              /* 轮询失败无所谓：本地计时已在走 */
            }
          })()
        }, POLL_MS)
        onNotice?.({ tone: 'info', text: `正在逐项测试（共 ${expectCount} 项，每项一次真实模型调用）…` })
        try {
          const r = await rpc('model/test', { provider, model })
          setTestResult(r.results)
          setCaps(r.capabilities)
          // 项数按**正式测试项**计（排除 `authoritative`：它只是前置的权威值刷新，
          // 不是被测能力）。否则会出现"测试完成：7 项"与"已测 6/6"自相矛盾。
          const realCount = r.results.filter((x) => x.item !== 'authoritative').length
          onNotice?.({ tone: 'ok', text: `测试完成：${realCount} 项，结果见下方（不会自动改写能力声明）` })
        } catch (error) {
          onNotice?.({ tone: 'error', text: `测试失败：${error.message}` })
        } finally {
          // 先作废本轮（让在途轮询回调丢弃结果），再清理
          myRunId.current += 1
          clearInterval(tick)
          setProgress(null)
          setBusy(false)
          onBusy?.(false)
        }
      }

      if (caps === null) {
        return h('div', { className: cx('caps') }, h('span', { className: cx('spin') }), '读取能力中…')
      }

      const raw = caps.authoritativeRaw ?? {}
      const rows = [
        ['text', '文本输入', undefined],
        ['image', '图片输入', raw.image],
        ['reasoning', '推理能力', raw.reasoning],
        ['tools', '工具调用', undefined],
        ['parallelTools', '并行工具调用', undefined],
        ['jsonMode', 'JSON 模式', undefined],
        ['temperature', '温度参数', undefined],
        ['stop', '停止序列', undefined],
      ]

      return h(
        'div',
        null,
        h(
          'div',
          { className: cx('caps') },
          rows.map(([field, label, authoritative]) =>
            h(CapRow, {
              key: field,
              label,
              field,
              cap: caps[field],
              authoritative,
              busy,
              onChange: setField,
              onReset: (f) => setField(f, null),
            }),
          ),
          // 数值型能力（非复选框）
          h('div', { className: cx('cap') },
            h('span', { style: { minWidth: '92px' } }, '上下文窗口'),
            h('span', { className: cx('mono') },
              caps.contextWindow?.value !== undefined && typeof caps.contextWindow.value === 'number'
                ? String(caps.contextWindow.value)
                : '未知'),
            h('span', { className: cx('capSrc') }, '· 来自 DSH'),
          ),
          h('div', { className: cx('cap') },
            h('span', { style: { minWidth: '92px' } }, '最大输出'),
            h('span', { className: cx('mono') },
              caps.maxOutputTokens?.value !== undefined && typeof caps.maxOutputTokens.value === 'number'
                ? String(caps.maxOutputTokens.value)
                : '未知'),
            h('span', { className: cx('capSrc') }, '· 来自 DSH'),
          ),
          caps.reasoning?.efforts?.length
            ? h('div', { className: cx('cap') },
                h('span', { style: { minWidth: '92px' } }, '可选推理档位'),
                h('span', { className: cx('mono') }, caps.reasoning.efforts.join(' / ')),
                caps.reasoning.defaultEffort ? h('span', { className: cx('capSrc') }, `· 默认 ${caps.reasoning.defaultEffort}`) : null,
              )
            : null,
        ),
        h(
          'div',
          { className: cx('row'), style: { marginTop: '8px' } },
          h('button', { className: cx('btn', 'btnPrimary'), disabled: busy, onClick: runTest },
            busy ? h('span', null, h('span', { className: cx('spin') }), '功能测试中…') : '功能测试'),
          // 说明放按钮**右侧**（与"性能测试"一行一致，用户要求统一）。
          // ⚠ 必须**短**：`.dim-lt-row` 是 flex-wrap，文案一长就换行到下一排，
          // 视觉上又变成"在按钮下方"（用户实测反馈）。
          // 因此行内只写"这是什么"，"结果不会自动回填"这条要点放到结果区的提示里。
          h('span', { className: cx('muted') }, '逐项真实调用，发现隐藏能力'),
        ),
        // 测试进度：显示"已测 N / 共 M · 正在测 XXX · 已用 Xs"
        // 进入测试后**立即显示**，本地计时自走；服务端数据到达后补充精确项数。
        // （不再有 visible 门槛 —— 那会让轮询失败时全程无反馈。）
        progress !== null
          ? h('div', { className: cx('inline', 'inlineOk'), style: { marginTop: '6px' } },
              h('span', { className: cx('spin') }),
              ` 已测 ${Math.min(progress.done, progress.expect)}/${progress.expect} 项` +
                (progress.current !== null && progress.current !== undefined ? ` · 正在测「${progress.current}」` : '') +
                ` · 已用 ${progress.elapsed} 秒` +
                (progress.elapsed >= 25 ? '（图片项最长等 30 秒）' : ''),
            )
          : null,
        testResult
          ? h('div', { className: cx('caps'), style: { marginTop: '8px' } },
              // 结果区顶部固定提示（3b 要点）：把"不会自动回填"讲清楚。
              // 放在这里而不是按钮旁，是因为按钮那行空间有限（文案一长就换行）。
              h(
                Notice,
                { tone: 'info' },
                '下面是实测结果，仅供你参考 —— 不会自动改写上面的能力声明。要改声明，请直接点左侧复选框。',
              ),
              // 汇总提示（P16 改进）：同一原因（如"未配置凭据"）会在多行重复出现，
              // 逐行显示既啰嗦又把药丸挤扁。这里**合并成一条**置顶，行内只留状态。
              //
              // ⚠ 措辞（方案 1）：原先写作「（N 项一致）」，但"N 项"对用户没有意义
              //（他不知道为什么会有"项"这个概念）。改为**点名具体是哪些项**，
              // 并说明这些项是同一个原因导致的。
              (() => {
                const notes = testResult.map((r) => r.note).filter((n) => typeof n === 'string' && n.length > 0)
                const counted = new Map()
                for (const n of notes) counted.set(n, (counted.get(n) ?? 0) + 1)
                const repeated = [...counted.entries()].filter(([, c]) => c > 1)
                if (repeated.length === 0) return null
                return h(
                  Notice,
                  { tone: 'warn' },
                  repeated
                    .map(([n, c]) => {
                      const names = testResult
                        .filter((r) => r.note === n)
                        .map((r) => CAP_ITEM_LABEL[r.item] ?? r.item)
                      return `${names.join('、')}：${n}` + (c > names.length ? `（${c} 项）` : '')
                    })
                    .join('；'),
                )
              })(),
              testResult.map((r) => {
                // 「权威值刷新」不是单项三态，而是**一组权威值快照**
                //（`{image, reasoning, contextWindow, maxOutputTokens…}`，没有 `value` 字段）。
                // 用三态药丸渲染会取到 undefined → 显示成孤零零的 `?`（用户实测发现）。
                // 这里给它单独的渲染分支：直接列出刷新到的权威值。
                if (r.item === 'authoritative') {
                  const bits = []
                  if (r.image !== undefined) bits.push(`图片=${VALUE_META[r.image]?.text ?? r.image}`)
                  if (r.reasoning !== undefined) bits.push(`推理=${VALUE_META[r.reasoning]?.text ?? r.reasoning}`)
                  if (typeof r.contextWindow === 'number') bits.push(`上下文=${r.contextWindow.toLocaleString()}`)
                  if (typeof r.maxOutputTokens === 'number') bits.push(`最大输出=${r.maxOutputTokens.toLocaleString()}`)
                  else if (r.maxOutputTokens !== undefined) bits.push(`最大输出=${VALUE_META[r.maxOutputTokens]?.text ?? r.maxOutputTokens}`)
                  return h('div', { key: r.item, className: cx('cap') },
                    h('span', { style: { minWidth: '92px' } }, '权威值刷新'),
                    h(Pill, { tone: 'on' }, '已刷新'),
                    h('span', { className: cx('capSrc') }, bits.length > 0 ? bits.join(' · ') : '无可用权威值'),
                  )
                }
                // 已在汇总里说过的重复原因，行内不再重复显示
                const noteRepeated =
                  typeof r.note === 'string' &&
                  r.note.length > 0 &&
                  testResult.filter((x) => x.note === r.note).length > 1
                // 测试结果的药丸文案（方案 1+2，用户要求）：
                // `supported` 在这条链路上其实只代表"**实测请求没报错**"，
                // 用能力矩阵里的"支持"会让人以为"参数确实生效了"——不准确。
                // 因此测试结果区改用「已通过 / 未通过 / 待定」，更贴合它的真实含义。
                const TEST_META = {
                  supported: { tone: 'on', text: '已通过' },
                  unsupported: { tone: 'off', text: '未通过' },
                  unknown: { tone: 'warn', text: '待定' },
                }
                const meta = TEST_META[r.value] ?? VALUE_META[r.value] ?? { tone: 'warn', text: String(r.value ?? '?') }
                return h('div', { key: r.item, className: cx('cap') },
                  h('span', { style: { minWidth: '92px' } }, CAP_ITEM_LABEL[r.item] ?? r.item),
                  h(Pill, { tone: meta.tone }, meta.text),
                  r.ms !== undefined ? h('span', { className: cx('capSrc') }, `${r.ms} ms`) : null,
                  r.verified === true ? h('span', { className: cx('green') }, '内容已读出') : null,
                  r.verified === false && r.answers ? h('span', { className: cx('inlineErr') }, `模型读出的内容不符（它说："${String(r.answers).slice(0, 40)}"）`) : null,
                  // 方法/依据说明一律收进 ⓘ 悬停（方案 1）：行内只留结论，避免长句挤爆版面。
                  r.note && !noteRepeated
                    ? h('span', { className: cx('infoIcon'), title: r.note, 'aria-label': r.note }, 'ⓘ')
                    : null,
                  r.evidence ? h('span', { className: cx('capSrc'), title: r.evidence }, '（有依据）') : null,
                  r.error ? h('span', { className: cx('red') }, r.error) : null,
                )
              }),
            )
          : null,
      )
    }

    // ────────────────────────────── 主页面 ──────────────────────────────

    function LanternPage(props) {
      // 只用 `rpc`：`close` 曾用于渲染一个与设置弹窗 × 重复的「关闭」按钮，已移除。
      const { rpc } = props
      const [status, setStatus] = React.useState(null)
      const [selected, setSelected] = React.useState(null)

      // ⚠ 关键：`rpc` 每次渲染都是新引用。
      // 若把它放进依赖数组，定时器会反复重建；更不能把"轮询计数"用作子组件 key——
      // 那会让 ProviderPage 每 5 秒被强制重挂载，表现为**模型永远点不开**
      // （openId 被重置）。本机实测踩过，故用 ref 稳定引用、key 只随选择变化。
      const rpcRef = React.useRef(rpc)
      rpcRef.current = rpc

      React.useEffect(() => {
        let cancelled = false
        const tick = async () => {
          try {
            const s = await rpcRef.current('status', {})
            if (!cancelled) setStatus(s)
          } catch {
            /* 面板仍可用（显示空状态） */
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), 5000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])

      const providers = status?.directory?.providers ?? []
      const allProviders = status?.directory?.allProviders ?? providers
      const current = selected === null ? 'status' : selected
      const activeProvider = providers.find((p) => p.id === current) ?? allProviders.find((p) => p.id === current)

      return h(
        'section',
        { className: cx('page'), 'aria-label': 'LANtern 设置' },
        h(
          'header',
          { className: cx('header') },
          h(
            'div',
            { className: cx('brand') },
            h('strong', { className: cx('brandName') }, 'LANtern · 局域网模型灯塔'),
            h('p', { className: cx('brandDesc') }, '把本机 DSH 的全部模型公开给局域网'),
          ),
          h(
            'div',
            { className: cx('headerActions') },
            status ? h(Pill, { tone: status.enabled ? 'on' : 'off' }, status.enabled ? '运行中' : '已停止') : null,
            // 局域网可达性：用**短标记 + 悬停提示**，避免长文案把 header 挤变形
            //（header 会随面板宽度换行；面板仅 ~340px，长句会占掉好几行）。
            (() => {
              if (!status?.enabled) return null
              const activeListen = (status.listen ?? []).filter((x) => x.listening !== false)
              if (activeListen.length === 0) return null
              const lanReachable = activeListen.some((x) => x.bind === '0.0.0.0' || x.bind === '::')
              return h(
                'span',
                {
                  className: cx('capSrc'),
                  title: lanReachable
                    ? '监听地址为 0.0.0.0，局域网内其他设备可直接访问。'
                    : '当前只绑本机回环（127.0.0.1），局域网访问不到。\n' +
                      '要暴露到局域网：改用 standalone 模式，或让 DSH 以 --host 0.0.0.0 启动。',
                },
                lanReachable ? '· 局域网可访问' : '· 仅本机',
              )
            })(),
            status ? h('span', { className: cx('muted') }, `${status.directory?.publicCount ?? 0} 个模型`) : null,
            // 不再渲染「关闭」按钮（用户指出）：DSH 设置弹窗**右上角本来就有 ×**，
            // 这个按钮是从 Jet Hub 原样复制来的，功能与 × 完全重复，属冗余入口。
          ),
        ),
        h(
          'div',
          { className: cx('layout') },
          h(
            'nav',
            { className: cx('rail'), role: 'tablist', 'aria-label': 'LANtern 导航' },
            // ① 状态与安全：固定在最上方（用户要求：位于各 provider 之上）
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: cx('nav'),
                'aria-selected': current === 'status',
                onClick: () => setSelected('status'),
              },
              h('span', { className: cx('navIcon') }, '⚙'),
              h(
                'span',
                { className: cx('navLabel') },
                h('strong', null, '状态与安全'),
                h('span', null, '开关 · 端口 · Key'),
              ),
              null,
            ),
            h('div', { className: cx('railDivider') }),
            providers.map((p) =>
              h(
                'button',
                {
                  key: p.id,
                  type: 'button',
                  role: 'tab',
                  className: cx('nav'),
                  'aria-selected': current === p.id,
                  onClick: () => setSelected(p.id),
                },
                h('span', { className: cx('navIcon') }, p.visible ? '▸' : '·'),
                h(
                  'span',
                  { className: cx('navLabel') },
                  // 悬停提示**统一格式**：两行各自一个 title 会导致"有时看到大字、
                  // 有时看到小字"的不一致体验（用户实测发现）。
                  // 这里两行共用同一个 `名称(@slug)`，与模型公开名 `<model>@<slug>` 同构。
                  (() => {
                    const nameTip = p.visible
                      ? `${p.name}(@${p.slug})`
                      : `${p.name}（隐藏：${p.hiddenReason ?? '不可用'}）`
                    return [
                      h('strong', { key: 'n', title: nameTip }, p.name),
                      h('span', { key: 's', title: nameTip }, p.visible ? p.slug : `隐藏（${p.hiddenReason ?? '不可用'}）`),
                    ]
                  })(),
                ),
                h('span', { className: cx('navCount') }, p.visible ? String(p.modelCount) : '—'),
              ),
            ),
            providers.length === 0
              ? h('div', { className: cx('railFoot') }, '当前没有可显示的 provider')
              : null,
          ),
          h(
            'main',
            { className: cx('panel'), role: 'tabpanel' },
            // key 只随"当前选择"变化，**不随轮询变化**（否则每次轮询都会重挂载子页，
            // 展开状态与输入都会被清空）。
            current === 'status'
              ? h(StatusPage, { key: 'status', rpc })
              : activeProvider
                ? h(ProviderPage, { key: current, rpc, provider: activeProvider })
                : h('div', { className: cx('empty') }, '该 provider 已不可用'),
          ),
        ),
      )
    }

    // ────────────────────────────── 插件入口 ──────────────────────────────

    var inject = ['slots', 'connection']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'lantern: install styles')

      const rpcCall = async (method, payload) => {
        const raw = await ctx.connection.rpc.call('/api', ENDPOINT, { method, payload })
        return unwrap(raw)
      }

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'lantern',
            order: 40,
            label: () => 'LANtern',
            inject: () => ({ rpc: rpcCall }),
          },
          LanternPage,
        ),
      )
    }

    module.exports = { apply, inject, name: 'lantern-client' }
    return module.exports
  },
})
