# Jev Ad Block

Chrome Manifest V3 广告拦截扩展。网络规则拦截广告请求；内容脚本把候选元素交给 Jev（TypeSafe System One）语义判断并隐藏；无 API key、请求失败或超配额时回退本地规则。

## 能力

- **分层检测**（由早到晚）：`cosmetic.css` 强标记 CSS 直隐 → 社区定向 cosmetic（`document_start` 注入 CSS）→ 站点 detectors / labels → 浮层几何 → 打分候选，后三层交 Jev 精判。浮层判断区分登录/同意/支付等必要 UI，避免误杀 cookie 横幅。
- **社区规则**：构建期转换 EasyList China + CJX's Annoyance List。网络规则转 DNR 静态规则集，定向 cosmetic 按域名分桶注入；通用 cosmetic 与 procedural/scriptlet 不引入（与 uBO Lite 默认策略一致）。
- **网络拦截**：`declarativeNetRequest` 静态规则集（手写 `ad_networks` + 社区 `community`，含第三方/排除域语义映射）；用户白名单与本页暂停的放行优先级高于全部列表规则。
- **乐观隐藏**：高置信候选先隐藏，Jev 判定非广告时自动恢复；同站点同 slot 的签名裁决缓存 7 天，命中免 API 往返。
- **错误恢复**：瞬态错误退避重试，连续失败短暂冷却；仅鉴权/协议错误才停用本页 Jev。
- **自定义规则与白名单**：设置页可添加 CSS 选择器（按用户判断直接隐藏，不交 Jev）与白名单域名（子域名自动匹配，完全跳过）。
- **快捷键**：`Ctrl/Cmd+Shift+J` 全局启用/暂停。

## 安装

1. `npm run build` 生成 `dist/`。
2. Chrome `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `dist/`。
3. 无 API key 即可用本地规则、网络拦截与 CSS 隐藏。

> 内容脚本按注入时机合并为 `dist/src/content/early-bundle.js`（document_start）与 `dist/src/content/bundle.js`（document_idle）；改源文件后需重新 `npm run build`。

## 配置与使用

- 设置页填 TypeSafe API key 启用 Jev 判断。`adThreshold` 0.75 / `mainGuard` 0.55 / `hourlyBudget` 30000（默认，可调）。

> Jev 判断很廉价（实测批量近免费：1 个候选 364ms、64 个 406ms），所以数量上限一律只作为病理页面（无限滚动、广告农场）的兜底，正常页面不触发；判断尽量交给 Jev，本地确定性路径只保留 force / 自定义选择器与反拦截墙。
- 「全局启用」与弹窗「本页」开关共同控制 DOM 隐藏与网络拦截；关本页会恢复已隐藏元素且导航后保持关闭。「恢复本页」恢复并暂停本标签页；「重新扫描」重扫。

隐私口径：配置 API key 后，候选（≤240 字文字、元素特征、外链域名，可能含个人信息）可能发送给 TypeSafe；不含页面 URL、标题、链接路径与查询参数。API key 仅存浏览器本地。

> CSS 直隐（`cosmetic.css` 与社区早期注入）不可经「恢复本页」还原，刷新恢复——与 uBO Origin 的 cosmetic 过滤一致。Jev 判断的槽位由 JS 层处理，可恢复。

规则文件：DOM 规则在 [`rules/dom/`](rules/dom/)，网络规则在 [`rules/network/`](rules/network/)，CSS 隐藏在 [`src/content/cosmetic.css`](src/content/cosmetic.css)。社区规则由 [`scripts/convert-filters.js`](scripts/convert-filters.js) 生成，分发保留来源与许可声明。

## 许可

本项目以 [GPL-3.0](LICENSE) 授权。

`rules/network/community.json` 与 `rules/dom/community.js` 由 [EasyList China](https://github.com/easylist/easylistchina) 与 [CJX's Annoyance List](https://github.com/cjx82630/cjxlist) 转换而来，二者均以 GPLv3 授权。本项目的许可选择与上游保持一致。

```bash
npm run build   # 按 run_at 分包拼接内容脚本并生成 dist/
npm run check   # 构建并校验语法、JSON、清单路径、图标、DNR 规则集
npm run filters # 拉取并转换社区规则（EasyList China + CJX Annoyance）
npm test        # 单元测试（纯函数，无需 API key）
```

DNR 规则集由 `scripts/lint-dnr.js` 校验（已接入 `npm run check`）。Chrome 加载静态 ruleset 是全有或全无的：只要一条规则违规，整个规则集被拒、网络拦截静默失效。lint 覆盖非法 urlFilter 字符集、重复 id、`allow`+空 `condition`、域名形状（尾点/通配/带 scheme）等——`check` 报错会指到具体规则 id。

端到端脚本 [`tests/test_extension.py`](tests/test_extension.py)：需 Python 3、Playwright、真实 API key、本地 fixture 服务、有头环境（headless Chromium 不加载未打包扩展）。

```bash
python3 -m http.server 8765 --directory tests/fixtures
TYPESAFE_API_KEY=ts-... python3 tests/test_extension.py
```

## 架构

```
manifest.json            权限、content_scripts（CSS / 早期 JS document_start、主 JS document_idle、all_frames）、DNR 规则集、快捷键
src/background/sw.js     服务工作线程：消息路由、DNR 规则同步（全局/本页/白名单）、命令、日志持久化
src/background/judge.js  Jev API 调用、重试、小时配额（session 持久化）、签名→裁决缓存（local，7 天）
src/content/             内容脚本（构建时按 run_at 合并为 early-bundle.js / bundle.js）
  early.js               社区定向 cosmetic 的 document_start CSS 注入（防闪现）
  pipeline.js            候选入队、乐观隐藏、失败回退、错误退避
  layers/rules.js        确定性检测器（强信号直隐，弱信号交 Jev；站点 force 规则直隐）
  layers/labels.js       广告标签 → 容器定位
  layers/overlays.js     浮层几何与遮挡判断
  layers/ambiguous.js    打分候选 → Jev 精判
  hide.js                隐藏/恢复（单元素与整页）
  protect.js             主内容与受保护内容保护（站点语义词在 site 模块 protectText）
rules/dom/               站点规则（知乎/微博/B站/QQ邮箱/hao123）+ 社区定向 cosmetic（early.js 消费）
rules/network/           DNR 网络拦截规则（手写 ad_networks + 生成的 community）
scripts/lint-dnr.js      DNR 规则集静态校验（构建期拦住会让整包被拒的规则）
src/content/cosmetic.css 最强广告标记的 CSS 隐藏（document_start 注入）
```
