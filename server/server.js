require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const sjtuAuthRoutes = require('./routes/sjtuAuth');
const requestSendRoutes = require('./routes/requestSend');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // secure: true, // 部署到 HTTPS 环境后再开启
      maxAge: 1000 * 60 * 60 * 8 // 8 小时
    }
  })
);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/sjtu', sjtuAuthRoutes);
app.use('/api/request', requestSendRoutes);

// --- 前端页面关闭后自动退出后端 ---
// 前端每隔 HEARTBEAT_INTERVAL_MS 调用一次 /api/heartbeat；
// 如果超过 HEARTBEAT_TIMEOUT_MS 都没收到心跳（说明所有页面都已关闭），就退出进程。
// 只要还有一个标签页开着并保持心跳，服务就不会关闭。
const HEARTBEAT_TIMEOUT_MS = 15000;
let lastHeartbeat = Date.now();

app.post('/api/heartbeat', (req, res) => {
  lastHeartbeat = Date.now();
  res.sendStatus(204);
});

setInterval(() => {
  if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
    console.log('openJWB: 长时间未收到前端心跳，正在退出服务...');
    process.exit(0);
  }
}, 5000);

app.listen(PORT, () => {
  console.log(`openJWB server running at http://localhost:${PORT}`);
});
