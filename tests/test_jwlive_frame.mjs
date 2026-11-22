import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 仅替换模块依赖，直接运行实际 JWLive 实现，不需要浏览器或 SJTU 网络。
const source = (await readFile(new URL('../public/js/jwlive.js', import.meta.url), 'utf8'))
    .replace("import { CookieBridge } from './cookie.js';", 'class CookieBridge {}')
    .replace("import jwbauth from './jwbauth.js';", 'const jwbauth = globalThis.__liveTestAuth;');
const authCalls = [];
globalThis.__liveTestAuth = {
    requireJAAuthCookie: async () => 'existing-auth',
    oauth2Chain: async () => { authCalls.push('CAS'); }
};
const { JWLive, sortTodayLiveCourses, liveCourseTime } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const originalFetch = globalThis.fetch;
try {
    const now = Date.parse('2026-11-18T10:00:00+08:00');
    const rows = [
        { id: 2, subjName: '高等数学I', letiNumber: 2, courBeginTime: '2026-11-18 10:00:00' },
        { id: 3, courName: '物理', courBeginTime: '2026-11-18 08:00:00' },
        { id: 1, subjName: '高等数学I', letiNumber: 1, liveStartTime: Date.parse('2026-11-18T09:00:00+08:00') },
        { id: 4, subjName: '高等数学I', letiNumber: 1, courBeginTime: '2026-11-17 09:00:00' }
    ];
    assert.deepEqual(sortTodayLiveCourses(rows, now).map((r) => r.id), [1, 2, 3]);
    assert.equal(liveCourseTime(rows[0]), now);
    assert.deepEqual(sortTodayLiveCourses([], now), []);
    const discovery = new JWLive();
    discovery.getServerDateTime = async () => ({ currentDatetime: now });
    discovery.getUnionLiveCourses = async ({ pageIndex }) => ({
        records: [{ teclId: pageIndex === 1 ? 100 : 200 }], pageCount: 2
    });
    discovery.getTeclLiveCourses = async (teclId) => ({ records: teclId === 100 ? rows.slice(0, 2) : rows.slice(2), pageCount: 1 });
    assert.deepEqual((await discovery.getTodayLiveCourses()).records.map((r) => r.id), [1, 2, 3]);
    const loginBridge = {
        request: async (service, path, options) => {
            authCalls.push(path);
            const json = path === '/cloud-rbac/authority/me' ? { result: { user: {} } }
                : path.endsWith('/oauth2/token') ? { result: { jwt_token: 'new-jwt' } }
                : { result: { user: { code: 'test' } } };
            if (path.endsWith('/authority/me') && !path.startsWith('/cloud-rbac')) {
                assert.equal(options.headers['Jwt-Token'], 'new-jwt');
            }
            return { json: () => json, text: () => JSON.stringify(json) };
        },
        cookie: async () => 'live-cookie'
    };
    const authenticated = new JWLive(loginBridge);
    authenticated.jwtToken = 'stale-jwt';
    await authenticated.login();
    assert.deepEqual(authCalls, ['CAS', '/cloud-rbac/authority/me',
        '/jy-application-resourcemanage/oauth2/token', '/jy-application-resourcemanage/authority/me']);
    assert.equal(authenticated.jwtToken, 'new-jwt');
    let logins = 0;
    const live = new JWLive();
    live.login = async () => { logins++; live.user = { code: 'test' }; };
    const responses = [];
    globalThis.fetch = async () => {
        assert.ok(live.user, '取帧之前必须完成课堂实录登录');
        return responses.shift();
    };
    const success = { ok: true, json: async () => ({ ok: true, frame: 'jpeg' }) };
    const unauthorized = { ok: false, status: 401, json: async () => ({
        ok: false, authInvalid: true, message: '直播流鉴权失败'
    }) };
    responses.push(success);
    assert.equal((await live.getLiveFrame(123)).frame, 'jpeg');
    assert.equal(logins, 1, '首次取帧应调用现有登录逻辑');
    responses.push(unauthorized, success);
    assert.equal((await live.getLiveFrame(123)).frame, 'jpeg');
    assert.equal(logins, 2, '403 转换的鉴权错误应触发重新登录及取帧');
    responses.push(unauthorized, unauthorized);
    await assert.rejects(live.getLiveFrame(123), { authInvalid: true });
    assert.equal(logins, 3, '重试应有上限');
    responses.push({ ok: false, status: 400, json: async () => ({ ok: false, message: '未开播' }) });
    await assert.rejects(live.getLiveFrame(123), /未开播/);
    assert.equal(logins, 3, '普通取帧错误不应重新登录');
    responses.push({ ok: false, status: 409, json: async () => ({
        ok: false, courseUnavailable: true, message: '直播已结束'
    }) });
    await assert.rejects(live.getLiveFrame(123), { courseUnavailable: true });
    assert.equal(logins, 3, '已结束的课次不应重新登录');
    assert.equal(responses.length, 0);
    console.log('JWLive frame authentication regression checks passed');
} finally {
    globalThis.fetch = originalFetch;
}
