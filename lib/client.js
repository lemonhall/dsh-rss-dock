/**
 * Client half of dsh-rss-dock —— 右侧栏的「RSS 阅读器」tab。
 *
 * 纯 DOM：左边订阅源、右边条目。已读/收藏的**真相在宿主**（lib/state.js），
 * 这里 2 秒轮询一次 —— 所以 Agent 用 rss_panel 标了已读，界面会自己跟上。
 *
 * ⚠️ 整个模块包在 IIFE 里：DSH 把所有客户端插件拼成一个脚本加载，
 * 顶层的 const 会跨插件撞名（实测 TAB_KIND 撞过，直接把 web app 挡在启动之外）。
 */

;(() => {
const TAB_KIND = 'rss-reader'
const TAB_ID = 'dsh-rss-dock:rss'

const ROUTES = {
  feeds: '/dsh-rss/feeds',
  items: '/dsh-rss/items',
  state: '/dsh-rss/state',
  translate: '/dsh-rss/translate',
}

window.__ModuleLoader__.load({
  id: 'dsh-rss-dock',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary, #5a7cff)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    function fmtWhen(ms) {
      if (!ms) return ''
      const diff = Date.now() - ms
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
      if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function ReaderPanel() {
      const [feeds, setFeeds] = React.useState([])
      const [items, setItems] = React.useState([])
      const [state, setState] = React.useState({ read: {}, starred: [], selectedFeed: null })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      /**
       * 译文表：原文 → 中文。
       * 用**单独的 map**而不是改 items 里的字段 —— 这样刷新、切换源、重新排序都不会把译文弄丢，
       * 也不需要在十几个渲染点都改一遍（渲染时查一次表就行）。
       */
      const [zh, setZh] = React.useState({})
      const [onlyUnread, setOnlyUnread] = React.useState(false)
      const stateRef = React.useRef(state)
      React.useEffect(() => {
        stateRef.current = state
      }, [state])

      const [activeFeed, setActiveFeed] = React.useState(null)

      const pushState = React.useCallback((patch) => {
        fetch(ROUTES.state, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }).catch(() => {
          /* 本地视图优先，下一轮轮询会对齐 */
        })
      }, [])

      const load = React.useCallback(
        async (feed) => {
          setBusy(true)
          try {
            const url = feed ? `${ROUTES.items}?feed=${encodeURIComponent(feed)}` : ROUTES.items
            const response = await fetch(url)
            const payload = await response.json()
            if (!payload.ok) throw new Error(payload.error || '取条目失败')
            setItems(payload.items || [])
            setError(payload.errors && payload.errors.length ? `${payload.errors.length} 个源取失败` : null)
          } catch (err) {
            setError(String((err && err.message) || err))
          } finally {
            setBusy(false)
          }
        },
        [],
      )

      /**
       * 列表一到就把标题+摘要**批量**送去翻译（一次请求，不是一条一发）。
       * 后台跑、失败不打扰 —— 翻译挂了列表照样是英文，不影响阅读。
       * 组件卸载时用 dropped 标记丢弃迟到的响应，避免对着已卸载组件 setState。
       */
      React.useEffect(() => {
        const texts = []
        for (const item of items) {
          if (item.title) texts.push(String(item.title))
          if (item.summary) texts.push(String(item.summary))
        }
        if (!texts.length) return undefined
        let dropped = false
        fetch(ROUTES.translate, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ texts }),
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (dropped || !payload || !payload.ok || !Array.isArray(payload.translated)) return
            const next = {}
            texts.forEach((src, index) => {
              const dst = payload.translated[index]
              if (dst && dst !== src) next[src] = dst
            })
            if (Object.keys(next).length) setZh((prev) => ({ ...prev, ...next }))
          })
          .catch(() => {})
        return () => {
          dropped = true
        }
      }, [items])

      // 首次：取源清单 + 状态 + 全部条目
      React.useEffect(() => {
        let cancelled = false
        fetch(ROUTES.feeds)
          .then((response) => response.json())
          .then((payload) => {
            if (cancelled || !payload || !payload.ok) return
            setFeeds(payload.feeds || [])
            if (payload.state) setState(payload.state)
          })
          .catch(() => {})
        load(null)
        return () => {
          cancelled = true
        }
      }, [load])

      // 双向通道：2 秒轮询宿主状态（Agent 改了已读/收藏，界面跟上）
      React.useEffect(() => {
        let cancelled = false
        const timer = setInterval(() => {
          fetch(ROUTES.state)
            .then((response) => response.json())
            .then((payload) => {
              if (cancelled || !payload || !payload.ok) return
              const remote = payload.state || {}
              const current = stateRef.current || {}
              if ((remote.revision || 0) !== (current.revision || 0)) setState(remote)
            })
            .catch(() => {})
        }, 2000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])

      const read = state.read || {}
      const starred = state.starred || []
      const unreadOf = (feedTitle) => items.filter((item) => (!feedTitle || item.feed === feedTitle) && !read[item.id]).length
      /**
       * ⚠️ 只按「未读」筛，**不按源筛**。
       *
       * 选中的源已经由宿主在 `?feed=` 里筛过了（实测：`?feed=纽约时报 · 商业`
       * 只返回商业那几条）。客户端再筛一遍是冗余的，而且**一旦两边的字符串对不上**
       * （改过订阅源标题之后就会对不上），列表就会永久卡在某个源上 ——
       * 实测症状：点过「纽约时报 · 国际」之后，再点商业/科技/其它都还停在国际。
       */
      const visible = items.filter((item) => !onlyUnread || !read[item.id])
      const totalUnread = items.filter((item) => !read[item.id]).length

      const openItem = (item) => {
        if (!read[item.id]) {
          setState((prev) => ({ ...prev, read: { ...(prev.read || {}), [item.id]: Date.now() } }))
          pushState({ read: { ...read, [item.id]: Date.now() } })
        }
        if (item.link) {
          try {
            window.open(item.link, '_blank', 'noopener')
          } catch {
            /* 打不开就算了，链接还显示在标题里 */
          }
        }
      }

      const toggleStar = (item, event) => {
        event.stopPropagation()
        const has = starred.includes(item.id)
        const next = has ? starred.filter((id) => id !== item.id) : [...starred, item.id]
        setState((prev) => ({ ...prev, starred: next }))
        pushState({ starred: next })
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text } },
        // 顶栏
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '9px 12px',
              borderBottom: `1px solid ${C.border}`,
              fontSize: 12,
            },
          },
          h('span', { style: { fontWeight: 600 } }, '📰 RSS'),
          h('span', { style: { fontFamily: C.mono, fontSize: 10, color: C.dim } }, `未读 ${totalUnread} / ${items.length}`),
          h(
            'span',
            {
              onClick: () => setOnlyUnread((value) => !value),
              style: {
                marginLeft: 'auto',
                cursor: 'pointer',
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 5,
                color: onlyUnread ? C.text : C.dim,
                background: onlyUnread ? `color-mix(in srgb, ${C.accent} 24%, transparent)` : 'transparent',
                border: `1px solid ${C.border}`,
              },
            },
            '只看未读',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => load(activeFeed),
              title: '重新抓取',
              style: { border: `1px solid ${C.border}`, background: 'transparent', color: C.text, borderRadius: 6, fontSize: 12, padding: '1px 7px', cursor: 'pointer' },
            },
            busy ? '…' : '⟳',
          ),
        ),
        error ? h('div', { style: { padding: '4px 12px', fontSize: 10.5, color: '#ff5a4d' } }, error) : null,
        // 主体：左源右条目
        h(
          'div',
          { style: { flex: '1 1 auto', minHeight: 0, display: 'flex' } },
          h(
            'div',
            { style: { width: 168, flex: 'none', borderRight: `1px solid ${C.border}`, overflow: 'auto', padding: '6px 4px' } },
            [
              { key: null, title: '全部', count: items.filter((item) => !read[item.id]).length },
              ...feeds.map((feed) => ({ key: feed.title, title: feed.title, count: unreadOf(feed.title) })),
            ].map((row) =>
              h(
                'div',
                {
                  key: row.key || '__all',
                  onClick: () => {
                    setActiveFeed(row.key)
                    load(row.key)
                  },
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 7px',
                    borderRadius: 6,
                    fontSize: 11.5,
                    cursor: 'pointer',
                    color: activeFeed === row.key ? C.text : C.dim,
                    background: activeFeed === row.key ? `color-mix(in srgb, ${C.accent} 20%, transparent)` : 'transparent',
                  },
                },
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.title),
                h('span', { style: { marginLeft: 'auto', fontFamily: C.mono, fontSize: 10, opacity: 0.7 } }, row.count ? String(row.count) : ''),
              ),
            ),
          ),
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0, overflow: 'auto', padding: '4px 6px 12px' } },
            visible.length
              ? visible.map((item) =>
                  h(
                    'div',
                    {
                      key: item.id,
                      onClick: () => openItem(item),
                      style: {
                        padding: '7px 8px',
                        borderRadius: 7,
                        cursor: 'pointer',
                        opacity: read[item.id] ? 0.55 : 1,
                        borderBottom: `1px solid color-mix(in srgb, ${C.border} 60%, transparent)`,
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'baseline', gap: 6 } },
                      h('span', { style: { fontSize: 12.5, lineHeight: 1.4, fontWeight: read[item.id] ? 400 : 600 } }, zh[item.title] || item.title),
                      h(
                        'span',
                        {
                          onClick: (event) => toggleStar(item, event),
                          title: starred.includes(item.id) ? '取消收藏' : '收藏',
                          style: { marginLeft: 'auto', flex: 'none', cursor: 'pointer', color: starred.includes(item.id) ? '#ffd479' : C.dim, fontSize: 12 },
                        },
                        starred.includes(item.id) ? '★' : '☆',
                      ),
                    ),
                    item.summary
                      ? h(
                          'div',
                          {
                            style: {
                              marginTop: 3,
                              fontSize: 11,
                              color: C.dim,
                              lineHeight: 1.45,
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            },
                          },
                          zh[item.summary] || item.summary,
                        )
                      : null,
                    h(
                      'div',
                      { style: { marginTop: 3, fontFamily: C.mono, fontSize: 10, color: C.dim } },
                      `${item.feed || ''} · ${fmtWhen(item.at)}`,
                    ),
                  ),
                )
              : h('div', { style: { padding: 14, fontSize: 12, color: C.dim } }, busy ? '抓取中…' : '没有条目'),
          ),
        ),
      )
    }

    function RssBody() {
      return h(ReaderPanel)
    }

    function RssTitle() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { 'aria-hidden': 'true' }, '📰'),
        h('span', null, 'RSS'),
      )
    }

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      ctx.inject(['sidebarRightTabs'], (scoped) => {
        scoped.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => 'RSS',
          guide: [
            {
              id: TAB_KIND,
              kind: TAB_KIND,
              order: 70,
              title: () => 'RSS 阅读器',
              description: () => '订阅源 · 未读 · 收藏',
              icon: () => h('span', { style: { fontSize: 16 } }, '📰'),
            },
          ],
        })
      })
      ctx.inject(['slots'], (scoped) => {
        scoped.slots.inject('sidebar.right.pane.tab', () =>
          scoped.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, RssBody),
        )
        scoped.slots.inject('sidebar.right.pane.tab.title', () =>
          scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, RssTitle),
        )
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
})()
