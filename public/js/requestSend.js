// "请求发送"模式：让用户输入任意 URL（或从预设下拉框选），后端用当前登录态的
// cookie jar 发请求，自动带 Cookie、自动接收 Set-Cookie。响应区的 Body / Header
// 切换栏控制显示响应体还是响应头。
const presetSelect = document.getElementById('preset-select');
const reqMethod = document.getElementById('req-method');
const reqUrl = document.getElementById('req-url');
const sendBtn = document.getElementById('send-btn');
const reqStatus = document.getElementById('req-status');

const respTabs = document.getElementById('resp-tabs');
const respBodyPre = document.querySelector('#resp-body pre');
const respHeaderPre = document.querySelector('#resp-header pre');

// 预设下拉框变化时同步填充到 URL 输入框
presetSelect.addEventListener('change', () => {
  if (presetSelect.value) {
    reqUrl.value = presetSelect.value;
  }
});

// 响应区上方 Body / Header 切换
respTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.resp-tab');
  if (!tab) return;
  respTabs.querySelectorAll('.resp-tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.resp-panel').forEach((panel) => {
    const isTarget = panel.id === `resp-${tab.dataset.tab}`;
    panel.classList.toggle('active', isTarget);
  });
});

// 尝试把字符串格式化成好看的 JSON；失败就原样返回
function tryPrettyJson(text) {
  if (text == null) return '';
  if (typeof text !== 'string') {
    try {
      return JSON.stringify(text, null, 2);
    } catch {
      return String(text);
    }
  }
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

function renderHeaders(headers) {
  const lines = [];
  Object.keys(headers).forEach((name) => {
    const value = headers[name];
    if (Array.isArray(value)) {
      value.forEach((v) => lines.push(`${name}: ${v}`));
    } else {
      lines.push(`${name}: ${value}`);
    }
  });
  return lines.join('\n');
}

sendBtn.addEventListener('click', async () => {
  const url = reqUrl.value.trim();
  if (!url) {
    reqStatus.textContent = '请填写请求链接';
    return;
  }

  sendBtn.disabled = true;
  reqStatus.textContent = '发送中...';
  respBodyPre.textContent = '';
  respHeaderPre.textContent = '';

  try {
    const res = await fetch('/api/request/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, method: reqMethod.value })
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      reqStatus.textContent = data.message || '请求失败';
      return;
    }

    const { status, statusText, headers, body } = data.response;
    reqStatus.textContent = `状态：${status} ${statusText || ''}`.trim();

    respBodyPre.textContent = tryPrettyJson(body);
    respHeaderPre.textContent = renderHeaders(headers);
  } catch (err) {
    reqStatus.textContent = '网络错误，请检查后端服务是否已启动';
  } finally {
    sendBtn.disabled = false;
  }
});
