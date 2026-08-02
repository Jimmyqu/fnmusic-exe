const { app, BrowserWindow, shell, session, Menu, ipcMain, Tray, nativeImage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

  // 对 fnos.net 中转域名和 NAS 直连 IP 放行 SSL 证书验证
  // fnos.net 证书可能过期（ERR_CERT_DATE_INVALID），NAS 自签证书也会被拒绝
  ses.setCertificateVerifyProc((request, callback) => {
    const { hostname } = request;
    if (hostname.endsWith('.fnos.net') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      callback(0); // 接受证书
    } else {
      callback(-2); // 使用 Chromium 默认验证
    }
  });
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
// 返回候选地址列表（按优先级排序）：局域网 http > 公网 http > relay https 兜底
// API 返回数据示例：
//   { ipv4: ["192.168.5.18"], publicIpv4: ["39.186.22.84"], fn: ["srtv666.fnos.net:443"],
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
    if (!json || json.code !== 0 || !json.data) return null;

    const d = json.data;
    const httpPort = d.port && d.port.httpPort;
    const candidates = [];

    // 1. 局域网 http（优先级最高，局域网内最快，无证书问题）
    if (httpPort) {
      (d.ipv4 || []).forEach((ip) => {
        candidates.push(`http://${ip}:${httpPort}`);
      });
      // 2. 公网 http 直连（无证书问题）
      (d.publicIpv4 || []).forEach((ip) => {
        candidates.push(`http://${ip}:${httpPort}`);
      });
    }

    // 3. relay https 中转（兜底，fnos.net 域名，证书可能过期需 session 放行）
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

    return candidates.length > 0 ? candidates : null;
  } catch (e) {
    console.error('resolveFnid error:', e.message);
    return null;
  }
}

// 并发探测候选地址，返回第一个成功响应的 URL
// http 候选用 Node fetch 探测；https relay 探测可能因证书失败，直接跳过交由 BrowserWindow 加载
async function probeCandidates(candidates) {
  const withTimeout = (p, ms) =>
    Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);

  // 分离 http 候选（可探测）和 https 兜底（不探测，直接用）
  const httpCandidates = candidates.filter((u) => u.startsWith('http://'));
  const httpsFallback = candidates.find((u) => u.startsWith('https://'));

  // 并发探测所有 http 候选，谁先成功用谁
  if (httpCandidates.length > 0) {
    try {
      const winner = await Promise.any(httpCandidates.map(async (url) => {
        const resp = await withTimeout(fetch(url, { method: 'GET', redirect: 'manual' }), 5000);
        // 任何 HTTP 响应（含 401/404/302）都说明地址可达
        return url;
      }));
      return winner;
    } catch {
      // 所有 http 候选都失败，走 https 兜底
    }
  }

  return httpsFallback || null;
}

// 自动补 /music 后缀：已以 /music 或 /music/ 结尾则原样返回，否则末尾追加 /music
function ensureMusicSuffix(url) {
  try {
    const u = new URL(url);
    if (/\/music\/?$/.test(u.pathname)) return u.href;
    const path = u.pathname.replace(/\/+$/, '');
    u.pathname = path + '/music';
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: '飞牛音乐',
    backgroundColor: '#00000000',
    show: false,
    autoHideMenuBar: true,
    // 无边框客户端外观：隐藏标题栏，保留原生最小化/最大化/关闭按钮（右上角覆盖层）
    frame: false,
    // 仅保留关闭按钮（叉叉 = 最小化到托盘），隐藏最小化 / 最大化按钮
    minimizable: false,
    maximizable: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#e8e8f0',
      height: 36
    },
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

  mainWindow.once('ready-to-show', () => mainWindow.show());

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
    `).catch(() => {});
    mainWindow.webContents.executeJavaScript(`
      (function(){
        if (document.getElementById('__fn-dragbar')) return;
        var d = document.createElement('div');
        d.id = '__fn-dragbar';
        d.className = '__fn-dragbar';
        document.documentElement.appendChild(d);
      })();
    `).catch(() => {});
  });

  // 站内新窗口放行，站外用系统默认浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = getAllowedOrigin();
    if (url && allowed && url.startsWith(allowed)) {
      return { action: 'allow' };
    }
    if (url) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 仅允许停留在当前服务器站内
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = getAllowedOrigin();
    if (allowed && !url.startsWith(allowed)) {
      event.preventDefault();
      if (url) shell.openExternal(url);
    }
  });

  // 媒体自动播放 / 全屏权限（使用持久化分区）
  getSession().setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' || permission === 'fullscreen');
  });

  // 启动分支：已配置服务器 -> 直接进入；否则进入设置页
  const cfg = readConfig();
  if (cfg.serverUrl) {
    loadServer(cfg.serverUrl);
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

// 加载服务器页面
function loadServer(rawUrl) {
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
  writeConfig({ serverUrl: url });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(url, { userAgent: UA });
  }
}

// 加载本地服务器地址输入页
function loadSetup() {
  allowedOrigin = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  }
}

// 重置：清空服务器地址配置与所有持久化存储（cookies / localStorage 等），回到设置页重新填写
function resetServerData() {
  try {
    fs.unlinkSync(getConfigPath());
  } catch {}
  allowedOrigin = null;
  loadSetup();
  getSession().clearStorageData().catch(() => {});
}

// 设置页提交服务器地址：fnid 优先解析，网址则规范化后补 /music
ipcMain.handle('submit-server', async (event, rawUrl) => {
  const input = (rawUrl || '').trim();
  if (!input) {
    return { ok: false, error: '请输入服务器地址' };
  }

  // fnid 分支：调用 fnos.net API 解析候选地址，并发探测选最优
  if (isFnid(input)) {
    const candidates = await resolveFnid(input);
    if (!candidates || candidates.length === 0) {
      return { ok: false, error: 'fnid 解析失败，请检查或使用网址登录' };
    }
    const selected = await probeCandidates(candidates);
    if (!selected) {
      return { ok: false, error: '所有候选地址均不可达，请检查网络或使用网址登录' };
    }
    const finalUrl = ensureMusicSuffix(selected);
    if (!finalUrl) {
      return { ok: false, error: '解析到的地址格式无效' };
    }
    loadServer(finalUrl);
    return { ok: true };
  }

  // 网址分支：规范化 + 补 /music
  const url = normalizeUrl(input);
  if (!url) {
    return { ok: false, error: '地址无效，请检查后重试' };
  }
  const finalUrl = ensureMusicSuffix(url);
  if (!finalUrl) {
    return { ok: false, error: '地址格式无效' };
  }
  loadServer(finalUrl);
  return { ok: true };
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

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => showMainWindow()
    },
    { type: 'separator' },
    {
      label: '重置地址',
      click: () => {
        resetServerData();
        showMainWindow();
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

  tray.setContextMenu(contextMenu);

  // 单击托盘图标：显示/隐藏主窗口
  tray.on('click', () => showMainWindow());
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
