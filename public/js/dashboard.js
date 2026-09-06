const metricsEl = document.getElementById('metrics');
const updatedAtEl = document.getElementById('updated-at');
const usernameDisplay = document.getElementById('username-display');
const logoutBtn = document.getElementById('logout-btn');
const modeNav = document.getElementById('mode-nav');

async function checkAuthAndLoad() {
  const statusRes = await fetch('/api/sjtu/status');
  const status = await statusRes.json();

  if (!status.loggedIn) {
    window.location.href = 'index.html';
    return;
  }

  usernameDisplay.textContent = 'SJTU 账号';
  loadSummary();
}

async function loadSummary() {
  const res = await fetch('/api/dashboard/summary');

  if (res.status === 401) {
    window.location.href = 'index.html';
    return;
  }

  const { data } = await res.json();
  updatedAtEl.textContent = new Date(data.updatedAt).toLocaleString('zh-CN');

  metricsEl.innerHTML = '';
  data.metrics.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'metric-card';
    card.innerHTML = `
      <div class="label">${m.label}</div>
      <div class="value">${m.value}</div>
    `;
    metricsEl.appendChild(card);
  });
}

// 模式切换：点击侧栏按钮切换显示对应面板
function switchMode(mode) {
  modeNav.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  document.querySelectorAll('.mode-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `mode-${mode}`);
  });
}

modeNav.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  switchMode(btn.dataset.mode);
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = 'index.html';
});

checkAuthAndLoad();
