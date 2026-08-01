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

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var url = input.value.trim();
      if (!url) {
        setMsg('请输入服务器地址', true);
        input.focus();
        return;
      }
      if (!/\/music\/?$/i.test(url)) {
        setMsg('地址需以 /music 或 /music/ 结尾', true);
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
        }
        // 成功则主进程会跳转页面，无需在此处理
      } catch (err) {
        setMsg('发生错误：' + (err.message || err), true);
        btn.disabled = false;
        btn.textContent = '连接';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
