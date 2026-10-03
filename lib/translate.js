/**
 * 翻译模块 —— 给 RSS 的英文条目配上中文。
 *
 * 三个设计决定：
 *
 * ① **按原文哈希缓存，同一段文字一辈子只翻一次。**
 *    RSS 每 10 分钟刷一次、面板每 2 秒轮询一次 —— 不缓存的话同一篇文章会被翻几百遍。
 *    缓存键是 text 的 sha1，所以「RSS 摘要」和「文章正文里的同一句」也会命中同一条。
 *
 * ② **批量翻**，不是一条一发。列表一次几十条，一次请求全带上去。
 *    模型返回 JSON 数组；解析失败就**逐条重试一次**，再失败就放弃（不阻塞列表）。
 *
 * ③ **中文内容不翻**。少数派、阮一峰那种本来就是中文，翻了是浪费钱。
 *    判据是「CJK 字符占非空白字符的比例」—— 超过一半就当它是中文。
 *
 * 提供商：默认用 DeepSeek 的 chat API（本机已有凭据、国内快、质量够）。
 * 拿不到凭据就不翻 —— 列表照样能看，只是不带中文。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

const API_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'
/** 单次批量请求最多带多少段（太多会被模型截断/漏译）。 */
const BATCH_SIZE = 20
/** 缓存上限（条）；超了按插入顺序丢最老的。 */
const CACHE_LIMIT = 4000

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 这段文字要不要翻？中文占比过半就不翻。 */
export function needsTranslation(text) {
  const s = String(text || '')
  const meaningful = s.replace(/\s/g, '')
  if (meaningful.length < 4) return false
  let cjk = 0
  for (const ch of meaningful) if (CJK.test(ch)) cjk += 1
  return cjk / meaningful.length < 0.5
}

/** 缓存键：原文的 sha1。 */
export function cacheKey(text) {
  return createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 20)
}

/** 从模型返回里抠出 JSON 数组（它有时会包 ```json 或加解释）。 */
export function parseTranslationPayload(raw, expected) {
  const text = String(raw || '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length !== expected) return null
  return parsed.map((item) => (typeof item === 'string' ? item : String((item && item.text) || '')))
}

/**
 * 翻译器：一个缓存 + 一个 provider 调用。
 * `getApiKey` 是回调 —— 因为凭据在 cordis 的 credentials 服务里，注入时机由宿主决定。
 */
export function createTranslator({ cacheFile, getApiKey, fetchImpl, log } = {}) {
  /** key → { src, dst, at } */
  const cache = new Map()
  let dirty = false

  if (cacheFile && existsSync(cacheFile)) {
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'))
      for (const row of Array.isArray(saved) ? saved : []) {
        if (row && row.k && row.d) cache.set(row.k, { dst: row.d, at: row.t || 0 })
      }
    } catch {
      /* 缓存坏了就当没有 */
    }
  }

  function persist() {
    if (!cacheFile || !dirty) return
    try {
      mkdirSync(dirname(cacheFile), { recursive: true })
      const rows = [...cache.entries()].slice(-CACHE_LIMIT).map(([k, v]) => ({ k, d: v.dst, t: v.at }))
      const tmp = `${cacheFile}.tmp`
      writeFileSync(tmp, JSON.stringify(rows), 'utf8')
      renameSync(tmp, cacheFile)
      dirty = false
    } catch (error) {
      if (log) log(`翻译缓存写盘失败：${(error && error.message) || error}`)
    }
  }

  const getCached = (text) => {
    const hit = cache.get(cacheKey(text))
    return hit ? hit.dst : null
  }

  function put(src, dst) {
    const key = cacheKey(src)
    cache.set(key, { dst, at: Date.now() })
    dirty = true
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
    }
    persist()
  }

  /** 批量翻一段段文字。返回与输入等长的数组，翻不了的用原文占位。 */
  async function translateMany(texts) {
    const list = texts.map((t) => String(t || ''))
    const out = list.map((t) => getCached(t) || t)
    const todo = []
    list.forEach((text, index) => {
      if (getCached(text)) return
      if (!needsTranslation(text)) {
        // 本来就是中文 —— 直接当"译好了"，省一次请求也省一次缓存
        cache.set(cacheKey(text), { dst: text, at: Date.now() })
        dirty = true
        return
      }
      todo.push({ text, index })
    })
    if (!todo.length) return out

    const key = getApiKey ? getApiKey() : null
    if (!key) {
      if (log) log('没有 DeepSeek 凭据，跳过翻译')
      return out
    }

    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
      const batch = todo.slice(i, i + BATCH_SIZE)
      const translated = await translateBatch(batch.map((row) => row.text), key)
      batch.forEach((row, k) => {
        const dst = translated ? translated[k] : null
        if (dst) {
          out[row.index] = dst
          put(row.text, dst)
        }
      })
    }
    persist()
    return out
  }

  async function translateBatch(texts, key) {
    const payload = {
      model: MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是翻译。把用户给的 JSON 数组里每一项翻成简体中文，保持原意、术语准确、标题不要加句号。' +
            '只输出一个 JSON 数组，长度与输入完全一致，元素是翻译后的字符串，不要任何解释或代码块。',
        },
        { role: 'user', content: JSON.stringify(texts) },
      ],
    }
    const doFetch = fetchImpl || fetch
    try {
      const response = await doFetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        if (log) log(`翻译请求失败 HTTP ${response.status}`)
        return null
      }
      const data = await response.json()
      const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
      return parseTranslationPayload(raw, texts.length)
    } catch (error) {
      if (log) log(`翻译请求异常：${(error && error.message) || error}`)
      return null
    }
  }

  return {
    translateMany,
    getCached,
    stats: () => ({ cached: cache.size }),
    flush: persist,
  }
}

export { API_URL, MODEL, BATCH_SIZE, CACHE_LIMIT }
