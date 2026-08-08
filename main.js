const { app, BrowserWindow, shell, session, Menu, ipcMain, Tray, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

// 项目仓库地址（版本更新检查与首页展示统一使用）
const REPO_URL = 'https://github.com/wbc389561407/fnmusic-exe';
// 用 tags 接口而非 releases/latest：后者会跳过 prerelease / draft，导致取到的不是最新 tag
const REPO_TAGS_API = 'https://api.github.com/repos/wbc389561407/fnmusic-exe/tags';

// 伪装成普通 Chrome 浏览器的 User-Agent，避免被站点拦截
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 持久化分区：cookies / localStorage 都落盘到 userData，重启后保留登录态
const PARTITION = 'persist:feiniu';

// 获取持久化 session
function getSession() {
  return session.fromPartition(PARTITION);
}

// 让会话 cookie（无过期时间）也持久化保存，避免重启后需要重新登录
function setupCookiePersistence() {
  const ses = getSession();

  // 注意：不要在此处设置 setCertificateVerifyProc。
  // 之前对非 fnos.net 域名返回 callback(-2) 会直接拒绝 SSL 握手（net_error -2 ERR_FAILED），
  // 导致普通 https 站点（如 your-domain.com）无法加载。
  // fnid 中转 *.fnos.net 的证书问题改由窗口级 certificate-error 事件处理。
  ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (removed) return;
    // 仅处理「会话型」cookie（没有 expirationDate）
    if (!cookie.session && cookie.expirationDate) return;
    try {
      const host = (cookie.domain || '').replace(/^\./, '');
      const url = (cookie.secure ? 'https://' : 'http://') + host + (cookie.path || '/');
      const detail = {
        url,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite || 'unspecified',
        expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 // 1 年
      };
      if (!cookie.hostOnly) detail.domain = cookie.domain;
      ses.cookies.set(detail).catch(() => {});
    } catch {}
  });
}

// 配置文件路径（userData 目录下的 config.json）
function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// 读取已保存的服务器地址
function readConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// 写入配置
function writeConfig(cfg) {
  fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}

// 规范化地址：
// - 不带协议的纯 IP / 主机名 → 默认补 http:// 与 :5666 端口（飞牛 NAS 默认端口）
// - 带协议 / 带端口 → 完全尊重用户输入，不覆盖
// - 去首尾空格
function normalizeUrl(input) {
  let url = (input || '').trim();
  if (!url) return null;
  const hasProto = /^https?:\/\//i.test(url);
  if (!hasProto) url = 'http://' + url;
  try {
    const u = new URL(url);
    // 仅「不带协议」场景补默认端口 5666；带协议的地址不干预端口
    if (!hasProto && !u.port) {
      u.port = '5666';
    }
    return u.href;
  } catch {
    return null;
  }
}

// ===== fnid 解析（通过 fnos.net 远程访问 API 获取真实服务器地址）=====
// 逆向自 fnos.net 前端 JS，API 需同时携带两套签名
// 候选地址优先级：局域网 http（最快，无证书问题）> fnos.net 中继 https（兜底）
// 不考虑公网 IP 直连（家庭网络绝大多数无公网 IP，且公网 IP 直连意义不大）
const FNOS_PREFIX = 'NDzZTVxnRKP8Z0jXg1VAMonaG8akvh';
const FNOS_API_KEY = 'zIGtkc3dqZnJpd29qZXJqa2w7c';
const FNOS_API_PATH = '/api/v1/fn/con';
const FNOS_API_URL = 'https://fnos.net' + FNOS_API_PATH;

// 判断输入是否为 fnid：不含 . / : 且不带协议的短字符串
function isFnid(input) {
  const s = (input || '').trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return false; // 带协议的是网址
  if (/[.\/:]/.test(s)) return false;        // 含 . / : 视为网址/IP
  return /^[a-zA-Z0-9_-]+$/.test(s);          // 仅字母数字下划线短横
}

// 通过 fnid 调用 fnos.net API 解析真实服务器地址
// 返回候选地址列表（按优先级排序）：局域网 http > fnos.net 中继 https 兜底
// API 返回数据示例：
//   { ipv4: ["192.168.x.x"], publicIpv4: ["x.x.x.x"], fn: ["your-fnid.fnos.net:443"],
//     port: { httpPort: 40710, httpsPort: 40711 } }
async function resolveFnid(fnid) {
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

  // fn-sign：基于 fnid + 当前时间戳的 sha256
  const tsFn = Date.now();
  const fnSign = sha256(`trim_connect\`${fnid}\`${tsFn}\`anna`);

  // authx：基于 PREFIX + url + nonce + ts + md5(body) + apiKey 的 md5
  const body = JSON.stringify({ fnId: fnid });
  const nonce = (Math.floor(Math.random() * 9e5) + 1e5).toString().padStart(6, '0');
  const tsAx = Date.now();
  const authxSign = md5([FNOS_PREFIX, FNOS_API_PATH, nonce, tsAx, md5(body), FNOS_API_KEY].join('_'));
  const authx = `nonce=${nonce}&timestamp=${tsAx}&sign=${authxSign}`;

  // 用 Promise.race 加超时，防止网络挂起导致前端永远卡在"连接中"
  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);

  try {
    const resp = await withTimeout(fetch(FNOS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'fn-sign': fnSign,
        'authx': authx,
        'User-Agent': UA
      },
      body
    }), 10000);
    const json = await withTimeout(resp.json(), 5000);
    console.log('[resolveFnid] api response code:', json && json.code);
    if (!json || json.code !== 0 || !json.data) return null;

    const d = json.data;
    const httpPort = d.port && d.port.httpPort;
    const candidates = [];

    // 1. 局域网 http（优先级最高，局域网内最快，无证书问题）
    if (httpPort) {
      (d.ipv4 || []).forEach((ip) => {
        candidates.push(`http://${ip}:${httpPort}`);
      });
    }

    // 2. fnos.net 中继 https（兜底，跨网段时使用）
    (d.fn || []).forEach((fn) => {
      const m = fn.match(/^([^:]+):(\d+)$/);
      if (m) {
        const host = m[1];
        const port = parseInt(m[2], 10);
        candidates.push(port === 443 ? `https://${host}` : `https://${host}:${port}`);
      } else {
        candidates.push(`https://${fn}`);
      }
    });

    console.log('[resolveFnid] candidates:', candidates);
    return candidates.length > 0 ? candidates : null;
  } catch (e) {
    console.error('[resolveFnid] error:', e.message);
    return null;
  }
}

// 顺序探测候选地址：先逐个尝试局域网 http，通则用；全不通则用 https 中继兜底
// 注意：https 中继不做主动探测（证书可能过期，fetch 会失败），直接交由 BrowserWindow 加载
async function probeCandidates(candidates) {
  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);

  const httpCandidates = candidates.filter((u) => u.startsWith('http://'));
  const httpsFallback = candidates.find((u) => u.startsWith('https://'));

  // 顺序逐个探测局域网 http 候选，第一个可达即返回
  for (const url of httpCandidates) {
    try {
      // 任何 HTTP 响应（含 401/404/302）都说明地址可达
      await withTimeout(fetch(url, { method: 'GET', redirect: 'manual' }), 5000);
      console.log('[probeCandidates] lan reachable:', url);
      return url;
    } catch (e) {
      console.log('[probeCandidates] lan failed:', url, e.message);
    }
  }

  console.log('[probeCandidates] all lan failed, fallback to relay');
  return httpsFallback || null;
}

// 统一解析用户输入为可访问地址（异步：fnid 分支需要调用远程 API）
// - fnid：调 fnos.net API 获取候选 → 顺序探测局域网 → 不通再用中继
// - IP / 网址：规范化 + 补 /music/
// 返回 { url, error }，url 非空即可直接访问
async function resolveAccessUrl(input) {
  const s = (input || '').trim();
  if (!s) return { url: null, error: '请输入服务器地址' };

  if (isFnid(s)) {
    console.log('[resolveAccessUrl] fnid -> resolve via fnos.net API');
    const candidates = await resolveFnid(s);
    if (!candidates || candidates.length === 0) {
      return { url: null, error: 'fnid 解析失败，请检查或使用网址登录' };
    }
    const selected = await probeCandidates(candidates);
    if (!selected) {
      return { url: null, error: '所有候选地址均不可达，请检查网络或使用网址登录' };
    }
    const finalUrl = ensureMusicSuffix(selected);
    if (!finalUrl) {
      return { url: null, error: '解析到的地址格式无效' };
    }
    console.log('[resolveAccessUrl] fnid ->', finalUrl);
    return { url: finalUrl, error: null };
  }

  const url = normalizeUrl(s);
  if (!url) return { url: null, error: '地址无效，请检查后重试' };
  const finalUrl = ensureMusicSuffix(url);
  if (!finalUrl) return { url: null, error: '地址格式无效' };
  console.log('[resolveAccessUrl] address ->', finalUrl);
  return { url: finalUrl, error: null };
}

// 自动补 /music/ 后缀（带尾斜杠）
// 统一用 /music/ 避免服务器 301 重定向 /music → /music/ 导致 loadURL 出现 ERR_FAILED
function ensureMusicSuffix(url) {
  try {
    const u = new URL(url);
    if (/\/music\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace(/\/+$/, '') + '/';
      return u.href;
    }
    const path = u.pathname.replace(/\/+$/, '');
    u.pathname = path + '/music/';
    return u.href;
  } catch {
    return null;
  }
}

let mainWindow = null;
let tray = null;
// 是否处于「真正退出」流程：托盘右键退出 / window-all-closed 时置 true，
// 用于拦截 close 事件，让叉叉走「最小化到托盘」而非退出
let isQuitting = false;

// 基准窗口高度（在该高度下页面竖直方向无滚动条）
const BASE_HEIGHT = 1150;
// 三档窗口尺寸预设
const WIN_PRESETS = {
  large: { width: 1855, height: 1143, label: '大窗口' },
  medium: { width: 1575, height: 927, label: '中窗口' },
  small: { width: 1280, height: 860, label: '小窗口' }
};

// 根据屏幕高度自动选择最合适的窗口档位（默认大窗口，超了用中窗口，还超用小窗口）
function pickDefaultPreset() {
  const { workArea } = require('electron').screen.getPrimaryDisplay();
  const h = workArea.height;
  if (h >= WIN_PRESETS.large.height) return 'large';
  if (h >= WIN_PRESETS.medium.height) return 'medium';
  return 'small';
}

// 读取持久化的窗口档位（large/medium/small），无配置则自动选择
function getSavedPreset() {
  const cfg = readConfig();
  if (cfg.windowPreset && WIN_PRESETS[cfg.windowPreset]) return cfg.windowPreset;
  return pickDefaultPreset();
}

// 计算指定档位的窗口尺寸与页面缩放比例
// - 缩放比例仅按高度计算：zoom = winHeight / BASE_HEIGHT
//   保证等效视口高度 = 基准高度，竖直方向无滚动条
function calcWinSizeAndZoom(preset) {
  const p = WIN_PRESETS[preset] || WIN_PRESETS.small;
  const zoom = snapToZoomStep(p.height / BASE_HEIGHT);
  return { winWidth: p.width, winHeight: p.height, zoom };
}

// 浏览器固定缩放档位（百分比），缩放只能取这些值保证字体清晰
const ZOOM_STEPS = [0.25, 0.33, 0.50, 0.67, 0.75, 0.80, 0.90, 1.00, 1.10, 1.25, 1.50, 1.75, 2.00];

// 将任意缩放比例吸附到最接近的固定档位
function snapToZoomStep(value) {
  let best = ZOOM_STEPS[0];
  let bestDiff = Math.abs(value - best);
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    const diff = Math.abs(value - ZOOM_STEPS[i]);
    if (diff < bestDiff) {
      best = ZOOM_STEPS[i];
      bestDiff = diff;
    }
  }
  return best;
}

// 切换窗口档位：持久化配置并立即应用尺寸与缩放
function applyWindowPreset(preset) {
  if (!WIN_PRESETS[preset]) return;
  const cfg = readConfig();
  cfg.windowPreset = preset;
  writeConfig(cfg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    const { winWidth, winHeight, zoom } = calcWinSizeAndZoom(preset);
    mainWindow.setSize(winWidth, winHeight);
    mainWindow.webContents.setZoomFactor(zoom);
  }
  // 刷新托盘菜单勾选状态
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// 自动登录：若当前在登录页且配置了用户名密码，自动填入 input 并点击 button
// 在 did-finish-load（整页加载）和 did-navigate-in-page（SPA 路由切换）时都会触发
function tryAutoLogin() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cfg = readConfig();
  if (!cfg.username || !cfg.password) return;
  const creds = JSON.stringify({ u: cfg.username, p: cfg.password });
  mainWindow.webContents.executeJavaScript(`
    (function(){
      var creds = ${creds};
      // 仅在登录页执行
      if (location.pathname.indexOf('/login') === -1) return;
      // 防重复
      if (window.__fnAutoLoginDone) return;
      window.__fnAutoLoginDone = true;

      var tries = 0;
      var timer = setInterval(function(){
        tries++;
        if (tries > 20) { clearInterval(timer); return; }

        // 登录表单：两个 input（用户名 + 密码）+ 一个 button
        var inputs = document.querySelectorAll('input');
        if (inputs.length < 2) return;
        var userEl = inputs[0];
        var passEl = inputs[1];
        // 确保第二个是密码框（登录表单的标志）
        if (passEl.type !== 'password') return;

        // 使用原生 setter 触发框架（React/Vue）的 onChange
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(userEl, creds.u);
        userEl.dispatchEvent(new Event('input', { bubbles: true }));
        userEl.dispatchEvent(new Event('change', { bubbles: true }));
        setter.call(passEl, creds.p);
        passEl.dispatchEvent(new Event('input', { bubbles: true }));
        passEl.dispatchEvent(new Event('change', { bubbles: true }));

        clearInterval(timer);

        // 点击登录按钮（type=submit 的那个，避免误点页面其他 button）
        var btn = document.querySelector('button[type="submit"]') || document.querySelector('button');
        if (btn) btn.click();
      }, 400);
    })();
  `).catch(() => {});
}

// 自动播放：若配置开启，进入主界面后点击底部播放按钮
// 仅点击播放按钮，不触发"随机漫游"等会切歌的兜底操作
// 播放按钮可能异步加载，多次重试点击；检测到「暂停」按钮出现说明已开始播放
function tryAutoPlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cfg = readConfig();
  if (!cfg.autoPlay) return;
  mainWindow.webContents.executeJavaScript(`
    (function(){
      if (window.__fnAutoPlayStarted) return;
      // 仅在主界面启动（登录页 pathname 含 /login）
      if (location.pathname.indexOf('/login') !== -1) return;
      window.__fnAutoPlayStarted = true;

      var tries = 0;
      var maxTries = 20;  // 最多重试 10 秒
      var timer = setInterval(function(){
        tries++;
        if (tries > maxTries) { clearInterval(timer); return; }
        // 检测到「暂停」按钮 = 已在播放，停止重试
        if (document.querySelector('button[aria-label="暂停"]')) {
          clearInterval(timer);
          return;
        }
        // 点击「播放」按钮（播放器异步加载期间可能暂未出现）
        var btn = document.querySelector('button[aria-label="播放"]');
        if (btn) btn.click();
      }, 500);
    })();
  `).catch(() => {});
}

function createWindow() {
  const preset = getSavedPreset();
  const { winWidth, winHeight, zoom } = calcWinSizeAndZoom(preset);
  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 1000,
    minHeight: 860,
    title: '飞牛音乐',
    backgroundColor: '#00000000',
    show: false,
    autoHideMenuBar: true,
    // 无边框客户端外观：隐藏标题栏，叉叉用自定义注入按钮（原生 overlay 无法控制 hover 底色）
    frame: false,
    // 仅保留关闭按钮（叉叉 = 最小化到托盘），隐藏最小化 / 最大化按钮
    minimizable: false,
    maximizable: false,
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true,
      partition: PARTITION,
      // 关闭后台节流：窗口最小化/失焦后，页面定时器与音频仍正常推进，
      // 站点「无感知」窗口被最小化，照常自动切换下一首
      backgroundThrottling: false
    }
  });

  // 每次启动强制使用计算出的窗口尺寸与页面缩放，避免系统记住上次调整后的大小
  mainWindow.once('ready-to-show', () => {
    mainWindow.setSize(winWidth, winHeight);
    mainWindow.webContents.setZoomFactor(zoom);
    mainWindow.show();
  });

  // 窗口高度变化时动态调整页面缩放，保证竖直方向无滚动条
  // 公式：zoom = 当前高度 / BASE_HEIGHT
  let resizeTimer = null;
  mainWindow.on('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const [_, h] = mainWindow.getContentSize();
        if (h > 0) {
          mainWindow.webContents.setZoomFactor(snapToZoomStep(h / BASE_HEIGHT));
        }
      }
    }, 150);
  });

  // 远程页面加载完成后，注入顶部可拖拽条（浮于页面之上，不占用布局空间，避免底部被裁）
  mainWindow.webContents.on('did-finish-load', () => {
    const currentUrl = mainWindow.webContents.getURL();
    if (!/^https?:/i.test(currentUrl)) return; // 仅对远程服务器页面注入
    mainWindow.webContents.insertCSS(`
      body { -webkit-app-region: no-drag; }
      .__fn-dragbar {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        height: 36px !important;
        -webkit-app-region: drag !important;
        z-index: 2147483647 !important;
        background: rgba(15, 15, 23, 0.0) !important;
        pointer-events: auto !important;
      }
      .__fn-close-btn {
        position: fixed !important;
        top: 8px !important;
        right: 10px !important;
        width: 22px !important;
        height: 22px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        -webkit-app-region: no-drag !important;
        z-index: 2147483648 !important;
        cursor: pointer !important;
        color: #8a8a96 !important;
        background: transparent !important;
        border: none !important;
        border-radius: 4px !important;
        transition: color 0.15s !important;
        opacity: 0.7 !important;
      }
      .__fn-close-btn:hover {
        color: #e8e8f0 !important;
        background: transparent !important;
        opacity: 1 !important;
      }
      .__fn-close-btn svg {
        width: 11px !important;
        height: 11px !important;
        display: block !important;
      }
    `).catch(() => {});
    mainWindow.webContents.executeJavaScript(`
      (function(){
        if (document.getElementById('__fn-dragbar')) return;
        var d = document.createElement('div');
        d.id = '__fn-dragbar';
        d.className = '__fn-dragbar';
        document.documentElement.appendChild(d);
        // 自定义关闭按钮（叉叉 = 最小化到托盘，由主进程 close 事件处理）
        var b = document.createElement('div');
        b.id = '__fn-close-btn';
        b.className = '__fn-close-btn';
        b.title = '关闭';
        b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
        b.addEventListener('click', function(){
          if (window.serverBridge && window.serverBridge.minimizeToTray) {
            window.serverBridge.minimizeToTray();
          }
        });
        document.documentElement.appendChild(b);
      })();
    `).catch(() => {});

    // 自动播放 + 自动登录
    tryAutoPlay();
    tryAutoLogin();
  });

  // SPA 路由切换（如 cookie 失效跳到 /login，或自动登录后跳回主页）
  // did-finish-load 不会触发，需监听 did-navigate-in-page
  mainWindow.webContents.on('did-navigate-in-page', () => {
    tryAutoLogin();
    tryAutoPlay();
  });

  // 站内新窗口放行，站外用系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // 禁止任何 window.open 新建窗口（避免页面弹出的额外窗口）
    // 同源链接用系统浏览器打开，跨域链接也用系统浏览器打开
    if (url) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 窗口级证书错误处理：放行 fnos.net 中转域名与 NAS 直连 IP 的证书
  // fnos.net 证书可能过期（ERR_CERT_DATE_INVALID），NAS 自签证书也会被拒绝
  // 注意：仅放行这两类，普通 https 站点走默认验证，避免引入安全风险
  mainWindow.webContents.on('certificate-error', (event, url, error, certificate, callback) => {
    let host = '';
    try { host = new URL(url).hostname; } catch {}
    if (host.endsWith('.fnos.net') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      event.preventDefault();
      callback(true); // 接受证书
    } else {
      callback(false); // 拒绝（走默认）
    }
  });

  // 仅允许停留在当前服务器站内
  // 跨域导航直接阻止，不调用 shell.openExternal：
  //  - 页面内部的重定向（如 fnos.net 中继 → NAS 局域网 IP）已由 isNavigationAllowed 放行
  //  - 其他跨域导航通常是页面 a 标签跳转，应交给 setWindowOpenHandler（target=_blank）走系统浏览器
  //  - 若此处也 openExternal，会发生"app 内被弹出到外部浏览器"的问题
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = getAllowedOrigin();
    console.log('[will-navigate] url:', url, 'allowed:', allowed);
    if (allowed && !isNavigationAllowed(url, allowed)) {
      console.log('[will-navigate] BLOCKED');
      event.preventDefault();
    }
  });

  // 诊断：页面加载失败时打印错误，便于定位白屏 / 跳转失败
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.log('[did-fail-load] code:', errorCode, 'desc:', errorDescription, 'url:', validatedURL);
  });

  // 诊断：导航开始时打印，确认 loadURL 是否触发
  mainWindow.webContents.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
    console.log('[did-start-navigation] url:', url, 'mainFrame:', isMainFrame);
  });

  // 媒体自动播放 / 全屏权限（使用持久化分区）
  getSession().setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' || permission === 'fullscreen');
  });

  // 启动分支：读取用户原始输入，每次启动走一次 resolveAccessUrl 确认本次访问地址
  // - 有 serverInput：异步解析为可访问地址并加载（fnid 需调 API + 探测）
  // - 没有：进入设置页
  const cfg = readConfig();
  if (cfg.serverInput) {
    resolveAccessUrl(cfg.serverInput).then(({ url, error }) => {
      if (url) {
        applyServerUrl(url);
      } else {
        console.log('[startup] resolve failed:', error);
        loadSetup();
      }
    });
  } else {
    loadSetup();
  }

  // 叉叉 = 最小化到托盘；只有 isQuitting（托盘右键退出）才真正关闭
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 当前允许的站点前缀（origin），仅在进入服务器后生效
let allowedOrigin = null;
function getAllowedOrigin() {
  return allowedOrigin;
}

// 判断 IP 是否为私网地址（10.x / 172.16-31.x / 192.168.x / 127.x / 169.254.x）
function isPrivateIp(ip) {
  if (!ip) return false;
  return (
    ip === '127.0.0.1' ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

// 判断目标 url 是否允许在 app 内导航
// 1. 同 origin 直接放行
// 2. fnos.net 中继场景：放行整个 fnos.net 域内导航（子域名 ↔ 路径形式互转）
// 3. fnos.net 中继可能 302 重定向到 NAS 局域网 IP：放行私网 IP，避免重定向被丢到外部浏览器
// 4. 局域网 IP origin 场景：放行同 IP 不同端口（NAS 站内跳端口登录等）
function isNavigationAllowed(url, allowed) {
  if (!url || !allowed) return false;
  if (url.startsWith(allowed)) return true;
  try {
    const allowedHost = new URL(allowed).hostname;
    const navHost = new URL(url).hostname;
    // fnos.net 域内互转
    if ((allowedHost === 'fnos.net' || allowedHost.endsWith('.fnos.net')) &&
        (navHost === 'fnos.net' || navHost.endsWith('.fnos.net'))) {
      return true;
    }
    // fnos.net 中继 → 私网 IP 重定向放行
    if ((allowedHost === 'fnos.net' || allowedHost.endsWith('.fnos.net')) && isPrivateIp(navHost)) {
      return true;
    }
    // 局域网 IP origin：放行同 IP 不同端口
    if (isPrivateIp(allowedHost) && navHost === allowedHost) {
      return true;
    }
  } catch {}
  return false;
}

// 应用服务器地址：设置 allowedOrigin 并在窗口加载，不写配置
function applyServerUrl(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    loadSetup();
    return;
  }
  try {
    allowedOrigin = new URL(url).origin;
  } catch {
    allowedOrigin = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(url, { userAgent: UA }, (err) => {
      if (err) console.log('[applyServerUrl] loadURL error:', err.code, err.message);
    });
  }
}

// 加载本地服务器地址输入页
function loadSetup() {
  allowedOrigin = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  }
}

// 退出登录：清除 cookies（登录态）与已保存的密码，保留服务器地址等其它配置，回到设置页
function logoutAccount() {
  const cfg = readConfig();
  delete cfg.password;
  writeConfig(cfg);
  getSession().clearStorageData({ storages: ['cookies'] }).catch(() => {});
  allowedOrigin = null;
  loadSetup();
}

// 返回已保存的服务器地址与用户名，供设置页预填（退出登录后保留输入历史）
ipcMain.handle('get-saved-input', () => {
  const cfg = readConfig();
  return { url: cfg.serverInput || '', username: cfg.username || '' };
});

// 设置页提交服务器地址（含可选用户名密码）：统一走 resolveAccessUrl 解析，持久化用户原始输入
ipcMain.handle('submit-server', async (event, payload) => {
  // 兼容：payload 可能是字符串（旧调用）或对象 { url, username, password }
  const input = typeof payload === 'string'
    ? payload.trim()
    : (payload && payload.url ? payload.url : '').trim();
  const username = (payload && typeof payload === 'object' ? (payload.username || '').trim() : '');
  const password = (payload && typeof payload === 'object' ? (payload.password || '') : '');

  const { url, error } = await resolveAccessUrl(input);
  if (!url) {
    return { ok: false, error };
  }
  // 持久化用户原始输入与登录凭据，下次启动重新解析
  const cfg = readConfig();
  cfg.serverInput = input;
  if (username) cfg.username = username;
  if (password) cfg.password = password;
  writeConfig(cfg);
  applyServerUrl(url);
  return { ok: true };
});

// 返回应用版本号（sandbox 渲染进程无法 require package.json，由主进程提供）
ipcMain.handle('get-app-version', () => app.getVersion());

// 比较版本号：返回 1 表示 latest > current，0 相等，-1 latest < current
function compareVersions(latest, current) {
  const pa = String(latest).replace(/^v/, '').split('.').map(Number);
  const pb = String(current).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

// 检查更新：调用 GitHub tags 接口获取最新 tag，与当前版本对比
async function checkForUpdate() {
  return new Promise((resolve) => {
    const req = https.get(REPO_TAGS_API, { headers: { 'User-Agent': 'fnmusic-exe-updater' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const list = JSON.parse(data);
          // tags 接口返回数组（按创建时间倒序），取第一个即最新 tag
          const latestTag = (Array.isArray(list) && list[0] && list[0].name) || '';
          if (!latestTag) {
            resolve({ hasUpdate: false, error: 'no_tag' });
            return;
          }
          const currentVer = app.getVersion();
          const hasUpdate = compareVersions(latestTag, currentVer) > 0;
          resolve({
            hasUpdate,
            currentVersion: currentVer,
            latestVersion: latestTag,
            releaseUrl: REPO_URL + '/releases/tag/' + latestTag
          });
        } catch {
          resolve({ hasUpdate: false, error: 'parse_failed' });
        }
      });
    });
    req.on('error', (e) => resolve({ hasUpdate: false, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ hasUpdate: false, error: 'timeout' }); });
  });
}

ipcMain.handle('check-update', () => checkForUpdate());

// 最小化到托盘（叉叉按钮调用）
ipcMain.handle('minimize-to-tray', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  return true;
});

// 创建托盘图标与右键菜单
function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) trayIcon = nativeImage.createEmpty();
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('飞牛音乐');

  tray.setContextMenu(buildTrayMenu());

  // 单击托盘图标：显示/隐藏主窗口
  tray.on('click', () => showMainWindow());
}

// 构建托盘右键菜单（每次构建都读取最新状态，确保勾选正确）
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        // 切换开机自启状态
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
        // 重新构建菜单刷新勾选状态
        tray.setContextMenu(buildTrayMenu());
      }
    },
    {
      label: '打开自动播放',
      type: 'checkbox',
      checked: !!readConfig().autoPlay,
      click: (menuItem) => {
        // 切换自动播放配置并持久化
        const cfg = readConfig();
        cfg.autoPlay = menuItem.checked;
        writeConfig(cfg);
        // 重新构建菜单刷新勾选状态
        tray.setContextMenu(buildTrayMenu());
      }
    },
    { type: 'separator' },
    {
      label: '窗口大小',
      submenu: [
        {
          label: '大窗口 (1855×1143)',
          type: 'radio',
          checked: getSavedPreset() === 'large',
          click: () => applyWindowPreset('large')
        },
        {
          label: '中窗口 (1575×927)',
          type: 'radio',
          checked: getSavedPreset() === 'medium',
          click: () => applyWindowPreset('medium')
        },
        {
          label: '小窗口 (1280×860)',
          type: 'radio',
          checked: getSavedPreset() === 'small',
          click: () => applyWindowPreset('small')
        }
      ]
    },
    { type: 'separator' },
    {
      label: '退出登录',
      click: () => {
        logoutAccount();
        showMainWindow();
      }
    },
    { type: 'separator' },
    {
      label: '关于',
      click: () => {
        const ver = app.getVersion();
        dialog.showMessageBox({
          type: 'info',
          title: '关于飞牛音乐',
          message: '飞牛音乐',
          detail: `版本：v${ver}\n\n基于 Electron 封装的飞牛音乐桌面客户端\n项目地址：https://github.com/wbc389561407/fnmusic-exe\n\n声明：个人自用项目，仅供学习交流。\n飞牛官方发布正式桌面客户端后，本项目将停止维护。`,
          buttons: ['确定'],
          icon: path.join(__dirname, 'build', 'icon.ico')
        });
      }
    },
    { type: 'separator' },
    {
      label: '退出飞牛音乐',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

// 显示并聚焦主窗口
function showMainWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '设置',
      submenu: [
        {
          label: '切换服务器地址...',
          click: () => loadSetup()
        },
        {
          label: '清除已保存地址并重置',
          click: () => {
            try {
              fs.unlinkSync(getConfigPath());
            } catch {}
            loadSetup();
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ===== 启动时更新检测 =====
// 启动后调用 checkForUpdate（GitHub tags 接口），有更新则弹窗一次
// 注意：checkForUpdate 同时被 IPC 'check-update' 复用，供设置页显示更新链接（不弹窗）
// 启动弹窗与设置页链接互不干扰，避免重复弹窗
async function checkUpdateAndNotify() {
  try {
    const info = await checkForUpdate();
    if (!info || !info.hasUpdate) return;
    const result = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: '发现新版本',
      detail: `当前版本：v${info.currentVersion}\n最新版本：${info.latestVersion}\n\n是否前往下载最新版本？`,
      buttons: ['前往下载', '稍后再说'],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response === 0 && info.releaseUrl) {
      shell.openExternal(info.releaseUrl);
    }
  } catch (e) {
    console.log('[checkUpdateAndNotify] error:', e.message);
  }
}

// 单实例锁：防止重复启动多个程序实例
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 已有实例在运行，当前实例直接退出
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户再次双击图标尝试启动第二个实例：聚焦到已有窗口
    showMainWindow();
  });

  app.whenReady().then(() => {
    setupCookiePersistence();
    buildMenu();
    createTray();
    createWindow();
    // 启动后延迟 3 秒异步检测更新（不阻塞窗口显示），仅弹窗一次
    setTimeout(checkUpdateAndNotify, 3000);

    app.on('activate', () => {
      // macOS 点击 dock 图标时，若窗口被隐藏则重新显示
      showMainWindow();
    });
  });
}

// 退出前强制写入 cookie 存储，确保登录态落盘
let quitting = false;
app.on('will-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  let done = false;
  const finish = () => { if (!done) { done = true; app.exit(0); } };
  getSession().cookies.flushStore().finally(finish);
  // 兜底：最多等 1.5s 强制退出，避免 flushStore 卡住导致无法关闭
  setTimeout(finish, 1500);
});

// 窗口全部关闭后不退出应用，保留托盘（点击叉叉已 hide 到托盘，正常不会触发）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 不直接 quit，保持托盘运行；用户从托盘「退出」才真正结束
  }
});

// 真正退出时销毁托盘图标
app.on('before-quit', () => {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
