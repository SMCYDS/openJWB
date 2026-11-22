# 附属插件

每个插件使用独立目录管理。主体只依赖 `public/js/addon-host.js` 通用加载器，
不静态导入任何插件，不包含插件页面、按钮事件、私有登录或业务逻辑。

安装插件时，将完整目录放入 `public/plugins/`，在 `public/misc/plugins.js` 注册：

```js
"example": {
    kind: "addon",
    entry: "/plugins/example/index.js",
    enabled: true,
    chinese: "示例插件"
}
```

刷新后，插件出现在基础模块下方的横线后。首次打开才动态导入入口；
`enabled: false` 时不导入插件、不发起插件登录或业务请求。
主体自身启用的基础模块仍按各自配置运行。

卸载时关闭配置或移走插件目录；彻底移除入口时删除对应配置项。
文件缺失或插件加载失败只显示插件局部错误，不阻止基础模块启动。
涉及后端 manifest 的安装、卸载需要重启服务以更新桥接白名单。

插件入口约定：

```js
export function mount({ root, auth, services, config }) {
    // root: 插件专属 section，只在该节点内部创建/查询 DOM。
    // auth.getJAAuthCookie(): 当前统一登录凭据。
    // auth.subscribe(listener): 登录变化通知，返回取消订阅函数。
    // services.canvas: 现有 Canvas 公共 API（含 login）。
    // services.live: 现有课堂直播公共 API。
    return {
        activate() { /* 页面打开时执行，可返回 Promise */ },
        dispose() { /* 停止任务、解除订阅和事件监听、释放资源 */ }
    };
}
```

允许插件调用基础模块的公开登录和业务接口，不复制它们的登录实现。
插件不能通过基础模块的 DOM、按钮 ID、页面启用状态或入口脚本私有变量完成调用。
基础模块也不能反向导入插件。

插件需要额外桥接站点时，在自身 `manifest.json` 的 `backend.upstreams`
声明 HTTPS SJTU origin 及明确允许读取的 Cookie 名称。服务端只读取声明，
不会导入插件代码；无插件目录时注册为空，非法声明或与基础服务重名的声明被跳过。
