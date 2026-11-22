import { CookieBridge } from './cookie.js';
import jwbauth from './jwbauth.js';

export class OCanvas {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        this.clientId = 'lACSIkmjF7lRHNKaVrIp';
        // Canvas 的 authorize URL 由服务端签发（state 为含 nonce 的 JWT，存于 _normandy_session），
        // 不能像 PE 那样直接请求 jaccount authorize，必须从 /login/openid_connect 进入整个跳转链。
        this.jaAuthCookie = null;
        this.user = null;
    }

    setJAAuthCookie(cookie) {
        this.jaAuthCookie = cookie || null;
    }

    async requestJson(path, options) {
        let response;
        try {
            response = await this.bridge.request('oc', path, options);
        } catch (error) {
            if (error.status === 401 || error.status === 403) error.authInvalid = true;
            throw error;
        }
        const rawText = typeof response.text === 'function' ? response.text() : '';
        try {
            return JSON.parse(rawText);
        } catch (parseError) {
            const error = new Error(`${path} 返回内容无法解析为 JSON: ${parseError.message}`);
            error.details = {
                path,
                status: response.status ?? null,
                contentType: response.contentType || 'unknown',
                responsePreview: rawText.slice(0, 400)
                    .replace(/("(?:access_token|refresh_token|token|session)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
            };
            if (response.status === 401) error.authInvalid = true;
            throw error;
        }
    }

    async login(jaAuthCookie = this.jaAuthCookie) {
        this.jaAuthCookie = await jwbauth.requireJAAuthCookie(jaAuthCookie);

        // /login/openid_connect -> jaccount authorize -> /login/oauth2/callback -> 首页，由 bridge 自动跟随
        await jwbauth.oauth2Chain({ service: 'oc', entry: '/login/openid_connect' });

        let me;
        try {
            me = await this.requestJson('/api/v1/users/self');
        } catch (error) {
            // 未登录时该接口返回 4xx（实测为 404/401），统一视为授权未完成
            const wrapped = new Error(`Canvas 授权未完成：未取得有效会话 (${error.message})`);
            wrapped.authInvalid = true;
            throw wrapped;
        }
        if (!me || typeof me !== 'object' || !me.id) {
            const error = new Error('Canvas 会话已建立，但 /api/v1/users/self 未返回用户信息');
            error.authInvalid = true;
            throw error;
        }
        this.user = me;
        return me;
    }

    async withLoginRetry(operation) {
        if (!this.user) await this.login();
        try {
            return await operation();
        } catch (error) {
            if (!error.authInvalid) throw error;
            this.user = null;
            await this.login();
            return operation();
        }
    }

    async getInfo() {
        return this.withLoginRetry(async () => {
            const [me, courses] = await Promise.all([
                this.requestJson('/api/v1/users/self'),
                this.requestJson('/api/v1/courses', { params: { per_page: 100 } })
            ]);
            return { profile: me, courses };
        });
    }
}

export default new OCanvas();
