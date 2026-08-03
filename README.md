# fnmusic-exe · 飞牛音乐客户端

> 基于 Electron 封装的飞牛音乐客户端，核心解决网页版无法后台播放、最小化后切歌中断的痛点。

项目来源：https://github.com/wbc389561407/fnmusic-exe

![img_1.png](img_1.png)

## 立项初衷

飞牛音乐官方早期仅提供网页版，存在两个让人难以忍受的问题：

1. **浏览器标签页切到后台后，音频会被节流甚至暂停**，导致切歌、自动播放下一首失效；
2. **关闭浏览器或清理 cookie 后登录态丢失**，需要反复扫码登录。

本项目就是为了给自己做一个能稳定后台播放、自动切歌的桌面客户端。本质上是用 Electron 套了一层壳，关掉后台节流、持久化登录态、加个托盘，让网页版"无感知"地当一个原生应用来用。

> **声明**：本项目为个人自用性质，仅供学习交流。一旦飞牛官方发布正式桌面客户端，本项目将停止维护并关闭仓库，请优先使用官方版本。

## 功能特性

- **后台不节流**：关闭 `backgroundThrottling`，窗口最小化 / 失焦后，页面定时器与音频仍正常推进，自动切歌不中断
- **登录态持久化**：基于 `persist:feiniu` 分区，cookies / localStorage 落盘到 `userData`，重启后免重新登录；会话型 cookie 自动续期 1 年
- **托盘常驻**：点叉叉 = 最小化到托盘，仅在托盘右键「退出」时真正关闭
- **无边框外观**：隐藏原生标题栏，保留右上角最小化 / 最大化 / 关闭覆盖层，顶部注入可拖拽区域
- **服务器地址可配置**：首次启动进入设置页输入服务器地址；菜单栏「设置 → 切换服务器地址」可随时切换
- **站内导航限制**：仅允许停留在已配置的服务器站内，外链自动转交系统默认浏览器打开
- **UA 伪装**：伪装为普通 Chrome 浏览器，避免被站点拦截
- **NSIS 安装包**：支持桌面快捷方式、开始菜单、自定义安装路径

## 安装与使用

### 方式一：直接安装（推荐）

下载 [Releases](../../releases) 中的 `飞牛音乐-Setup-x.x.x.exe`，双击安装即可。

首次启动会进入服务器地址输入页，填入你部署的飞牛音乐服务地址后进入主界面。

### 方式二：从源码运行

```bash
# 安装依赖
npm install

# 开发模式启动
npm start

# 打包 Windows 安装包
npm run dist

# 打包 portable 免安装版
npm run dist:portable
```

> 运行前需自行配置好 Node.js 环境与 Electron 依赖。

## 常见操作

| 操作 | 行为 |
| --- | --- |
| 点击窗口右上角 × | 最小化到托盘，不退出 |
| 单击托盘图标 | 显示 / 聚焦主窗口 |
| 托盘右键 → 显示主窗口 | 显示主窗口 |
| 托盘右键 → 退出飞牛音乐 | 真正退出应用 |
| 菜单栏 → 设置 → 切换服务器地址 | 回到设置页重新填写地址 |
| 菜单栏 → 设置 → 清除已保存地址并重置 | 删除配置文件并重置 |

## 配置文件位置

配置文件 `config.json` 与 cookie 存储位于 Electron 的 `userData` 目录：

- Windows: `%APPDATA%\feiniu-music\`

## 技术栈

- Electron 28
- electron-builder 24（NSIS 打包）
- 原生 JavaScript，无前端框架

## 版本号

当前版本：**v2.1.8**

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)（Semantic Versioning）：

- **主版本号（MAJOR）**：存在不兼容的 API / 行为变更时递增
- **次版本号（MINOR）**：新增向下兼容的功能时递增
- **修订号（PATCH）**：仅做向下兼容的缺陷修复时递增

版本号同步维护在 [package.json](package.json) 的 `version` 字段。

## 更新日志

### v2.1.8

- 新增启动时自动更新检测：通过 Gitee API 获取最新 release 版本号，与当前版本对比
  - 版本不一致时弹窗提示，显示当前版本与最新版本，提供「前往下载」按钮跳转 releases 页面
  - 检测地址：`https://gitee.com/wang_bingchen/fnmusic-exe/releases`
  - 异步检测不阻塞窗口显示，请求失败静默忽略

### v2.1.7

- 托盘右键菜单新增「打开自动播放」选项：勾选后启动 app 进入主界面自动点击播放按钮开始播放
  - 进入主界面后自动点击底部 `button[aria-label="播放"]`，播放器异步加载期间最多重试 10 秒
  - 检测到 `button[aria-label="暂停"]` 出现即视为已开始播放，停止重试
  - 配置持久化到 `config.json` 的 `autoPlay` 字段
  - 仅在主界面触发（登录页跳过），避免误操作

### v2.1.6

- 修复开机自启后出现额外窗口的问题：禁止页面 `window.open` 新建窗口，所有外部链接改用系统浏览器打开

### v2.1.5

- 修复打包后设置页报「初始化失败：桥接对象不可用」的问题
  - 根因：preload 在 `sandbox: true` 下 `require('../package.json')` 会抛错，导致整个 preload 脚本执行失败、`serverBridge` 未暴露
  - 修复：版本号改由主进程 `app.getVersion()` 通过 IPC `get-app-version` 提供，preload 不再 require 本地文件

### v2.1.4

- 设置页新增版本号显示（标题下方）
- 托盘右键菜单新增「关于」项：弹窗显示版本号、项目简介、项目地址与声明
- 安装包文件名由 `飞牛音乐-Setup-x.x.x.exe` 改为 `fnmusic-Setup-x.x.x.exe`

### v2.1.0

- **fnid 解析重构**：恢复通过 fnos.net API 解析真实服务器地址，不再直接走中继地址
  - 输入 fnid 后调用 `fnos.net` 远程访问 API 获取候选地址列表
  - 候选地址优先级：局域网 http（最快，无证书问题）> fnos.net 中继 https（兜底）
  - 移除公网 IP 直连分支（家庭网络绝大多数无公网 IP，直连意义不大）
  - 局域网 http 候选**顺序探测**（非并发），第一个可达即用；全不通则用 https 中继兜底
  - https 中继不做主动探测（证书可能过期 fetch 失败），直接交由 BrowserWindow 加载
- **修复 fnid 在局域网跳出 app 框架的问题**：
  - 根因：之前直接构造 `https://{fnid}.fnos.net/music/` 中继地址，在局域网环境下中继会 302 重定向到 NAS 局域网 IP，触发跨域后被 `will-navigate` 丢到系统浏览器
  - 修复：fnid 现在先探测局域网 IP，局域网通就直接用局域网 IP 加载，避免中继重定向跨域
- **`isNavigationAllowed` 增强**：
  - 放行 fnos.net 中继 → 私网 IP 的重定向（兜底防御，避免重定向被拦截）
  - 放行局域网 IP origin 同 IP 不同端口的导航（NAS 站内跳端口登录等场景）
- **`will-navigate` 跨域处理调整**：跨域导航仅 `preventDefault` 阻止，不再调用 `shell.openExternal`
  - 页面内部重定向已由 `isNavigationAllowed` 放行
  - 用户点击外链走 `setWindowOpenHandler`（target=_blank）转交系统浏览器
  - 避免页面内部跨域导航被错误地弹出到外部浏览器
- 新增 `isPrivateIp` 辅助函数：识别 10.x / 172.16-31.x / 192.168.x / 127.x / 169.254.x 私网段

### v2.0.0

- **重大修复**：解决 1.6.0 引入的 `setCertificateVerifyProc` 导致普通 https 站点（如 `your-domain.com`）SSL 握手被拒绝（`net_error -2 ERR_FAILED`）的严重问题
  - 根因：session 级 `setCertificateVerifyProc` 对非 fnos.net / 非 IP 域名返回 `callback(-2)`，该值在 Electron 中代表"直接拒绝"而非"使用默认验证"，导致所有普通 https 站点无法加载
  - 修复：移除 session 级 `setCertificateVerifyProc`，改用窗口级 `certificate-error` 事件，仅对 `*.fnos.net` 中转域名与 NAS 直连 IP 放行证书，普通 https 站点恢复 Chromium 默认验证
- 地址解析方法 `resolveAccessUrl(input)` 稳定化：fnid / IP / 域名 / 完整地址统一入口，输出可直接浏览器打开的访问地址
- 持久化改为记录用户原始输入（`serverInput`），每次启动重新走 `resolveAccessUrl` 确认本次访问地址，fnid 不再缓存解析结果
- `ensureMusicSuffix` 统一补 `/music/`（带尾斜杠），避免服务器 301 重定向触发 `ERR_FAILED`
- fnid 简化为直接构造中继地址 `https://{fnid}.fnos.net/music/`，移除 fnos.net API 解析与并发探测逻辑
- 导航放行：`isNavigationAllowed` 放行 fnos.net 域内互转（子域名 ↔ 路径形式），避免中继 301 被拦截后丢到外部浏览器
- 移除冗余的 `crypto` / `net` 依赖与 FNOS API 签名常量
- 全链路加诊断日志（`[resolveAccessUrl]` / `[will-navigate]` / `[did-fail-load]` 等），便于排查加载问题

### v1.8.1

- 修复访问 `https://your-domain.com/music` 卡在"连接中"的问题：服务器 301 重定向 `/music` → `/music/`，Electron `loadURL` 跟随重定向时出现 `ERR_FAILED`
- `ensureMusicSuffix` 统一补成 `/music/`（带尾斜杠），fnid 中继地址同步改为 `/music/`，从源头避免 301 重定向

### v1.8.0

- 重构地址解析：新增统一方法 `resolveAccessUrl(input)`，fnid / IP / 完整地址统一入口
- 持久化改为记录用户原始输入（`serverInput`），不再分 fnid / serverUrl 两个字段
- 每次启动读取原始输入，重新走 `resolveAccessUrl` 确认本次访问地址
- 移除 buildFnidUrl / loadFnid，fnid 分支并入统一解析方法

### v1.7.0

- 简化 fnid 访问逻辑：fnid 直接走中继地址 `https://{fnid}.fnos.net/music`，不再调用 fnos.net API 解析候选、不再探测公网/局域网地址
- 移除 resolveFnid / probeCandidates 及相关签名常量，去掉 crypto / net 依赖
- fnid 持久化 fnid 本身（非解析地址），下次启动直接用 fnid 构造中继地址加载

### v1.6.0

- 新增 fnid 登录支持：输入 fnid（如 `your-fnid`）自动通过 `fnos.net` API 解析真实服务器地址
- 局域网 / 外网智能适配：fnid 解析返回多个候选地址（局域网 IP、公网 IP、relay 中转），并发探测选最优可达地址
  - 局域网内优先用局域网 IP 直连（http，最快）
  - 外网用公网 IP 直连（http）
  - 都不通时用 fnos.net 中转（https 兜底）
- 放行 `*.fnos.net` 中转域名与 NAS 直连 IP 的 SSL 证书验证，解决证书过期 / 自签证书导致无法加载的问题（`ERR_CERT_DATE_INVALID`）
- fnid 解析与探测均加超时兜底，避免网络挂起导致界面卡在"连接中"

### v1.5.4

- 服务器地址输入页面新增项目来源链接（`https://github.com/wbc389561407/fnmusic-exe`）
- 调整地址输入逻辑：纯 IP 自动补 `http://` 与 `:5666` 默认端口；带协议 / 带端口则完全尊重用户输入
- 应用单实例锁：重复双击桌面图标不再启动多个程序，改为聚焦到已有窗口

### v1.5.3

- 服务器地址输入不以 `/music` 或 `/music/` 结尾时，自动补全 `/music` 后缀，不再弹错误提示拦截

### v1.5.2

- 不带协议的地址默认按 `http` 访问，解决 http 流量被强制升级到 https 导致不通的问题

### v1.5.1

- 窗口启动背景与右上角叉叉按钮覆盖层底色改为透明，启动后顶部不再有黑色遮挡
- 修复顶部拖拽条 padding 注入导致页面内部 `100vh` 布局被裁切、底部播放控制栏（上一首 / 下一首）溢出窗口边界的问题，改为纯浮动拖拽条不占布局空间

### v1.5.0

- 服务器地址校验：输入地址必须以 `/music` 或 `/music/` 结尾，否则不跳转并提示用户

### v1.4.0

- 隐藏窗口右上角最小化 / 最大化按钮，仅保留叉叉（最小化到托盘）
- 托盘右键菜单新增「重置地址」：一键清空服务器地址配置与所有持久化存储（cookies / localStorage），回到设置页重新填写

### v1.3.0

- 关闭 `backgroundThrottling`，解决窗口最小化 / 失焦后切歌中断的问题
- 会话型 cookie 自动续期 1 年，避免重启后需要重新登录
- 退出前 `flushStore` 强制落盘，兜底 1.5s 超时强制退出
- 叉叉改为最小化到托盘，仅托盘右键「退出」真正关闭
- 首次启动进入服务器地址设置页，配置后写入 `userData/config.json`
- 菜单栏新增「切换服务器地址」「清除已保存地址并重置」
- 站内导航限制：仅允许停留在已配置服务器站内，外链转交系统浏览器
- 伪装为普通 Chrome 浏览器 User-Agent
- 无边框窗口 + 顶部可拖拽条 + 右上角原生按钮覆盖层
- NSIS 安装包：自定义安装路径、桌面快捷方式、开始菜单快捷方式

### v1.2.0

- 基于 `persist:feiniu` 分区持久化 cookies / localStorage
- 新增托盘图标与右键菜单
- 服务器地址配置文件化，支持菜单栏切换

### v1.1.0

- 基础无边框窗口外观
- 注入顶部可拖拽区域，避免被覆盖层按钮遮挡

### v1.0.0

- 项目立项
- 基于 Electron 封装飞牛音乐网页，实现基础桌面客户端

## License

[MIT](LICENSE)
