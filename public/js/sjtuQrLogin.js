(async function () {
  const img = document.getElementById('qrcode-img');
  const statusEl = document.getElementById('qrcode-status');

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function refreshImage() {
    // 加时间戳绕过浏览器缓存，拿到最新一次后端缓存的二维码
    img.src = '/api/sjtu/login/qrcode/image?t=' + Date.now();
  }

  try {
    setStatus('正在连接 jaccount...');
    const startRes = await fetch('/api/sjtu/login/start', { method: 'POST' });
    const startData = await startRes.json();
    if (!startRes.ok || !startData.ok) {
      setStatus(startData.message || '连接 jaccount 失败');
      return;
    }

    setStatus('正在获取二维码...');
    const qrStartRes = await fetch('/api/sjtu/login/qrcode/start', { method: 'POST' });
    const qrStartData = await qrStartRes.json();
    if (!qrStartRes.ok || !qrStartData.ok) {
      setStatus(qrStartData.message || '获取二维码失败');
      return;
    }

    const stream = new EventSource('/api/sjtu/login/qrcode/stream');
    stream.addEventListener('update', () => {
      refreshImage();
      setStatus('请使用 Jaccount App 扫码登录（二维码每分钟自动刷新）');
    });
    stream.addEventListener('login-success', () => {
      setStatus('登录成功，正在跳转...');
      stream.close();
      window.location.href = 'dashboard.html';
    });
    stream.addEventListener('login-failed', () => {
      setStatus('登录失败，请刷新页面重试');
      stream.close();
    });
    stream.onerror = () => {
      setStatus('二维码更新连接已断开，请刷新页面重试');
    };
  } catch (err) {
    setStatus('网络错误，请检查后端服务是否已启动');
  }
})();
