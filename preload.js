// preload: 通过 contextBridge 向渲染层暴露受控的 IPC 接口
// setup.html 用 serverBridge.submit 提交服务器地址
const { contextBridge, ipcRenderer } = require('electron');

// 应用版本号（来自 package.json，由 Electron 注入）
const APP_VERSION = process.env.npm_package_version || require('../package.json').version;

contextBridge.exposeInMainWorld('serverBridge', {
  // 提交服务器地址，返回 Promise<{ ok: boolean, error?: string }>
  submit: (url) => ipcRenderer.invoke('submit-server', url),
  // 应用版本号，供设置页显示
  version: APP_VERSION
});

// 阻止页面默认拖拽打开文件的行为
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
});
