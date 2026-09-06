const express = require('express');
const router = express.Router();

const mySjtuLoggedInStore = require('../services/mySjtu/loggedInStore');
const { createSjtuClient } = require('../services/sjtu/client');

// 登录态校验：占位登录（req.session.user）或真实 jaccount 登录（mySjtuLoggedInStore）任一即可。
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  if (mySjtuLoggedInStore.isLoggedIn(req.sessionID)) return next();
  res.status(401).json({ ok: false, message: '未登录' });
}

// 把 axios 响应头对象拍平成 { name: value | value[] }，方便前端按表格展示。
// axios 把多个同名 header 合并成数组（例如 Set-Cookie），这里保持原样。
function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  Object.keys(headers).forEach((name) => {
    out[name] = headers[name];
  });
  return out;
}

// 发送任意请求：复用当前登录会话的 cookie jar（自动带上 JSESSIONID/keepalive 等），
// 同时 cookie jar 也会自动接收并保存响应里的 Set-Cookie，下次请求会继续带上。
// 不自动跟随重定向（maxRedirects: 0），让用户看到原始响应头和 Set-Cookie。
router.post('/send', requireLogin, async (req, res) => {
  const { url, method = 'GET', headers, body } = req.body || {};
  if (!url) {
    return res.status(400).json({ ok: false, message: '缺少 url' });
  }

  // 优先用登录后运作模块里的 http 客户端（带 my.sjtu.edu.cn 登录 cookie）；
  // 占位登录（auth.js 设置的 req.session.user）没有真实 cookie jar，
  // 这里临时建一个空 jar 的客户端，保证工具本身可用，但请求不会带登录态。
  const session = mySjtuLoggedInStore.getSession(req.sessionID);
  let http;
  let jar;
  if (session) {
    http = session.http;
    jar = session.jar;
  } else {
    const tmp = createSjtuClient();
    http = tmp.http;
    jar = tmp.jar;
  }

  try {
    const axiosReq = {
      method: String(method).toUpperCase(),
      url,
      headers: headers || {},
      // 不自动跟随重定向，方便用户观察原始响应（含 Set-Cookie / Location）
      maxRedirects: 0,
      timeout: 30000,
      // 任何状态码都返回给前端，不抛错
      validateStatus: () => true,
      // 让 axios 把响应体按原始类型返回（JSON 自动解析、其他返回字符串/Buffer）
      responseType: 'text',
      transformResponse: [(data) => data]
    };
    if (body && axiosReq.method !== 'GET' && axiosReq.method !== 'HEAD') {
      axiosReq.data = body;
    }

    const resp = await http(axiosReq);

    // 拿到响应后，cookie jar 已经自动收下 Set-Cookie；这里把当前 url 域下的
    // cookie 一并返回，方便前端确认登录态变化。
    let cookies = [];
    try {
      const domainCookies = await jar.getCookies(url);
      cookies = domainCookies.map((c) => ({
        key: c.key,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires ? new Date(c.expires).toISOString() : null
      }));
    } catch (e) {
      // 取 cookie 失败不影响主流程
    }

    res.json({
      ok: true,
      response: {
        status: resp.status,
        statusText: resp.statusText,
        headers: normalizeHeaders(resp.headers),
        body: resp.data
      },
      cookies
    });
  } catch (err) {
    console.error('[requestSend] 请求失败:', err.message);
    res.status(502).json({ ok: false, message: '请求失败: ' + err.message });
  }
});

module.exports = router;
