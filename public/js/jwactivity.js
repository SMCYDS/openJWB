import { CookieBridge } from './cookie.js';
import jwbauth from './jwbauth.js';

// 校园活动平台 (activity.sjtu.edu.cn)：SPA + 前端换 token（与 make.sjtu.edu.cn 同型）。
// 链路：jaccount authorize -> 302 /auth?code=...（bridge 返回最终 URL 提取 code）
//       -> GET /api/v1/login/token?code=... -> data=token -> Authorization: Bearer <token>
// API 约定：HTTP 恒 200，业务码在 body.code（401=未登录）。
export class JWActivity {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        this.clientId = 'NMCTdJI6Tluw2SSTe6tW';
        this.redirectUri = 'https://activity.sjtu.edu.cn/auth';
        this.jaAuthCookie = null;
        this.token = null;
        this.user = null;
    }

    setJAAuthCookie(cookie) {
        this.jaAuthCookie = cookie || null;
    }

    async requestJson(path, options = {}) {
        const { noAuth, ...rest } = options;
        const headers = { ...(rest.headers || {}) };
        if (this.token && !noAuth) headers.Authorization = `Bearer ${this.token}`;
        let response;
        try {
            response = await this.bridge.request('activity', path, { ...rest, headers });
        } catch (error) {
            if (error.status === 401 || error.status === 403) error.authInvalid = true;
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
            };
            throw error;
        }
        if (result && typeof result === 'object' && 'code' in result && Number(result.code) !== 200) {
            const error = new Error(`${path} 返回错误 [code: ${result.code}]: ${result.message || '未知错误'}`);
            error.apiCode = Number(result.code);
            if (error.apiCode === 401 || error.apiCode === 403) error.authInvalid = true;
            throw error;
        }
        return result;
    }

    async login(jaAuthCookie = this.jaAuthCookie) {
        this.jaAuthCookie = await jwbauth.requireJAAuthCookie(jaAuthCookie);
        const response = await jwbauth.oauth2Chain({
            clientId: this.clientId,
            redirectUri: this.redirectUri,
            scope: 'profile'
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

        const tokenResult = await this.requestJson('/api/v1/login/token', {
            params: { code },
            noAuth: true
        });
        if (!tokenResult?.data) {
            throw new Error(`/api/v1/login/token 未返回 token: ${JSON.stringify(tokenResult).slice(0, 300)}`);
        }
        this.token = tokenResult.data;

        const profile = await this.requestJson('/api/v1/profile');
        this.user = profile?.data || null;
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

    async getHotList(activityTypeId = 1, fill = 1) {
        return this.withLoginRetry(async () => {
            const result = await this.requestJson('/api/v1/hot/list', {
                params: { activity_type_id: activityTypeId, fill }
            });
            return result?.data ?? result;
        });
    }

    async getHomeActivities({ page = 1, perPage = 20, activityTypeId = 1, timeSort = 'desc', canApplyWithQuota = false } = {}) {
        return this.withLoginRetry(async () => {
            const result = await this.requestJson('/api/v1/activity/list/home', {
                params: {
                    page,
                    per_page: perPage,
                    activity_type_id: activityTypeId,
                    time_sort: timeSort,
                    can_apply_with_quota: canApplyWithQuota ? 'true' : 'false'
                }
            });
            return result?.data ?? result;
        });
    }
}

export default new JWActivity();
