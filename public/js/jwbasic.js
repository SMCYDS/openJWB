import { CookieBridge } from './cookie.js';
import jwbauth from './jwbauth.js';

// 交我办基础服务：承载 calendar.sjtu.edu.cn（校历/日程）等服务端 OAuth2 站点的请求。
// 登录与 PE 同型：/login -> jaccount authorize -> /login?code&state 由服务端完成换票，
// 会话凭据为 calendar 域的 JSESSIONID（HttpOnly），另需 PORTAL_LOCALE=zh。
export class JWBasic {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        this.jaAuthCookie = null;
        this.calSessionId = null;
    }

    setJAAuthCookie(cookie) {
        this.jaAuthCookie = cookie || null;
    }

    async requestJson(path, options) {
        const response = await this.bridge.request('calendar', path, options);
        const rawText = response.text();
        try {
            return JSON.parse(rawText);
        } catch (parseError) {
            // 未登录时 API 会 302 进 SSO 重登录链，JAAuthCookie 失效则最终落在 jalogin HTML 页
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
    }

    async login(jaAuthCookie = this.jaAuthCookie) {
        this.jaAuthCookie = await jwbauth.requireJAAuthCookie(jaAuthCookie);
        await this.bridge.setCookie('calendar', 'PORTAL_LOCALE', 'zh');

        await jwbauth.oauth2Chain({ service: 'calendar', entry: '/login' });

        const calSessionId = await this.bridge.cookie('calendar', 'JSESSIONID');
        if (!calSessionId) {
            const error = new Error('授权未完成：未取得 calendar.sjtu.edu.cn 的 JSESSIONID');
            error.authInvalid = true;
            throw error;
        }

        // 用一个小窗口的日程请求验证会话确实已认证
        try {
            await this.requestJson('/api/task/list', {
                params: { fromTime: '2026-01-01 00:00', toTime: '2026-01-08 00:00' }
            });
        } catch (error) {
            if (error.authInvalid) {
                const wrapped = new Error('calendar 会话已建立但未完成认证（JAAuthCookie 可能已失效）');
                wrapped.authInvalid = true;
                throw wrapped;
            }
            throw error;
        }
        this.calSessionId = calSessionId;
        return calSessionId;
    }

    async withLoginRetry(operation) {
        if (!this.calSessionId) await this.login();
        try {
            return await operation();
        } catch (error) {
            if (!error.authInvalid) throw error;
            this.calSessionId = null;
            await this.login();
            return operation();
        }
    }

    // /api/event/list 才是日历事件（校历周次 + events）；/api/task/list 仅是个人待办，多数账号为空。
    // 前端行为：两个接口并行请求后合并 {events..., tasks}，时间格式均为 'yyyy-MM-dd HH:mm'。
    async getCalendar(fromTime, toTime, { weekly = false } = {}) {
        const fmt = (d) => {
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        };
        const now = new Date();
        const start = new Date(now);
        start.setDate(start.getDate() - 7);
        const end = new Date(now);
        end.setDate(end.getDate() + 28);
        fromTime = fromTime || fmt(start);
        toTime = toTime || fmt(end);

        return this.withLoginRetry(async () => {
            const [eventRes, taskRes] = await Promise.all([
                this.requestJson('/api/event/list', {
                    params: { startDate: fromTime, endDate: toTime, weekly: weekly ? 'true' : 'false' }
                }),
                this.requestJson('/api/task/list', { params: { fromTime, toTime } })
                    .catch(() => null)
            ]);
            const data = eventRes?.data ?? eventRes ?? {};
            data.tasks = taskRes?.data ?? [];
            return data;
        });
    }
}

export default new JWBasic();
