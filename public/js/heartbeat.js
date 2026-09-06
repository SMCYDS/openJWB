// 页面存活心跳：只要本文件被加载（页面开着），就定时通知后端"我还活着"。
// 注意：没有用 pagehide/beforeunload 去主动触发关闭，因为站内跳转
// （比如登录页 -> 看板页）也会触发这些事件，会导致刚登录完服务就被关掉。
// 所以关闭时机完全交给后端的心跳超时机制判断（见 server.js）。
(function () {
  const HEARTBEAT_INTERVAL_MS = 5000;

  function sendHeartbeat() {
    fetch('/api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {});
  }

  sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
})();
