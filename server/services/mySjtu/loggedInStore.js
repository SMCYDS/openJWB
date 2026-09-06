// "登录后运作模块"：只关心用户登录 my.sjtu.edu.cn 成功之后的状态，
// 不关心是走了扫码登录还是以后可能加的账号密码登录 —— 只要拿到
// JSESSIONID/keepalive 和对应的 http 客户端，存进来就行。
//
// 后续要做的"请求教务数据"之类的模块，都应该从这里拿 http 客户端，
// 不需要知道 jaccount 登录流程的细节，做到登录逻辑和业务逻辑分离。
//
// 注意：进程内 Map 存储，重启后端会丢失登录态，只适用于单进程部署。
const store = new Map();

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时无操作视为过期，具体时长以后可依据 keepalive 调整

function markLoggedIn(sessionId, { jar, http, jsessionId, keepalive }) {
  const session = {
    jar,
    http,
    jsessionId,
    keepalive,
    loggedInAt: Date.now()
  };
  store.set(sessionId, session);
  return session;
}

function getSession(sessionId) {
  const session = store.get(sessionId);
  if (!session) return null;

  if (Date.now() - session.loggedInAt > SESSION_TTL_MS) {
    store.delete(sessionId);
    return null;
  }

  return session;
}

function isLoggedIn(sessionId) {
  return getSession(sessionId) !== null;
}

function clearSession(sessionId) {
  store.delete(sessionId);
}

module.exports = { markLoggedIn, getSession, isLoggedIn, clearSession };
