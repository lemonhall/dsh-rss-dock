# dsh-rss-dock 📰

DSH 右侧栏的 **RSS 阅读器**：左边订阅源（带未读数）、右边条目，点开即标已读，可收藏。

> 这是给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 右侧栏做的一排日常插件之一。
> 右侧栏本来就是 DSH 的「apps 入口」—— 官方的文件/终端/浏览器和第三方插件走的是**完全同一套机制**。

## 效果

![面板](https://cdn.jsdelivr.net/gh/lemonhall/dsh-rss-dock@main/docs/screenshot-panel.png)

（截图只裁了右侧栏面板。想换订阅源/分类/时长这些，改配置就行，不用碰代码。）

## 它能干什么

- **订阅源写在配置里**，RSS 2.0 与 Atom 都认（正则解析，不引 XML 库）
- 默认 8 个源：华尔街日报（国际/市场/科技/美国商业）+ Hacker News + 少数派 + 阮一峰 + Cloudflare
- **只看未读**开关、星标收藏、按时间倒序
- 宿主用 curl 走本机代理抓取，带重试；10 分钟缓存
- `rss_panel` 工具：Agent 可以直接读条目、标已读、收藏

## 装

```
plugin_manager  install_bundle  target=link:E:\development\dsh-rss-dock
```

或从 npm：

```
dsh plugin --profile <你的 profile> add dsh-rss-dock
```

装好之后：右侧栏点「**+**」→ 选「**RSS 阅读器**」。

⚠️ **客户端半边改动要重启一次应用**；宿主半边热生效 —— 但**新增宿主路由要重启**（实测，别指望热重载）。

## 它是怎么work的

```
lib/index.js    宿主半：路由 + rss_panel 工具（Agent 侧读写同一份状态）
lib/state.js    本地状态（原子写：临时文件 + rename，读的人不会撞上写了一半的文件）
lib/client.js   右侧栏 tab（整个模块包在 IIFE 里 —— DSH 把所有客户端插件拼成一个脚本，
                顶层 const 会跨插件撞名，实测撞过一次直接把应用挡在启动之外）
```

**双向通道**：状态存在宿主，客户端 2 秒轮询。所以**你在面板里点一下，Agent 调工具就能读到**；
**Agent 写一次，面板自己会跟着变**。这不是"一个只读的看板"。

## 已知限制

- 只做阅读，**不做全文抓取**（摘要来自 feed 本身）
- 已读/收藏存本地，**不跟任何在线服务同步**
- feed 的可用性取决于对方；取不到的源会在面板顶上给出行数提示，不会静默

## License

MIT
