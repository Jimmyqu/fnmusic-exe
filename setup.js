// setup.html 的脚本：收集服务器地址并通过 preload 暴露的 serverBridge 提交给主进程
// 放在外部文件，避免被页面 CSP 当作内联脚本拦截
(function () {
  function init() {
    var form = document.getElementById('form');
    var input = document.getElementById('url');
    var btn = document.getElementById('btn');
    var msg = document.getElementById('msg');

    if (!form) return;

    function setMsg(text, isError) {
      msg.textContent = text || '';
      msg.style.color = isError ? '#ff8a8a' : '#8aff9d';
    }

    // 若 preload 未成功注入桥接对象，给出可见提示
    if (!window.serverBridge || typeof window.serverBridge.submit !== 'function') {
      setMsg('初始化失败：桥接对象不可用，请重启应用', true);
      btn.disabled = true;
      return;
    }

    // 显示应用版本号（异步从主进程获取）
    var versionEl = document.getElementById('app-version');
    if (versionEl && typeof window.serverBridge.getVersion === 'function') {
      window.serverBridge.getVersion().then(function (v) {
        if (v) versionEl.textContent = 'v' + v;
      });
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var url = input.value.trim();
      if (!url) {
        setMsg('请输入服务器地址', true);
        input.focus();
        return;
      }
      btn.disabled = true;
      btn.textContent = '连接中...';
      setMsg('');
      try {
        var res = await window.serverBridge.submit(url);
        if (!res || !res.ok) {
          setMsg((res && res.error) || '连接失败，请检查地址', true);
          btn.disabled = false;
          btn.textContent = '连接';
        } else {
          // 成功：主进程会加载远程页面跳转。加 15 秒兜底，若页面仍未跳转则恢复按钮
          setTimeout(function () {
            if (document.getElementById('btn')) {
              btn.disabled = false;
              btn.textContent = '连接';
              setMsg('连接超时，请检查服务器是否在线', true);
            }
          }, 15000);
        }
      } catch (err) {
        setMsg('发生错误：' + (err.message || err), true);
        btn.disabled = false;
        btn.textContent = '连接';
      }
    });

    // 仓库链接点击：交给主进程 setWindowOpenHandler → shell.openExternal 用系统浏览器打开
    var repoLink = document.getElementById('repo-link');
    if (repoLink) {
      repoLink.addEventListener('click', function (e) {
        e.preventDefault();
        window.open(repoLink.href);
      });
    }

    // 自定义关闭按钮：调用 IPC 最小化到托盘
    var closeBtn = document.getElementById('close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        if (window.serverBridge && window.serverBridge.minimizeToTray) {
          window.serverBridge.minimizeToTray();
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
