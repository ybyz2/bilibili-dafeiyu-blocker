'use strict';
const fs = require('fs');
const vm = require('vm');

const path = require('path');
const SRC_PATH = process.env.DFY_SRC || path.join(__dirname, '..', 'dafeiyu.user.js');

function makeEl(tag) {
  const el = {
    tagName: tag,
    style: { cssText: '', display: 'block', width: '' },
    dataset: {},
    children: [],
    textContent: '',
    title: '',
    className: '',
    classList: {
      _s: new Set(),
      toggle(c, on) { if (on === undefined) { if (this._s.has(c)) this._s.delete(c); else this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }
    },
    appendChild(c) { if (c) c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c) { if (c) { c.parentNode = this; c.isConnected = true; } this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter(function (x) { return x !== c; }); return c; },
    remove() { this.isConnected = false; },
    setAttribute() { this._attr = 1; },
    getAttribute() { return null; },
    hasAttribute() { return false; },
    querySelectorAll() { return []; },
    removeAttribute() { this._attr = 0; },
    getRootNode() { return this._root || null; },
    attachShadow() { const s = makeEl('#shadow'); s._root = s; this.shadowRoot = s; return s; },
    focus() {},
    querySelector() { return null; },
    get offsetWidth() { return 100; },
    get offsetHeight() { return 30; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 40, bottom: 40 }; },
    isConnected: true,
    scrollHeight: 10,
    clientHeight: 10
  };
  Object.defineProperty(el, 'firstChild', { get() { return this.children[0] || null; } });
  return el;
}

function makeEnv(opts) {
  opts = opts || {};
  const store = Object.assign(Object.create(null), opts.store || {});
  const listeners = Object.create(null);
  const timers = [];
  const doc = {
    cookie: opts.cookie === undefined ? 'bili_jct=ABCDEF0123456789; SESSDATA=x' : opts.cookie,
    documentElement: makeEl('html'),
    head: makeEl('head'),
    body: makeEl('body'),
    visibilityState: 'visible',
    readyState: 'complete',
    createElement: makeEl,
    createTextNode: function (t) { return { nodeValue: t }; },
    querySelector: function (sel) {
      if (!opts.mount) return null;
      if (sel === '#commentapp bili-comments') return opts.mount.comments;
      if (sel === '#comment .reply-warp') return null;
      if (sel === '.reply-warp') return null;
      return null;
    },
    querySelectorAll: function () { return []; },
    addEventListener: function (t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: function () {}
  };
  const win = {
    document: doc,
    location: { hostname: 'www.bilibili.com', pathname: '/video/BV1xx411c7mD', href: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    innerWidth: 1280,
    innerHeight: 800,
    MutationObserver: class { observe() {} disconnect() {} },
    addEventListener: function (t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: function () {},
    setTimeout: function (fn, ms) { const id = setTimeout(fn, ms); timers.push(id); return id; },
    clearTimeout: function (t) { return clearTimeout(t); },
    Promise: Promise,
    Headers: class { constructor() {} delete() {} },
    Response: class { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; } },
    fetch: opts.fetch || function () { return Promise.resolve({ ok: true, status: 200 }); },
    XMLHttpRequest: function XMLHttpRequest() {},
    console: console
  };
  win.XMLHttpRequest.prototype = { open: function () {}, send: function () {} };
  win.window = win;
  win.unsafeWindow = win;

  const ctx = vm.createContext(win);
  ctx.GM_getValue = function (k, d) { return (k in store) ? store[k] : d; };
  ctx.GM_setValue = function (k, v) { if (opts.gmSetFail) throw new Error('QuotaExceeded'); store[k] = String(v); };
  ctx.GM_registerMenuCommand = function () { return 1; };

  let src = fs.readFileSync(SRC_PATH, 'utf8');
  const probe = fs.readFileSync(process.env.DFY_PROBE || path.join(__dirname, 'probe.js'), 'utf8');
  const marker = '})();';
  const at = src.lastIndexOf(marker);
  if (at < 0) throw new Error('cannot find IIFE tail');
  src = src.slice(0, at) + probe + '\n' + src.slice(at);
  try {
    vm.runInContext(src, ctx, { filename: SRC_PATH });
  } catch (e) {
    console.error('SCRIPT LOAD ERROR:', e && e.stack || e);
    throw e;
  }
  if (!win.__t) throw new Error('probe failed');
  win.__store = store;
  win.__listeners = listeners;
  win.__timers = timers;
  return win;
}

module.exports = { makeEnv: makeEnv, makeEl: makeEl };
