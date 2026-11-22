// Generic optional-plugin host. It knows no plugin IDs, business APIs or selectors.
export function createAuthChannel(getJAAuthCookie) {
    const listeners = new Set();
    return {
        getJAAuthCookie,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        notify() {
            for (const listener of listeners) {
                try { listener(getJAAuthCookie()); }
                catch (error) { console.error('[openJWB] 附属插件认证通知失败', error); }
            }
        }
    };
}

export function createAddonHost({ config, nav, content, onSelect, auth, services = {},
    document = globalThis.document, loadModule = (entry) => import(entry) }) {
    const entries = new Map();
    let selected = null;
    let disposed = false;
    let separator;
    let label;
    for (const [id, options] of Object.entries(config)) {
        if (options?.kind !== 'addon' || typeof options.entry !== 'string') continue;
        if (!separator) {
            separator = document.createElement('hr');
            separator.className = 'nav-divider';
            separator.setAttribute('aria-label', '基础模块与附属插件分隔');
            nav.appendChild(separator);
            label = document.createElement('div');
            label.className = 'nav-group-label';
            label.textContent = '附属插件';
            nav.appendChild(label);
        }
        const section = document.createElement('section');
        section.className = 'module';
        section.dataset.addon = id;
        section.hidden = true;
        content.appendChild(section);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nav-item';
        button.textContent = options.chinese || id;
        if (options.enabled !== true) {
            button.classList.add('locked');
            button.textContent += ' 🔒';
        }
        button.addEventListener('click', () => onSelect(id));
        nav.appendChild(button);
        entries.set(id, { options, section, button, loading: null, instance: null });
    }
    const host = {
        has: (id) => entries.has(id),
        hideAll() {
            selected = null;
            for (const item of entries.values()) {
                item.section.hidden = true;
                item.button.classList.remove('active');
            }
        },
        async activate(id) {
            host.hideAll();
            const item = entries.get(id);
            if (!item || disposed) return;
            selected = id;
            item.section.hidden = false;
            item.button.classList.add('active');
            if (item.options.enabled !== true) {
                item.section.textContent = '该附属插件未启用，请在插件配置中启用后刷新。';
                return;
            }
            try {
                if (!item.loading) {
                    item.section.textContent = '正在加载附属插件...';
                    item.loading = (async () => {
                        if (!/^\/plugins\/[a-zA-Z0-9_/-]+\.js$/.test(item.options.entry)) {
                            throw new Error('插件入口必须位于本站 /plugins/ 目录');
                        }
                        const module = await loadModule(item.options.entry);
                        const instance = await module.mount({ root: item.section, auth, services, config: item.options });
                        if (disposed) { instance?.dispose?.(); return; }
                        item.instance = instance;
                    })().catch((error) => { item.loading = null; throw error; });
                }
                await item.loading;
                if (!disposed && selected === id) await item.instance?.activate?.();
            } catch (error) {
                item.instance?.dispose?.();
                item.instance = null;
                item.loading = null;
                if (!disposed) item.section.textContent = `附属插件加载失败: ${error.message}。基础模块仍可使用。`;
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const item of entries.values()) {
                item.instance?.dispose?.();
                item.section.remove();
                item.button.remove();
            }
            entries.clear();
            separator?.remove();
            label?.remove();
        }
    };
    return host;
}
