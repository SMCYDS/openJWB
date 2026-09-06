const ENTRY_URL = 'https://my.sjtu.edu.cn/';

// jalogin 页面里 `var loginContext = {...};` 里我们关心的字段。
// 用逐字段正则提取而不是 eval 整个对象，避免执行不可信页面内容。
const LOGIN_CONTEXT_FIELDS = ['loginType', 'sid', 'client', 'returl', 'se', 'v', 'uuid'];

/**
 * 从 jalogin 页面 HTML 中解析出 loginContext。
 * 解析不到时返回 null，方便上层区分"页面结构变了"和"网络/跳转失败"。
 */
function parseLoginContext(html) {
  const blockMatch = html.match(/var\s+loginContext\s*=\s*\{([\s\S]*?)\};/);
  if (!blockMatch) {
    return null;
  }

  const block = blockMatch[1];
  const context = {};

  for (const field of LOGIN_CONTEXT_FIELDS) {
    const fieldMatch = block.match(new RegExp(`${field}\\s*:\\s*"([^"]*)"`));
    context[field] = fieldMatch ? fieldMatch[1] : '';
  }

  return context;
}

/**
 * 走一遍 my.sjtu.edu.cn -> oauth2/authorize -> jalogin 的跳转链路，
 * 依赖传入的 http 客户端（需带 cookie jar）在跳转间保持 session。
 * 返回解析出的 loginContext，同时把最终页面的 html 也一并返回，
 * 方便调试或后续需要用到页面里其他信息时扩展。
 */
async function fetchLoginContext(http) {
  const res = await http.get(ENTRY_URL);

  if (res.status >= 400) {
    throw new Error(`访问 ${ENTRY_URL} 失败，状态码 ${res.status}`);
  }

  const html = typeof res.data === 'string' ? res.data : String(res.data);
  const loginContext = parseLoginContext(html);

  if (!loginContext) {
    throw new Error('未能在最终页面中找到 loginContext，可能登录页结构已变化，或跳转链路中断');
  }

  return { loginContext, html, finalUrl: res.request?.res?.responseUrl || res.config?.url };
}

module.exports = { fetchLoginContext, parseLoginContext };
