# 我给 DSH 的右侧栏塞了个 RSS 阅读器

📰 **RSS 阅读器** —— DSH 右侧栏的一个新 tab。

## 为什么做这个

我不缺 RSS 阅读器，我缺的是**一个就在我干活的地方、不用切窗口的** RSS 阅读器。写代码的时候右侧栏点一下，扫一眼标题，够了。

## 长什么样

![RSS 阅读器](https://cdn.jsdelivr.net/gh/lemonhall/dsh-rss-dock@main/docs/screenshot-panel.png)

（图只截了右侧栏面板。我这台机器桌面左下角有真名，所以截图从来不整屏。）

## 它能干什么

- **订阅源写在配置里**，RSS 2.0 与 Atom 都认（正则解析，不引 XML 库）
- 默认 8 个源：华尔街日报（国际/市场/科技/美国商业）+ Hacker News + 少数派 + 阮一峰 + Cloudflare
- **只看未读**开关、星标收藏、按时间倒序
- 宿主用 curl 走本机代理抓取，带重试；10 分钟缓存
- `rss_panel` 工具：Agent 可以直接读条目、标已读、收藏

## 一个值得说的设计决定

**正则解析 feed，不引 XML 库。** RSS 2.0 和 Atom 的骨架都很规矩，真正常见的坑只有一个：`<![CDATA[...]]>`。我第一版先剥标签再处理 CDATA，结果 Hacker News 的条目标题被整段吃掉、一条都解析不出来 —— 顺序反过来就好了。这个 bug 现在有一条回归测试盯着。

## 双向的，不只看

这是这批插件的共同点：**状态在宿主、界面 2 秒轮询**。所以我在面板里点一下，Agent 调工具就能读到；Agent 写一次（比如「帮我记一笔午饭 12.5」），面板自己就变了。

装：

```
# 先装 DSH（桌面版从 https://harness.deepseek.com 下载安装包；只要 CLI 的话）：
npm i -g @deepseek-ai/dsh

# 再装这个插件（桌面版也可以走 GUI：右侧栏「插件 → 添加插件」）
dsh plugin --profile desktop add dsh-rss-dock

# 如果你是开发者、想用本地目录直接挂：
plugin_manager install_bundle target=link:E:\development\dsh-rss-dock
```

代码在 <https://github.com/lemonhall/dsh-rss-dock>，npm 上是 `dsh-rss-dock`。右侧栏点「**+**」→ 选「RSS 阅读器」就能看到它。

## 已知限制

- 只做阅读，**不做全文抓取**（摘要来自 feed 本身）
- 已读/收藏存本地，**不跟任何在线服务同步**
- feed 的可用性取决于对方；取不到的源会在面板顶上给出行数提示，不会静默
