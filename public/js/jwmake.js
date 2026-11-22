import { CookieBridge } from './cookie.js';
import jwbauth from './jwbauth.js';

// 学创加工服务平台 (make.sjtu.edu.cn)：SvelteKit SPA，jAccount 授权码由前端换取自家 Bearer token。
// 链路：jaccount authorize -> 302 /user/authorize?code=...（bridge 返回最终 URL 供提取 code）
//       -> POST /api/user/login {code, redirect_uri} -> result.token -> Authorization: Bearer <token>
export class JWMake {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        this.clientId = '0CMsvKl2dIuvFs4Rx348';
        this.redirectUri = 'https://make.sjtu.edu.cn/user/authorize';
        this.jaAuthCookie = null;
        this.token = null;
        this.user = null;
    }

    setJAAuthCookie(cookie) {
        this.jaAuthCookie = cookie || null;
    }

    async requestJson(path, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        let response;
        try {
            response = await this.bridge.request('make', path, { ...options, headers });
        } catch (error) {
            if (error.status === 401 || error.status === 403) error.authInvalid = true;
            try {
                const body = JSON.parse(error.body || '');
                if (body.message) error.message = `${path} 失败 (${error.status}): ${body.message}`;
            } catch { /* 非 JSON 响应体 */ }
            throw error;
        }
        const rawText = response.text();
        let result;
        try {
            result = JSON.parse(rawText);
        } catch (parseError) {
            const error = new Error(`${path} 返回内容无法解析为 JSON: ${parseError.message}`);
            error.details = {
                path,
                status: response.status ?? null,
                contentType: response.contentType || 'unknown',
                responsePreview: rawText.slice(0, 400)
                    .replace(/("(?:token|access_token|refresh_token)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
            };
            throw error;
        }
        if (result && result.error) {
            const error = new Error(`${path} 返回错误: ${result.message || result.error}`);
            error.apiError = result.error;
            throw error;
        }
        return result;
    }

    async login(jaAuthCookie = this.jaAuthCookie) {
        this.jaAuthCookie = await jwbauth.requireJAAuthCookie(jaAuthCookie);

        const response = await jwbauth.oauth2Chain({
            clientId: this.clientId,
            redirectUri: this.redirectUri
        });

        let code = null;
        try {
            code = new URL(response.url).searchParams.get('code');
        } catch { /* 最终 URL 无法解析 */ }
        if (!code) {
            const error = new Error('授权未完成：回调中未取得 code（JAAuthCookie 可能已失效）');
            error.authInvalid = true;
            throw error;
        }

        const loginResult = await this.requestJson('/api/user/login', {
            method: 'POST',
            bodyType: 'json',
            body: { code, redirect_uri: this.redirectUri },
            headers: { 'Content-Type': 'application/json' }
        });
        const token = loginResult?.result?.token;
        if (!token) {
            throw new Error(`/api/user/login 未返回 token: ${JSON.stringify(loginResult).slice(0, 300)}`);
        }
        this.token = token;

        const info = await this.requestJson('/api/user/info');
        this.user = info?.result?.user_info || info?.result || null;
        return { token: this.token, user: this.user };
    }

    async withLoginRetry(operation) {
        if (!this.token) await this.login();
        try {
            return await operation();
        } catch (error) {
            if (!error.authInvalid) throw error;
            this.token = null;
            this.user = null;
            await this.login();
            return operation();
        }
    }

    async getInfo() {
        return this.withLoginRetry(async () => {
            const info = await this.requestJson('/api/user/info');
            return info?.result ?? info;
        });
    }

    async queryOrder(processType = 'thdprint', page = 1, pageSize = 10) {
        return this.withLoginRetry(async () => {
            const result = await this.requestJson('/api/order/orders', {
                params: { current_page: page, page_size: pageSize, process_type: processType }
            });
            return result?.result ?? result;
        });
    }
}

export default new JWMake();
