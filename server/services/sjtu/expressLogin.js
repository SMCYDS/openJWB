const EXPRESS_LOGIN_URL = 'https://jaccount.sjtu.edu.cn/jaccount/expresslogin';
const MY_SJTU_ORIGIN = 'https://my.sjtu.edu.cn';

/**
 * 扫码成功后，websocket 会推送 { type: "LOGIN", error: 0 }。
 * 这时候拿 loginContext.uuid 去请求 expresslogin，会依次跳转：
 *   jaccount/expresslogin -> oauth2/authorize -> my.sjtu.edu.cn/?code=...&state=...
 *   -> my.sjtu.edu.cn 首页
 * 走完这一串，my.sjtu.edu.cn 会种下 JSESSIONID / keepalive 两个 cookie，
 * 登录正式完成。entry.http 自带 cookie jar，会自动跟着走完整条重定向链路
 * 并把沿途的 Set-Cookie 都收进 entry.jar，这里只是把登录后要用的两个
 * cookie 显式取出来，方便存到"登录后运作模块"。
 */
async function completeExpressLogin(entry) {
  const uuid = entry.loginContext && entry.loginContext.uuid;
  if (!uuid) {
    throw new Error('缺少 loginContext.uuid，无法完成 expresslogin');
  }

  const url = `${EXPRESS_LOGIN_URL}?uuid=${encodeURIComponent(uuid)}`;
  const res = await entry.http.get(url);

  if (res.status >= 400) {
    throw new Error(`expresslogin 失败，状态码 ${res.status}`);
  }

  const cookies = await entry.jar.getCookies(MY_SJTU_ORIGIN);
  const jsessionId = cookies.find((c) => c.key === 'JSESSIONID');
  const keepalive = cookies.find((c) => c.key === 'keepalive');

  if (!jsessionId) {
    throw new Error('expresslogin 完成后未在 my.sjtu.edu.cn 域下找到 JSESSIONID，登录可能未成功');
  }

  return {
    jsessionId: jsessionId.value,
    keepalive: keepalive ? keepalive.value : null
  };
}

module.exports = { completeExpressLogin };
