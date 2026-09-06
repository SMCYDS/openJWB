const express = require('express');
const router = express.Router();

const { fetchLoginContext } = require('../services/sjtu/loginContext');
const { startQrLogin } = require('../services/sjtu/qrLogin');
const sjtuSessionStore = require('../services/sjtu/sessionStore');
const mySjtuLoggedInStore = require('../services/mySjtu/loggedInStore');

// 第一步：走完 my.sjtu.edu.cn -> oauth2/authorize -> jalogin 的跳转链路，
// 拿到 loginContext 并存到（按我们自己的 session 区分的）内存里，
// 后续"提交账号密码"步骤会复用这里存的 http 客户端（带着同一份 cookie）。
router.post('/login/start', async (req, res) => {
  try {
    // express-session 配置了 saveUninitialized: false，如果这个 session
    // 从没被写过东西，就不会给浏览器下发 Set-Cookie，下一次请求 sessionID
    // 会变，导致后面"提交密码"步骤找不到这里存的登录会话。这里主动写一个
    // 标记字段，强制这个 session 落地并保持同一个 sessionID。
    req.session.sjtuLoginStarted = true;

    const entry = sjtuSessionStore.createEntry(req.sessionID);
    const { loginContext } = await fetchLoginContext(entry.http);

    entry.loginContext = loginContext;

    // client / returl / se 是后续提交密码要用到的敏感参数，只留在后端，
    // 不返回给前端；前端只需要知道流程走到哪一步、以及展示用的字段。
    res.json({
      ok: true,
      loginType: loginContext.loginType,
      sid: loginContext.sid,
      uuid: loginContext.uuid
    });
  } catch (err) {
    console.error('[sjtuAuth] login/start failed:', err.message);
    sjtuSessionStore.deleteEntry(req.sessionID);
    res.status(502).json({ ok: false, message: '获取 jaccount 登录信息失败，请稍后重试' });
  }
});

// 第二步：基于 /login/start 拿到的 uuid，连接二维码 websocket 并开始轮询刷新。
// 这个接口本身不等二维码下载完再返回，图片走 /login/qrcode/image 拿，
// 有没有更新走 /login/qrcode/stream (SSE) 通知前端。
router.post('/login/qrcode/start', async (req, res) => {
  const entry = sjtuSessionStore.getEntry(req.sessionID);
  if (!entry || !entry.loginContext) {
    return res.status(400).json({ ok: false, message: '请先调用 /api/sjtu/login/start' });
  }

  try {
    await startQrLogin(entry);
    res.json({ ok: true });
  } catch (err) {
    console.error('[sjtuAuth] login/qrcode/start failed:', err.message);
    res.status(502).json({ ok: false, message: '连接二维码服务失败，请稍后重试' });
  }
});

// 返回当前缓存的二维码图片（最新一次通过 websocket 刷新拿到的）
router.get('/login/qrcode/image', (req, res) => {
  const entry = sjtuSessionStore.getEntry(req.sessionID);
  if (!entry || !entry.qr || !entry.qr.image) {
    return res.status(404).json({ ok: false, message: '二维码还没准备好，请稍后重试' });
  }

  res.set('Content-Type', entry.qr.contentType || 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(entry.qr.image);
});

// 二维码刷新事件推送（SSE）：每次后端通过 websocket 拿到新二维码，
// 就给前端发一个 update 事件，前端收到后重新请求 /login/qrcode/image。
router.get('/login/qrcode/stream', (req, res) => {
  const entry = sjtuSessionStore.getEntry(req.sessionID);
  if (!entry) {
    return res.status(400).json({ ok: false, message: '请先调用 /api/sjtu/login/start' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  const sendUpdate = () => {
    res.write(`event: update\ndata: ${JSON.stringify({ updatedAt: entry.qr.updatedAt })}\n\n`);
  };
  const sendLoginSuccess = () => {
    res.write(`event: login-success\ndata: {}\n\n`);
  };
  const sendLoginFailed = (msg) => {
    res.write(`event: login-failed\ndata: ${JSON.stringify(msg || {})}\n\n`);
  };

  // 如果已经有二维码了，先推一次，避免前端刚连上时空等一分钟
  if (entry.qr.image) {
    sendUpdate();
  }

  entry.qr.emitter.on('update', sendUpdate);
  entry.qr.emitter.on('login-success', sendLoginSuccess);
  entry.qr.emitter.on('login-failed', sendLoginFailed);

  req.on('close', () => {
    entry.qr.emitter.off('update', sendUpdate);
    entry.qr.emitter.off('login-success', sendLoginSuccess);
    entry.qr.emitter.off('login-failed', sendLoginFailed);
  });
});

// 查询"登录后运作模块"里是否已经有这个后端 session 对应的 my.sjtu.edu.cn 登录态
router.get('/status', (req, res) => {
  const session = mySjtuLoggedInStore.getSession(req.sessionID);
  res.json({
    ok: true,
    loggedIn: session !== null,
    loggedInAt: session ? session.loggedInAt : null
  });
});

module.exports = router;
