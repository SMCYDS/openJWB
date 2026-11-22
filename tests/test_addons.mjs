import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAddonHost, createAuthChannel } from '../public/js/addon-host.js';
import { Document } from './dom_stub.mjs';

const document = new Document();
const nav = document.createElement('nav');
const content = document.createElement('main');
let cookie = 'account-a';
const auth = createAuthChannel(() => cookie);
const config = { optional: { kind: 'addon', entry: '/plugins/missing/index.js', enabled: false, chinese: '选装插件' } };
let imports = 0;
const disabled = createAddonHost({ config, nav, content, auth, document, onSelect() {},
    loadModule: async () => { imports++; throw new Error('must not import disabled plugin'); } });
await disabled.activate('optional');
assert.equal(imports, 0);
assert.equal(nav.children[0].tagName, 'hr');
assert.equal(nav.children[0].attributes['aria-label'], '基础模块与附属插件分隔');
disabled.dispose();
assert.equal(nav.children.length, 0);

// Missing optional assets fail locally; the host still supports other modules.
config.optional.enabled = true;
const missing = createAddonHost({ config, nav, content, auth, document, onSelect() {},
    loadModule: async () => { throw new Error('404'); } });
await missing.activate('optional');
assert.match(content.children[0].textContent, /加载失败.*基础模块仍可使用/);
missing.hideAll();
assert.equal(content.children[0].hidden, true);
missing.dispose();

// Pending import cannot activate or leak a plugin after host disposal.
let completeImport;
let disposed = 0;
const delayed = createAddonHost({ config, nav, content, auth, document, onSelect() {},
    loadModule: () => new Promise((resolve) => { completeImport = resolve; }) });
const opening = delayed.activate('optional');
delayed.dispose();
completeImport({ mount: async () => ({ dispose: () => { disposed++; }, activate: () => assert.fail('disposed host activated') }) });
await opening;
assert.equal(disposed, 1);

// Main entry has no static import edge into optional plugins, including transitive imports.
const visited = new Set();
async function visit(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    const source = await readFile(url, 'utf8');
    for (const match of source.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"]/gm)) {
        const dependency = new URL(match[1], url);
        assert.ok(!dependency.pathname.includes('/plugins/'), 'core imports optional assets');
        await visit(dependency);
    }
}
await visit(new URL('../public/index.js', import.meta.url));
const main = await readFile(new URL('../public/index.js', import.meta.url), 'utf8');
assert.doesNotMatch(main, /jwsign|jwlivesign|livesign-/);

// Execute the actual main entry with an uninstalled, disabled addon and Canvas off.
// Stub only upstream APIs/browser primitives; keep main navigation and host code real.
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalStorage = globalThis.localStorage;
const bootDocument = new Document();
const bootElements = new Map();
const bootSections = new Map();
bootDocument.getElementById = (id) => {
    if (!bootElements.has(id)) bootElements.set(id, bootDocument.createElement('div'));
    return bootElements.get(id);
};
const bootContent = bootDocument.createElement('main');
bootDocument.querySelector = (selector) => {
    if (selector === 'main') return bootContent;
    const id = selector.match(/data-module="([^"]+)"/)?.[1];
    if (!bootSections.has(id)) bootSections.set(id, bootDocument.createElement('section'));
    return bootSections.get(id);
};
const hideListeners = [];
const baseIds = ['jwbauth', 'jwbasic', 'jwbpe', 'ocanvas', 'jwmake', 'jwelect', 'jwactivity', 'jwids', 'jwlive'];
globalThis.window = {
    plugins: Object.fromEntries(baseIds.map((id) => [id, { enabled: id === 'jwbauth' }])),
    addEventListener: (name, listener) => { if (name === 'pagehide') hideListeners.push(listener); }
};
globalThis.window.plugins.uninstalled = { kind: 'addon', enabled: false, entry: '/plugins/not-installed/index.js' };
globalThis.document = bootDocument;
globalThis.localStorage = { getItem: () => null };
globalThis.__bootAPIs = {
    base: { buildings: {}, setJAAuthCookie() {}, login: () => assert.fail('disabled base API logged in') },
    auth: {
        bridge: { start: async () => {}, cookie: async () => null },
        onLoginSuccess() {},
        initLogin: async () => ({ addEventListener() {} })
    },
    host: { createAddonHost, createAuthChannel }
};
try {
    const bootSource = main.replace(/^import (.+) from ['"](.+)['"];$/gm, (_, binding, path) => {
        if (path.endsWith('/addon-host.js')) return `const ${binding}=globalThis.__bootAPIs.host;`;
        if (path.endsWith('/jwlive.js')) return 'const jwlive=globalThis.__bootAPIs.base; const liveCourseTime=()=>0, liveCourseDay=()=>"";';
        return `const ${binding}=globalThis.__bootAPIs.${path.endsWith('/jwbauth.js') ? 'auth' : 'base'};`;
    });
    await import('data:text/javascript;base64,' + Buffer.from(bootSource).toString('base64'));
    const bootNav = bootElements.get('module-nav');
    assert.equal(bootNav.children.filter((node) => node.tagName === 'hr').length, 1);
    await bootNav.children.at(-1).click();
    assert.match(bootContent.children[0].textContent, /未启用/);
    await bootNav.children[0].click();
    assert.equal(bootSections.get('jwbauth').hidden, false);
    assert.equal(bootContent.children[0].hidden, true);
    hideListeners.forEach((listener) => listener({ persisted: false }));
} finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.localStorage = originalStorage;
}
console.log('Optional plugin loading, missing assets, disposal and import isolation checks passed');
