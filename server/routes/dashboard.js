const express = require('express');
const router = express.Router();

const mySjtuLoggedInStore = require('../services/mySjtu/loggedInStore');

// 登录态校验中间件：本地占位登录（auth.js 设置的 req.session.user）
// 或者真实的 jaccount 扫码登录（存在"登录后运作模块"里），任一满足即可。
// 占位登录以后接入真实账号体系时会被替换/移除。
function requireLogin(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  if (mySjtuLoggedInStore.isLoggedIn(req.sessionID)) {
    return next();
  }
  res.status(401).json({ ok: false, message: '未登录' });
}

// TODO: 替换为真实数据源（学校网络服务接口/抓包解析结果）
router.get('/summary', requireLogin, (req, res) => {
  res.json({
    ok: true,
    data: {
      updatedAt: new Date().toISOString(),
      metrics: [
        { label: '示例指标 A', value: 0 },
        { label: '示例指标 B', value: 0 },
        { label: '示例指标 C', value: 0 }
      ]
    }
  });
});

module.exports = router;
