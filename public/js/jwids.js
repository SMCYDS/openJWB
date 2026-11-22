import { CookieBridge } from './cookie.js';
import jwbauth from './jwbauth.js';

// 教学楼信息 (ids.sjtu.edu.cn)：服务端 OAuth2 客户端。
// 入口 /oauthClient/userLogin -> jaccount authorize -> http://ids.sjtu.edu.cn/oauthClient/callbackCode
// （bridge 内自动升级 https）-> JSESSIONID 会话。
// API 约定：HTTP 200 + {code, msg, data}，code===200 为成功；部分查询接口匿名也可用。
export class JWIds {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        this.clientId = 'pmZTZ9QZEAwXGLGheU99';
        this.jaAuthCookie = null;
        this.idsSessionId = null;
        this.userName = null;
        // 教学楼名称 -> buildId
        this.buildings = {
            '东下院': 124,
            '东中院': 564,
            '东上院': 122,
            '上院': 126,
            '中院': 128,
            '下院': 127
        };
    }

    setJAAuthCookie(cookie) {
        this.jaAuthCookie = cookie || null;
    }

    // 入参允许中文楼名或数字 buildId，统一翻译为 buildId
    resolveBuildId(build) {
        if (typeof build === 'number' && Number.isFinite(build)) return build;
        const text = String(build ?? '').trim();
        if (/^\d+$/.test(text)) return Number(text);
        const id = this.buildings[text];
        if (id === undefined) {
            throw new Error(`未知教学楼: ${build}（可选：${Object.keys(this.buildings).join('、')}）`);
        }
        return id;
    }

    async requestJson(path, options) {
        const response = await this.bridge.request('ids', path, options);
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
            if (response.status === 401 || /text\/html/i.test(response.contentType || '')) {
                error.authInvalid = true;
            }
            throw error;
        }
        if (result && typeof result === 'object' && 'code' in result && Number(result.code) !== 200) {
            const error = new Error(`${path} 返回错误 [code: ${result.code}]: ${result.msg || '未知错误'}`);
            error.apiCode = Number(result.code);
            if (error.apiCode === 401 || error.apiCode === 403) error.authInvalid = true;
            throw error;
        }
        return result;
    }

    // /sysUser/isSign：已登录返回 {code:200,data:{isSignFlag:true,...}}；
    // 匿名会被过滤器 302 回首页（最终拿到 HTML）
    async isLoggedIn() {
        const response = await this.bridge.request('ids', '/sysUser/isSign');
        if (!/json/i.test(response.contentType || '')) return false;
        const result = JSON.parse(response.text());
        const data = result?.data;
        if (Number(result?.code) === 200 && data && data.isSignFlag) {
            this.userName = data.userName || data.name || null;
            return true;
        }
        return false;
    }

    async login(jaAuthCookie = this.jaAuthCookie) {
        this.jaAuthCookie = await jwbauth.requireJAAuthCookie(jaAuthCookie);
        const response = await jwbauth.oauth2Chain({ service: 'ids', entry: '/oauthClient/userLogin' });
        const finalUrl = response.url || '';

        // 授权未完成：被弹回 jAccount 登录页
        if (/^https?:\/\/jaccount\.sjtu\.edu\.cn\//.test(finalUrl)) {
            const error = new Error('JAAuthCookie 已失效，请重新扫码登录后再试');
            error.authInvalid = true;
            error.jaAuthExpired = true;
            throw error;
        }

        // ids 是 Tomcat：无 Cookie 时用 URL 重写传递会话（;jsessionid=），
        // 已认证会话可能只在落地 URL 里而不在 Cookie jar 中，需要补回
        const rewritten = finalUrl.match(/;jsessionid=([0-9A-Fa-f]+)/)?.[1];
        if (rewritten) await this.bridge.setCookie('ids', 'JSESSIONID', rewritten);

        if (!(await this.isLoggedIn())) {
            const error = new Error(`教学楼信息系统授权未完成：未取得有效会话（落地于 ${finalUrl || '未知地址'}）`);
            error.authInvalid = true;
            throw error;
        }
        this.idsSessionId = await this.bridge.cookie('ids', 'JSESSIONID');
        return this.idsSessionId;
    }

    async withLoginRetry(operation) {
        if (!this.idsSessionId) await this.login();
        try {
            return await operation();
        } catch (error) {
            if (!error.authInvalid) throw error;
            this.idsSessionId = null;
            await this.login();
            return operation();
        }
    }

    // 查询教学楼课表信息；courseDate 格式 'yyyy-MM-dd'，默认今天
    async getBuildRoomSchedule(build, courseDate) {
        const buildId = this.resolveBuildId(build);
        if (!courseDate) courseDate = new Date().toLocaleDateString('sv-SE');
        return this.withLoginRetry(async () => {
            const result = await this.requestJson('/build/findBuildRoomType', {
                method: 'POST',
                bodyType: 'form',
                body: { buildId: String(buildId), courseDate }
            });
            return result?.data ?? result;
        });
    }

    // 查询教学楼实时使用信息
    async getSchoolCourseInfo(build) {
        const buildId = this.resolveBuildId(build);
        return this.withLoginRetry(async () => {
            const result = await this.requestJson('/classroomUse/findSchoolCourseInfo', {
                method: 'POST',
                bodyType: 'form',
                body: { buildId: String(buildId) }
            });
            return result?.data ?? result;
        });
    }
}

export default new JWIds();
