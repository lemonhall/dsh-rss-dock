/**
 * Host half of dsh-rss-dock —— 抓订阅源、解析、暴露给右侧栏，并给 Agent 一个读写口。
 *
 * 抓取用 curl 走本机代理（很多源在墙外），解析用正则同时认 RSS 2.0 与 Atom ——
 * 不为一个阅读器引 XML 库。
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStateStore } from './state.js'
import { createTranslator } from './translate.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULTS = {
  curl: 'curl.exe',
  proxy: 'http://127.0.0.1:7897',
  timeoutMs: 20000,
  maxItems: 40,
  cacheTtlMs: 600000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-rss-dock/0.1',
  // 英文条目自动配中文（翻译用 DeepSeek，凭据走 ctx.credentials；拿不到就不翻）
  translate: true,
  feeds: [],
}

const ROUTE_FEEDS = '/dsh-rss/feeds'
const ROUTE_ITEMS = '/dsh-rss/items'
const ROUTE_STATE = '/dsh-rss/state'
const ROUTE_TRANSLATE = '/dsh-rss/translate'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const stateStore = createStateStore(join(DSH_HOME, 'dsh-rss-dock', 'state.json'), {
  read: {}, // { itemId: 时间戳 }
  starred: [], // [itemId]
  selectedFeed: null, // 界面左侧选中的源（显示名）
  pendingQuestion: null, // 界面"问一句"攒的内容，Agent 能读到
})

/** 每个源一份缓存：url → { at, items, error }。 */
const feedCache = new Map()

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    /* 连接已经断了 */
  }
}

/** curl 取文本；状态码用 `-w '\n%{http_code}'` 从尾巴切出来。 */
function curlText(url, options) {
  const { proxy, curl = 'curl.exe', timeoutMs = 20000, userAgent } = options || {}
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-rss-'))
  const args = [
    '-sS',
    '-L',
    '--compressed',
    '--retry',
    '2',
    '--retry-delay',
    '1',
    '--retry-connrefused',
    '--max-time',
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
  ]
  if (userAgent) args.push('-A', userAgent)
  args.push('-w', '\n%{http_code}')
  if (proxy) args.push('-x', String(proxy))
  args.push(url)
  return new Promise((resolve) => {
    execFile(
      curl,
      args,
      { timeout: timeoutMs + 5000, windowsHide: true, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        try {
          rmSync(scratch, { recursive: true, force: true })
        } catch {
          /* gone */
        }
        const raw = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '')
        const match = /\n(\d{3})\s*$/.exec(raw)
        resolve({
          status: match ? Number(match[1]) : 0,
          content: match ? raw.slice(0, match.index) : raw,
          error: error ? `curl 退出码 ${error.code ?? '?'}：${String(error.message || error).slice(0, 160)}` : undefined,
        })
      },
    )
  })
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
}

function stripTags(text) {
  return decodeEntities(
    String(text || '')
      // ⚠️ 必须先剥 CDATA 再剥标签：`<![CDATA[Where Is the Planet]]>` 里没有 `>`，
      // 若先跑 `<[^>]*>`，整段 CDATA 会被当成一个标签吃掉，标题变空串、条目被丢掉。
      // （HN 的 feed 就是这样，20 条全没了。描述里因为夹了 `<p>` 才侥幸没出事。）
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function pickTag(block, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block)
  return match ? match[1].trim() : ''
}

/** 同时认 RSS 2.0（`<item>`）与 Atom（`<entry>`）。 */
export function parseFeed(xml, feed) {
  const text = String(xml || '')
  const items = []
  const push = (item) => {
    if (!item.title) return
    items.push({ ...item, feed: feed.title || feed.url })
  }

  for (const block of text.match(/<item[\s>][\s\S]*?<\/item>/g) || []) {
    push({
      id: stripTags(pickTag(block, 'guid')) || pickTag(block, 'link') || stripTags(pickTag(block, 'title')),
      title: stripTags(pickTag(block, 'title')),
      link: decodeEntities(pickTag(block, 'link')),
      summary: stripTags(pickTag(block, 'description')).slice(0, 400),
      at: Date.parse(pickTag(block, 'pubDate')) || 0,
    })
  }

  if (!items.length) {
    for (const block of text.match(/<entry[\s>][\s\S]*?<\/entry>/g) || []) {
      const linkMatch = /<link[^>]*href=["']([^"']+)["']/.exec(block)
      push({
        id: stripTags(pickTag(block, 'id')) || (linkMatch ? linkMatch[1] : '') || stripTags(pickTag(block, 'title')),
        title: stripTags(pickTag(block, 'title')),
        link: linkMatch ? decodeEntities(linkMatch[1]) : '',
        summary: stripTags(pickTag(block, 'summary') || pickTag(block, 'content')).slice(0, 400),
        at: Date.parse(pickTag(block, 'updated') || pickTag(block, 'published')) || 0,
      })
    }
  }

  return items
}

/** 取一个源（带缓存）。 */
async function feedItems(feed, opts) {
  const key = feed.url
  const hit = feedCache.get(key)
  if (hit && Date.now() - hit.at < opts.cacheTtlMs) return hit
  const result = await curlText(feed.url, opts)
  let entry
  if (result.status < 200 || result.status >= 300) {
    entry = { at: Date.now(), items: [], error: `HTTP ${result.status} ${String(result.content || result.error).slice(0, 120)}` }
  } else {
    const items = parseFeed(result.content, feed).slice(0, opts.maxItems)
    entry = { at: Date.now(), items, error: items.length ? undefined : '没解析出条目（可能不是 RSS/Atom）' }
  }
  feedCache.set(key, entry)
  return entry
}

/** 限流并发。 */
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      out[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return out
}

function feedList(opts) {
  return (opts.feeds || [])
    .map((feed, index) => ({ index, title: String(feed.title || feed.url || `源 ${index + 1}`), url: String(feed.url || '') }))
    .filter((feed) => feed.url)
}

/** Host plugin body. */
function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const opts = { ...DEFAULTS, ...cfg }

  /**
   * 翻译器。凭据从 cordis 的 credentials 里取 —— 拿不到就**不翻**（列表照样能看，
   * 不会因为翻译把阅读器搞挂）。缓存落盘在插件自己的目录下，同一段文字只翻一次。
   */
  const translator = createTranslator({
    cacheFile: join(DSH_HOME, 'dsh-rss-dock', 'translate-cache.json'),
    /**
     * 取 DeepSeek 的 key。**异步**，API 是 `resolve(ref)` 不是 `get(...)`。
     *
     * 我第一版猜了个同步的 `credentials.get('DSH_DEEPSEEK_API_KEY')` —— 那个方法根本不存在，
     * 于是每次静默拿到 null、翻译器一路返回原文，界面上看到的就是「还是英文」。
     * 契约（cordis_inspect_query(host, Service, listService, {service:'credentials'})）：
     *   resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
     *   ResolvedCredential = { value: string; source: string }
     * 契约还写明「每次操作都要重新解析、不要跨操作缓存」——所以这里不缓存。
     */
    getApiKey: async () => {
      if (opts.translate === false) return null
      try {
        const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
        if (!credentials || typeof credentials.resolve !== 'function') return null
        for (const ref of ['DSH_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY']) {
          const resolved = await credentials.resolve(ref)
          if (resolved && resolved.value) return String(resolved.value)
        }
        return null
      } catch {
        return null
      }
    },
    log: (message) => {
      try {
        ctx.logger && ctx.logger.info && ctx.logger.info(`[rss] ${message}`)
      } catch {
        /* 没有 logger 就算了 */
      }
    },
  })

  ctx.inject(['tools'], (toolScoped) => {
    toolScoped.tools.register({
      name: 'rss_panel',
      description:
        '读写 DSH 右侧栏「RSS 阅读器」面板。' +
        'action=list 看订阅源；action=items 取条目（可给 feed=源标题，不给就取全部、按时间倒序）；' +
        'action=state 看已读/收藏；action=read/unread/star/unstar 改标记（用 itemId 或 link）。' +
        'itemId 从 items 的返回里拿。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'items', 'state', 'read', 'unread', 'star', 'unstar', 'select_feed'],
            description: '要做的动作；list/items/state 是只读的。',
          },
          feed: { type: 'string', description: 'items/select_feed：订阅源标题（如 少数派）。' },
          count: { type: 'number', description: 'items：最多取几条，默认 15。' },
          itemId: { type: 'string', description: 'read/unread/star/unstar：条目 id 或它的 link。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: String((value && value.text) || '') }]
        },
      },
      presentCall(args) {
        return { card: 'terminal', title: `rss_panel ${String((args && args.action) || 'items')}`.trim() }
      },
      async execute(args) {
        const action = String((args && args.action) || 'items').toLowerCase()
        const feeds = feedList(opts)

        if (action === 'list') {
          return { text: feeds.map((feed) => `${feed.index + 1}. ${feed.title}  ${feed.url}`).join('\n') || '（配置里没有订阅源）' }
        }

        if (action === 'state') {
          const s = stateStore.get()
          return {
            text: JSON.stringify(
              {
                已读: Object.keys(s.read || {}).length,
                收藏: s.starred || [],
                选中源: s.selectedFeed,
                pendingQuestion: s.pendingQuestion,
                revision: s.revision,
              },
              null,
              2,
            ),
          }
        }

        if (action === 'items') {
          const wanted = String(args.feed || '').trim()
          const count = Math.min(60, Math.max(1, Number(args.count) || 15))
          const targets = wanted ? feeds.filter((feed) => feed.title.includes(wanted) || feed.url.includes(wanted)) : feeds
          if (!targets.length) return { text: `没有匹配「${wanted}」的订阅源` }
          const results = await mapLimit(targets, 3, (feed) => feedItems(feed, opts))
          const all = results.flatMap((entry) => entry.items || []).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, count)
          const state = stateStore.get()
          const lines = all.map((item) => {
            const flags = [state.read && state.read[item.id] ? '已读' : '', (state.starred || []).includes(item.id) ? '★' : '']
              .filter(Boolean)
              .join(' ')
            const when = item.at ? new Date(item.at).toLocaleString('zh-CN', { hour12: false }) : '时间未知'
            return `- [${item.feed}] ${item.title}\n  ${when}${flags ? `  ${flags}` : ''}\n  ${item.link}\n  id=${item.id}`
          })
          const errors = results.filter((entry) => entry.error)
          return {
            text:
              (lines.join('\n') || '（没抓到条目）') +
              (errors.length ? `\n\n有 ${errors.length} 个源取失败：${errors.map((entry) => entry.error).join('；')}` : ''),
          }
        }

        const itemId = String(args.itemId || '').trim()
        if (!itemId) return { text: 'read/unread/star/unstar 需要 itemId（或 link）' }
        const s = stateStore.get()
        if (action === 'read') {
          const next = stateStore.patch({ read: { ...s.read, [itemId]: Date.now() } })
          return { text: `已标已读：${itemId}（共 ${Object.keys(next.read).length} 条）` }
        }
        if (action === 'unread') {
          const read = { ...s.read }
          delete read[itemId]
          stateStore.patch({ read })
          return { text: `已标未读：${itemId}` }
        }
        if (action === 'star' || action === 'unstar') {
          const has = (s.starred || []).includes(itemId)
          const want = action === 'star'
          if (has !== want) {
            stateStore.patch({ starred: want ? [...(s.starred || []), itemId] : (s.starred || []).filter((id) => id !== itemId) })
          }
          return { text: `${want ? '已收藏' : '已取消收藏'}：${itemId}` }
        }
        if (action === 'select_feed') {
          const next = stateStore.patch({ selectedFeed: args.feed ? String(args.feed) : null })
          return { text: `面板已切到：${next.selectedFeed || '全部'}` }
        }
        return { text: `不认识的动作：${action}` }
      },
    })
  })

  ctx.inject(['webServer'], (scoped) => {
    const disposers = []

    /**
     * POST { texts: [...] } → { translated: [...] }（等长、同序）。
     *
     * 故意做成**纯文本进、纯文本出** —— 不掺条目 id，这样客户端只在这一处接线，
     * items 路由和缓存都不必知道翻译的存在。翻不了的项原样返回（不是空串），
     * 所以客户端可以无脑覆盖显示。
     */
    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_TRANSLATE,
        handler: (req, res) => {
          if (String(((req && req.headers) || {})['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            res.statusCode = 403
            res.end('forbidden')
            return
          }
          if (String((req && req.method) || 'GET').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'use POST' })
            return
          }
          const chunks = []
          req.on('data', (chunk) => {
            chunks.push(chunk)
            if (chunks.reduce((n, c) => n + c.length, 0) > 512 * 1024) req.destroy()
          })
          req.on('end', async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
              const texts = Array.isArray(body.texts) ? body.texts.slice(0, 200).map((t) => String(t || '')) : []
              const translated = await translator.translateMany(texts)
              sendJson(res, 200, { ok: true, translated, stats: translator.stats() })
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
            }
          })
          req.on('error', () => {
            try {
              sendJson(res, 500, { ok: false, error: 'request error' })
            } catch {
              /* 连接可能已断 */
            }
          })
        },
      }),
    )

    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_FEEDS,
        handler: (req, res) => {
          if (String(((req && req.headers) || {})['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            res.statusCode = 403
            res.end()
            return
          }
          sendJson(res, 200, {
            ok: true,
            cacheTtlMs: opts.cacheTtlMs,
            feeds: feedList(opts),
            state: stateStore.get(),
          })
        },
      }),
    )

    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_ITEMS,
        handler: async (req, res) => {
          try {
            if (String(((req && req.headers) || {})['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
              res.statusCode = 403
              res.end()
              return
            }
            const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams
            const wanted = String(query.get('feed') || '').trim()
            const feeds = feedList(opts)
            const targets = wanted ? feeds.filter((feed) => feed.title === wanted) : feeds
            const results = await mapLimit(targets, 3, (feed) => feedItems(feed, opts))
            const items = results
              .flatMap((entry) => entry.items || [])
              .sort((a, b) => (b.at || 0) - (a.at || 0))
              .slice(0, Math.max(1, Number(query.get('count')) || 120))
            sendJson(res, 200, {
              ok: true,
              updatedAt: Date.now(),
              items,
              errors: results.map((entry, index) => (entry.error ? { feed: targets[index] && targets[index].title, error: entry.error } : null)).filter(Boolean),
            })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
    )

    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_STATE,
        handler: (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          const headers = (req && req.headers) || {}
          if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            res.statusCode = 403
            res.end()
            return
          }
          if (method === 'GET' || method === 'HEAD') {
            sendJson(res, 200, { ok: true, state: stateStore.get() })
            return
          }
          if (method === 'POST') {
            let raw = ''
            req.on('data', (chunk) => {
              raw += chunk
              if (raw.length > 512 * 1024) req.destroy()
            })
            req.on('end', () => {
              let body = {}
              try {
                body = raw.trim() ? JSON.parse(raw) : {}
              } catch {
                sendJson(res, 400, { ok: false, error: '请求体不是 JSON' })
                return
              }
              sendJson(res, 200, { ok: true, state: stateStore.patch(body) })
            })
            return
          }
          res.statusCode = 405
          res.end()
        },
      }),
    )

    ctx.on('dispose', () => {
      for (const off of disposers) {
        try {
          off()
        } catch {
          /* already gone */
        }
      }
    })
  })
}

export { apply, ROUTE_FEEDS, ROUTE_ITEMS, ROUTE_STATE, ROUTE_TRANSLATE, DEFAULTS }
