/**
 * 拿本地已下载的 feed 文件跑解析器，看每个源解析出几条：
 *   node test/parse-file.mjs <file1> <file2> ...
 */
import { readFileSync } from 'node:fs'
import { parseFeed } from '../lib/index.js'

for (const file of process.argv.slice(2)) {
  try {
    const raw = readFileSync(file, 'utf8')
    const items = parseFeed(raw, { title: file.split(/[\\/]/).pop() })
    const head = raw.slice(0, 90).replace(/\s+/g, ' ')
    console.log(`${file.split(/[\\/]/).pop()}: ${items.length} 条   开头=<${head}>`)
  } catch (error) {
    console.log(`${file}: 读不了 ${error.message}`)
  }
}
