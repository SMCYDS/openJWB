const express = require('express');
const router = express.Router();

// NOTE: 登录校验逻辑暂未实现（占位）。
// 当前任何用户名/密码都会登录成功，仅用于打通 session 流程和前端页面跳转。
// 后续接入真实账号体系时，在这里替换为实际的校验逻辑。
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ ok: false, message: '请输入用户名和密码' });
  }

  req.session.user = { username };
  res.json({ ok: true, user: { username } });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/status', (req, res) => {
  if (req.session.user) {
    res.json({ ok: true, loggedIn: true, user: req.session.user });
  } else {
    res.json({ ok: true, loggedIn: false });
  }
});

module.exports = router;
