const { createSjtuClient } = require('./client');
const { createQrState, stopQrLogin } = require('./qrLogin');

// 按我们自己后端的 session id 缓存每个用户正在进行的 jaccount 登录会话
// （cookie jar + 已解析出的 loginContext）。后续"提交密码"、"用登录后的
// cookie 请求教务数据"等步骤都复用同一个 entry 里的 http 客户端。
//
// 注意：这里用进程内 Map 存储，重启后端会丢失所有进行中的登录会话，
// 且只适用于单进程部署。以后如果要多实例/多进程部署，需要换成
// Redis 之类的外部存储，并把 http/jar 换成可序列化的 cookie 字符串。
const store = new Map();

const ENTRY_TTL_MS = 10 * 60 * 1000; // 10 分钟未完成登录就视为过期

function createEntry(sessionId) {
  const { jar, http } = createSjtuClient();
  const entry = {
    sessionId, // 挂在 entry 上，方便 qrLogin/expressLogin 在 websocket 回调里定位回这个后端 session
    jar,
    http,
    loginContext: null,
    qr: createQrState(),
    createdAt: Date.now()
  };
  store.set(sessionId, entry);
  return entry;
}

function getEntry(sessionId) {
  const entry = store.get(sessionId);
  if (!entry) return null;

  if (Date.now() - entry.createdAt > ENTRY_TTL_MS) {
    store.delete(sessionId);
    return null;
  }

  return entry;
}

function deleteEntry(sessionId) {
  const entry = store.get(sessionId);
  if (entry) {
    stopQrLogin(entry);
  }
  store.delete(sessionId);
}

// 定期清理过期的登录会话，防止内存泄漏（同时会断开对应的二维码 websocket）
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, entry] of store.entries()) {
    if (now - entry.createdAt > ENTRY_TTL_MS) {
      stopQrLogin(entry);
      store.delete(sessionId);
    }
  }
}, 60 * 1000).unref();

module.exports = { createEntry, getEntry, deleteEntry };
