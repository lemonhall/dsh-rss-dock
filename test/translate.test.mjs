/**
 * 翻译模块的纯函数测试（不联网）：
 *   node test/translate.test.mjs
 */
import { needsTranslation, cacheKey, parseTranslationPayload } from '../lib/translate.js'

let failed = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`}`)
}

// --- 要不要翻：中文内容不翻（省请求也是省钱）---
check('英文标题要翻', needsTranslation('Fed Signals Rate Cut in September'), true)
check('中文标题不翻', needsTranslation('美联储暗示九月降息'), false)
check('中文摘要不翻', needsTranslation('这是一段中文摘要，讲的是利率的事情。'), false)
check('中英混排但以中文为主 → 不翻', needsTranslation('美联储 Fed 暗示降息 rate cut 的可能性'), false)
check('中英混排但以英文为主 → 翻', needsTranslation('The Fed signaled a rate cut 降息'), true)
check('太短的不管', needsTranslation('AI'), false)
check('空的不翻', needsTranslation(''), false)
check('纯符号不翻', needsTranslation('   ---   '), false)
check('日文汉字也算 CJK（不翻）', needsTranslation('日銀が利下げを示唆'), false)

// --- 缓存键：同一段文字必须同一个键，不同文字必须不同 ---
check('同样的文字同一个键', cacheKey('hello world'), cacheKey('hello world'))
check('不同文字不同键', cacheKey('a') === cacheKey('b'), false)
check('键长为 20', cacheKey('x').length, 20)
check('空字符串也有键', cacheKey('').length, 20)

// --- 模型返回的解析（它经常包 ```json 或加解释）---
check('干净数组', parseTranslationPayload('["甲","乙"]', 2), ['甲', '乙'])
check('包在代码块里', parseTranslationPayload('```json\n["甲","乙"]\n```', 2), ['甲', '乙'])
check('前后有解释文字', parseTranslationPayload('好的，翻译如下：[ "甲", "乙" ] 希望有帮助', 2), ['甲', '乙'])
check('长度不对 → 拒绝（宁可重试也别错位）', parseTranslationPayload('["甲"]', 2), null)
check('不是数组 → 拒绝', parseTranslationPayload('{"a":1}', 2), null)
check('坏 JSON → 拒绝', parseTranslationPayload('[甲,乙]', 2), null)
check('空输入 → 拒绝', parseTranslationPayload('', 2), null)
check('对象元素取 text', parseTranslationPayload('[{"text":"甲"},{"text":"乙"}]', 2), ['甲', '乙'])

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
