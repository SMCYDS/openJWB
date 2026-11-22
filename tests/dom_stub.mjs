// Small DOM boundary fixture for plugin lifecycle/event tests (no browser globals).
export class Element {
    constructor(tag, document) {
        this.tagName = tag;
        this.ownerDocument = document;
        this.children = [];
        this.dataset = {};
        this.hidden = false;
        this.disabled = false;
        this.textContent = '';
        this.value = '';
        this.listeners = new Map();
        this.classes = new Set();
        this.classList = { add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name) };
        this.attributes = {};
        this.fields = new Map();
        this.actions = new Map();
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(child) {
        child.parent = this;
        this.children.push(child);
        if (this.tagName === 'select' && this.children.length === 1) this.value = child.value;
        return child;
    }
    replaceChildren(...children) {
        this.children = [];
        this.value = '';
        this.fields.clear();
        this.actions.clear();
        for (const child of children) this.appendChild(child);
    }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this); }
    addEventListener(name, fn, options = {}) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add(fn);
        options.signal?.addEventListener('abort', () => this.listeners.get(name).delete(fn));
    }
    async click() {
        if (!this.disabled) await Promise.all([...this.listeners.get('click') || []].map((fn) => fn({ target: this })));
    }
    set innerHTML(html) {
        this.replaceChildren();
        for (const match of html.matchAll(/<(input|select|button|pre|img)[^>]*data-(field|action)="([^"]+)"[^>]*>/g)) {
            const element = this.ownerDocument.createElement(match[1]);
            element.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
            (match[2] === 'field' ? this.fields : this.actions).set(match[3], element);
            this.appendChild(element);
        }
    }
    querySelector(selector) {
        const match = selector.match(/\[data-(field|action)="([^"]+)"\]/);
        return match ? (match[1] === 'field' ? this.fields : this.actions).get(match[2]) : null;
    }
}

export class Document {
    createElement(tag) { return new Element(tag, this); }
}
