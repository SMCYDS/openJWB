import { CookieBridge } from './cookie.js';
import jwbauth from './jwbauth.js';

export class JWBPE {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        this.clientId = '9mqzULSXYgUYj5fPOpyL';
        this.authUrl = `https://jaccount.sjtu.edu.cn/oauth2/authorize?response_type=code&scope=profile&client_id=${this.clientId}&state=8&redirect_uri=https://pe.sjtu.edu.cn/oauth2Login`;
        this.defaultLocation = '121.42800347222222,31.024470757378474';
        this.peSessionId = null;
        this.jaAuthCookie = null;
        this.lastUid = null;
        this.lastSubmitInfo = null;
    }

    async fetchDynamicUid() {
        const uidJson = await this.requestJson('/sports/my/uid');
        const dynamicToken = uidJson.data?.uid;
        if (!dynamicToken) {
            throw new Error(`/sports/my/uid 未返回 data.uid: ${JSON.stringify(uidJson)}`);
        }
        this.lastUid = dynamicToken;
        return dynamicToken;
    }

    setJAAuthCookie(cookie) {
        this.jaAuthCookie = cookie || null;
    }

    async requestJson(path, options) {
        const response = await this.bridge.request('pe', path, options);
        let result;
        let rawText = '';
        try {
            if (typeof response.text === 'function') {
                rawText = response.text();
                result = JSON.parse(rawText);
            } else {
                result = await response.json();
            }
        } catch (parseError) {
            const details = {
                path,
                status: response.status ?? null,
                contentType: response.contentType || 'unknown',
                parseError: parseError.message,
                responseLength: rawText.length,
                responsePreview: rawText.slice(0, 400)
                    .replace(/("(?:JAAuthCookie|JSESSIONID|Authorization|access_token|refresh_token|token|uid|studentNo|userAccount|name)"\s*:\s*")[^"]*(")/gi, '$1[redacted]$2')
                    .replace(/((?:code|ticket|token|state)=)[^&\s"'<>]*/gi, '$1[redacted]')
            };
            console.log('[JWBPE] 响应 JSON 解析失败', details);
            const error = new Error(`${path} 返回内容无法解析为 JSON: ${parseError.message}`);
            error.details = details;
            if (response.status === 401 || /text\/html/i.test(response.contentType || '')) {
                error.apiCode = 401;
                error.authInvalid = true;
            }
            throw error;
        }
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
            const error = new Error(`${path} 返回了无效的数据结构`);
            error.details = { path, status: response.status ?? null, contentType: response.contentType || 'unknown' };
            throw error;
        }
        if (result.code !== undefined && Number(result.code) !== 0) {
            const error = new Error(`${path} 返回错误 [code: ${result.code}]: ${result.msg || result.message || '未知错误'}`);
            error.apiCode = Number(result.code);
            error.authInvalid = error.apiCode === 401;
            error.details = { path, status: response.status ?? null, contentType: response.contentType || 'unknown', code: result.code };
            throw error;
        }
        return result;
    }

    async login(jaAuthCookie = this.jaAuthCookie) {
        this.jaAuthCookie = await jwbauth.requireJAAuthCookie(jaAuthCookie);
        await jwbauth.oauth2Chain({
            clientId: this.clientId,
            redirectUri: 'https://pe.sjtu.edu.cn/oauth2Login',
            scope: 'profile',
            state: '8'
        });

        const peSessionId = await this.bridge.cookie('pe', 'JSESSIONID');
        if (!peSessionId) {
            const error = new Error('授权未完成：未取得 pe.sjtu.edu.cn 的 JSESSIONID');
            error.authInvalid = true;
            throw error;
        }
        let userJson;
        try {
            userJson = await this.requestJson('/sports/my/user');
        } catch (error) {
            if (error.apiCode === undefined && error.details?.path === '/sports/my/user') error.authInvalid = true;
            throw error;
        }
        if (!Array.isArray(userJson.data) || !userJson.data[0]) {
            const error = new Error('体育系统会话已建立，但未获取到已登录用户信息');
            error.authInvalid = true;
            throw error;
        }
        this.peSessionId = peSessionId;
        return peSessionId;
    }

    async withLoginRetry(operation) {
        if (!this.peSessionId) await this.login();
        try {
            return await operation();
        } catch (error) {
            if (error.apiCode !== 401) throw error;
            this.peSessionId = null;
            await this.login();
            return operation();
        }
    }

    async getInfo() {
        return this.withLoginRetry(async () => {
            const [userJson, dataJson, targetJson, todayJson] = await Promise.all([
                this.requestJson('/sports/my/user'),
                this.requestJson('/sports/my/data'),
                this.requestJson('/sports/my/semesterTarget'),
                this.requestJson('/sports/my/run/data')
            ]);

            const profile = userJson.data?.[0];
            const runData = dataJson.data?.[0];
            if (!profile || !runData) {
                throw new Error('体育系统个人信息接口返回空数据');
            }

            return {
                student: {
                    name: profile.name || '',
                    studentNo: profile.studentNo || '',
                    deptName: profile.deptName || '',
                    userAccount: profile.userAccount || '',
                    avatar: profile.avatar || ''
                },
                running: {
                    totalKm: Number.parseFloat(runData.totalKm || '0'),
                    validKm: Number.parseFloat(runData.resultKm || '0'),
                    percent: Number.parseFloat(runData.percent || '0'),
                    targetKm: Number.parseFloat(targetJson.data?.target || '0'),
                    todayKm: Number.parseFloat(todayJson.data?.today || '0')
                }
            };
        });
    }

    async getPointRule(location = this.defaultLocation) {
        return this.withLoginRetry(async () => {
            const dynamicToken = await this.fetchDynamicUid();

            const ruleJson = await this.requestJson('/api/running/point-rule', {
                params: { location },
                headers: {
                    'User-Agent': 'TaskCenterApp/3.6.4/iPhone 17/ScreenFringe (iOS,iPhone,26.5.2; Scale/3.0)',
                    'Cache-Control': 'no-cache',
                    'Accept-Language': 'zh',
                    'Authorization': dynamicToken
                }
            });
            if (!ruleJson.data) throw new Error('/api/running/point-rule 未返回 data');
            return ruleJson.data;
        });
    }

    async runningSubmit(tracks, options = {}) {
        if (!Array.isArray(tracks)) throw new Error('tracks 必须是数组');
        return this.withLoginRetry(async () => {
            const dynamicToken = await this.fetchDynamicUid();

            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const startTs = tracks
                .flatMap((track) => (track.points || []).map((point) => point.locatetime))
                .filter(Number.isFinite)
                .sort((a, b) => a - b)[0];
            const start = startTs ? new Date(startTs) : now;

            const record = {
                uid: dynamicToken,
                spavg: options.spavg ?? 0,
                fravg: options.fravg ?? 0,
                time: options.time ??
                    `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 ${pad(start.getHours())}:${pad(start.getMinutes())}`,
                updateTime: options.updateTime ??
                    `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
                type: options.type ?? 'score',
                state: options.state ?? false,
                tracks,
                sid: (options.sid || crypto.randomUUID()).toUpperCase(),
                vaildDistance: options.vaildDistance ?? '0.00',
                sumDistance: options.sumDistance ??
                    tracks.reduce((sum, track) => sum + (Number(track.distance) || 0), 0)
            };
            const { tracks: _tracks, ...submitInfo } = record;
            this.lastSubmitInfo = submitInfo;

            return this.requestJson('/api/running/result/upload', {
                method: 'POST',
                bodyType: 'json',
                body: [record],
                headers: {
                    'User-Agent': 'TaskCenterApp/3.6.4/iPhone 17/ScreenFringe (iOS,iPhone,26.5.2; Scale/3.0)',
                    'Cache-Control': 'no-cache',
                    'Accept-Language': 'zh',
                    'Authorization': dynamicToken
                }
            });
        });
    }
}

export default new JWBPE();
