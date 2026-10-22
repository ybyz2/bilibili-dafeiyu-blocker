// ==UserScript==
// @name         屏蔽大肥鱼
// @namespace    dafeiyu
// @version      1.2.0
// @description  屏蔽B站评论区里的大肥鱼
// @match        https://www.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @homepageURL  https://github.com/ybyz2/bilibili-dafeiyu-blocker
// @supportURL   https://github.com/ybyz2/bilibili-dafeiyu-blocker/issues
// @updateURL    https://raw.githubusercontent.com/ybyz2/bilibili-dafeiyu-blocker/main/dafeiyu.user.js
// @downloadURL  https://raw.githubusercontent.com/ybyz2/bilibili-dafeiyu-blocker/main/dafeiyu.user.js
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  var W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__dfy) return;
  W.__dfy = 1;

  /* ============ 配置 ============ */

  var HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  var SKEY = 'dafeiyu.config.v2';
  var VALID_TIER = { cup: 1, standard: 1, kill: 1, atonly: 1 };
  var VALID_SUB  = { only: 1, whole: 1, none: 1 };

  var config = { tier: 'standard', sub: 'only', showCount: true };

  (function load() {
    var raw = null;
    try { raw = HAS_GM ? GM_getValue(SKEY, null) : W.localStorage.getItem(SKEY); }
    catch (e) { return; }
    if (!raw) return;
    try {
      var o = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!o || typeof o !== 'object') return;
      if (VALID_TIER[o.tier]) config.tier = o.tier;
      if (VALID_SUB[o.sub]) config.sub = o.sub;
      if (typeof o.showCount === 'boolean') config.showCount = o.showCount;
    } catch (e) {}
  })();

  function save() {
    var s = JSON.stringify(config);
    try {
      if (HAS_GM) GM_setValue(SKEY, s);
      else W.localStorage.setItem(SKEY, s);
    } catch (e) {}
  }

  /* ============ 判定 ============ */

  var RE_NAME  = /鱼|鲸/;
  var RE_BRAND = /大肥鱼|肥鱼|鲸鱼|大肥鲸|鲸鱼娘|本鲸|本鱼|本肥鱼|主人/;
  var RE_QUOTE = /^回复\s*@[\s\S]{0,24}?\s*[:：]\s*/;
  var RE_DASH  = /[\u2014\u2015\u2500]|--/;
  var RE_CHAR  = /[鱼鲸]/;
  var RE_PUNCT = /[：；]/;

  function textOf(r) {
    var c = r && r.content;
    return c && typeof c.message === 'string' ? c.message : '';
  }

  function isBlocked(r, tier) {
    var full = textOf(r);

    /* @ 只看剥掉系统前缀后的正文；关键词看完整原文 */
    var body = full;
    if (full.charCodeAt(0) === 0x56DE /* 回 */ && full.charCodeAt(1) === 0x590D /* 复 */) {
      var m = RE_QUOTE.exec(full);
      if (m) body = full.slice(m[0].length);
    }

    if (tier === 'atonly') return body.indexOf('@') !== -1;

    var m = r && r.member;
    if (m && RE_NAME.test(m.uname || m.name || '')) return true;

    if (RE_BRAND.test(full)) return true;
    if (tier === 'cup') return false;
    if (body.indexOf('@') !== -1) return true;
    if (tier === 'standard') return false;
    if (RE_CHAR.test(full)) return true;
    if (RE_PUNCT.test(full)) return true;
    if (RE_DASH.test(full)) return true;
    return false;
  }

  var removed = 0;

  /* ============ 处理接口数据 ============ */

  /* 只处理真正带评论数组的接口，避免解析 subject/description 这类无关响应 */
  function apiKind(url) {
    if (!url || url.indexOf('/x/v2/reply') === -1) return 0;
    if (url.indexOf('/x/v2/reply/reply') !== -1) return 2;      // 楼中楼
    if (url.indexOf('/x/v2/reply/wbi/main') !== -1) return 1;   // 一级（wbi）
    if (url.indexOf('/x/v2/reply/main') !== -1) return 1;       // 一级
    if (url.indexOf('/x/v2/reply?') !== -1) return 1;           // 旧版一级
    return 0;   /* add / del / action / subject / report 等一律跳过 */
  }

  function processPayload(json, kind) {
    var data = json && json.data;
    if (!data) return 0;

    var tier = config.tier;
    var sub = config.sub;
    var n = 0, kept, i, j, c;

    /* 楼中楼接口 */
    if (kind === 2) {
      if (sub === 'none') return 0;
      var list = data.replies;
      if (!list || !list.length) return 0;
      kept = [];
      for (i = 0; i < list.length; i++) {
        if (isBlocked(list[i], tier)) { n++; continue; }
        kept.push(list[i]);
      }
      if (n) data.replies = kept;
      removed += n;
      markDirty();
      return n;
    }

    /* 置顶不处理 */
    var pinned = null;
    var tops = data.top_replies;
    if (tops && tops.length) {
      pinned = {};
      for (i = 0; i < tops.length; i++) {
        if (tops[i] && tops[i].rpid != null) pinned[tops[i].rpid] = 1;
      }
    }
    if (data.top && data.top.upper && data.top.upper.rpid != null) {
      pinned = pinned || {};
      pinned[data.top.upper.rpid] = 1;
    }

    var roots = data.replies;
    if (!roots || !roots.length) return 0;

    kept = [];
    for (i = 0; i < roots.length; i++) {
      c = roots[i];

      if (pinned && c && pinned[c.rpid]) { kept.push(c); continue; }

      var rootHit = isBlocked(c, tier);
      var kids = c && c.replies;
      var hasKids = kids && kids.length;

      if (rootHit) {
        n += 1 + (hasKids ? kids.length : 0);
        continue;
      }

      if (!hasKids || sub === 'none') { kept.push(c); continue; }

      /* 主楼未命中，看楼中楼 */
      var hitCount = 0;
      for (j = 0; j < kids.length; j++) {
        if (isBlocked(kids[j], tier)) hitCount++;
      }

      if (!hitCount) { kept.push(c); continue; }

      if (sub === 'whole') {
        n += 1 + kids.length;
        continue;
      }

      /* only：只删命中的楼中楼 */
      var rest = [];
      for (j = 0; j < kids.length; j++) {
        if (isBlocked(kids[j], tier)) continue;
        rest.push(kids[j]);
      }
      c.replies = rest;
      n += hitCount;
      kept.push(c);
    }

    if (n) data.replies = kept;
    removed += n;
    markDirty();
    return n;
  }


  /* ============ 界面 ============ */

  var CSS = ":host{all:initial}\n*{box-sizing:border-box;margin:0;padding:0}\n\n/* 主题变量 */\n.t{\n  --bg:rgba(252,251,249,.94);--bd:rgba(0,0,0,.07);--tx:#1f1f23;--dim:#8b8b94;\n  --sh:0 20px 48px -18px rgba(0,0,0,.34),0 2px 6px -2px rgba(0,0,0,.06),inset 0 1px 0 rgba(255,255,255,.9);\n  --hv:rgba(0,0,0,.05);--tg:rgba(0,0,0,.1);--line:rgba(0,0,0,.07)\n}\n.t.dk{\n  --bg:rgba(38,38,44,.94);--bd:rgba(255,255,255,.1);--tx:#f0f0f4;--dim:#9a9aa6;\n  --sh:0 20px 48px -18px rgba(0,0,0,.8),0 2px 6px -2px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.07);\n  --hv:rgba(255,255,255,.09);--tg:rgba(255,255,255,.16);--line:rgba(255,255,255,.09)\n}\n\n/* 面板 */\n.p{position:fixed;top:78px;right:18px;z-index:2147483600;width:300px;\npadding:20px 20px 14px;border-radius:20px;\nbackground:var(--bg);\nbackdrop-filter:blur(40px) saturate(180%);-webkit-backdrop-filter:blur(40px) saturate(180%);\nborder:1px solid var(--bd);box-shadow:var(--sh);\nfont-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"HarmonyOS Sans SC\",\"Microsoft YaHei\",sans-serif;\n-webkit-font-smoothing:antialiased;\ntransform-origin:top right;animation:pop .18s cubic-bezier(.2,.9,.3,1)}\n@keyframes pop{from{opacity:0;transform:scale(.93) translateY(-6px)}to{opacity:1;transform:none}}\n\n/* 关闭 */\n.x{position:absolute;top:13px;right:14px;width:26px;height:26px;\ndisplay:flex;align-items:center;justify-content:center;\nfont-size:19px;line-height:1;color:var(--dim);cursor:pointer;border-radius:8px;\ntransition:background .14s,color .14s;user-select:none}\n.x:hover{background:var(--hv);color:var(--tx)}\n\n/* 分组标题 */\n.g{font-size:11.5px;font-weight:600;color:var(--dim);letter-spacing:.1em;\npadding:16px 8px 7px}\n.g:first-of-type{padding-top:2px}\n\n/* 选项 */\n.o{font-size:16px;line-height:1.2;color:var(--tx);padding:12px 14px;border-radius:11px;cursor:pointer;\ntransition:background .14s,color .14s,transform .1s}\n.o:hover{background:var(--hv)}\n.o:active{transform:scale(.985)}\n.o.on{background:#fb7299;color:#fff;font-weight:600;\nbox-shadow:0 4px 14px -4px rgba(251,114,153,.7)}\n\n/* 开关行 */\n.s{display:flex;align-items:center;justify-content:space-between;\nfont-size:15px;color:var(--tx);\npadding:16px 8px 8px;margin-top:10px;border-top:1px solid var(--line)}\n.sw{width:42px;height:24px;border-radius:12px;background:var(--tg);position:relative;cursor:pointer;\ntransition:background .2s;flex:none}\n.sw.on{background:#fb7299}\n.sw:after{content:\"\";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;\nbackground:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);transition:left .2s cubic-bezier(.3,1.2,.5,1)}\n.sw.on:after{left:21px}\n\n/* 评论区那行字 */\n.b{display:inline-block;padding:12px 22px;margin:6px 0 20px;border-radius:12px;\nfont-size:16px;line-height:1.4;letter-spacing:.01em;user-select:none;font-weight:600;\nfont-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"HarmonyOS Sans SC\",\"Microsoft YaHei\",sans-serif;\n-webkit-font-smoothing:antialiased;\ncolor:#59616d;background:rgba(0,0,0,.055);\nborder:1px solid rgba(0,0,0,.055)}\n.b.dk{color:#c5cbd5;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.13)}";
 var TIERS = [
    { id: 'cup',      label: '小杯' },
    { id: 'standard', label: '标准' },
    { id: 'kill',     label: '杀戮' },
    { id: 'atonly',   label: '只屏蔽 @' }
  ];

  var SUBS = [
    { id: 'only',  label: '只删楼中楼' },
    { id: 'whole', label: '整楼删除' },
    { id: 'none',  label: '不管楼中楼' }
  ];

  var host = null, panel = null, swEl = null;
  var bHost = null, bText = null;

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  /* B站夜间模式：<html class="dark"> */
  function isDark() {
    var de = document.documentElement;
    if (!de) return false;
    var c = de.className || '';
    if (c.indexOf('dark') !== -1) return true;
    return de.getAttribute('data-theme') === 'dark';
  }

  function applyTheme(elm) {
    if (elm) elm.classList.toggle('dk', isDark());
  }

  function syncTheme() {
    if (panel) applyTheme(panel);
    if (bText) bText.classList.toggle('dk', isDark());
  }

  /* html.dark 变的时候跟着变 */
  /*
   * 主题跟随。html 的 class 变化很少，但用全量 attributes 监听会带来额外开销，
   * 这里只监听 class / data-theme 两个属性，且回调里不读 DOM（直接 toggle）。
   */
  var tmo = null;

  function watchTheme() {
    if (tmo || !W.MutationObserver) return;
    tmo = new W.MutationObserver(syncTheme);
    tmo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme']
    });
  }

  function pick(group, id) {
    var all = group.children;
    for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i].dataset.v === id);
  }

  function buildPanel() {
    if (panel) return;

    host = el('div');
    host.style.cssText = 'all:initial';
    var sh = host.attachShadow({ mode: 'open' });
    var st = el('style');
    st.textContent = CSS;
    sh.appendChild(st);

    panel = el('div', 'p t');
    applyTheme(panel);

    /* 关闭 */
    var x = el('div', 'x', '×');
    x.title = '关闭';
    x.onclick = closePanel;
    panel.appendChild(x);

    panel.appendChild(el('div', 'g', '屏蔽强度'));
    var tg = el('div');
    TIERS.forEach(function (t) {
      var o = el('div', 'o' + (config.tier === t.id ? ' on' : ''), t.label);
      o.dataset.v = t.id;
      o.onclick = function () { config.tier = t.id; save(); pick(tg, t.id); };
      tg.appendChild(o);
    });
    panel.appendChild(tg);

    panel.appendChild(el('div', 'g', '楼中楼'));
    var sg = el('div');
    SUBS.forEach(function (t) {
      var o = el('div', 'o' + (config.sub === t.id ? ' on' : ''), t.label);
      o.dataset.v = t.id;
      o.onclick = function () { config.sub = t.id; save(); pick(sg, t.id); };
      sg.appendChild(o);
    });
    panel.appendChild(sg);

    var sr = el('div', 's');
    sr.appendChild(el('span', null, '显示已清条数'));
    swEl = el('div', 'sw' + (config.showCount ? ' on' : ''));
    swEl.onclick = function () {
      config.showCount = !config.showCount;
      save();
      swEl.classList.toggle('on', config.showCount);
      if (config.showCount) {
        drawBanner();
        if (!bHost || !bHost.isConnected) watchMount();
      } else {
        drawBanner();
        stopWatch();
      }
    };
    sr.appendChild(swEl);
    panel.appendChild(sr);

    sh.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);
  }

  function openPanel() {
    buildPanel();
    applyTheme(panel);
    host.style.display = 'block';
  }

  function closePanel() {
    if (host) host.style.display = 'none';
  }

  /* ============ 评论区顶部「已清 N 条」 ============ */

  /*
   * 定位插入点。
   * 新评论区：<bili-comments> 是自定义元素，内容在 shadowRoot 里
   *   shadowRoot > #contents > [#reply-commentbox(发评论), #feed(评论列表), ...]
   *   → 插到 #feed 之前，正好是「发评论框」和「第一条评论」中间
   * 旧评论区：兜底用 #comment .reply-warp
   */
  function findMount() {
    var el2 = document.querySelector('#commentapp bili-comments');
    if (el2 && el2.shadowRoot) {
      var feed = el2.shadowRoot.querySelector('#feed');
      if (feed && feed.parentNode) return { parent: feed.parentNode, before: feed };
    }
    var host2 = document.querySelector('#comment .reply-warp') || document.querySelector('.reply-warp');
    if (host2) {
      var list = host2.querySelector('.reply-list') || host2.querySelector('.comment-list');
      if (list && list.parentNode) return { parent: list.parentNode, before: list };
      return { parent: host2, before: host2.firstChild };
    }
    return null;
  }

  function drawBanner() {
    if (!config.showCount) {
      if (bHost) { bHost.remove(); bHost = null; bText = null; }
      return;
    }

    if (bHost && bHost.isConnected) {
      if (bText) {
        bText.textContent = '已清 ' + removed + ' 条';
        bText.classList.toggle('dk', isDark());
      }
      return;
    }

    var m = findMount();
    if (!m) return;

    if (!bHost) {
      bHost = el('div');
      bHost.style.cssText = 'display:block;width:100%';

      var sh = bHost.attachShadow({ mode: 'open' });
      var st = el('style');
      st.textContent = CSS;
      sh.appendChild(st);

      bText = el('div', 'b');
      sh.appendChild(bText);
    }

    if (bText) {
      bText.textContent = '已清 ' + removed + ' 条';
      bText.classList.toggle('dk', isDark());
    }
    if (m.before) m.parent.insertBefore(bHost, m.before);
    else m.parent.appendChild(bHost);
  }

  /*
   * bili-comments 是懒加载的：DOMContentLoaded 时 shadowRoot 可能还不存在。
   * 只在还没插上时才监听，插上就断开，避免常驻开销。
   */
  var mo = null, moTimer = 0, moShadow = null;

  function watchMount() {
    if (mo || !config.showCount || !W.MutationObserver) return;

    var tries = 0;

    function retry() {
      if (!config.showCount) { stopWatch(); return; }
      if (bHost && bHost.isConnected) { stopWatch(); return; }
      if (++tries > 40) { stopWatch(); return; }
      drawBanner();
      if (bHost && bHost.isConnected) { stopWatch(); return; }
      watchShadow();
    }

    mo = new W.MutationObserver(retry);
    mo.observe(document.documentElement, { childList: true, subtree: true });

    /* 15 秒还没等到就放弃，不留常驻监听 */
    moTimer = setTimeout(stopWatch, 15000);
  }

  /* bili-comments 的内容在 shadowRoot 里，document 级观察器看不到，
   * 所以要单独观察它。 */
  function watchShadow() {
    if (moShadow || !config.showCount) return;
    var bc = document.querySelector('#commentapp bili-comments') || document.querySelector('bili-comments');
    if (!bc || !bc.shadowRoot) return;

    moShadow = new W.MutationObserver(function () {
      if (bHost && bHost.isConnected) { stopWatch(); return; }
      drawBanner();
      if (bHost && bHost.isConnected) stopWatch();
    });
    moShadow.observe(bc.shadowRoot, { childList: true, subtree: true });
  }

  function stopWatch() {
    if (moTimer) { clearTimeout(moTimer); moTimer = 0; }
    if (mo) { mo.disconnect(); mo = null; }
    if (moShadow) { moShadow.disconnect(); moShadow = null; }
  }

  function markDirty() { drawBanner(); }

  /* ============ 拦截 ============ */

  function hookFetch() {
    var raw = W.fetch;
    if (typeof raw !== 'function' || raw.__dfy) return;

    var wrapped = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var kind = apiKind(url);
      var promise = raw.apply(this, arguments);
      if (!kind) return promise;

      return promise.then(function (res) {
        if (!res || !res.ok) return res;
        return res.clone().text().then(function (txt) {
          var json;
          try { json = JSON.parse(txt); } catch (e) { return res; }

          var n = 0;
          try { n = processPayload(json, kind); } catch (e) { return res; }
          if (!n) return res;

          var headers = new W.Headers(res.headers);
          headers['delete']('content-length');
          return new W.Response(JSON.stringify(json), {
            status: res.status,
            statusText: res.statusText,
            headers: headers
          });
        })['catch'](function () { return res; });
      });
    };

    wrapped.__dfy = 1;
    W.fetch = wrapped;
  }

  function hookXHR() {
    var XHR = W.XMLHttpRequest;
    if (!XHR || XHR.__dfy) return;

    var open = XHR.prototype.open;
    XHR.prototype.open = function (m, url) {
      this.__dfyUrl = url;
      this.__dfyDone = 0;   /* 实例可能被复用，每次 open 都要重置 */
      return open.apply(this, arguments);
    };

    var send = XHR.prototype.send;
    XHR.prototype.send = function () {
      var url = this.__dfyUrl;
      var kind = apiKind(url);
      if (!kind) return send.apply(this, arguments);

      var xhr = this;
      xhr.addEventListener('readystatechange', function () {
        if (xhr.readyState !== 4 || xhr.__dfyDone) return;
        xhr.__dfyDone = 1;
        if (xhr.status < 200 || xhr.status >= 300) return;

        try {
          var isJson = xhr.responseType === 'json';
          var raw = isJson ? xhr.response : xhr.responseText;
          if (!raw) return;

          var obj = isJson ? raw : JSON.parse(raw);
          if (!processPayload(obj, kind)) return;

          var out = JSON.stringify(obj);
          var define = function (k, v) {
            try { Object.defineProperty(xhr, k, { configurable: true, get: function () { return v; } }); }
            catch (e) {}
          };
          if (isJson) {
            define('response', obj);
          } else {
            define('responseText', out);
            define('response', out);
          }
        } catch (e) {}
      });

      return send.apply(this, arguments);
    };

    XHR.__dfy = 1;
  }

  /* ============ 启动 ============ */

  hookFetch();
  hookXHR();

  function boot() {
    watchTheme();
    if (config.showCount) {
      drawBanner();
      /* 还没插上（评论区懒加载中）就短暂监听，插上即停 */
      if (!bHost || !bHost.isConnected) watchMount();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  /* 唯一的入口：脚本管理器菜单 */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closePanel();
  }, { passive: true });

  if (typeof GM_registerMenuCommand === 'function') {
    try {
      GM_registerMenuCommand('设置', openPanel);
    } catch (e) {}
  }

})();
