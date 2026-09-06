const form = document.getElementById('login-form');
const errorMsg = document.getElementById('error-msg');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.textContent = '';

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      errorMsg.textContent = data.message || '登录失败';
      return;
    }

    window.location.href = 'dashboard.html';
  } catch (err) {
    errorMsg.textContent = '网络错误，请检查后端服务是否已启动';
  }
});
