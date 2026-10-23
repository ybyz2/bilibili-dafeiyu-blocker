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

  var MAX_WORDS = 100;   /* 自定义屏蔽词上限 */
  var MAX_LEN   = 24;    /* 单条长度上限 */

  var config = { tier: 'standard', sub: 'only', showCount: true, words: [] };

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
      if (o.words && o.words.length) {
        /* 去空、去重、截断，脏数据一律丢掉，不让它拖累每一条评论的判定 */
        var ws = [], seen = Object.create(null), w, lw;
        for (var i = 0; i < o.words.length && ws.length < MAX_WORDS; i++) {
          w = o.words[i];
          if (typeof w !== 'string') continue;
          w = w.replace(/^\s+|\s+$/g, '').slice(0, MAX_LEN);
          if (!w) continue;
          lw = w.toLowerCase();
          if (seen[lw]) continue;
          seen[lw] = 1;
          ws.push(w);
        }
        config.words = ws;
      }
    } catch (e) {}
  })();

  /* 写盘，返回是否真的写成功 */
  function writeOut() {
    var s = JSON.stringify(config);
    try {
      if (HAS_GM) GM_setValue(SKEY, s);
      else W.localStorage.setItem(SKEY, s);
    } catch (e) { return false; }
    return true;
  }

  function readBack() {
    try {
      var raw = HAS_GM ? GM_getValue(SKEY, null) : W.localStorage.getItem(SKEY);
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) { return null; }
  }

  /*
   * 保存 = 写盘 + 回读校验。
   * 用户点「保存」时其实早就生效了（改一下就落盘），这个按钮的意义是
   * 「确认刚刚那些改动真的存住了」，所以这里真的再读一遍比对，
   * 对不上就报失败，不能给一个假的「保存成功」。
   */
  function save() {
    var want = JSON.stringify(config);
    if (!writeOut()) return { ok: false, msg: '保存失败，浏览器拒绝了写入' };

    var back = readBack();
    if (!back || typeof back !== 'object') return { ok: false, msg: '保存失败，没有读回来' };

    /* 最硬的一条：读回来的整串必须和我们写进去的一致 */
    if (JSON.stringify(back) !== want) return { ok: false, msg: '保存失败，读回来的内容不对' };

    /* 比对真正决定行为的那几项 */
    if (back.tier !== config.tier) return { ok: false, msg: '保存失败，档位没有存住' };
    if (back.sub !== config.sub) return { ok: false, msg: '保存失败，楼中楼设置没有存住' };
    if ((back.showCount ? 1 : 0) !== (config.showCount ? 1 : 0)) return { ok: false, msg: '保存失败，开关没有存住' };

    var bw = back.words;
    if (!bw || bw.length !== config.words.length) return { ok: false, msg: '保存失败，屏蔽词数量对不上' };
    for (var i = 0; i < config.words.length; i++) {
      if (bw[i] !== config.words[i]) return { ok: false, msg: '保存失败，屏蔽词没存全' };
    }
    return { ok: true };
  }

  /* 保存并提示：成功才说成功 */
  function saveAndToast(alsoClose) {
    var r = save();
    /* 提示条贴着「用户正在看的那个面板」出现，所以要在关面板之前量 */
    var anchor = (subHost && subHost.style.display !== 'none') ? subPanel : panel;
    toast(r.ok ? '保存成功' : r.msg, anchor);
    /* 存住了才收界面；失败就把界面留在原地，让人看得到原因 */
    if (r.ok && alsoClose) { closeSub(false); closePanel(); }
  }

  /* ============ 判定 ============ */

  var RE_NAME  = /鱼|鲸/;
  var RE_BRAND = /大肥鱼|肥鱼|鲸鱼|大肥鲸|鲸鱼娘|本鲸|本鱼|本肥鱼|主人/;
  var RE_QUOTE = /^回复\s*@[\s\S]{0,40}?\s*[:：]\s*/;
  var RE_DASH  = /[\u2014\u2015\u2500]|--/;
  var RE_CHAR  = /[鱼鲸]/;
  var RE_PUNCT = /[：；]/;
  var RE_CORNER = /[「」]/;

  /*
   * 自定义屏蔽词。
   *
   * 旧写法是「每条评论 toLowerCase + 逐个 indexOf」，100 个词 × 几千条评论
   * 就是几十万次字符串扫描。改成合成一个正则：V8 的匹配器比 JS 循环快得多，
   * 而且只扫一遍，词越多越划算。
   *
   * wordsRe 三态：undefined = 还没构建，null = 没有词或构建失败。
   */
  var wordsRe;

  function escapeRe(s) {
    /* 把正则元字符全部转义：含 | 和 -，否则词里带竖线会破坏整个交替结构 */
    return s.replace(/[.*+?^${}()|[\]\\/|-]/g, '\\$&');
  }

  function customRe() {
    if (wordsRe !== undefined) return wordsRe;
    var ws = config.words, parts = [], i;
    for (i = 0; i < ws.length; i++) {
      if (ws[i]) parts.push(escapeRe(ws[i]));
    }
    if (!parts.length) { wordsRe = null; return null; }
    try { wordsRe = new RegExp(parts.join('|'), 'i'); }
    catch (e) { wordsRe = null; }
    return wordsRe;
  }

  /* 命中任意一个自定义词就屏蔽。不区分大小写，包含即命中 */
  function hitCustomWord(text) {
    if (!config.words.length) return false;
    var re = customRe();
    if (!re) {
      /* 极端情况（正则构造失败）退回逐词比对，保证功能不丢 */
      var s = text.toLowerCase();
      for (var i = 0; i < config.words.length; i++) {
        if (s.indexOf(config.words[i].toLowerCase()) !== -1) return true;
      }
      return false;
    }
    return re.test(text);
  }

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

    /* 自定义屏蔽词：所有档位都生效，不受档位取舍影响 */
    if (hitCustomWord(full)) return true;

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
  var bannerCache = '';          /* 上次写进 DOM 的数字，用来跳过无变化的刷新 */
  var counted = Object.create(null);   /* 本轮已计过数的 rpid */

  var countedN = 0;
  var COUNT_CAP = 50000;

  function statTotal() { return stat.r + stat.s; }

  function resetCount() {
    stat.r = 0;
    stat.s = 0;
    counted = Object.create(null);
    countedN = 0;
    bannerCache = '';   /* 让文案缓存失效，清零后能真的刷出来 */
  }

  /* 同一轮里可能连着调好几次 drawBanner，合到一帧里只刷一次 */
  var bannerQ = 0;

  function queueBanner() {
    if (bannerQ) return;
    bannerQ = 1;
    (typeof Promise !== 'undefined' ? Promise.resolve() : { then: function (f) { setTimeout(f, 0); } })
      .then(function () {
        bannerQ = 0;
        drawBanner();
      });
  }

  /* items: [{ id, r, s }]，id 为 null 时不去重 */
  function commitCount(items) {
    var k, it, key, changed = false;
    for (k = 0; k < items.length; k++) {
      it = items[k];
      if (it.id != null) {
        key = '' + it.id;
        if (counted[key]) continue;
        if (countedN >= COUNT_CAP) break;   /* 封顶了就别再白跑后面的条目 */
        counted[key] = 1;
        countedN++;
      }
      if (it.r) { stat.r += it.r; changed = true; }
      if (it.s) { stat.s += it.s; changed = true; }
    }
    /* 全是重复条目时数字没变，就别白刷一次 DOM */
    if (!changed) return;
    queueBanner();
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
      pinned = Object.create(null);
      for (i = 0; i < tops.length; i++) {
        if (tops[i] && tops[i].rpid != null) pinned[tops[i].rpid] = 1;
      }
    }
    if (data.top && data.top.upper && data.top.upper.rpid != null) {
      pinned = pinned || Object.create(null);
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
      var rest = [], drop = Object.create(null);
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

  var CSS = ":host{all:initial}\n*{box-sizing:border-box;margin:0;padding:0}\n\n/* 主题变量 */\n.t{\n  --bg:rgba(252,251,249,.94);--bd:rgba(0,0,0,.07);--tx:#1f1f23;--dim:#8b8b94;\n  --sh:0 20px 48px -18px rgba(0,0,0,.34),0 2px 6px -2px rgba(0,0,0,.06),inset 0 1px 0 rgba(255,255,255,.9);\n  --hv:rgba(0,0,0,.05);--tg:rgba(0,0,0,.1);--line:rgba(0,0,0,.07)\n}\n.t.dk{\n  --bg:rgba(38,38,44,.94);--bd:rgba(255,255,255,.1);--tx:#f0f0f4;--dim:#9a9aa6;\n  --sh:0 20px 48px -18px rgba(0,0,0,.8),0 2px 6px -2px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.07);\n  --hv:rgba(255,255,255,.09);--tg:rgba(255,255,255,.16);--line:rgba(255,255,255,.09)\n}\n\n/* 面板 */\n.p{position:fixed;top:78px;right:18px;z-index:2147483600;width:300px;\npadding:20px 20px 14px;border-radius:20px;\nbackground:var(--bg);\nbackdrop-filter:blur(40px) saturate(180%);-webkit-backdrop-filter:blur(40px) saturate(180%);\nborder:1px solid var(--bd);box-shadow:var(--sh);\nfont-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"HarmonyOS Sans SC\",\"Microsoft YaHei\",sans-serif;\n-webkit-font-smoothing:antialiased;\ntransform-origin:top right;animation:pop .18s cubic-bezier(.2,.9,.3,1)}\n@keyframes pop{from{opacity:0;transform:scale(.93) translateY(-6px)}to{opacity:1;transform:none}}\n\n/* 关闭 */\n.x{position:absolute;top:13px;right:14px;width:26px;height:26px;\ndisplay:flex;align-items:center;justify-content:center;\nfont-size:19px;line-height:1;color:var(--dim);cursor:pointer;border-radius:8px;\ntransition:background .14s,color .14s;user-select:none}\n.x:hover{background:var(--hv);color:var(--tx)}\n\n/* 分组标题 */\n.g{font-size:11.5px;font-weight:600;color:var(--dim);letter-spacing:.1em;\npadding:16px 8px 7px}\n.g:first-of-type{padding-top:2px}\n\n/* 选项 */\n.o{font-size:16px;line-height:1.2;color:var(--tx);padding:12px 14px;border-radius:11px;cursor:pointer;\ntransition:background .14s,color .14s,transform .1s}\n.o:hover{background:var(--hv)}\n.o:active{transform:scale(.985)}\n.o.on{background:#fb7299;color:#fff;font-weight:600;\nbox-shadow:0 4px 14px -4px rgba(251,114,153,.7)}\n\n/* 开关行 */\n.s{display:flex;align-items:center;justify-content:space-between;\nfont-size:15px;color:var(--tx);\npadding:16px 8px 8px;margin-top:10px;border-top:1px solid var(--line)}\n.sw{width:42px;height:24px;border-radius:12px;background:var(--tg);position:relative;cursor:pointer;\ntransition:background .2s;flex:none}\n.sw.on{background:#fb7299}\n.sw:after{content:\"\";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;\nbackground:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);transition:left .2s cubic-bezier(.3,1.2,.5,1)}\n.sw.on:after{left:21px}\n\n/* 评论区那行字 */\n.b{display:inline-block;padding:12px 22px;margin:6px 0 20px;border-radius:12px;\nfont-size:16px;line-height:1.4;letter-spacing:.01em;user-select:none;font-weight:600;\nfont-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"HarmonyOS Sans SC\",\"Microsoft YaHei\",sans-serif;\n-webkit-font-smoothing:antialiased;\ncolor:#59616d;background:rgba(0,0,0,.055);\nborder:1px solid rgba(0,0,0,.055)}\n\n/* 气泡：已加的屏蔽词 */\n/* 词多了要能滚，否则面板会顶穿屏幕、保存按钮点不到。\n   只有真的溢出时才加 .more 显示底部渐隐，短列表不加，免得把内容淡掉 */\n.ws{display:flex;flex-wrap:wrap;gap:7px;padding:2px 6px 10px;min-height:8px;\nmax-height:min(46vh,340px);overflow-y:auto;overscroll-behavior:contain}\n.ws:empty{display:none}\n.ws.more{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 18px),transparent 100%);\nmask-image:linear-gradient(to bottom,#000 calc(100% - 18px),transparent 100%)}\n/* 滚动条做得轻一点，别抢视觉 */\n.ws::-webkit-scrollbar{width:6px}\n.ws::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:3px}\n.ws::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.28)}\n.ws::-webkit-scrollbar-track{background:transparent}\n.dk .ws::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2)}\n.dk .ws::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.34)}\n.w{display:inline-flex;align-items:center;gap:5px;\nmax-width:100%;padding:6px 6px 6px 11px;border-radius:9px;\nfont-size:13.5px;line-height:1.25;color:var(--tx);\nbackground:rgba(251,114,153,.12);\nborder:1px solid rgba(251,114,153,.3);\nword-break:break-all;animation:tin .16s cubic-bezier(.2,.9,.3,1)}\n@keyframes tin{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:none}}\n.w span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.w i{flex:none;width:17px;height:17px;display:flex;align-items:center;justify-content:center;\nfont-style:normal;font-size:13px;line-height:1;border-radius:5px;cursor:pointer;\ncolor:#fb7299;opacity:.75;transition:background .14s,opacity .14s}\n.w i:hover{background:rgba(251,114,153,.2);opacity:1}\n.w.dk{background:rgba(251,114,153,.16);border-color:rgba(251,114,153,.34)}\n\n/* 输入行：输入框 + 确定 */\n.r{display:flex;gap:8px;padding:2px 6px 4px}\n.in{flex:1;min-width:0;height:38px;padding:0 12px;border-radius:10px;\nfont-size:14.5px;font-family:inherit;color:var(--tx);\nbackground:var(--hv);border:1px solid var(--bd);outline:none;\ntransition:border-color .14s,background .14s}\n.in::placeholder{color:var(--dim)}\n.in:focus{border-color:rgba(251,114,153,.55);background:var(--tg)}\n.btn{flex:none;height:38px;padding:0 15px;border-radius:10px;\nfont-size:14.5px;font-weight:600;line-height:38px;cursor:pointer;\ncolor:var(--tx);background:var(--hv);border:1px solid var(--bd);\ntransition:background .14s,opacity .14s,transform .1s}\n.btn:hover{background:var(--tg)}\n.btn:active{transform:scale(.97)}\n.btn.pri{color:#fff;background:#fb7299;border-color:#fb7299;\nbox-shadow:0 4px 14px -6px rgba(251,114,153,.8)}\n.btn.pri:hover{background:#fa5c8b}\n\n\n/* 底部操作区 */\n.f{display:flex;justify-content:flex-end;gap:8px;\npadding:14px 6px 2px;margin-top:8px;border-top:1px solid var(--line)}\n\n/* 二级页 */\n.p2{position:fixed;top:78px;right:18px;z-index:2147483601;width:330px;\nmax-height:calc(100vh - 96px);display:flex;flex-direction:column;\npadding:20px 20px 14px;border-radius:20px;\nbackground:var(--bg);\nbackdrop-filter:blur(40px) saturate(180%);-webkit-backdrop-filter:blur(40px) saturate(180%);\nborder:1px solid var(--bd);box-shadow:var(--sh);\nfont-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"HarmonyOS Sans SC\",\"Microsoft YaHei\",sans-serif;\n-webkit-font-smoothing:antialiased;\ntransform-origin:top right;animation:pop .18s cubic-bezier(.2,.9,.3,1)}\n.tip{font-size:12px;line-height:1.5;color:var(--dim);padding:8px 6px 0}\n\n/* 保存成功提示：贴在面板上方出现，位置由 JS 算 */\n.toast{position:fixed;z-index:2147483647;padding:11px 22px;border-radius:12px;\nmax-width:min(360px,80vw);\nfont-size:14.5px;font-weight:600;line-height:1.35;\nbackground:rgba(38,38,44,.94);color:#fff;\nborder:1px solid rgba(255,255,255,.14);\nbox-shadow:0 16px 40px -14px rgba(0,0,0,.6);\nopacity:0;pointer-events:none;\ntransform:translateY(6px);\ntransition:opacity .2s ease,transform .2s cubic-bezier(.2,.9,.3,1)}\n.toast.on{opacity:1;transform:translateY(0)}\n.toast.dk{background:rgba(252,251,249,.96);color:#1f1f23;\nborder:1px solid rgba(0,0,0,.08)}";
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
  var subHost = null, subPanel = null;   /* 自定义屏蔽词那个二级界面 */
  var listEl = null, inputEl = null;      /* 气泡区 / 输入框 */
  var toastHost = null, toastEl = null, toastTimer = 0;

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
    var dk = isDark();
    if (panel) applyTheme(panel);
    if (subPanel) applyTheme(subPanel);
    if (bText) bText.classList.toggle('dk', dk);
    if (toastEl) toastEl.classList.toggle('dk', dk);
    if (listEl && listEl.children) {
      for (var i = 0; i < listEl.children.length; i++) {
        listEl.children[i].classList.toggle('dk', dk);
      }
    }
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

  /* ============ 自定义屏蔽词 ============ */

  /* 词表变了：清正则缓存 + 旧计数作废 + 立刻落盘（点叉即生效，不等保存） */
  function wordsChanged() {
    wordsRe = undefined;
    resetCount();
    drawBanner();
    writeOut();
  }

  function addWord(raw) {
    var w = (raw == null ? '' : String(raw)).replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
    if (!w) return { ok: false, msg: '词不能为空' };
    if (w.length > MAX_LEN) return { ok: false, msg: '最多 ' + MAX_LEN + ' 个字' };
    if (config.words.length >= MAX_WORDS) return { ok: false, msg: '最多 ' + MAX_WORDS + ' 个词' };
    for (var i = 0; i < config.words.length; i++) {
      if (config.words[i].toLowerCase() === w.toLowerCase()) return { ok: false, msg: '这个已经有了' };
    }
    config.words.push(w);
    return { ok: true, word: w };
  }

  function removeWord(w) {
    for (var i = 0; i < config.words.length; i++) {
      if (config.words[i] === w) { config.words.splice(i, 1); return true; }
    }
    return false;
  }

  function drawWords() {
    if (!listEl) return;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    var dk = isDark();
    for (var i = 0; i < config.words.length; i++) {
      listEl.appendChild(makeBubble(config.words[i], dk));
    }
    syncFade();
  }

  /* 内容溢出了才加底部渐隐，暗示还能往下滚 */
  function syncFade() {
    if (!listEl) return;
    try {
      listEl.classList.toggle('more', listEl.scrollHeight > listEl.clientHeight + 1);
    } catch (e) {}
  }

  function makeBubble(w, dk) {
    var b = el('div', 'w' + (dk ? ' dk' : ''));
    b.appendChild(el('span', null, w));
    var x = el('i', null, '×');
    x.title = '删除';
    x.onclick = function () {
      removeWord(w);
      drawWords();
      wordsChanged();
    };
    b.appendChild(x);
    return b;
  }

  /* 每个 shadow root 都要自己的一份样式 */
  function ensureStyleIn(root) {
    var st = el('style');
    st.textContent = CSS;
    root.appendChild(st);
  }

  /*
   * 提示条固定摆在「用户正在看的那个面板」上方：
   * 水平方向对齐面板中线，垂直方向贴面板顶边往上 12px。
   * 面板是 fixed + top:78px/right:18px，尺寸随内容变，所以每次量了再算。
   * 上面放不下（面板很高 / 窗口很矮）就翻到面板下方，最后夹回视口。
   */
  function placeToast(anchor) {
    if (!toastEl) return;

    var de = document.documentElement;
    var vw = W.innerWidth || (de && de.clientWidth) || 0;
    var vh = W.innerHeight || (de && de.clientHeight) || 0;
    if (!vw || !vh) return;

    var tw = toastEl.offsetWidth || 0;
    var th = toastEl.offsetHeight || 0;
    var GAP = 12;      /* 和面板边缘的距离 */
    var EDGE = 12;     /* 离视口边缘至少留这么多 */

    var rect = null;
    try {
      if (anchor && anchor.getBoundingClientRect) {
        var b = anchor.getBoundingClientRect();
        if (b && b.width) rect = b;     /* 面板不可见时量到 0，就当没有锚点 */
      }
    } catch (e) { rect = null; }

    var left, top;
    if (rect) {
      left = Math.round(rect.left + (rect.width - tw) / 2);
      top = Math.round(rect.top - GAP - th);          /* 面板上方 */
      if (top < EDGE) top = Math.round(rect.bottom + GAP);   /* 上面放不下就翻到下面 */
    } else {
      /* 没有锚点：落在面板原本待的那块区域（右侧 18px、宽 300px）上方 */
      left = Math.round(vw - 18 - 300 + (300 - tw) / 2);
      top = 78 - GAP - th;
      if (top < EDGE) top = 78 + GAP;   /* 太高了放不下就落到面板位置下面一点 */
    }

    if (left < EDGE) left = EDGE;
    if (left + tw > vw - EDGE) left = vw - EDGE - tw;
    if (top < EDGE) top = EDGE;
    if (top + th > vh - EDGE) top = vh - EDGE - th;

    toastEl.style.left = left + 'px';
    toastEl.style.top = top + 'px';
    toastEl.style.right = 'auto';
    toastEl.style.bottom = 'auto';
  }

  function toast(msg, anchor) {
    if (!toastHost) {
      toastHost = el('div');
      toastHost.style.cssText = 'all:initial';
      var sh = toastHost.attachShadow({ mode: 'open' });
      ensureStyleIn(sh);
      toastEl = el('div', 'toast');
      sh.appendChild(toastEl);
      (document.body || document.documentElement).appendChild(toastHost);
    }
    if (!toastHost.isConnected) (document.body || document.documentElement).appendChild(toastHost);

    toastEl.textContent = msg;
    toastEl.classList.toggle('dk', isDark());

    /* 先摆好位再显示，免得先闪一下再跳过去 */
    placeToast(anchor);
    toastEl.classList.remove('on');
    void toastEl.offsetWidth;
    toastEl.classList.add('on');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastTimer = 0;
      if (toastEl) toastEl.classList.remove('on');
    }, 1800);
  }

  function header(onClose) {
    var h = el('div', 'x', '×');
    h.title = '关闭';
    h.onclick = onClose;
    return h;
  }

  /* ---------- 二级界面：自定义屏蔽词 ---------- */
  function buildSub() {
    if (subHost) return;

    subHost = el('div');
    subHost.style.cssText = 'all:initial;display:none';
    var sh = subHost.attachShadow({ mode: 'open' });
    ensureStyleIn(sh);

    subPanel = el('div', 'p2 t');
    applyTheme(subPanel);

    subPanel.appendChild(header(function () { closeSub(true); }));

    subPanel.appendChild(el('div', 'g', '自定义屏蔽词'));

    listEl = el('div', 'ws');
    subPanel.appendChild(listEl);

    var row = el('div', 'r');
    inputEl = el('input', 'in');
    inputEl.type = 'text';
    inputEl.maxLength = MAX_LEN;
    inputEl.placeholder = '输入一个词，回车添加';
    inputEl.onkeydown = function (e) {
      if (e.keyCode === 13 || e.key === 'Enter') { e.preventDefault(); commitInput(); }
    };
    row.appendChild(inputEl);

    var add = el('div', 'btn', '确定');
    add.onclick = commitInput;
    row.appendChild(add);
    subPanel.appendChild(row);

    subPanel.appendChild(el('div', 'tip', '命中任意一个词就屏蔽（不分大小写，包含即命中）。' +
      '所有档位都生效。' + MAX_WORDS + ' 个词以内。'));

    var foot = el('div', 'f');
    var ok = el('div', 'btn pri', '保存');
    ok.onclick = function () { saveAndToast(true); };   /* 等同于「保存 + 点叉」，全部退出 */
    foot.appendChild(ok);
    subPanel.appendChild(foot);

    sh.appendChild(subPanel);
    (document.body || document.documentElement).appendChild(subHost);
  }

  function commitInput() {
    if (!inputEl) return;
    var r = addWord(inputEl.value);
    if (!r.ok) { toast(r.msg, subPanel); return; }
    inputEl.value = '';
    drawWords();
    wordsChanged();
    inputEl.focus();
  }

  function openSub() {
    buildSub();
    applyTheme(subPanel);
    reattach(subHost);
    drawWords();
    /* 两个面板位置一样，编辑时把主面板收起来，免得叠在一起 */
    if (host) host.style.display = 'none';
    subHost.style.display = 'block';
    syncFade();      /* 显示出来之后才量得到真实高度 */
    if (inputEl) { try { inputEl.focus(); } catch (e) {} }
  }

  /* back=true：叉掉二级页回主面板；保存时传 false，所有界面一起退出 */
  function closeSub(back) {
    if (subHost) subHost.style.display = 'none';
    if (back !== false) openPanel();
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
        config.tier = t.id; writeOut(); pick(tg, t.id);
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
        config.sub = t.id; writeOut(); pick(sg, t.id);
        resetCount(); drawBanner();
      };
      sg.appendChild(o);
    });
    panel.appendChild(sg);

    /* 自定义屏蔽词入口 */
    panel.appendChild(el('div', 'g', '自定义屏蔽词'));
    var wr = el('div', 'o', '编辑屏蔽词…');
    wr.onclick = openSub;
    panel.appendChild(wr);

    var sr = el('div', 's');
    sr.appendChild(el('span', null, '显示已清条数'));
    swEl = el('div', 'sw' + (config.showCount ? ' on' : ''));
    swEl.onclick = function () {
      config.showCount = !config.showCount;
      writeOut();
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

    /* 主面板的保存：勾选即存，这里再确认一次并给个反馈 */
    var foot = el('div', 'f');
    var ok = el('div', 'btn pri', '保存');
    ok.onclick = function () { saveAndToast(true); };
    foot.appendChild(ok);
    panel.appendChild(foot);

    sh.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);
  }

  /* 页面整块重建时 host 会被一起摘掉，用之前先确认还挂在文档上 */
  function reattach(h) {
    if (!h) return;
    if (!h.isConnected) (document.body || document.documentElement).appendChild(h);
  }

  function openPanel() {
    buildPanel();
    applyTheme(panel);
    reattach(host);
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

  /* 文案没变就不碰 DOM：B站评论区滚动时这里会被高频调用 */
  function updateBannerText() {
    if (!bText) return;
    var sig = stat.r + '/' + stat.s;
    if (sig === bannerCache) return;   /* 数字没变，DOM 一个字都不写 */

    var txt = '已清 ' + statTotal() + ' 条';
    var tip = '一级评论 ' + stat.r + ' 条 · 楼中楼 ' + stat.s + ' 条';
    bannerCache = sig;

    /* 再和 DOM 上的实际值比一次：清零 / 清缓存之后数字往往没变，
       这时连赋值都不做，免得白白触发一次样式重算 */
    if (bText.textContent !== txt) bText.textContent = txt;
    if (bText.title !== tip) bText.title = tip;
    bText.classList.toggle('dk', isDark());
  }

  function drawBanner() {
    if (!config.showCount) {
      if (bHost) { bHost.remove(); bHost = null; bText = null; }
      return;
    }

    if (bHost && bHost.isConnected) {
      updateBannerText();
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

    updateBannerText();
    if (m.before) m.parent.insertBefore(bHost, m.before);
    else m.parent.appendChild(bHost);
  }

  /*
   * bili-comments 是懒加载的：DOMContentLoaded 时 shadowRoot 可能还不存在。
   *
   * 早期版本用 document 级 MutationObserver（subtree:true）等它出现，
   * 在 B 站这种每秒几十次 DOM 变动的页面上开销很大，而且拿不到 shadowRoot
   * 内部的变化还要再挂一个。改成廉价轮询：300ms 查一次，插上就停，
   * 15 秒还没等到也停，不留常驻开销。
   */
  var mountTimer = 0, mountTries = 0;

  var MOUNT_MS = 300;
  var MOUNT_MAX = 50;      /* 50 × 300ms = 15 秒 */

  function watchMount() {
    if (mountTimer || !config.showCount) return;
    mountTries = 0;
    mountTimer = setTimeout(tickMount, MOUNT_MS);
  }

  function tickMount() {
    mountTimer = 0;
    if (!config.showCount) return;
    if (bHost && bHost.isConnected) return;
    if (++mountTries > MOUNT_MAX) return;

    drawBanner();
    if (bHost && bHost.isConnected) return;
    mountTimer = setTimeout(tickMount, MOUNT_MS);
  }

  function stopWatch() {
    if (mountTimer) { clearTimeout(mountTimer); mountTimer = 0; }
    mountTries = 0;
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
    /* 长度和编码都变了，留着会让浏览器按旧值处理 */
    try { headers['delete']('content-length'); } catch (e) {}
    try { headers['delete']('content-encoding'); } catch (e) {}

    /* ResponseInit 只认 status / statusText / headers，别的塞进去会被忽略，
       所以 type / url / redirected 走下面的 defineProperty 补 */
    var init = { status: res.status, statusText: res.statusText, headers: headers };
    var out = new W.Response(text, init);

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

          /* 首屏：换成新的那个列表，数字重新算。
             注意是「请求成功了就清」，不是「有命中才清」——
             否则切到一个零评论 / 零命中的视频时，上一个视频的数字会残留。 */
          if (first) { onFirstPage(); queueBanner(); }
          if (!r || !r.items.length) return res;

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
        if (xhr.__dfyFirst) { onFirstPage(); queueBanner(); }   /* 首屏：换成新列表，重新算 */
        if (!f || !f.items.length) return (xhr.__dfyCache = null);
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
      if (e.key !== 'Escape' && e.keyCode !== 27) return;
      /* 二级页开着先关二级页，再按一次才关主面板 */
      if (subHost && subHost.style.display !== 'none') { closeSub(true); return; }
      closePanel();
    }, true);
  } catch (e) {}

  if (typeof GM_registerMenuCommand === 'function') {
    try {
      GM_registerMenuCommand('设置', openPanel);
    } catch (e) {}
  }

})();
