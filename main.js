const { app, BrowserWindow, shell, session, Menu, ipcMain, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

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
  // 导致普通 https 站点（如 music.wbcwqq.cn）无法加载。
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

// ===== fnid 访问（通过 fnos.net 中继）=====
// fnid 直接走中继地址 https://{fnid}.fnos.net/music，无需调用 API 解析候选

// 判断输入是否为 fnid：不含 . / : 且不带协议的短字符串
function isFnid(input) {
  const s = (input || '').trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return false; // 带协议的是网址
  if (/[.\/:]/.test(s)) return false;        // 含 . / : 视为网址/IP
  return /^[a-zA-Z0-9_-]+$/.test(s);          // 仅字母数字下划线短横
}

// 统一解析用户输入为可访问地址
// - fnid：构造中继地址 https://{fnid}.fnos.net/music/
// - IP / 网址：规范化 + 补 /music/
// 返回 { url, error }，url 非空即可直接访问
function resolveAccessUrl(input) {
  const s = (input || '').trim();
  if (!s) return { url: null, error: '请输入服务器地址' };

  if (isFnid(s)) {
    const url = `https://${s}.fnos.net/music/`;
    console.log('[resolveAccessUrl] fnid ->', url);
    return { url, error: null };
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
    if (isNavigationAllowed(url, allowed)) {
      return { action: 'allow' };
    }
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
  // fnos.net 中继场景：子域名形式(srtv369.fnos.net)与路径形式(fnos.net/srtv369)会互转，
  // 需放行整个 fnos.net 域内导航，避免重定向被拦截后丢到外部浏览器导致 app 内卡住
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = getAllowedOrigin();
    console.log('[will-navigate] url:', url, 'allowed:', allowed);
    if (allowed && !isNavigationAllowed(url, allowed)) {
      console.log('[will-navigate] BLOCKED -> openExternal');
      event.preventDefault();
      if (url) shell.openExternal(url);
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
  // - 有 serverInput：解析为可访问地址并加载
  // - 没有：进入设置页
  const cfg = readConfig();
  if (cfg.serverInput) {
    const { url, error } = resolveAccessUrl(cfg.serverInput);
    if (url) {
      applyServerUrl(url);
    } else {
      console.log('[startup] resolve failed:', error);
      loadSetup();
    }
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

// 判断目标 url 是否允许在 app 内导航
// 1. 同 origin 直接放行
// 2. fnos.net 中继场景：子域名形式(srtv369.fnos.net)与路径形式(fnos.net/srtv369)会互相重定向，
//    当已配置服务器为 fnos.net 中继时，放行整个 fnos.net 域内导航，避免重定向被拦截导致卡住
function isNavigationAllowed(url, allowed) {
  if (!url || !allowed) return false;
  if (url.startsWith(allowed)) return true;
  try {
    const allowedHost = new URL(allowed).hostname;
    const navHost = new URL(url).hostname;
    if (allowedHost === 'fnos.net' || allowedHost.endsWith('.fnos.net')) {
      if (navHost === 'fnos.net' || navHost.endsWith('.fnos.net')) {
        return true;
      }
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

// 重置：清空服务器地址配置与所有持久化存储（cookies / localStorage 等），回到设置页重新填写
function resetServerData() {
  try {
    fs.unlinkSync(getConfigPath());
  } catch {}
  allowedOrigin = null;
  loadSetup();
  getSession().clearStorageData().catch(() => {});
}

// 设置页提交服务器地址：统一走 resolveAccessUrl 解析，持久化用户原始输入
ipcMain.handle('submit-server', async (event, rawUrl) => {
  const input = (rawUrl || '').trim();
  const { url, error } = resolveAccessUrl(input);
  if (!url) {
    return { ok: false, error };
  }
  // 持久化用户原始输入，下次启动重新解析
  writeConfig({ serverInput: input });
  applyServerUrl(url);
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
