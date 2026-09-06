const WebSocket = require('ws');
const { EventEmitter } = require('events');

const { completeExpressLogin } = require('./expressLogin');
const loggedInStore = require('../mySjtu/loggedInStore');

const JACCOUNT_ORIGIN = 'https://jaccount.sjtu.edu.cn';
const WS_BASE_URL = 'wss://jaccount.sjtu.edu.cn/jaccount/sub/';
const QR_REFRESH_INTERVAL_MS = 60 * 1000;

/**
 * 给一个 sessionStore 里的 entry 初始化二维码登录所需的状态。
 * 单独抽出来，方便 sessionStore 在创建 entry 时直接调用，
 * 也方便这里维护 qr 状态的形状（image/contentType/updatedAt/emitter...）。
 */
function createQrState() {
  return {
    ws: null,
    interval: null,
    image: null, // Buffer
    contentType: null,
    updatedAt: 0,
    // 'pending' | 'success' | 'failed'，扫码后 websocket 推送 LOGIN 消息时更新
    loginStatus: 'pending',
    emitter: new EventEmitter()
  };
}

/**
 * 用 entry.jar 里已有的 cookie（跟 /login/start 时走 my.sjtu.edu.cn 拿到的是
 * 同一份 session）去连 wss://jaccount.sjtu.edu.cn/jaccount/sub/{uuid}，
 * 连上之后立即请求一次二维码，之后每 60 秒再请求一次刷新。
 *
 * 每次收到新的 sig/ts 都会去下载对应的二维码图片，存到 entry.qr.image，
 * 并通过 entry.qr.emitter 发出 'update' 事件，供 SSE 路由推给前端。
 */
async function startQrLogin(entry) {
  if (!entry.loginContext || !entry.loginContext.uuid) {
    throw new Error('缺少 loginContext.uuid，请先完成 /login/start');
  }

  if (entry.qr && entry.qr.ws) {
    // 已经在跑了，不用重复连接
    return entry.qr;
  }

  const qr = entry.qr || createQrState();
  entry.qr = qr;

  const cookie = await entry.jar.getCookieString(JACCOUNT_ORIGIN);
  const ws = new WebSocket(WS_BASE_URL + entry.loginContext.uuid, {
    headers: { Cookie: cookie }
  });
  qr.ws = ws;

  ws.on('open', () => {
    requestQrCodeUpdate(ws);
    qr.interval = setInterval(() => requestQrCodeUpdate(ws), QR_REFRESH_INTERVAL_MS);
  });

  ws.on('message', (raw) => {
    handleWsMessage(entry, raw).catch((err) => {
      console.error('[sjtu qrLogin] 处理二维码消息失败:', err.message);
    });
  });

  ws.on('error', (err) => {
    console.error('[sjtu qrLogin] websocket 出错:', err.message);
  });

  ws.on('close', () => {
    if (qr.interval) {
      clearInterval(qr.interval);
      qr.interval = null;
    }
    qr.ws = null;
  });

  return qr;
}

function requestQrCodeUpdate(ws) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'UPDATE_QR_CODE' }));
  }
}

async function handleWsMessage(entry, raw) {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'UPDATE_QR_CODE') {
    if (msg.error !== 0) {
      console.error('[sjtu qrLogin] 服务端返回错误:', msg);
      return;
    }
    const { sig, ts } = msg.payload || {};
    if (!sig || !ts) {
      return;
    }
    await fetchQrCodeImage(entry, { sig, ts });
    return;
  }

  if (msg.type === 'LOGIN') {
    await handleLoginMessage(entry, msg);
    return;
  }
}

/**
 * 扫码成功后 websocket 会推送 { type: "LOGIN", error: 0 }。
 * 走完 expresslogin 拿到 JSESSIONID/keepalive 后存进"登录后运作模块"，
 * 二维码轮询也就没必要继续了，顺便停掉。
 */
async function handleLoginMessage(entry, msg) {
  if (msg.error !== 0) {
    console.error('[sjtu qrLogin] 扫码登录失败:', msg);
    entry.qr.loginStatus = 'failed';
    entry.qr.emitter.emit('login-failed', msg);
    return;
  }

  try {
    const { jsessionId, keepalive } = await completeExpressLogin(entry);

    loggedInStore.markLoggedIn(entry.sessionId, {
      jar: entry.jar,
      http: entry.http,
      jsessionId,
      keepalive
    });

    entry.qr.loginStatus = 'success';
    stopQrLogin(entry);
    entry.qr.emitter.emit('login-success');
  } catch (err) {
    console.error('[sjtu qrLogin] expresslogin 失败:', err.message);
    entry.qr.loginStatus = 'failed';
    entry.qr.emitter.emit('login-failed', { message: err.message });
  }
}

async function fetchQrCodeImage(entry, { sig, ts }) {
  const uuid = entry.loginContext.uuid;
  const url = `${JACCOUNT_ORIGIN}/jaccount/qrcode?uuid=${encodeURIComponent(uuid)}&ts=${encodeURIComponent(
    ts
  )}&sig=${encodeURIComponent(sig)}`;

  const res = await entry.http.get(url, { responseType: 'arraybuffer' });
  if (res.status >= 400) {
    throw new Error(`获取二维码图片失败，状态码 ${res.status}`);
  }

  entry.qr.image = Buffer.from(res.data);
  entry.qr.contentType = res.headers['content-type'] || 'image/png';
  entry.qr.updatedAt = Date.now();
  entry.qr.emitter.emit('update');
}

function stopQrLogin(entry) {
  if (!entry.qr) return;

  if (entry.qr.interval) {
    clearInterval(entry.qr.interval);
    entry.qr.interval = null;
  }
  if (entry.qr.ws) {
    entry.qr.ws.terminate();
    entry.qr.ws = null;
  }
}

module.exports = { createQrState, startQrLogin, stopQrLogin };
