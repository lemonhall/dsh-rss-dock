/**
 * parseFeed 的单元测试（纯函数，不用起应用）：
 *   node test/parse.test.mjs
 * 覆盖 RSS 2.0、Atom、以及"不是 feed"的输入。
 */
import { parseFeed } from '../lib/index.js'

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>示例源</title>
  <item>
    <title>第一篇 &amp; 标题</title>
    <link>https://example.com/a</link>
    <guid>guid-a</guid>
    <pubDate>Tue, 01 Oct 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>这是<b>摘要</b></p>]]></description>
  </item>
  <item>
    <title>第二篇</title>
    <link>https://example.com/b</link>
    <pubDate>Wed, 02 Oct 2026 11:30:00 GMT</pubDate>
  </item>
</channel></rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>原子源</title>
  <entry>
    <title> Atom 一条 </title>
    <link rel="alternate" href="https://example.org/x"/>
    <id>tag:example.org,2026:x</id>
    <updated>2026-10-03T01:02:03Z</updated>
    <summary>原子摘要</summary>
  </entry>
</feed>`

const HN_LIKE = `<rss version="2.0"><channel><title>HN</title>
<item><title><![CDATA[Where Is the Planet]]></title><link>https://news.ycombinator.com/item?id=1</link><description><![CDATA[<p>Article URL</p>]]></description></item>
</channel></rss>`

let failed = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`}`)
}

const rss = parseFeed(RSS, { title: '示例源' })
check('RSS 条数', rss.length, 2)
check('RSS 标题去实体', rss[0].title, '第一篇 & 标题')
check('RSS 链接', rss[0].link, 'https://example.com/a')
check('RSS id 用 guid', rss[0].id, 'guid-a')
check('RSS 摘要去标签', rss[0].summary, '这是 摘要')
check('RSS 时间解析', new Date(rss[0].at).toISOString(), '2026-10-01T10:00:00.000Z')
check('RSS 缺 guid 时用 link', rss[1].id, 'https://example.com/b')
check('RSS 带上源名', rss[0].feed, '示例源')

const atom = parseFeed(ATOM, { title: '原子源' })
check('Atom 条数', atom.length, 1)
check('Atom 标题 trim', atom[0].title, 'Atom 一条')
check('Atom 取 link href', atom[0].link, 'https://example.org/x')
check('Atom 时间解析', new Date(atom[0].at).toISOString(), '2026-10-03T01:02:03.000Z')

check('不是 feed 时返回空', parseFeed('<html><body>hi</body></html>', { title: 'x' }).length, 0)

// 回归：标题整段是 CDATA（HN 的 feed 就是这样）。
// 曾经的 bug 是「先剥标签后剥 CDATA」，`<![CDATA[...]]>` 内部没有 `>`，
// 会被 `<[^>]*>` 整段吃掉 → 标题空 → 条目被丢 → 20 条变 0 条。
const hn = parseFeed(HN_LIKE, { title: 'HN' })
check('CDATA 标题的条数', hn.length, 1)
check('CDATA 标题内容', hn[0].title, 'Where Is the Planet')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
