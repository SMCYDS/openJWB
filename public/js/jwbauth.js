//整个js文件用于处理JWB的登录认证，整体模块化。
import { CookieBridge } from './cookie.js';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class JWBAuth {
    constructor(bridge = new CookieBridge()) {
        this.bridge = bridge;
        this.listeners = new Set();
        this.socket = null;
        this.refreshTimer = null;
        this.qrUrl = null;
        this.qrSequence = 0;
        this.generation = 0;
    }

    closeLogin() {
        this.generation++;
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = null;
        const current = this.socket;
        this.socket = null;
        if (current) current.close();
        if (this.qrUrl) URL.revokeObjectURL(this.qrUrl);
        this.qrUrl = null;
    }

    fail(socket, message) {
        if (this.socket !== socket) return;
        this.closeLogin();
        socket.dispatchEvent(new CustomEvent('auth-error', { detail: message }));
    }

    parseLoginContext(html) {
        // 仅提取字段，不执行来自上游页面的 JavaScript。
        const block = html.match(/var\s+loginContext\s*=\s*\{([\s\S]*?)\};/)?.[1];
        const uuid = block?.match(/\buuid\s*:\s*"([^"]*)"/)?.[1];
        if (!uuid) throw new Error('未找到登录 uuid');
        return { uuid };
    }

    async initLogin(mode, callback) {
        //mode: "password" or "qrcode"
        /*
        callback: 建立login websocket之后调用，如果是qrcode模式的话会传入参数url供生成二维码
        */
        if (!['password', 'qrcode'].includes(mode)) throw new Error('不支持的登录模式');
        this.closeLogin();
        const generation = this.generation;
        await this.bridge.start();
        const page = await this.bridge.request('my', '/');
        if (generation !== this.generation) throw new Error('登录已取消');
        const { uuid } = this.parseLoginContext(page.text());
        if (mode === 'password') {
            callback?.();
            return;
        }

        const socket = new WebSocket(`wss://jaccount.sjtu.edu.cn/jaccount/sub/${encodeURIComponent(uuid)}`);
        this.socket = socket;
        let completing = false;
        const update = () => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'UPDATE_QR_CODE' }));
        };
        socket.addEventListener('open', () => {
            if (this.socket !== socket) return;
            update();
            this.refreshTimer = setInterval(update, 60 * 1000);
        });
        socket.addEventListener('message', async (event) => {
            if (this.socket !== socket) return;
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'UPDATE_QR_CODE') {
                    if (message.error !== 0) throw new Error('二维码服务返回错误');
                    const { sig, ts } = message.payload || {};
                    if (!sig || !ts) return;
                    const sequence = ++this.qrSequence;
                    const image = await this.bridge.request('jaccount', '/jaccount/qrcode', {
                        params: { uuid, sig, ts }
                    });
                    if (this.socket !== socket || sequence !== this.qrSequence) return;
                    // 只保留最新一次图片的 blob URL，避免二维码定期刷新造成内存泄漏。
                    const url = URL.createObjectURL(new Blob([image.bytes], { type: image.contentType }));
                    const previous = this.qrUrl;
                    this.qrUrl = url;
                    callback?.(url);
                    if (previous) URL.revokeObjectURL(previous);
                } else if (message.type === 'LOGIN') {
                    if (message.error !== 0) throw new Error('扫码登录失败');
                    if (completing) return;
                    completing = true;
                    await this.bridge.request('jaccount', '/jaccount/expresslogin', { params: { uuid } });
                    const token = await this.bridge.cookie('my', 'JSESSIONID');
                    const jaAuthCookie = (await this.bridge.cookie('jaccount', 'JAAuthCookie')) ||
                                         (await this.bridge.cookie('my', 'JAAuthCookie'));
                    if (this.socket !== socket) return;
                    if (!token) throw new Error('登录后未收到 JSESSIONID');
                    this.closeLogin();
                    this.listeners.forEach((listener) => listener(token, jaAuthCookie));
                }
            } catch (error) {
                this.fail(socket, error.message);
            }
        });
        socket.addEventListener('error', () => this.fail(socket, 'WebSocket 连接失败，请检查服务端 Origin 或 Cookie 限制'));
        socket.addEventListener('close', () => this.fail(socket, '二维码连接已断开'));
        return socket;
    }

    passwordLogin(username, password, callback) {
        //用户输入用户名密码后调用，这个暂时功能空着只初始化结构
    }

    onLoginSuccess(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    // 各第三方系统 jAccount OAuth 共用的前置步骤：解析 JAAuthCookie 并注入 .sjtu.edu.cn 域
    async requireJAAuthCookie(jaAuthCookie) {
        const authCookie = jaAuthCookie ||
                           (await this.bridge.cookie('jaccount', 'JAAuthCookie')) ||
                           (await this.bridge.cookie('my', 'JAAuthCookie'));
        if (!authCookie) {
            throw new Error('未检测到有效的 JAAuthCookie，请先完成 jAccount 登录');
        }
        await this.bridge.setCookie('.sjtu.edu.cn', 'JAAuthCookie', authCookie);
        return authCookie;
    }

    // 统一第三方 jAccount OAuth2 授权链（bridge 自动跟随跨域跳转）：
    // - entry 提供时从业务方登录入口发起（服务端自行生成 authorize URL，适用于
    //   state/nonce 与会话绑定的站点，如 oc/calendar/i）
    // - 否则直接请求 jaccount authorize（适用于服务端不校验 state 的站点，如 pe/make）
    // 返回 bridge 响应，resp.url 为最终落地地址（可从中提取 code 或判断落地域）
    async oauth2Chain({ service, entry, clientId, redirectUri, scope, state, params } = {}) {
        const headers = { 'User-Agent': CHROME_UA };
        if (entry) {
            return this.bridge.request(service, entry, { params, headers });
        }
        return this.bridge.request('jaccount', '/oauth2/authorize', {
            params: {
                response_type: 'code',
                ...(scope ? { scope } : {}),
                client_id: clientId,
                redirect_uri: redirectUri,
                ...(state ? { state } : {}),
                ...(params || {})
            },
            headers
        });
    }
}

//另外注册一个事件 onLoginSuccess，返回token
export default new JWBAuth();
