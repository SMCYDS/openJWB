# openJWB 数据看板（脚手架）

## 目录结构

```
openJWB/
├─ server/              # Node.js + Express 后端
│  ├─ server.js         # 入口，静态资源托管 + session 中间件
│  ├─ routes/
│  │  ├─ auth.js        # 登录/登出/登录状态接口（校验逻辑待接入，当前任意账号密码可登录）
│  │  └─ dashboard.js   # 看板数据接口（当前返回 mock 数据）
│  ├─ .env              # 本地环境变量（已加入 .gitignore，不要提交）
│  └─ .env.example
└─ public/               # 纯 HTML+CSS+原生JS 前端
   ├─ index.html         # 登录页
   ├─ dashboard.html     # 看板页
   ├─ css/style.css
   └─ js/
      ├─ heartbeat.js    # 页面存活心跳（用于自动关闭后端，见下文）
      ├─ main.js         # 登录页逻辑
      └─ dashboard.js    # 看板页逻辑
```

## 运行

### 方式一：一键启动（推荐，分享给别人用）

直接双击根目录下的 `start.bat`：
- 自动检测本机是否有 Node.js，没有则尝试用 `winget` 自动安装（没有 winget 会提示手动安装并给出下载地址）
- 自动执行 `npm install`（仅首次运行需要联网下载依赖）
- 自动启动服务并打开浏览器访问 http://localhost:18960（端口取自 `.env` 里的 `PORT`）

把整个 `openJWB` 文件夹拷给别人，双击 `start.bat` 即可，无需手动操作命令行。

### 方式二：手动启动

```bash
cd server
npm install
npm start
```

打开 http://localhost:18960 即可看到登录页，任意用户名密码可登录进入看板页。

## 后端何时会关闭

后端是独立的 Node.js 进程，和浏览器标签页没有直接关联，默认情况下只有以下几种方式会关闭：
- 关掉 `start.bat` 弹出的命令行窗口，或在里面按 `Ctrl+C`
- 进程本身崩溃

为了实现"关掉浏览器页面后自动关掉后端"，加了一个**心跳机制**：
- 前端页面（登录页/看板页都引入了 `js/heartbeat.js`）每 5 秒向后端发一次 `POST /api/heartbeat`
- 后端每 5 秒检查一次，如果连续 15 秒没收到任何心跳（也就是所有打开的标签页都关掉了、刷新导致的短暂间隔不会触发），就会自动调用 `process.exit(0)` 退出
- 只要还有一个标签页/窗口开着并保持心跳，后端就不会关闭；多开几个标签页也没问题，任意一个在发心跳都算活着

注意事项：
- 没有用 `beforeunload`/`pagehide` 做"立即关闭"，因为站内跳转（登录页 → 看板页）也会触发这些事件，会导致刚登录完后端就被误杀，所以关闭时机统一交给心跳超时判断，代价是关闭会有最多 15 秒左右的延迟
- 如需调整这个延迟，改 `server/server.js` 里的 `HEARTBEAT_TIMEOUT_MS`（同时把 `public/js/heartbeat.js` 里的 `HEARTBEAT_INTERVAL_MS` 保持在超时时间的 1/3 左右比较稳妥）

## 后续要做的事

- `routes/auth.js`：接入真实的账号校验逻辑
- `routes/dashboard.js`：接入真实数据源（学校网络服务接口/抓包解析结果），替换 mock 数据
- 部署到内网/公网前，记得在 `server.js` 里给 session cookie 开启 `secure: true`（需要 HTTPS），并根据实际跨域需求配置 CORS
