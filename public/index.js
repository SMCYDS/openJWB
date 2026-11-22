import jwbauth from './js/jwbauth.js';
import jwbpe from './js/jwbpe.js';
import ocanvas from './js/ocanvas.js';
import jwmake from './js/jwmake.js';
import jwbasic from './js/jwbasic.js';
import jwelect from './js/jwelect.js';
import jwactivity from './js/jwactivity.js';
import jwids from './js/jwids.js';
import jwlive, { liveCourseTime, liveCourseDay } from './js/jwlive.js';
import { createAddonHost, createAuthChannel } from './js/addon-host.js';

const plugins = window.plugins || {};
const pluginCfg = (name) => (plugins[name] && typeof plugins[name] === 'object' ? plugins[name] : {});
const pluginOn = (name) => pluginCfg(name).enabled !== false;
const pluginName = (name) => pluginCfg(name).chinese || name;
const MODULE_IDS = ['jwbauth', 'jwbasic', 'jwbpe', 'ocanvas', 'jwmake', 'jwelect', 'jwactivity', 'jwids'];
const MODULE_HOSTS = { jwbauth: 'jaccount.sjtu.edu.cn', jwbasic: 'calendar.sjtu.edu.cn', jwbpe: 'pe.sjtu.edu.cn', ocanvas: 'oc.sjtu.edu.cn', jwmake: 'make.sjtu.edu.cn', jwelect: 'i.sjtu.edu.cn', jwactivity: 'activity.sjtu.edu.cn', jwids: 'ids.sjtu.edu.cn' };

const status = document.getElementById('status');
const image = document.getElementById('qrcode');
image.hidden = true;
const peOutput = document.getElementById('pe-output');
const btnPeLogin = document.getElementById('btn-pe-login');
const btnGetInfo = document.getElementById('btn-get-info');
const btnGetPointRule = document.getElementById('btn-get-point-rule');
const btnRunningSubmit = document.getElementById('btn-running-submit');
const tracksModal = document.getElementById('tracks-modal');
const tracksInput = document.getElementById('tracks-input');
const btnTracksConfirm = document.getElementById('tracks-confirm');
const btnTracksCancel = document.getElementById('tracks-cancel');
const peAuth = document.getElementById('pe-auth');
const ocOutput = document.getElementById('oc-output');
const btnOcLogin = document.getElementById('btn-oc-login');
const btnOcInfo = document.getElementById('btn-oc-info');
const makeOutput = document.getElementById('make-output');
const btnMakeLogin = document.getElementById('btn-make-login');
const btnMakeInfo = document.getElementById('btn-make-info');
const btnMakeOrders = document.getElementById('btn-make-orders');
const makeOrderType = document.getElementById('make-order-type');
const basicOutput = document.getElementById('basic-output');
const btnBasicLogin = document.getElementById('btn-basic-login');
const btnBasicCalendar = document.getElementById('btn-basic-calendar');
const electOutput = document.getElementById('elect-output');
const btnElectLogin = document.getElementById('btn-elect-login');
const btnElectSchedule = document.getElementById('btn-elect-schedule');
const actOutput = document.getElementById('act-output');
const btnActLogin = document.getElementById('btn-act-login');
const btnActHot = document.getElementById('btn-act-hot');
const btnActHome = document.getElementById('btn-act-home');
const idsOutput = document.getElementById('ids-output');
const btnIdsLogin = document.getElementById('btn-ids-login');
const btnIdsSchedule = document.getElementById('btn-ids-schedule');
const btnIdsRealtime = document.getElementById('btn-ids-realtime');
const idsBuild = document.getElementById('ids-build');
const idsDate = document.getElementById('ids-date');
const liveOutput = document.getElementById('live-output');
const btnLiveLogin = document.getElementById('btn-live-login');
const btnLiveCourses = document.getElementById('btn-live-courses');
const btnLiveCheckIn = document.getElementById('btn-live-checkin');
const btnLiveStop = document.getElementById('btn-live-stop');
const liveCourseId = document.getElementById('live-course-id');
const liveFrameImg = document.getElementById('live-frame-img');
const btnLiveFrame = document.getElementById('btn-live-frame');
let liveCoursesLoading = null;
let liveCoursesDay = null;

if (idsBuild) {
    for (const name of Object.keys(jwids.buildings)) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        idsBuild.appendChild(option);
    }
}
if (idsDate) idsDate.value = new Date().toLocaleDateString('sv-SE');
const AUTH_STORAGE_KEY = 'openjwb_ja_auth_cookie';
let jaAuthCookie = null;
const addonAuth = createAuthChannel(() => jaAuthCookie);

const moduleNav = document.getElementById('module-nav');
const moduleSections = {};
const navItems = {};
const lockedSection = document.querySelector('[data-module="locked"]');
const lockedName = document.getElementById('locked-name');
let activeNavItem = null;
let addonHost = null;

function selectModule(id) {
    addonHost?.hideAll();
    if (addonHost?.has(id)) {
        for (const section of Object.values(moduleSections)) if (section) section.hidden = true;
        if (lockedSection) lockedSection.hidden = true;
        activeNavItem?.classList.remove('active');
        activeNavItem = null;
        void addonHost.activate(id);
        return;
    }
    const enabled = pluginOn(id);
    for (const mid of MODULE_IDS) {
        if (moduleSections[mid]) moduleSections[mid].hidden = mid !== id || !enabled;
    }
    if (lockedSection) {
        lockedSection.hidden = enabled;
        if (!enabled && lockedName) lockedName.textContent = `「${pluginName(id)}」模块未启用`;
    }
    activeNavItem?.classList.remove('active');
    activeNavItem = navItems[id] || null;
    activeNavItem?.classList.add('active');
    if (enabled && id === 'ocanvas' && pluginOn('jwlive')) {
        void refreshLiveCourses(liveOutput);
    }
}

for (const id of MODULE_IDS) {
    moduleSections[id] = document.querySelector(`section[data-module="${id}"]`);
    const heading = moduleSections[id]?.querySelector('h2');
    if (heading) heading.innerHTML = `${pluginName(id)} <span class="muted" style="font-size:13px;font-weight:400">${MODULE_HOSTS[id]}</span>`;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'nav-item';
    const label = document.createElement('span');
    label.textContent = pluginName(id);
    item.appendChild(label);
    if (!pluginOn(id)) {
        item.classList.add('locked');
        const lock = document.createElement('span');
        lock.className = 'lock';
        lock.textContent = '🔒';
        item.appendChild(lock);
    }
    item.addEventListener('click', () => selectModule(id));
    moduleNav.appendChild(item);
    navItems[id] = item;
}
addonHost = createAddonHost({ config: plugins, nav: moduleNav, content: document.querySelector('main'),
    onSelect: selectModule, auth: addonAuth, services: { canvas: ocanvas, live: jwlive } });
window.addEventListener('pagehide', (event) => { if (!event.persisted) addonHost.dispose(); });
selectModule('jwbauth');

document.getElementById('auth-details')?.addEventListener('toggle', (event) => {
    if (event.target.open) void refreshAuthInfo();
});

function setStatus(text, cls = '') {
    status.textContent = text;
    status.className = cls;
}

function logError(context, error) {
    console.log(`[openJWB] ${context}`, {
        message: error?.message || String(error),
        details: error?.details || null,
        stack: error?.stack || null
    });
}

async function refreshAuthInfo() {
    let peSession = jwbpe.peSessionId || '';
    let ocSession = '';
    let calSession = jwbasic.calSessionId || '';
    let iSession = jwelect.iSessionId || '';
    let idsSession = jwids.idsSessionId || '';
    let liveSession = jwlive.sessionCookie || '';
    try {
        if (pluginOn('jwbpe')) peSession = (await jwbpe.bridge.cookie('pe', 'JSESSIONID')) || peSession;
        if (pluginOn('ocanvas')) ocSession = (await ocanvas.bridge.cookie('oc', '_normandy_session')) || ocSession;
        if (pluginOn('jwbasic')) calSession = (await jwbasic.bridge.cookie('calendar', 'JSESSIONID')) || calSession;
        if (pluginOn('jwelect')) iSession = (await jwelect.bridge.cookie('i', 'JSESSIONID')) || iSession;
        if (pluginOn('jwids')) idsSession = (await jwids.bridge.cookie('ids', 'JSESSIONID')) || idsSession;
        if (pluginOn('jwlive')) liveSession = (await jwlive.bridge.cookie('live', 'jy-application-resourcemanage')) || liveSession;
    } catch (error) {
        logError('读取会话 Cookie 失败', error);
    }
    peAuth.textContent = `Cookie: JAAuthCookie=${jwbpe.jaAuthCookie || '(无)'}; JSESSIONID=${peSession || '(无)'}; _normandy_session=${ocSession || '(无)'}; calJSESSIONID=${calSession || '(无)'}; iJSESSIONID=${iSession || '(无)'}; idsJSESSIONID=${idsSession || '(无)'}; liveSession=${liveSession || '(无)'}\nAuthorization: ${jwbpe.lastUid || '(未获取)'}; makeToken: ${jwmake.token || '(未获取)'}; actToken: ${jwactivity.token || '(未获取)'}`;
}

async function startQrLogin() {
    image.hidden = false;
    try {
        const socket = await jwbauth.initLogin('qrcode', (url) => {
            image.src = url;
            setStatus('请扫码登录');
        });
        socket.addEventListener('auth-error', (event) => {
            console.log('[openJWB] 登录认证失败', event.detail);
            setStatus(event.detail, 'err');
        });
    } catch (error) {
        logError('初始化登录失败', error);
        setStatus(error.message, 'err');
    }
}

const SERVICES = [
    {
        id: 'jwbpe', api: jwbpe, output: () => peOutput, label: '体育系统',
        okText: (sid) => `体育系统登录成功, pe JSESSIONID: ${sid}`
    },
    {
        id: 'ocanvas', api: ocanvas, output: () => ocOutput, label: 'Canvas',
        okText: (me) => `Canvas 登录成功: ${me.name || '(未知用户)'} (id: ${me.id})`
    },
    {
        id: 'jwmake', api: jwmake, output: () => makeOutput, label: '学创加工',
        okText: ({ user }) => `学创加工登录成功: ${user?.nickname || user?.sjtu_info?.name || user?.name || '(未知用户)'}`
    },
    {
        id: 'jwbasic', api: jwbasic, output: () => basicOutput, label: '交我办基础服务',
        okText: (sid) => `交我办基础服务登录成功, calendar JSESSIONID: ${sid}`
    },
    {
        id: 'jwelect', api: jwelect, output: () => electOutput, label: '教务系统',
        okText: (sid) => `教务系统登录成功, i JSESSIONID: ${sid}`
    },
    {
        id: 'jwactivity', api: jwactivity, output: () => actOutput, label: '校园活动',
        okText: ({ user }) => `校园活动登录成功: ${user?.nickname || user?.name || user?.jaccount || '(未知用户)'}`
    },
    {
        id: 'jwids', api: jwids, output: () => idsOutput, label: '教学楼信息',
        okText: (sid) => `教学楼信息登录成功: ${jwids.userName || ''}, ids JSESSIONID: ${sid}`
    },
    {
        id: 'jwlive', api: jwlive, output: () => liveOutput, label: '课堂直播',
        okText: ({ user }) => `课堂实录登录成功: ${user?.name || '(未知用户)'} (${user?.code || ''})`
    },

];

// 依次登录已启用的子系统；任一系统判定 JAAuthCookie 失效时返回 true
async function loginServices(cookie) {
    let authInvalid = false;
    for (const svc of SERVICES) {
        if (!pluginOn(svc.id)) continue;
        const out = svc.output();
        try {
            const result = await svc.api.login(cookie);
            if (out) out.textContent = svc.okText(result);
            if (svc.id === 'jwlive') await refreshLiveCourses(liveOutput);
        } catch (error) {
            logError(`登录${svc.label}失败`, error);
            if (out) out.textContent = `登录${svc.label}失败: ${error.message}`;
            if (error.authInvalid || error.apiCode === 401) authInvalid = true;
        }
    }
    return authInvalid;
}

async function handleLoginSuccess(token, cookie) {
    jaAuthCookie = cookie || null;
    for (const svc of SERVICES) svc.api.setJAAuthCookie(jaAuthCookie);
    addonAuth.notify();
    if (!token) return;
    setStatus(`登录成功\nJSESSIONID: ${token}\nJAAuthCookie: ${jaAuthCookie ?? '未返回'}\n正在登录子系统...`);
    if (jaAuthCookie) {
        try {
            localStorage.setItem(AUTH_STORAGE_KEY, jaAuthCookie);
        } catch (error) {
            logError('保存 JAAuthCookie 到 localStorage 失败', error);
        }
    }
    const authInvalid = await loginServices(jaAuthCookie);
    image.hidden = true;
    if (authInvalid) {
        try {
            localStorage.removeItem(AUTH_STORAGE_KEY);
        } catch (storageError) {
            logError('清除无效 JAAuthCookie 失败', storageError);
        }
        jaAuthCookie = null;
        addonAuth.notify();
        setStatus('JAAuthCookie 无效，请重新扫码登录。', 'err');
        await refreshAuthInfo();
        await startQrLogin();
        return;
    }
    setStatus('jAccount 已登录；各子系统登录结果见下方输出。', 'ok');
    await refreshAuthInfo();
}

jwbauth.onLoginSuccess((token, cookie) => {
    void handleLoginSuccess(token, cookie);
});

async function restoreLogin() {
    let savedCookie;
    try {
        // 先拉取 Python 会话 jar 里的 JAAuthCookie（服务端会话仍在即自动登录），
        // 再回退到浏览器 localStorage 保存的凭据
        await jwbauth.bridge.start();
        savedCookie = (await jwbauth.bridge.cookie('jaccount', 'JAAuthCookie')) ||
                      (await jwbauth.bridge.cookie('my', 'JAAuthCookie'));
    } catch (error) {
        logError('从会话 jar 读取 JAAuthCookie 失败', error);
    }
    if (!savedCookie) {
        try {
            savedCookie = localStorage.getItem(AUTH_STORAGE_KEY);
        } catch (error) {
            logError('读取 localStorage 登录凭据失败', error);
            return false;
        }
    }
    if (!savedCookie) return false;

    jaAuthCookie = savedCookie;
    for (const svc of SERVICES) svc.api.setJAAuthCookie(savedCookie);
    addonAuth.notify();
    setStatus('正在验证已保存的 jAccount 登录状态...');
    try {
        const authInvalid = await loginServices(savedCookie);
        if (authInvalid) {
            try {
                localStorage.removeItem(AUTH_STORAGE_KEY);
            } catch (storageError) {
                logError('清除无效 JAAuthCookie 失败', storageError);
            }
            jaAuthCookie = null;
            for (const svc of SERVICES) svc.api.setJAAuthCookie(null);
            addonAuth.notify();
            await refreshAuthInfo();
            return false;
        }
        image.hidden = true;
        setStatus('已使用有效的 jAccount Cookie 自动登录。', 'ok');
        await refreshAuthInfo();
        return true;
    } catch (error) {
        logError('自动登录失败', error);
        setStatus(`自动登录暂时失败：${error.message}`, 'err');
        return true;
    }
}

btnPeLogin?.addEventListener('click', async () => {
    try {
        peOutput.textContent = '正在登录体育系统...';
        const sid = await jwbpe.login(jaAuthCookie);
        peOutput.textContent = `体育系统登录成功, pe JSESSIONID: ${sid}`;
        await refreshAuthInfo();
    } catch (err) {
        logError('登录体育系统失败', err);
        peOutput.textContent = `登录体育系统失败: ${err.message}`;
    }
});

btnOcLogin?.addEventListener('click', async () => {
    try {
        ocOutput.textContent = '正在登录 Canvas...';
        const me = await ocanvas.login(jaAuthCookie);
        ocOutput.textContent = `Canvas 登录成功: ${me.name || '(未知用户)'} (id: ${me.id})\n${JSON.stringify(me, null, 2)}`;
        await refreshAuthInfo();
    } catch (err) {
        logError('登录 Canvas 失败', err);
        ocOutput.textContent = `登录 Canvas 失败: ${err.message}`;
    }
});

btnOcInfo?.addEventListener('click', async () => {
    try {
        ocOutput.textContent = '正在获取 Canvas 个人信息与课程...';
        const info = await ocanvas.getInfo();
        ocOutput.textContent = JSON.stringify(info, null, 2);
        await refreshAuthInfo();
    } catch (err) {
        logError('获取 Canvas 信息失败', err);
        ocOutput.textContent = `获取 Canvas 信息失败: ${err.message}`;
    }
});

btnMakeLogin?.addEventListener('click', async () => {
    try {
        makeOutput.textContent = '正在登录学创加工...';
        const { user } = await jwmake.login(jaAuthCookie);
        makeOutput.textContent = `学创加工登录成功: ${user?.nickname || user?.sjtu_info?.name || user?.name || '(未知用户)'}\ntoken: ${jwmake.token}\n\n${JSON.stringify(user, null, 2)}`;
        await refreshAuthInfo();
    } catch (err) {
        logError('登录学创加工失败', err);
        makeOutput.textContent = `登录学创加工失败: ${err.message}`;
    }
});

btnMakeInfo?.addEventListener('click', async () => {
    try {
        makeOutput.textContent = '正在获取学创加工用户信息...';
        const info = await jwmake.getInfo();
        makeOutput.textContent = JSON.stringify(info, null, 2);
        await refreshAuthInfo();
    } catch (err) {
        logError('获取学创加工信息失败', err);
        makeOutput.textContent = `获取学创加工信息失败: ${err.message}`;
    }
});

btnMakeOrders?.addEventListener('click', async () => {
    const typeName = makeOrderType.selectedOptions[0]?.textContent || makeOrderType.value;
    try {
        makeOutput.textContent = `正在查询${typeName}订单...`;
        const orders = await jwmake.queryOrder(makeOrderType.value);
        makeOutput.textContent = JSON.stringify(orders, null, 2);
    } catch (err) {
        logError('查询订单失败', err);
        makeOutput.textContent = `查询订单失败: ${err.message}`;
    }
});

btnBasicLogin?.addEventListener('click', async () => {
    try {
        basicOutput.textContent = '正在登录交我办基础服务...';
        const sid = await jwbasic.login(jaAuthCookie);
        basicOutput.textContent = `交我办基础服务登录成功, calendar JSESSIONID: ${sid}`;
        await refreshAuthInfo();
    } catch (err) {
        logError('登录交我办基础服务失败', err);
        basicOutput.textContent = `登录交我办基础服务失败: ${err.message}`;
    }
});

btnBasicCalendar?.addEventListener('click', async () => {
    try {
        basicOutput.textContent = '正在获取校历日程...';
        const tasks = await jwbasic.getCalendar();
        basicOutput.textContent = JSON.stringify(tasks, null, 2);
        await refreshAuthInfo();
    } catch (err) {
        logError('获取校历日程失败', err);
        basicOutput.textContent = `获取校历日程失败: ${err.message}`;
    }
});

btnElectLogin?.addEventListener('click', async () => {
    try {
        electOutput.textContent = '正在登录教务系统...';
        const sid = await jwelect.login(jaAuthCookie);
        electOutput.textContent = `教务系统登录成功, i JSESSIONID: ${sid}`;
        await refreshAuthInfo();
    } catch (err) {
        logError('登录教务系统失败', err);
        electOutput.textContent = `登录教务系统失败: ${err.message}`;
    }
});

btnElectSchedule?.addEventListener('click', async () => {
    try {
        electOutput.textContent = '正在查询课表...';
        const schedule = await jwelect.getSchedule();
        electOutput.textContent = JSON.stringify(schedule, null, 2);
    } catch (err) {
        logError('查询课表失败', err);
        electOutput.textContent = `查询课表失败: ${err.message}`;
    }
});

btnActLogin?.addEventListener('click', async () => {
    try {
        actOutput.textContent = '正在登录校园活动平台...';
        const { user } = await jwactivity.login(jaAuthCookie);
        actOutput.textContent = `校园活动登录成功: ${user?.nickname || user?.name || '(未知用户)'}\ntoken: ${jwactivity.token}\n\n${JSON.stringify(user, null, 2)}`;
        await refreshAuthInfo();
    } catch (err) {
        logError('登录校园活动平台失败', err);
        actOutput.textContent = `登录校园活动平台失败: ${err.message}`;
    }
});

btnActHot?.addEventListener('click', async () => {
    try {
        actOutput.textContent = '正在获取热门活动...';
        const data = await jwactivity.getHotList();
        actOutput.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
        logError('获取热门活动失败', err);
        actOutput.textContent = `获取热门活动失败: ${err.message}`;
    }
});

btnActHome?.addEventListener('click', async () => {
    try {
        actOutput.textContent = '正在获取首页活动列表...';
        const data = await jwactivity.getHomeActivities();
        actOutput.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
        logError('获取首页活动列表失败', err);
        actOutput.textContent = `获取首页活动列表失败: ${err.message}`;
    }
});

btnIdsLogin?.addEventListener('click', async () => {
    try {
        idsOutput.textContent = '正在登录教学楼信息...';
        const sid = await jwids.login(jaAuthCookie);
        idsOutput.textContent = `教学楼信息登录成功: ${jwids.userName || ''}, ids JSESSIONID: ${sid}`;
        await refreshAuthInfo();
    } catch (err) {
        logError('登录教学楼信息失败', err);
        idsOutput.textContent = `登录教学楼信息失败: ${err.message}`;
    }
});

btnIdsSchedule?.addEventListener('click', async () => {
    try {
        idsOutput.textContent = `正在查询${idsBuild.value} ${idsDate.value} 课表信息...`;
        const data = await jwids.getBuildRoomSchedule(idsBuild.value, idsDate.value);
        idsOutput.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
        logError('查询教学楼课表失败', err);
        idsOutput.textContent = `查询教学楼课表失败: ${err.message}`;
    }
});

btnIdsRealtime?.addEventListener('click', async () => {
    try {
        idsOutput.textContent = `正在查询${idsBuild.value}实时占用...`;
        const data = await jwids.getSchoolCourseInfo(idsBuild.value);
        idsOutput.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
        logError('查询教学楼实时信息失败', err);
        idsOutput.textContent = `查询教学楼实时信息失败: ${err.message}`;
    }
});

btnLiveLogin?.addEventListener('click', async () => {
    try {
        liveOutput.textContent = '正在登录课堂实录...';
        const { user } = await jwlive.login(jaAuthCookie);
        liveOutput.textContent = `课堂实录登录成功: ${user?.name || '(未知用户)'} (${user?.code || ''})\n会话 Cookie: ${jwlive.sessionCookie}`;
        await refreshAuthInfo();
    } catch (err) {
        logError('登录课堂实录失败', err);
        liveOutput.textContent = `登录课堂实录失败: ${err.message}`;
    }
});

async function refreshLiveCourses(output = liveOutput) {
    try {
        output.textContent = '正在查询今日直播课程...';
        if (!liveCoursesLoading) {
            liveCoursesLoading = jwlive.getTodayLiveCourses().then(({ records, now }) => {
                for (const select of [liveCourseId]) {
                    if (!select) continue;
                    const previous = liveCoursesDay === liveCourseDay(now) ? select.value : '';
                    select.replaceChildren();
                    for (const course of records) {
                        const option = document.createElement('option');
                        const begin = liveCourseTime(course);
                        const end = liveCourseTime(course, true);
                        const time = (t) => Number.isFinite(t) ? new Date(t).toLocaleTimeString('zh-CN', {
                            timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false
                        }) : '?';
                        const state = now >= end ? '已结束' : now < begin ? '未开始' : '直播中';
                        option.value = String(course.id);
                        option.textContent = `${course.courName || course.subjName || course.teclName || '课程'} ${course.letiNumber ? `第${course.letiNumber}节 ` : ''}${time(begin)}–${time(end)} [${state}] (${course.id})`;
                        select.appendChild(option);
                    }
                    if (!records.length) select.appendChild(new Option('今日没有可见的直播课程', ''));
                    if (records.some((c) => String(c.id) === previous)) select.value = previous;
                }
                liveCoursesDay = liveCourseDay(now);
                return records;
            }).finally(() => { liveCoursesLoading = null; });
        }
        const records = await liveCoursesLoading;
        output.textContent = records.length ? `已加载今日 ${records.length} 个课次，默认优先选择高等数学第一节课，可在下拉框中切换。` : '今日没有可见的直播课程。';
        return records;
    } catch (err) {
        liveCoursesDay = null;
        for (const select of [liveCourseId]) select?.replaceChildren(new Option('课程加载失败，请重试', ''));
        logError('查询直播课程失败', err);
        output.textContent = `查询直播课程失败: ${err.message}`;
        return [];
    }
}

btnLiveCourses?.addEventListener('click', () => { void refreshLiveCourses(liveOutput); });

async function selectedLiveCourse(select, output) {
    if (!select?.value || liveCoursesDay !== liveCourseDay(Date.now())) await refreshLiveCourses(output);
    return Number(select?.value) || null;
}

let liveCountLast = null;

btnLiveCheckIn?.addEventListener('click', async () => {
    const courseId = await selectedLiveCourse(liveCourseId, liveOutput);
    if (!courseId) {
        liveOutput.textContent += '\n请先从今日直播课程下拉框选择课次。';
        return;
    }
    if (jwlive.checkIn) {
        liveOutput.textContent = `已有签到会话进行中 (courseId=${jwlive.checkIn.courseId}, seq=${jwlive.checkIn.seq})，请先停止`;
        return;
    }
    try {
        liveOutput.textContent = `正在对 courseId=${courseId} 发起签到...`;
        const controller = await jwlive.startCheckIn(courseId, {
            onStart: (courseInfo) => {
                liveOutput.textContent = `签到会话已建立: ${courseInfo.courName} (${courseInfo.teachClassName})\n直播时间: ${new Date(Number(courseInfo.liveStartTime)).toLocaleString('sv-SE')} ~ ${new Date(Number(courseInfo.liveEndTime)).toLocaleString('sv-SE')}\nuuid: ${controller.state.uuid}\n等待上报回调...`;
            },
            onReport: (body) => {
                liveOutput.textContent = `签到上报中 seq=${body.seq} videoTime=${body.videoTime}s watchEnd=${body.watchEnd}\ncourseId=${body.courseId} ${body.courseName} (${body.teachingClassName})\n实时人数: ${liveCountLast}\nuuid: ${body.uuid}`;
            },
            onKeepAlive: () => {},
            onCount: (count) => {
                liveCountLast = count;
            },
            onError: (err) => {
                logError('签到上报出错', err);
                liveOutput.textContent += `\n[出错] ${err.message}`;
            },
            onEnd: (reason) => {
                liveOutput.textContent += `\n[签到结束] reason=${reason}`;
            }
        });
    } catch (err) {
        logError('发起签到失败', err);
        liveOutput.textContent = `发起签到失败: ${err.message}`;
    }
});

btnLiveStop?.addEventListener('click', () => {
    if (!jwlive.checkIn) {
        liveOutput.textContent = '当前没有进行中的签到会话';
        return;
    }
    liveOutput.textContent += '\n正在停止签到会话...';
    jwlive.stopCheckIn('stopped');
});

let lastLiveQrText = null;
let liveFrameController = null;

btnLiveFrame?.addEventListener('click', async () => {
    if (liveFrameController) {
        liveFrameController.stop();
        return;
    }
    const courseId = await selectedLiveCourse(liveCourseId, liveOutput);
    if (!courseId) {
        liveOutput.textContent += '\n请先从今日直播课程下拉框选择课次。';
        return;
    }
    try {
        liveOutput.textContent = `正在监听 courseId=${courseId} 的课件新分片...`;
        btnLiveFrame.textContent = '停止实时课件画面';
        liveFrameController = jwlive.watchLiveFrames(courseId, {
            detectQr: true,
            onFrame: (result) => {
                lastLiveQrText = result.qrText || null;
                liveFrameImg.src = `data:image/jpeg;base64,${result.frame}`;
                liveFrameImg.hidden = false;
                liveOutput.textContent = `实时课件: ${result.courseName || ''} (${result.channel || ''})\n` +
                    `分片时长 ${result.segmentDuration ?? '?'}s；下载 ${result.fetchMs ?? '?'}ms；识码 ${result.qrMs ?? '?'}ms\n` +
                    (lastLiveQrText ? `识别到二维码:\n${lastLiveQrText}` : '未识别到二维码，正在等待新画面');
            },
            onError: (error) => { liveOutput.textContent = `实时课件失败: ${error.message}`; },
            onEnd: (reason) => {
                liveFrameController = null;
                btnLiveFrame.textContent = '开始实时课件画面';
                liveOutput.textContent += `\n[画面监听结束] ${reason}`;
            }
        });
    } catch (err) {
        logError('获取直播帧失败', err);
        liveOutput.textContent = `获取直播帧失败: ${err.message}`;
    }
});

btnGetInfo?.addEventListener('click', async () => {
    try {
        peOutput.textContent = '正在获取体育系统学生数据...';
        const info = await jwbpe.getInfo();
        peOutput.textContent = JSON.stringify(info, null, 2);
    } catch (err) {
        logError('获取体育信息失败', err);
        peOutput.textContent = `获取体育信息失败: ${err.message}`;
    }
});

btnGetPointRule?.addEventListener('click', async () => {
    try {
        peOutput.textContent = '正在获取打卡点与规则...';
        const rules = await jwbpe.getPointRule();
        peOutput.textContent = `动态 uid (Authorization): ${jwbpe.lastUid}\n\n${JSON.stringify(rules, null, 2)}`;
        await refreshAuthInfo();
    } catch (err) {
        logError('获取打卡点与规则失败', err);
        peOutput.textContent = `获取打卡点与规则失败: ${err.message}`;
    }
});

btnRunningSubmit?.addEventListener('click', () => {
    tracksModal.style.display = 'flex';
    tracksInput.focus();
});

btnTracksCancel?.addEventListener('click', () => {
    tracksModal.style.display = 'none';
});

tracksModal?.addEventListener('click', (event) => {
    if (event.target === tracksModal) tracksModal.style.display = 'none';
});

btnTracksConfirm?.addEventListener('click', async () => {
    let tracks;
    try {
        tracks = JSON.parse(tracksInput.value);
    } catch (err) {
        peOutput.textContent = `tracks JSON 解析失败: ${err.message}`;
        return;
    }
    if (!Array.isArray(tracks)) {
        peOutput.textContent = 'tracks 必须是 JSON 数组';
        return;
    }
    tracksModal.style.display = 'none';
    try {
        peOutput.textContent = '正在上传跑步数据...';
        const result = await jwbpe.runningSubmit(tracks);
        const info = jwbpe.lastSubmitInfo;
        const header = info ? `本次上传授权信息:\nuid (Authorization): ${info.uid}\nsid: ${info.sid}\ntime: ${info.time}\nupdateTime: ${info.updateTime}\nvaildDistance: ${info.vaildDistance}\nsumDistance: ${info.sumDistance}\n\n` : '';
        peOutput.textContent = `${header}上传结果:\n${JSON.stringify(result, null, 2)}`;
        await refreshAuthInfo();
    } catch (err) {
        logError('上传跑步数据失败', err);
        peOutput.textContent = `上传跑步数据失败: ${err.message}`;
    }
});

const restored = await restoreLogin();
if (!restored) await startQrLogin();
