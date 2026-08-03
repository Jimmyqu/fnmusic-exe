// preload: 通过 contextBridge 向渲染层暴露受控的 IPC 接口
// setup.html 用 serverBridge.submit 提交服务器地址
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serverBridge', {
  // 提交服务器地址，返回 Promise<{ ok: boolean, error?: string }>
  submit: (url) => ipcRenderer.invoke('submit-server', url),
  // 获取应用版本号（主进程 app.getVersion()，sandbox 下不能用 require 读 package.json）
  getVersion: () => ipcRenderer.invoke('get-app-version')
});

// 阻止页面默认拖拽打开文件的行为
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
});
