import { CookieBridge } from './cookie.js';
import jwbauth from './jwbauth.js';

// 课堂直播 (v.sjtu.edu.cn 课堂实录)：Kedacom RBAC 平台 + jAccount CAS 代理。
// 本模块负责“挂直播/观看上报”（模拟播放器观看行为），与课堂扫码签到解耦——
// 扫码/定位签到由可选附属插件处理，本基础模块仅提供直播服务接口。
// 链路：/jy-application-resourcemanage/oauth2/authorize -> /cloud-rbac/authorize
//   -> /jy-cas-proxy/cas/login -> jaccount authorize -> proxy/callback 换票，
//   会话凭据为 v.sjtu.edu.cn 域的 jy-application-resourcemanage Cookie（HttpOnly）。
// “观看上报”即模拟播放器行为：进入直播间先 POST /v1/data/reporting（seq=1、uuid 标识一次观看、
// videoStartTime=0），此后每 30s 上报一次（seq 递增）；每 60s POST /v1/live/keepAlive
// 维持在线并查询 realTime/count；直播自然结束时补报 watchEnd=1 并停止。
// API 约定：HTTP 恒 200，业务码在 body.code（/authority/me 成功为 "0"，其余多为 null），
// 未登录的受保护接口直接返回 401/500 JSON 而非 302 登录页。
const REPORT_INTERVAL_MS = 30 * 1000;    // PLAYER_EVENT_TRACK_INTERVAL: 30 (s)
const KEEPALIVE_INTERVAL_MS = 60 * 1000; // 播放页统计轮询周期 (s)
const MAX_CONSECUTIVE_ERRORS = 3;

// 与平台一致的 'yyyy-MM-dd HH:mm'（courseStartTime/courseEndTime 用）
function fmtMinute(timestamp) {
    const d = new Date(Number(timestamp));
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 与平台一致的 'yyyy-MM-dd HH:mm:ss'（课程发现时间窗用）
function fmtSecond(timestamp) {
    const d = new Date(Number(timestamp));
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function randomUUID() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// 列表同时包含毫秒时间戳和上海本地时间字符串，不能直接 Number(courBeginTime)。
export function liveCourseTime(course, end = false) {
    const value = end ? (course.liveEndTime ?? course.courEndTime)
        : (course.liveStartTime ?? course.courBeginTime);
    if (typeof value === 'number' || /^\d+$/.test(value || '')) return Number(value);
    return Date.parse(String(value || '').replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(value || '') ? '' : '+08:00'));
}

export function liveCourseDay(timestamp) {
    return new Date(timestamp).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

export function sortTodayLiveCourses(records, now = Date.now()) {
    const today = liveCourseDay(now);
    const isMath = (c) => /高等数学/.test(c.courName || c.subjName || c.teclName || c.teachClassName || '');
    return records.filter((c) => c.id && Number.isFinite(liveCourseTime(c))
        && liveCourseDay(liveCourseTime(c)) === today).sort((a, b) =>
        Number(isMath(b)) - Number(isMath(a))
        || (isMath(a) && isMath(b) ? Number(Number(b.letiNumber) === 1) - Number(Number(a.letiNumber) === 1) : 0)
        || liveCourseTime(a) - liveCourseTime(b) || Number(a.id) - Number(b.id));
}

export class JWLive {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        this.apiBase = '/jy-application-resourcemanage';
        this.returnUri = 'https://v.sjtu.edu.cn/jy-mobile-resourcemanage-ui/';
        this.jaAuthCookie = null;
        this.user = null;
        this.sessionCookie = null;
        this.jwtToken = null;
        this.checkIn = null; // 当前签到会话
    }

    setJAAuthCookie(cookie) {
        if ((cookie || null) !== this.jaAuthCookie) {
            this.user = null;
            this.jwtToken = null;
            this.sessionCookie = null;
        }
        this.jaAuthCookie = cookie || null;
    }

    async requestJson(path, options = {}) {
        // 统一补 API 前缀：所有业务接口都在 /jy-application-resourcemanage 之下，
        // 漏前缀的请求会被 nginx 回退到 SPA 的 index.html（200 HTML）而非 404
        if (!path.startsWith(this.apiBase + '/')) path = this.apiBase + path;
        let response;
        try {
            response = await this.bridge.request('live', path, {
                ...options,
                headers: { ...(this.jwtToken ? { 'Jwt-Token': this.jwtToken } : {}), ...options.headers }
            });
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
            if (response.status === 401 || /text\/html/i.test(response.contentType || '')) {
                error.authInvalid = true;
            }
            throw error;
        }
        if (result && typeof result === 'object' && (result.ok === false || [401, 403].includes(Number(result.code)))) {
            const error = new Error(`${path} 返回错误 [code: ${result.code}]: ${result.message || '未知错误'}`);
            error.apiCode = result.code ?? null;
            if ([401, 403].includes(Number(error.apiCode))) error.authInvalid = true;
            throw error;
        }
        return result;
    }

    async fetchUser() {
        let result;
        try {
            result = await this.requestJson(this.apiBase + '/authority/me');
        } catch (error) {
            // 匿名访问 /authority/me 时服务端直接 500（不走 302 登录页）
            error.authInvalid = true;
            throw error;
        }
        const user = result?.result?.user || null;
        if (!user) {
            const error = new Error('课堂实录会话未认证：未取得用户信息');
            error.authInvalid = true;
            throw error;
        }
        return user;
    }

    async login(jaAuthCookie = this.jaAuthCookie) {
        this.user = null;
        this.sessionCookie = null;
        this.jwtToken = null;
        this.jaAuthCookie = await jwbauth.requireJAAuthCookie(jaAuthCookie);
        // authorize 会在 /cloud-rbac 与 /jy-cas-proxy 间多级 302，bridge 跟随跨域跳转完成换票
        await jwbauth.oauth2Chain({
            service: 'live',
            entry: this.apiBase + '/oauth2/authorize',
            params: { json: '0', returnUri: this.returnUri }
        });
        // 官方 CAS 回调先确认 RBAC 会话，再用 Cookie 换取供业务 API 使用的 JWT。
        const rbac = (await this.bridge.request('live', '/cloud-rbac/authority/me')).json();
        if (!rbac?.result?.user) throw new Error('课堂实录 CAS 登录未取得 RBAC 用户信息');
        const tokenResult = await this.requestJson('/oauth2/token');
        this.jwtToken = tokenResult?.result?.jwt_token || null;
        if (!this.jwtToken) throw new Error('课堂实录登录未取得 JWT 访问凭据');
        this.user = await this.fetchUser();
        this.sessionCookie = await this.bridge.cookie('live', 'jy-application-resourcemanage');
        return { user: this.user, sessionCookie: this.sessionCookie };
    }

    async withLoginRetry(operation) {
        if (!this.user) await this.login();
        try {
            return await operation();
        } catch (error) {
            if (!error.authInvalid) throw error;
            this.user = null;
            this.sessionCookie = null;
            this.jwtToken = null;
            await this.login();
            return operation();
        }
    }

    // 服务器时间（匿名可用），签到进度与课程发现均以此对齐本地时钟
    async getServerDateTime() {
        const result = await this.requestJson(this.apiBase + '/app/restApi/getServerDateTime');
        return result?.data ?? result;
    }

    // “我的直播课程”：union 查询当前账号可见的教学班直播（移动端 liveList 同款）。
    // day: 0 今天 / 1 明天 / 2 后天；null 为不限时间窗。
    async getUnionLiveCourses({ pageIndex = 1, pageSize = 20, day = 0, unionName = '', courStatus = 0 } = {}) {
        return this.withLoginRetry(async () => {
            const params = {
                orgaIds: '',
                courTransferFlag: '',
                labeIds: '',
                'page.pageIndex': String(pageIndex),
                'page.pageSize': String(pageSize),
                'page.orders[0].asc': 'true',
                'page.orders[0].field': 'courBeginTime',
                unionName,
                courStatus: String(courStatus)
            };
            if (day !== null) {
                const server = await this.getServerDateTime();
                const keys = day === 0 ? ['todayBeginTime', 'todayEndTime']
                    : day === 1 ? ['tomorrowBeginTime', 'tomorrowEndTime']
                    : ['afterTomorrowBeginTime', 'afterTomorrowEndTime'];
                params.courBeginTime = fmtSecond(server[keys[0]]);
                params.courEndTime = fmtSecond(server[keys[1]]);
            }
            const result = await this.requestJson('/mobile/union/vod_live_new', { params });
            return result?.data ?? result;
        });
    }

    // 指定教学班的直播课程列表（直播页播放列表同款）；liveDay: 0 今天 / 1 明天 / 2 后天
    async getTeclLiveCourses(teclId, { pageIndex = 1, pageSize = 1000, liveDay = 0 } = {}) {
        return this.withLoginRetry(async () => {
            const result = await this.requestJson('/v1/vod_live/t-1', {
                params: {
                    'page.pageIndex': String(pageIndex),
                    'page.pageSize': String(pageSize),
                    'page.orders[0].asc': 'true',
                    'page.orders[0].field': 'courBeginTime',
                    liveDay: String(liveDay),
                    teclId: String(teclId)
                }
            });
            return result?.data ?? result;
        });
    }

    // 今日列表可能按教学班聚合；展开成实际课次，避免把教学班 ID 当成 courseId。
    async getTodayLiveCourses() {
        const server = await this.getServerDateTime();
        const now = Number(server.currentDatetime) || Date.now();
        const collect = async (fetchPage) => {
            const records = [];
            let pageIndex = 1;
            let pageCount = 1;
            do {
                const page = await fetchPage(pageIndex);
                records.push(...(page?.records || []));
                pageCount = Number(page?.pageCount) || 1;
                pageIndex++;
            } while (pageIndex <= pageCount);
            return records;
        };
        const unions = await collect((pageIndex) => this.getUnionLiveCourses({ day: 0, pageIndex, pageSize: 1000 }));
        const records = unions.filter((c) => !c.teclId);
        for (const teclId of new Set(unions.map((c) => c.teclId).filter(Boolean))) {
            records.push(...await collect((pageIndex) => this.getTeclLiveCourses(teclId, { pageIndex, liveDay: 0 })));
        }
        const unique = [...new Map(records.map((c) => [String(c.id), c])).values()];
        return { records: sortTodayLiveCourses(unique, now), now };
    }

    // 课程详情：一次返回签到上报所需的全部字段（教学班、教师、起止时间等）
    async getCourseInfo(courseId, playType = 3) {
        return this.withLoginRetry(async () => {
            const result = await this.requestJson(this.apiBase + '/v1/course_vod_videoinfos', {
                params: { courseId: String(courseId), playType: String(playType) }
            });
            return result?.data ?? result;
        });
    }

    // 直播在线心跳（保持“正在观看”状态，教师端统计以此判定出勤）
    async keepAlive(courId, subjCode) {
        return this.requestJson(this.apiBase + '/v1/live/keepAlive', {
            method: 'POST',
            bodyType: 'json',
            body: { courId, subjCode }
        });
    }

    // 实时观看人数
    async getLiveCount(courseId, subjCode) {
        const result = await this.requestJson(this.apiBase + '/v1/live/realTime/count', {
            params: { courseId: String(courseId), subjCode }
        });
        return result?.data?.data ?? result?.data ?? null;
    }

    // 观看上报（签到的最小单元）
    async reportWatch(body) {
        return this.requestJson(this.apiBase + '/v1/data/reporting', {
            method: 'POST',
            bodyType: 'json',
            body
        });
    }

    // 构造 /v1/data/reporting 请求体（字段与移动端播放器逐一对齐）
    buildReportBody(courseInfo, user, { seq, uuid, videoStartTime = 0, videoTime = 0, watchEnd = 0, playSpeed = 1 } = {}) {
        const start = Number(courseInfo.liveStartTime ?? courseInfo.courBeginTime);
        const end = Number(courseInfo.liveEndTime ?? courseInfo.courEndTime);
        const teacher = courseInfo.tecList?.[0] || {};
        return {
            courseName: courseInfo.courName,
            courseId: courseInfo.id,
            currentTimestamp: Date.now(),
            courseTimestamp: start,
            courseEndTimestamp: end,
            courseStartTime: fmtMinute(start),
            courseEndTime: fmtMinute(end),
            platform: 1,
            playSpeed,
            playType: 0,
            watchEnd,
            reportType: 0,
            subjectCode: courseInfo.subjCode,
            subjectId: courseInfo.subjId,
            subjectName: courseInfo.subjName,
            teacherCode: courseInfo.tecCode,
            teacherId: teacher.id,
            teacherName: courseInfo.tecName,
            teachingClassCode: courseInfo.teachClassCode,
            teachingClassId: courseInfo.teclId,
            teachingClassName: courseInfo.teachClassName,
            userCode: user.code,
            userName: user.name,
            videoTime: Math.round(videoTime),
            videoLength: Math.round((end - start) / 1000),
            seq,
            uuid,
            videoStartTime
        };
    }

    // 直播观看进度（秒）：当前时间相对课程开始时间，即播放器的 currentTime
    liveProgress(courseInfo, now = Date.now()) {
        const start = Number(courseInfo.liveStartTime ?? courseInfo.courBeginTime);
        return Math.max(0, (now - start) / 1000);
    }

    // 单次签到：拉取课程详情并上报一条观看记录（seq=1、videoStartTime=0，与真实播放器首报一致）
    async checkIn(courseId, { playSpeed = 1 } = {}) {
        return this.withLoginRetry(async () => {
            const courseInfo = await this.getCourseInfo(courseId);
            const user = this.user || await this.fetchUser();
            const body = this.buildReportBody(courseInfo, user, {
                seq: 1,
                uuid: randomUUID(),
                videoStartTime: 0,
                videoTime: this.liveProgress(courseInfo),
                playSpeed
            });
            const result = await this.reportWatch(body);
            return { body, result };
        });
    }

    // 持续签到会话：完整模拟移动端播放器的观看上报节奏（HAR 实测）：
    //   进入直播间即上报 data/reporting(seq=1, videoStartTime=0)，此后每 30s 上报（seq 递增）；
    //   每 60s keepAlive + realTime/count；直播自然结束时补报 watchEnd=1 并停止。
    // 回调：onStart(courseInfo) / onReport(body, result) / onKeepAlive(result) /
    //       onCount(count) / onError(error) / onEnd(reason, error)
    // reason: 'course-end' 自然结束 | 'stopped' 手动停止 | 'auth-invalid' | 'error' | 'replaced'
    // 返回 controller: { stop(), state }
    async startCheckIn(courseId, options = {}) {
        if (this.checkIn) this.stopCheckIn('replaced');
        const {
            reportIntervalMs = REPORT_INTERVAL_MS,
            keepAliveIntervalMs = KEEPALIVE_INTERVAL_MS,
            playSpeed = 1,
            onStart, onReport, onKeepAlive, onCount, onError, onEnd
        } = options;

        const session = {
            courseId: Number(courseId),
            uuid: randomUUID(),
            seq: 0,
            consecutiveErrors: 0,
            stopped: false,
            courseInfo: null,
            reportTimer: null,
            keepAliveTimer: null,
            endTimer: null
        };
        const finish = (reason, error = null) => {
            if (session.stopped) return;
            session.stopped = true;
            for (const key of ['reportTimer', 'keepAliveTimer', 'endTimer']) {
                if (session[key]) {
                    clearTimeout(session[key]);
                    clearInterval(session[key]);
                    session[key] = null;
                }
            }
            if (this.checkIn === session) this.checkIn = null;
            try {
                onEnd?.(reason, error);
            } catch (callbackError) {
                console.error('[openJWB] onEnd 回调失败', callbackError);
            }
        };
        session.finish = finish;
        this.checkIn = session;

        const controller = {
            stop: () => finish('stopped'),
            get state() {
                return {
                    courseId: session.courseId,
                    seq: session.seq,
                    uuid: session.uuid,
                    stopped: session.stopped,
                    courseInfo: session.courseInfo
                };
            }
        };
        session.controller = controller;

        const fail = (error) => {
            try {
                onError?.(error);
            } catch (callbackError) {
                console.error('[openJWB] onError 回调失败', callbackError);
            }
            if (error.authInvalid) return finish('auth-invalid', error);
            session.consecutiveErrors += 1;
            if (session.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) finish('error', error);
        };

        const report = async ({ watchEnd = 0 } = {}) => {
            session.seq += 1;
            const body = this.buildReportBody(session.courseInfo, session.user, {
                seq: session.seq,
                uuid: session.uuid,
                videoStartTime: 0,
                videoTime: this.liveProgress(session.courseInfo, session.now()),
                watchEnd,
                playSpeed
            });
            const result = await this.reportWatch(body);
            session.consecutiveErrors = 0;
            try {
                onReport?.(body, result);
            } catch (callbackError) {
                console.error('[openJWB] onReport 回调失败', callbackError);
            }
        };

        try {
            const courseInfo = await this.getCourseInfo(courseId);
            const user = this.user || await this.fetchUser();
            const endAt = Number(courseInfo.liveEndTime ?? courseInfo.courEndTime);
            if (Date.now() >= endAt) {
                throw new Error(`直播已结束（${fmtMinute(endAt)}），无法开始签到`);
            }
            // 用服务器时间对齐本地时钟，避免签到进度/结束判定出现偏差
            const serverTime = await this.getServerDateTime().catch(() => null);
            const clockOffset = serverTime ? Number(serverTime.currentDatetime) - Date.now() : 0;
            session.courseInfo = courseInfo;
            session.user = user;
            session.now = () => Date.now() + clockOffset;

            // 首次上报（对应播放器 createTracking：seq=1、videoStartTime=0）
            await report();
            try {
                onStart?.(courseInfo);
            } catch (callbackError) {
                console.error('[openJWB] onStart 回调失败', callbackError);
            }
            // 初始化 await 期间可能已被停止/替换：不再创建定时器，避免泄漏
            if (session.stopped) return controller;

            // 心跳 + 实时人数（对应播放页 enableStatistics 轮询，先触发一次）
            const keepAliveTick = async () => {
                if (session.stopped) return;
                try {
                    const result = await this.keepAlive(courseInfo.id, courseInfo.subjCode);
                    try {
                        onKeepAlive?.(result);
                    } catch (callbackError) {
                        console.error('[openJWB] onKeepAlive 回调失败', callbackError);
                    }
                    const count = await this.getLiveCount(courseInfo.id, courseInfo.subjCode);
                    try {
                        onCount?.(count);
                    } catch (callbackError) {
                        console.error('[openJWB] onCount 回调失败', callbackError);
                    }
                } catch (error) {
                    fail(error);
                }
            };
            void keepAliveTick();

            session.reportTimer = setInterval(() => {
                if (session.stopped) return;
                report().catch(fail);
            }, reportIntervalMs);
            session.keepAliveTimer = setInterval(() => {
                void keepAliveTick();
            }, keepAliveIntervalMs);
            // 直播自然结束：补报 watchEnd=1（对应播放器 liveEnd 逻辑）
            session.endTimer = setTimeout(() => {
                if (session.stopped) return;
                report({ watchEnd: 1 })
                    .then(() => finish('course-end'))
                    .catch((error) => finish('error', error));
            }, Math.max(endAt - session.now(), 0));

            return controller;
        } catch (error) {
            finish('error', error);
            throw error;
        }
    }

    stopCheckIn(reason = 'stopped') {
        this.checkIn?.finish?.(reason);
    }

    // 获取直播最新帧（课件/电脑屏幕通道，非教师摄像头）。
    // 走本地服务端 /api/bridge/live/frame：服务端用当前会话取课程信息，
    // 选出“课件”通道的 HLS 流，用 opencv(ffmpeg) 抽最新一帧并可选识别画面二维码。
    // 返回 {frame, qrText, channel, courseName}；frame 为 JPEG base64。
    async getLiveFrame(courseId, { detectQr = true } = {}) {
        // 与课程查询共用认证流程；流鉴权失效时重新登录，再由服务端获取新的播放 URL/token。
        return this.withLoginRetry(async () => {
            const response = await fetch('/api/bridge/live/frame', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ courseId, detectQr, jwtToken: this.jwtToken })
            });
            const result = await response.json();
            if (!response.ok || !result.ok) {
                const error = new Error(result.message || '获取直播帧失败');
                if (response.status === 401 || result.authInvalid === true) error.authInvalid = true;
                if (result.courseUnavailable === true) error.courseUnavailable = true;
                throw error;
            }
            return result;
        });
    }

    // 服务端持续监听 HLS，新帧识码后立即通过长轮询交付，无前端定时等待。
    // stop() 取消等待并释放服务端消费者；多个消费者可共享同一条取流进程。
    watchLiveFrames(courseId, { detectQr = true, onFrame, onError, onEnd } = {}) {
        let stopped = false;
        let ended = false;
        let watchId = null;
        const abort = new AbortController();
        const finish = (reason, error = null) => {
            if (ended) return;
            ended = true;
            onEnd?.(reason, error);
        };
        const request = async (payload, signal = abort.signal) => {
            const response = await fetch('/api/bridge/live/watch', {
                method: 'POST', credentials: 'same-origin', signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (!response.ok || !result.ok) {
                const error = new Error(result.message || '直播监听失败');
                error.authInvalid = response.status === 401 || result.authInvalid === true;
                error.courseUnavailable = result.courseUnavailable === true;
                throw error;
            }
            return result;
        };
        const release = async () => {
            const id = watchId;
            watchId = null;
            if (id) {
                try { await request({ action: 'stop', watchId: id }, null); }
                catch (error) { console.debug('[openJWB] 释放直播监听', error.message); }
            }
        };
        const controller = {
            stop: () => {
                if (stopped) return;
                stopped = true;
                abort.abort();
                void release();
                finish('stopped');
            },
            finished: null
        };
        controller.finished = (async () => {
            let authRetries = 0;
            try {
                while (!stopped) {
                    try {
                        const start = await this.withLoginRetry(() => request({
                            action: 'start', courseId, detectQr, jwtToken: this.jwtToken
                        }));
                        watchId = start.watchId;
                        if (stopped) break;
                        let after = 0;
                        while (!stopped) {
                            const result = await request({ action: 'next', watchId, after });
                            if (stopped) break;
                            if (result.ended) {
                                stopped = true;
                                finish('course-end');
                                break;
                            }
                            if (result.event) {
                                after = result.event.eventId;
                                await onFrame?.(result.event);
                            }
                        }
                    } catch (error) {
                        if (stopped || error.name === 'AbortError') break;
                        if (!error.authInvalid || authRetries++ >= 1) throw error;
                        await release();
                        this.user = null;
                        this.jwtToken = null;
                        this.sessionCookie = null;
                        await this.login();
                    }
                }
            } catch (error) {
                if (!stopped) {
                    onError?.(error);
                    finish(error.courseUnavailable ? 'course-unavailable' : error.authInvalid ? 'auth-invalid' : 'error', error);
                }
            } finally {
                await release();
            }
        })();
        return controller;
    }
}

export default new JWLive();
