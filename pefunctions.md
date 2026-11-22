# 交大体育系统 (pe.sjtu.edu.cn) JS 模块封装开发指南

本文档旨在指导如何参照已有的 `jwblogin.js` 模块规范，将交大体育系统（上海交通大学学生体质健康与体育管理系统）的认证与核心功能封装为一个独立的 JavaScript 模块（如 `jwbpe.js`），支持通过 `JWBPE.login()`、`JWBPE.getInfo()`、`JWBPE.getPointRule()` 等进行简洁调用。

---

## 1. 架构与依赖设计

### 1.1 依赖关系
* **`cookie.js` 中的 `CookieBridge`**：
  负责跨域 HTTP 请求及 Cookie 管理（支持在各子域下设置 Cookie、获取 Cookie 以及带 Cookie 请求接口）。
* **`jwblogin.js` 中的 `JWBAuth`**：
  负责交我办/jAccount 的初始扫码或密码登录，登录成功后会产出全局单点登录凭据 `JAAuthCookie`。

### 1.2 模块导出与单例风格
参考 `jwblogin.js`，定义 `JWBPE` 类，并在文件末尾导出单例：
```javascript
export class JWBPE {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        // 缓存当前会话状态
        this.peSessionId = null;
        this.currentUid = null;
    }
    // ...各功能方法
}

export default new JWBPE();
```

---

## 2. 核心业务流程与接口规范

### 2.1 登录流程与会话建立 (`login()`)

体育系统本身不直接提供账号密码输入框，而是依托 jAccount OAuth 2.0 静默换票。

#### 关键参数
* **OAuth 授权端点**：
  `https://jaccount.sjtu.edu.cn/oauth2/authorize?response_type=code&scope=profile&client_id=9mqzULSXYgUYj5fPOpyL&state=8&redirect_uri=https://pe.sjtu.edu.cn/oauth2Login`
* **Client ID**：`9mqzULSXYgUYj5fPOpyL`（第一方免授权确认的受信 Client）
* **前提条件**：已通过 `jwblogin.js` 获得有效 `JAAuthCookie`（存放在 `.sjtu.edu.cn` 域）。

#### 流程步骤
1. 确认已注入 `JAAuthCookie`。
2. 使用标准浏览器 User-Agent 请求授权端点，跟随 302 重定向：
   * `jaccount.sjtu.edu.cn/oauth2/authorize`
   * $\to$ `pe.sjtu.edu.cn/oauth2Login?code=...`
   * $\to$ `pe.sjtu.edu.cn/phone/`
3. 提取并保存 `pe.sjtu.edu.cn` 域下的 `JSESSIONID`。
4. 后续所有请求均基于该 `JSESSIONID`。

---

### 2.2 学生档案与跑步数据获取 (`getInfo()`)

成功获取 `JSESSIONID` 后，通过并发调用体育系统 Web 内部接口，聚合为完整的学生体测与长跑档案。

| 接口地址 | 请求方式 | 作用说明 | 关键返回字段 |
| :--- | :--- | :--- | :--- |
| `/sports/my/user` | `GET` | 学生基本个人信息 | `studentNo` (学号), `name` (姓名), `deptName` (学院), `userAccount` (账号) |
| `/sports/my/data` | `GET` | 学期跑步达标汇总 | `totalKm` (总里程), `resultKm` (有效打卡里程), `percent` (完成率%) |
| `/sports/my/semesterTarget` | `GET` | 本学期考核要求 | `target` (学期目标公里数，如 `80`) |
| `/sports/my/run/data` | `GET` | 今日跑步数据 | `today` (今日已跑公里数) |

---

### 2.3 跑步打卡点与规则获取 (`getPointRule(location)`)

该接口是**交我办 App 原生跑步模块**所调用的底层接口，存在特殊的鉴权链条，必须严格按顺序处理。

#### ⚠️ 关键防坑机制：动态 UID 换取机制
如果直接调用 `/api/running/point-rule`，即使携带了有效的 `JSESSIONID`，服务端依然会返回如下错误：
```json
{
  "code": 1003,
  "msg": "暂未识别到您的身份信息，请尝试重新进入跑步页面 ~>_<~"
}
```
**原因**：
1. 错误信息中的“请重新进入跑步页面”，是指 App 进入跑步主界面时，会隐式调用一次：
   ```http
   GET https://pe.sjtu.edu.cn/sports/my/uid
   ```
2. 服务端收到请求后，会在当前的 Shiro Session 会话中**动态生成并绑定一个 32 位十六进制 Token**，并返回在 `data.uid` 中。
3. 随后调用 `/api/running/point-rule` 时，**必须在请求头的 `Authorization` 中传入该动态 `uid`**，服务端才会放行。

#### 接口详情
1. **第一步：换取动态 Token**
   * 请求：`GET https://pe.sjtu.edu.cn/sports/my/uid`
   * 提取响应：`res.data.uid`（32 位字符串，如 `bcdecd63975b4eb3b4265969d53d8cfe`）。
2. **第二步：请求打卡点与规则**
   * 请求：`GET https://pe.sjtu.edu.cn/api/running/point-rule`
   * 查询参数：`location`（例如：`"121.42800347222222,31.024470757378474"`）
   * **必备请求头**：
     * `Authorization`: 第一步返回的动态 `uid`
     * `User-Agent`: `TaskCenterApp/3.6.4/iPhone 17/ScreenFringe (iOS,iPhone,26.5.2; Scale/3.0)`
     * `Accept-Language`: `zh`
3. **返回数据结构**：
   * `points`: 坐标点数组。每个元素含 `location`（经纬度）与 `isneed`（`"Y"` 为必经点，`"N"` 为选经点）。
   * `rules`: 配速与跑步规则：
     * `dtlimit`: 单日最大计入里程（通常为 4 km）
     * `simin`: 单次起跑最低计入里程（通常为 1 km）
     * `rtmin` / `rtmax`: 实时配速窗口（秒/公里，如 180~540 对应 3分00秒~9分00秒）
     * `spmin` / `spmax`: 平均配速窗口（秒/公里）
     * `lduration`: 最低跑步有效持续时间（秒）
     * `tquantum`: 有效打卡时间段（例如 `"00:00 - 23:59"`）

---

## 3. 完整 JavaScript 模块参考实现 (`jwbpe.js`)

以下是完整可用的模块代码蓝图，代理 Agent 可直接参考或集成：

```javascript
/**
 * jwbpe.js - 交大体育系统 (pe.sjtu.edu.cn) 功能模块
 * 支持学生档案查询、跑步进度汇总及打卡点位规则获取
 */
import { CookieBridge } from './cookie.js';

export class JWBPE {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        this.clientId = '9mqzULSXYgUYj5fPOpyL';
        this.authUrl = `https://jaccount.sjtu.edu.cn/oauth2/authorize?response_type=code&scope=profile&client_id=${this.clientId}&state=8&redirect_uri=https://pe.sjtu.edu.cn/oauth2Login`;
        this.defaultLocation = '121.42800347222222,31.024470757378474';
    }

    /**
     * 1. 执行 OAuth2 静默授权登录，建立体育系统会话
     * @param {string} [jaAuthCookie] 可选。若未传入则尝试从 bridge 中读取已有的 JAAuthCookie
     * @returns {Promise<string>} 成功建立的 pe.sjtu.edu.cn JSESSIONID
     */
    async login(jaAuthCookie = null) {
        // 如果未显式传参，从 cookie 桥接器中获取全局登录票据
        const authCookie = jaAuthCookie ||
                           (await this.bridge.cookie('jaccount', 'JAAuthCookie')) ||
                           (await this.bridge.cookie('my', 'JAAuthCookie'));

        if (!authCookie) {
            throw new Error('未检测到有效的 JAAuthCookie，请先完成 jAccount 登录');
        }

        // 确保 .sjtu.edu.cn 域下具有该票据
        await this.bridge.setCookie?.('.sjtu.edu.cn', 'JAAuthCookie', authCookie);

        // 携带标准桌面浏览器 UA 发起授权，跟随重定向完成换票
        const authResp = await this.bridge.request('jaccount', this.authUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            followRedirect: true
        });

        // 提取体育系统专属的 JSESSIONID
        const peSessionId = await this.bridge.cookie('pe', 'JSESSIONID');
        if (!peSessionId) {
            throw new Error('授权重定向完成，但未在 pe.sjtu.edu.cn 域获取到 JSESSIONID');
        }

        return peSessionId;
    }

    /**
     * 2. 获取学生档案与本学期长跑综合进度
     * @returns {Promise<Object>} 结构化的学生与运动数据
     */
    async getInfo() {
        // 并行拉取基本档案、累计数据、学期目标、今日数据
        const [userResp, dataResp, targetResp, todayResp] = await Promise.all([
            this.bridge.request('pe', '/sports/my/user'),
            this.bridge.request('pe', '/sports/my/data'),
            this.bridge.request('pe', '/sports/my/semesterTarget'),
            this.bridge.request('pe', '/sports/my/run/data')
        ]);

        const userJson = typeof userResp.json === 'function' ? await userResp.json() : userResp;
        const dataJson = typeof dataResp.json === 'function' ? await dataResp.json() : dataResp;
        const targetJson = typeof targetResp.json === 'function' ? await targetResp.json() : targetResp;
        const todayJson = typeof todayResp.json === 'function' ? await todayResp.json() : todayResp;

        const profile = userJson?.data?.[0] || {};
        const runData = dataJson?.data?.[0] || {};

        return {
            student: {
                name: profile.name || '',
                studentNo: profile.studentNo || '',
                deptName: profile.deptName || '',
                userAccount: profile.userAccount || '',
                avatar: profile.avatar || ''
            },
            running: {
                totalKm: parseFloat(runData.totalKm || '0'),
                validKm: parseFloat(runData.resultKm || '0'),
                percent: parseFloat(runData.percent || '0'),
                targetKm: parseFloat(targetJson?.data?.target || '0'),
                todayKm: parseFloat(todayJson?.data?.today || '0')
            }
        };
    }

    /**
     * 3. 获取打卡点位与跑步判定规则
     * @param {string} [location] GPS经纬度字符串，默认使用交大闵行坐标
     * @returns {Promise<{points: Array, rules: Object}>}
     */
    async getPointRule(location = this.defaultLocation) {
        // 关键步骤 1：必须先调用 /sports/my/uid 获取当前会话绑定的动态 Authorization UID
        const uidResp = await this.bridge.request('pe', '/sports/my/uid');
        const uidJson = typeof uidResp.json === 'function' ? await uidResp.json() : uidResp;
        const dynamicToken = uidJson?.data?.uid;

        if (!dynamicToken) {
            throw new Error(`获取动态 Authorization 失败: ${JSON.stringify(uidJson)}`);
        }

        // 关键步骤 2：伪装 App 客户端发起打卡点与规则查询
        const ruleResp = await this.bridge.request('pe', '/api/running/point-rule', {
            params: { location },
            headers: {
                'User-Agent': 'TaskCenterApp/3.6.4/iPhone 17/ScreenFringe (iOS,iPhone,26.5.2; Scale/3.0)',
                'Cache-Control': 'no-cache',
                'Accept-Language': 'zh',
                'Authorization': dynamicToken
            }
        });

        const ruleJson = typeof ruleResp.json === 'function' ? await ruleResp.json() : ruleResp;
        if (ruleJson.code !== 0) {
            throw new Error(`获取点位规则失败 [code: ${ruleJson.code}]: ${ruleJson.msg}`);
        }

        return ruleJson.data;
    }
}

// 导出单例实例
export default new JWBPE();
```

---

## 4. 上层调用范例

在业务代码或 UI 界面中，配合 `jwblogin.js` 串联调用：

```javascript
import JWBAuth from './jwblogin.js';
import JWBPE from './jwbpe.js';

// 监听扫码登录成功事件
JWBAuth.onLoginSuccess(async (myToken, jaAuthCookie) => {
    console.log('jAccount 登录成功，正在换取体育系统权限...');

    // 1. 登录体育系统
    const peSessionId = await JWBPE.login(jaAuthCookie);
    console.log('体育系统登录成功, Session:', peSessionId);

    // 2. 获取体测与跑步数据
    const info = await JWBPE.getInfo();
    console.log(`欢迎 ${info.student.name} (${info.student.studentNo})`);
    console.log(`当前累计跑量: ${info.running.totalKm} km / 目标: ${info.running.targetKm} km (${info.running.percent}%)`);

    // 3. 获取实时打卡点与配速规则
    const pointRule = await JWBPE.getPointRule('121.42800347222222,31.024470757378474');
    console.log('当前点位数量:', pointRule.points.length);
    console.log('配速窗口 (秒/km):', pointRule.rules.rtmin, '至', pointRule.rules.rtmax);
});

// 初始化扫码流程
JWBAuth.initLogin('qrcode', (qrUrl) => {
    // 渲染二维码供用户扫码
    document.getElementById('qr-img').src = qrUrl;
});
```
