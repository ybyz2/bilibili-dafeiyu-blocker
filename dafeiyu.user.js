// ==UserScript==
// @name         屏蔽大肥鱼
// @namespace    dafeiyu
// @version      1.3.0
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
  var RE_QUOTE = /^回复\s*@[\s\S]{0,40}?\s*[:：]\s*/;
  var RE_DASH  = /[\u2014\u2015\u2500]|--/;
  var RE_CHAR  = /[鱼鲸]/;
  var RE_PUNCT = /[：；]/;
  var RE_CORNER = /[「」]/;

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

    /* 账号名含鱼/鲸：所有档位一律屏蔽（这条精度 100%，不参与档位取舍） */
    var m = r && r.member;
    if (m && RE_NAME.test(m.uname || m.name || '')) return true;

    if (tier === 'atonly') return body.indexOf('@') !== -1;

    if (RE_BRAND.test(full)) return true;
    if (tier === 'cup') return false;
    if (body.indexOf('@') !== -1) return true;
    if (tier === 'standard') return false;
    if (RE_CHAR.test(full)) return true;
    if (RE_PUNCT.test(full)) return true;
    if (RE_DASH.test(full)) return true;
    if (RE_CORNER.test(full)) return true;
    return false;
  }

  /* ============ 已清计数 ============ */

  /*
   * 只统计「这份评论列表里真正不会出现在页面上的评论」，三条规矩：
   *   1. 同一个 rpid 只算一次 —— 翻页重叠、切排序、重复展开楼中楼都不会重复计数
   *   2. 一级评论首屏（换排序 / 换视频 / 刷新）时清零重算，不会一路累加
   *   3. 只有真的把改过的数据交给页面之后才记数 —— 构造响应失败就不记，
   *      避免出现「数字涨了但评论还在」
   *
   * 一条一级评论命中时，它的楼中楼被整楼带走。接口只给前 2~3 条预览，
   * 所以楼中楼按 rcount（真实条数）记，不会少算。
   */
  var stat = { r: 0, s: 0 };     /* 一级评论 / 楼中楼 */
  var counted = {};              /* 本轮已计过数的 rpid */
  var countedN = 0;
  var COUNT_CAP = 50000;

  function statTotal() { return stat.r + stat.s; }

  function resetCount() {
    stat.r = 0;
    stat.s = 0;
    counted = {};
    countedN = 0;
  }

  /* items: [{ id, r, s }]，id 为 null 时不去重 */
  function commitCount(items) {
    var k, it, key;
    for (k = 0; k < items.length; k++) {
      it = items[k];
      if (it.id != null) {
        key = '' + it.id;
        if (counted[key]) continue;
        if (countedN >= COUNT_CAP) continue;
        counted[key] = 1;
        countedN++;
      }
      stat.r += it.r || 0;
      stat.s += it.s || 0;
    }
    drawBanner();
    /* 单页路由切换后评论区整块重建，banner 会被一起摘掉，这里补插回去 */
    if (config.showCount && (!bHost || !bHost.isConnected)) watchMount();
  }

  /*
   * 首屏请求来了就先按这个列表重算：换排序、换视频、刷新都会重发首屏，
   * 那时候旧数字已经不属于当前列表了。
   */
  function onFirstPage() { resetCount(); }

  /* 真的把改过的数据交给页面之后才结算 */
  function settle(r) {
    var mk = r.marks;
    if (mk) {
      for (var k = 0; k < mk.length; k++) {
        if (counted[mk[k]]) continue;
        if (countedN >= COUNT_CAP) break;
        counted[mk[k]] = 1;
        countedN++;
      }
    }
    commitCount(r.items);
  }

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

  /*
   * 过滤一份接口数据，只做「改数据 + 记账单」，不碰全局计数（交给 settle）。
   * 返回 null = 这份数据不用管；否则返回 { items }，
   * items 是被删掉的评论清单（一级 / 楼中楼分开）。
   */
  function filterPayload(json, kind) {
    var data = json && json.data;
    if (!data) return null;

    var tier = config.tier;
    var sub = config.sub;
    var items = [], marks = [], kept, i, j, c, kids, hit, hitKids, k;

    /* ---- 楼中楼接口 ---- */
    if (kind === 2) {
      if (sub === 'none') return null;
      var list = data.replies;
      if (!list || !list.length) return null;
      kept = [];
      for (i = 0; i < list.length; i++) {
        if (isBlocked(list[i], tier)) {
          items.push({ id: list[i] && list[i].rpid, r: 0, s: 1 });
          continue;
        }
        kept.push(list[i]);
      }
      if (!items.length) return null;
      data.replies = kept;
      return { items: items, marks: null };
    }

    /* ---- 一级评论 ---- */
    var roots = data.replies;
    if (!roots || !roots.length) return null;

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

    kept = [];
    for (i = 0; i < roots.length; i++) {
      c = roots[i];

      if (pinned && c && pinned[c.rpid]) { kept.push(c); continue; }

      var rootHit = isBlocked(c, tier);
      kids = (c && c.replies) || [];
      var hasKids = kids.length > 0;
      /* 整楼删除时楼中楼全没：接口只给预览，rcount 才是真条数 */
      var kidTotal = Math.max((c && c.rcount) || 0, kids.length);

      if (rootHit) {
        items.push({ id: c && c.rpid, r: 1, s: kidTotal });
        /* 预览里这几条楼中楼已经算在 rcount 里了，记个标记避免重复 */
        for (j = 0; j < kids.length; j++) {
          if (kids[j] && kids[j].rpid != null) marks.push('' + kids[j].rpid);
        }
        continue;
      }

      if (!hasKids || sub === 'none') { kept.push(c); continue; }

      /* 主楼未命中，看楼中楼（判定只跑一遍，命中列表留着后面用） */
      hitKids = [];
      for (j = 0; j < kids.length; j++) {
        if (isBlocked(kids[j], tier)) hitKids.push(j);
      }
      hit = hitKids.length;
      if (!hit) { kept.push(c); continue; }

      if (sub === 'whole') {
        items.push({ id: c && c.rpid, r: 1, s: Math.max((c && c.rcount) || 0, kids.length) });
        for (j = 0; j < kids.length; j++) {
          if (kids[j] && kids[j].rpid != null) marks.push('' + kids[j].rpid);
        }
        continue;
      }

      /* only：只删命中的楼中楼，主楼保留 */
      var rest = [], drop = {};
      for (k = 0; k < hitKids.length; k++) {
        j = hitKids[k];
        drop[j] = 1;
        items.push({ id: kids[j] && kids[j].rpid, r: 0, s: 1 });
      }
      for (j = 0; j < kids.length; j++) {
        if (!drop[j]) rest.push(kids[j]);
      }
      c.replies = rest;
      /* 「共 N 条回复」跟着减，免得点开是空的（空楼） */
      if (c.rcount) c.rcount = Math.max(0, c.rcount - hit);
      kept.push(c);
    }

    if (items.length) data.replies = kept;

    return { items: items, marks: marks.length ? marks : null };
  }

  /*
   * 首屏请求判定：换了排序、换了视频、刷新，都会重新拉第一页。
   * wbi/main 用 pagination_str={"offset":""}，旧版用 next=0 / pn=1。
   */
  function isFirstPageReq(url) {
    if (!url) return false;
    var u = url;
    try { u = decodeURIComponent(url); } catch (e) {}
    if (u.indexOf('pagination_str') !== -1) return u.indexOf('"offset":""') !== -1;
    if (!/[?&]next=/.test(u) && !/[?&]pn=/.test(u)) return true;
    return /[?&]next=0(&|$)/.test(u) || /[?&]pn=1(&|$)/.test(u);
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
      o.onclick = function () {
        config.tier = t.id; save(); pick(tg, t.id);
        resetCount(); drawBanner();     /* 旧数字属于旧规则，清掉 */
      };
      tg.appendChild(o);
    });
    panel.appendChild(tg);

    panel.appendChild(el('div', 'g', '楼中楼'));
    var sg = el('div');
    SUBS.forEach(function (t) {
      var o = el('div', 'o' + (config.sub === t.id ? ' on' : ''), t.label);
      o.dataset.v = t.id;
      o.onclick = function () {
        config.sub = t.id; save(); pick(sg, t.id);
        resetCount(); drawBanner();
      };
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
        bText.textContent = '已清 ' + statTotal() + ' 条';
        bText.title = '一级评论 ' + stat.r + ' 条 · 楼中楼 ' + stat.s + ' 条';
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
      bText.textContent = '已清 ' + statTotal() + ' 条';
      bText.title = '一级评论 ' + stat.r + ' 条 · 楼中楼 ' + stat.s + ' 条';
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

  /* ============ 拦截 ============ */

  /*
   * 复刻一份响应。改过的数据要塞回给页面，但不复制真实 Response 会有麻烦：
   *   - 有的埋点 / 日志会读 response.type、url
   *   - 被 302 跟随过的响应，body 已消费，直接 clone 会抛
   * 复制失败就原样放行（评论没删掉，但至少不炸页面），也不记数。
   */
  var RESP_KEYS = ['type', 'url', 'redirected'];

  function cloneRes(res, text) {
    var headers = new W.Headers(res.headers);
    try { headers['delete']('content-length'); } catch (e) {}
    try { headers['delete']('content-encoding'); } catch (e) {}
    var opts = { status: res.status, statusText: res.statusText, headers: headers };
    var init = { status: res.status, statusText: res.statusText, headers: headers };
    for (var i = 0; i < RESP_KEYS.length; i++) {
      try { if (res[RESP_KEYS[i]] !== undefined) init[RESP_KEYS[i]] = res[RESP_KEYS[i]]; } catch (e) {}
    }
    var out;
    try { out = new W.Response(text, init); }
    catch (e) { out = new W.Response(text, opts); }

    for (var j = 0; j < RESP_KEYS.length; j++) {
      (function (k) {
        try {
          Object.defineProperty(out, k, { configurable: true, get: function () { return res[k]; } });
        } catch (e) {}
      })(RESP_KEYS[j]);
    }
    return out;
  }

  function hookFetch() {
    var raw = W.fetch;
    if (typeof raw !== 'function' || raw.__dfy) return;

    var wrapped = function (input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var kind = apiKind(url);
      var promise = raw.apply(this, arguments);
      if (!kind) return promise;

      var first = kind === 1 && isFirstPageReq(url);

      return promise.then(function (res) {
        if (!res || !res.ok) return res;
        return res.clone().text().then(function (txt) {
          var json;
          try { json = JSON.parse(txt); } catch (e) { return res; }

          var r = null;
          try { r = filterPayload(json, kind); } catch (e) { return res; }

          /* 首屏：换成新的那个列表，数字重新算（请求失败就不动） */
          if (first && r) onFirstPage();
          if (!r || !r.items.length) {
            if (first && r) drawBanner();
            return res;
          }

          var out;
          try { out = cloneRes(res, JSON.stringify(json)); }
          catch (e) { return res; }

          /* 真的交给页面了才记账 */
          settle(r);
          return out;
        })['catch'](function () { return res; });
      });
    };

    wrapped.__dfy = 1;
    W.fetch = wrapped;
  }

  /*
   * XHR：responseText / response 都是只读原型属性，只能在实例上挂 getter 覆盖。
   *
   * 关键是「什么时候覆盖」。如果等 readystatechange 再挂，就依赖监听器的注册顺序——
   * 页面只要比我们早注册（比如 open 之前就挂了 onloadend），它读到的就是原始数据：
   * 评论没删掉，数字却涨了。这是最难复现的那类 bug。
   *
   * 所以改成「读的时候才变」：在 send() 里就挂上 getter，
   * 不管页面从哪个回调、按什么顺序读，读到的都是过滤后的数据。
   */
  function hookXHR() {
    var XHR = W.XMLHttpRequest;
    if (!XHR || XHR.__dfy) return;

    var proto = XHR.prototype;
    var dText = null, dResp = null;
    try {
      dText = Object.getOwnPropertyDescriptor(proto, 'responseText');
      dResp = Object.getOwnPropertyDescriptor(proto, 'response');
    } catch (e) {}
    if (!dText || !dText.get || !dResp || !dResp.get) return;

    var getText = dText.get;
    var getResp = dResp.get;

    /* 一份响应只解析一次，两个属性共用结果 */
    function once(xhr) {
      if (xhr.__dfyDone) return xhr.__dfyCache;
      if (xhr.readyState !== 4) return null;          /* 还在下载，先别缓存 */
      if (!xhr.__dfyKind) return null;
      if (xhr.status < 200 || xhr.status >= 300) { xhr.__dfyDone = 1; return (xhr.__dfyCache = null); }

      xhr.__dfyDone = 1;
      var r = null;
      try {
        var rt = xhr.responseType;
        var isJson = rt === 'json';
        if (!isJson && rt !== '' && rt !== 'text') { return (xhr.__dfyCache = null); }

        var raw = isJson ? getResp.call(xhr) : getText.call(xhr);
        if (!raw) return (xhr.__dfyCache = null);

        var obj = isJson ? raw : JSON.parse(raw);
        var f = filterPayload(obj, xhr.__dfyKind);
        if (xhr.__dfyFirst && f) onFirstPage();      /* 首屏：换成新列表，重新算 */
        if (!f || !f.items.length) {
          if (xhr.__dfyFirst && f) drawBanner();
          return (xhr.__dfyCache = null);
        }
        f.isJson = isJson;
        f.obj = obj;
        f.out = isJson ? obj : JSON.stringify(obj);
        settle(f);          /* 改过之后才记账 */
        r = f;
      } catch (err) { r = null; }
      return (xhr.__dfyCache = r);
    }

    var open = proto.open;
    proto.open = function (m, url) {
      this.__dfyKind = apiKind(url);
      this.__dfyFirst = this.__dfyKind === 1 && isFirstPageReq(url);
      this.__dfyDone = 0;        /* 实例会被连接池复用，每次 open 都要重置 */
      this.__dfyCache = null;
      return open.apply(this, arguments);
    };

    var send = proto.send;
    proto.send = function () {
      var xhr = this;
      if (xhr.__dfyKind) {
        try {
          Object.defineProperty(xhr, 'responseText', {
            configurable: true,
            get: function () {
              if (xhr.responseType === 'json') return getText.call(xhr);  /* 原生就该抛 */
              var r = once(xhr);
              return (r && r.items.length) ? r.out : getText.call(xhr);
            }
          });
          Object.defineProperty(xhr, 'response', {
            configurable: true,
            get: function () {
              var r = once(xhr);
              return (r && r.items.length) ? (r.isJson ? r.obj : r.out) : getResp.call(xhr);
            }
          });
        } catch (e) {}
      }
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

  /* Esc 关闭面板。事件要从页面的 window 上听 */
  try {
    (W.addEventListener ? W : document).addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) closePanel();
    }, true);
  } catch (e) {}

  if (typeof GM_registerMenuCommand === 'function') {
    try {
      GM_registerMenuCommand('设置', openPanel);
    } catch (e) {}
  }

})();
