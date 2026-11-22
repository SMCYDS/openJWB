import { CookieBridge } from './cookie.js';
import jwbauth from './jwbauth.js';

// 教务系统 ElectSys (i.sjtu.edu.cn)：服务端 OAuth2 客户端，与 PE 同型。
// 入口 /jaccountlogin -> jaccount authorize(scope=essential，无 state)
// -> 302 http://i.sjtu.edu.cn/jaccountlogin?code=...（bridge 内自动升级为 https）
// -> 服务端换 code 建立会话，凭据为 JSESSIONID（HttpOnly）。
export class JWElect {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        this.clientId = 'MVJGw8u0bzoMJVbfb4Fk';
        this.jaAuthCookie = null;
        this.iSessionId = null;
    }

    setJAAuthCookie(cookie) {
        this.jaAuthCookie = cookie || null;
    }

    async requestJson(path, options) {
        const response = await this.bridge.request('i', path, options);
        const rawText = response.text();
        try {
            return JSON.parse(rawText);
        } catch (parseError) {
            const error = new Error(`${path} 返回内容无法解析为 JSON: ${parseError.message}`);
            error.details = {
                path,
                status: response.status ?? null,
                contentType: response.contentType || 'unknown',
                url: response.url || null,
                responsePreview: rawText.slice(0, 400)
            };
            // 未认证请求会被 302 到 /xtgl/login_slogin.html（HTML 页）
            if (response.status === 401 || /login_slogin/.test(response.url || '') || /text\/html/i.test(response.contentType || '')) {
                error.authInvalid = true;
            }
            throw error;
        }
    }

    async isLoggedIn() {
        const response = await this.bridge.request('i', '/xtgl/index_initMenu.html');
        // 未认证会被重定向到登录页
        return !/login_slogin/.test(response.url || '');
    }

    async login(jaAuthCookie = this.jaAuthCookie) {
        this.jaAuthCookie = await jwbauth.requireJAAuthCookie(jaAuthCookie);
        await jwbauth.oauth2Chain({ service: 'i', entry: '/jaccountlogin' });

        if (!(await this.isLoggedIn())) {
            const error = new Error('教务系统授权未完成：未取得有效会话（JAAuthCookie 可能已失效）');
            error.authInvalid = true;
            throw error;
        }
        const sessionId = await this.bridge.cookie('i', 'JSESSIONID');
        this.iSessionId = sessionId;
        return sessionId;
    }

    async withLoginRetry(operation) {
        if (!this.iSessionId || !(await this.isLoggedIn().catch(() => false))) await this.login();
        try {
            return await operation();
        } catch (error) {
            if (!error.authInvalid) throw error;
            this.iSessionId = null;
            await this.login();
            return operation();
        }
    }

    // 学生课表查询；xqm: '3'=秋季学期, '12'=春季学期, '16'=夏季学期
    async getSchedule(xnm = '2026', xqm = '3') {
        return this.withLoginRetry(() =>
            this.requestJson('/kbcx/xskbcx_cxXsKb.html', {
                params: { gnmkdm: 'N253508' },
                method: 'POST',
                bodyType: 'form',
                body: { xnm, xqm }
            }));
    }
}

export default new JWElect();
