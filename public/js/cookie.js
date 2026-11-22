// 上游 Cookie 留在 Python 的独立会话中；这里仅封装浏览器对 bridge 的访问。
export class CookieBridge {
    async send(action, payload = {}) {
        const response = await fetch(`/api/bridge/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || 'Bridge 请求失败');
        return result;
    }

    async start() {
        await this.send('session');
    }

    async request(service, path, options = {}) {
        const result = await this.send('request', { ...options, service, path });
        const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
        if (result.status >= 400) {
            const error = new Error(`${service} 请求失败 (${result.status})`);
            error.status = result.status;
            error.body = new TextDecoder().decode(bytes);
            throw error;
        }
        return {
            bytes,
            status: result.status,
            contentType: result.contentType,
            url: result.url,
            text: () => new TextDecoder().decode(bytes),
            json: () => JSON.parse(new TextDecoder().decode(bytes))
        };
    }

    async cookie(service, name) {
        return (await this.send('cookie', { service, name })).value;
    }

    async setCookie(service, name, value) {
        return await this.send('cookie/set', { service, name, value });
    }
}
