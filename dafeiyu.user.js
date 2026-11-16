// ==UserScript==
// @name         屏蔽大肥鱼
// @namespace    dafeiyu
// @version      1.6.0
// @description  屏蔽B站评论区里的大肥鱼（简繁通吃），并可批量删除 / 拉黑
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

/*
 * 分层总览（详细说明见 ARCHITECTURE.md）
 *
 *   L0 Pure      纯函数 / 纯数据。不碰 DOM、网络、storage、定时器、全局状态。
 *   L1 State     可变状态收拢成 6 个对象：Config Pool Page Ledger Counter Me。
 *                字段只在各自模块的 set/mark/commit 里改，外部一律走 API。
 *   L2 Service   判定 / 过滤 / 候选集 / 设置变更。只调用 L0 L1 的 API，不碰 DOM。
 *   L3 Side      网络与执行器：fetch/XHR 钩子、写接口、任务执行器。
 *   L4 UI        界面：主面板、二级页、横幅、toast。只读 L1/L2 的查询函数。
 *   L5 Boot      启动：把上面几层串起来 + 页面级钩子。
 *
 * 依赖方向是单向的：L5 -> L4 -> L3 -> L2 -> L1 -> L0。
 * 唯一允许的「反向」调用是 L1 的变更回调（bump / onChange），由 L5 注入，
 * 这样 L1 不需要知道 UI 的存在。
 *
 * 全部实现仍然在一个 IIFE 里，单文件、零构建、零依赖 —— 分层是文件内部的
 * 分节注释和命名空间（Pure.* / Pool.* / UI.*），不是打包产物。
 */

(function () {
  'use strict';

  var W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__dfy) return;
  W.__dfy = 1;

  /* ==================================================================
   * L0  纯逻辑层（Pure）
   *
   * 这一层只有纯函数和纯数据：输入什么就输出什么，不读全局、不产生副作用。
   * 想验证一条规则，看这一段就够了，不需要把整个脚本跑起来。
   * ================================================================== */

  var Pure = (function () {

    /* ---------- 常量 ---------- */

    /* 写接口的节奏。B站会限流（-509），这些数字偏保守：
       宁可慢一点，也别把账号搞进风控。 */
    var TIMING = {
      delGap: 350,        /* 两条删除之间的间隔 */
      blockGap: 260,      /* 两批拉黑之间的间隔 */
      retryMax: 3,        /* 单个目标的最多重试次数 */
      delStartDelay: 500, /* 点确认后先等这么久再发第一条，给「刚点完就切页」留出拦截窗口 */
      reqTimeout: 15000,  /* 单个写请求的超时 */
      retryBase: 1200     /* -509 退避基数：1.2s / 2.4s / 3.6s */
    };

    /* 批量拉黑接口一次能塞多少人 */
    var BLOCK_BATCH = 50;

    var LIMITS = {
      words: 1000,        /* 自定义屏蔽词个数上限 */
      names: 1000,        /* 自定义屏蔽用户名个数上限 */
      wordLen: 24,        /* 单个条目字数上限（词与用户名共用） */
      countTrack: 50000,  /* 计数去重表上限 */
      errs: 20            /* 任务失败明细最多留几条 */
    };

    /*
     * 池子能装多少条「页面已加载出来的评论」。
     *
     * 这是删除 / 拉黑候选集的唯一来源，所以它直接决定了
     * 「滚很久之后回头还能处理多少」。
     * 2 万条 ≈ 9.8MB 堆内存（实测），换来的是长评论区不用来回滚。
     */
    var POOL_CAP = 20000;

    /*
     * 本地账本上限。拉黑表和删除表分开算 —— 原来共用一个 BOOK_CAP：
     *   - 拉黑表 m：每条 {mid, {n 名字, t 时间}}，占 ~48 字节，用户真正会回头查，留 3000 条
     *   - 删除表 r：每条 {rpid: 时间}，占 ~30 字节，纯粹用来「别再删一遍」，不需要名字
     * 共用 3000 本来就跟池子对不上：池子里能装 2 万条、账本只记得 3000 条，
     * 中间那批删完刷新就被忘了，会重新进候选再删一遍。
     */
    var BOOK_MID_CAP = 3000;    /* 拉黑表：3000 条 ≈ 140KB */
    var BOOK_DEL_CAP = 20000;   /* 删除表：2 万条 ≈ 605KB，和 POOL_CAP 对齐 */

    var VALID_TIER = { cup: 1, standard: 1, kill: 1, atonly: 1 };
    var VALID_SUB  = { only: 1, whole: 1, none: 1 };

    var DEFAULT_CONFIG = {
      tier: 'standard', sub: 'only', showCount: true, showActs: false, words: [], names: []
    };

    function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

    /* ---------- 简繁：不做文本转换，把字扩成字符类 ---------- */

    /*
     * 思路：不做文本转换，而是把判定用的每个字都扩成「简繁体字符类」。
     *   /鱼/  变成  /[鱼魚]/
     * 这样一条正则同时吃简体和繁体，不用在每条评论上跑一遍转换。
     *
     * 表只收「判定词里真用得到」的字。目前全部判定词
     *   肥鱼 / 鲸 / 大肥鱼 / 鲸鱼 / 大肥鲸 / 鲸鱼娘 / 本鲸 / 本鱼 / 本肥鱼 / 主人 / 鱼
     * 拆开去重也只有 8 个不同字（主人大娘本肥鱼鲸），
     * 其中真有繁体写法的只有两个：鱼->魚、鲸->鯨。
     * 其余六个字简繁同形，放进去也是白占地方。
     *
     * 编码：<简><繁> 连续拼接；同一个简体有多个繁体时用 ~ 接在后面。
     * 以后新增含繁体字的判定词时，在这里补一对就行。
     * 自定义屏蔽词也走这张表：表里没收的字，自定义词就只按原字匹配。
     * 想让自定义词也全面繁简通吃，得把完整繁简表换回来。
     */
    var S2T_RAW = '鱼魚鲸鯨';

    /* '鱼魚鲸鯨' -> { 鱼: '魚', 鲸: '鯨' } */
    function parseS2T(raw) {
      var d = Object.create(null), i = 0, n = raw.length, k, v;
      while (i < n) {
        k = raw.charAt(i++);
        v = raw.charAt(i++);
        while (i < n && raw.charAt(i) === '~') {
          v += raw.charAt(i + 1);
          i += 2;
        }
        if (k && v) d[k] = v;
      }
      return d;
    }

    var S2T = parseS2T(S2T_RAW);

    /* 正则元字符转义表。等价于 /[.*+?^$ {}()|[\]\\\/-]/g，写成转义形式免得
       编辑器 / 打包器把 $ 后面的花括号当成模板占位符 */
    var RE_ESC = /[.*+?^$\x7b\x7d()|[\x5d\\\/-]/g;  /* eslint-disable-line no-useless-escape */

    /* 把正则元字符转义，供拼装用。必须在展开之前作用于原始词。 */
    function escapeRe(s) {
      return s.replace(RE_ESC, '\\$&');
    }

    /* '大肥鱼' -> '大肥[鱼魚]'；没有繁体变体的字原样保留 */
    function expandWord(w, table) {
      var out = '', i, ch, t;
      for (i = 0; i < w.length; i++) {
        ch = w.charAt(i);
        t = (table || S2T)[ch];
        out += t ? '[' + ch + t + ']' : ch;
      }
      return out;
    }

    /*
     * 把一组词合成一个正则。
     * 先对每个原始词做元字符转义，再做繁体展开 —— 顺序不能反，
     * 否则展开出来的 [ ] 会被当成元字符转义掉。
     */
    function buildWordsRe(list, table) {
      var parts = [], i, re;
      for (i = 0; i < list.length; i++) {
        if (list[i]) parts.push(expandWord(escapeRe(list[i]), table));
      }
      if (!parts.length) return null;
      try { re = new RegExp(parts.join('|'), 'i'); } catch (e) { re = null; }
      if (!re) {
        /* 展开后破坏了正则结构，退回不展开的版本，至少还能按原词命中 */
        parts = [];
        for (i = 0; i < list.length; i++) {
          if (list[i]) parts.push(escapeRe(list[i]));
        }
        try { re = new RegExp(parts.join('|'), 'i'); } catch (e2) { re = null; }
      }
      return re;
    }

    /* ---------- 判定用到的正则 ---------- */

    /*
     * 账号名判定：只认「肥鱼」。
     * 这条比正文判定优先级高（命中就不再看档位），所以宁可窄。
     * 「小鲸」「鲸鱼娘」这种名字不认，靠正文品牌词兜底。
     */
    var RE_NAME  = buildWordsRe(['肥鱼']);
    var RE_BRAND = buildWordsRe(['大肥鱼', '肥鱼', '鲸鱼', '大肥鲸', '鲸鱼娘', '本鲸', '本鱼', '本肥鱼', '主人']);
    var RE_CHAR  = buildWordsRe(['鱼', '鲸']);   /* 杀戮档：单字 */

    /* 「回复 @xxx :」——B站自动拼的引用前缀，判 @ 之前要剥掉 */
    var RE_QUOTE = /^回复\s*@[\s\S]{0,40}?\s*[:：]\s*/;

    /*
     * 杀戮档的「全角标点 / 破折号 / 直角引号」合并成一条字符类。
     * 原来拆成三个正则逐条 test，没命中的评论要多扫两遍；
     * 合成一次扫描，判定结果和原来完全一致。
     */
    var RE_KILLP = /[：；「」]|[\u2014\u2015\u2500]|--/;

    /*
     * 有没有真的 @ 到人。
     * 原来只判 indexOf('@') !== -1，连「QQ 邮箱」「@所有人」这种正文里的
     * 裸 @ 也算命中 —— 标准档下就是一条误删。
     */
    var RE_AT = /(?:^|[^\w.+-])@[\w\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af-]/;

    /* ---------- 判定内核 ---------- */

    function textOf(r) {
      var c = r && r.content;
      return c && typeof c.message === 'string' ? c.message : '';
    }

    /* 剥掉「回复 @xxx :」前缀。@ 只看剥完的正文，关键词看完整原文 */
    function stripQuotePrefix(full) {
      if (full.charCodeAt(0) === 0x56DE /* 回 */ && full.charCodeAt(1) === 0x590D /* 复 */) {
        var q = RE_QUOTE.exec(full);
        if (q) return full.slice(q[0].length);
      }
      return full;
    }

    /*
     * 先走 indexOf 的快速路径：绝大多数评论压根没有 @，
     * 没必要为它们跑一遍正则（这是每条评论都要过的热路径）。
     */
    function hasAt(body) {
      return body.indexOf('@') !== -1 && RE_AT.test(body);
    }

    /*
     * 唯一的判定入口。ctx 传三样东西：
     *   tier       当前档位
     *   custom     自定义屏蔽词正则（null = 没有词 / 构建失败）
     *   customName 自定义屏蔽用户名正则（同上）
     *
     * 优先级从上到下，命中即返回：
     *   0 自定义用户名 / 账号名含「肥鱼」（只看名字，不参与档位取舍）
     *   1 自定义屏蔽词（所有档位）      2 只屏蔽 @ 档到此为止
     *   3 品牌词                        4 小杯档到此为止
     *   5 @ 到人                        6 标准档到此为止
     *   7 单字鱼 / 鲸                   8 全角标点 / 破折号 / 直角引号
     */
    function isBlocked(r, ctx) {
      var full = textOf(r);
      var body = stripQuotePrefix(full);
      var m;

      /* 账号名判定：自定义用户名 + 内置「肥鱼」。只看名字，不参与档位取舍 */
      m = r && r.member;
      var uname = (m && (m.uname || m.name)) || '';
      if (uname) {
        if (ctx.customName && ctx.customName.test(uname)) return true;
        if (RE_NAME.test(uname)) return true;
      }

      /* 自定义屏蔽词：所有档位都生效 */
      if (ctx.custom && ctx.custom.test(full)) return true;

      if (ctx.tier === 'atonly') return hasAt(body);

      if (RE_BRAND.test(full)) return true;
      if (ctx.tier === 'cup') return false;
      if (hasAt(body)) return true;
      if (ctx.tier === 'standard') return false;
      if (RE_CHAR.test(full)) return true;
      return RE_KILLP.test(full);
    }

    /* ---------- 接口 URL 分类 ---------- */

    /*
     * url 在真实页面里不一定是字符串：xhr.open('GET', new URL(...)) 很常见，
     * Request 对象也会被直接传进 fetch。这里必须先归一化再判断，
     * 否则 indexOf 会抛 TypeError —— 而它是在页面调用 open/send 的栈里抛的，
     * 等于我们把人家的请求打断了。
     */
    function normalizeUrl(url) {
      if (url && typeof url !== 'string') {
        /* Request 有 .url，URL 有 .href，两者都得认。
           原来只认 .href，fetch(new Request(...)) 会被 String() 成
           "[object Object]"，于是首屏判断失灵、评论也过滤不掉。 */
        if (typeof url.url === 'string' && url.url) return url.url;
        if (typeof url.href === 'string') return url.href;
        return String(url);
      }
      return url || '';
    }

    /*
     * 认四种评论接口，返回 0 / 1 / 2：
     *   1 = 一级评论（main / wbi/main / 老式 reply?）
     *   2 = 楼中楼（reply/reply）
     *   0 = 不管是（del / add / action / report 一律放行）
     */
    function apiKind(url) {
      url = normalizeUrl(url);
      if (!url || url.indexOf('/x/v2/reply') === -1) return 0;
      if (url.indexOf('/x/v2/reply/reply') !== -1) return 2;
      if (url.indexOf('/x/v2/reply/wbi/main') !== -1) return 1;
      if (url.indexOf('/x/v2/reply/main') !== -1) return 1;
      if (url.indexOf('/x/v2/reply?') !== -1) return 1;
      return 0;
    }

    /*
     * 首屏请求判定：换了排序、换了视频、刷新，都会重新拉第一页。
     * wbi/main 用 pagination_str={"offset":""}，旧版用 next=0 / pn=1。
     *
     * kind 收进函数内部判断。原来靠调用方写 kind === 1 短路，
     * 语义上很危险：以后多加一处调用漏写，展开楼中楼时就会清空整个池子。
     */
    function isFirstPageReq(url, kind) {
      if (kind !== undefined && kind !== 1) return false;
      if (!url) return false;
      var u = url;
      try { u = decodeURIComponent(url); } catch (e) {}
      if (u.indexOf('pagination_str') !== -1) return u.indexOf('"offset":""') !== -1;
      if (!/[?&]next=/.test(u) && !/[?&]pn=/.test(u)) return true;
      return /[?&]next=0(&|$)/.test(u) || /[?&]pn=1(&|$)/.test(u);
    }

    /* ---------- 错误码 ---------- */

    /*
     * 错误码翻译成人话。宁可说清楚，也别把 -509 这种数字直接丢给用户。
     *   -101 未登录  -111 csrf 失效  -352 / -509 风控限流
     *   -403 没权限  22008 黑名单满  22120 已在黑名单  12022 已经删了
     * 返回 null = 算成功。
     */
    function explain(code, message) {
      if (code === 0) return null;
      if (code === -101) return '未登录，请先登录 B 站';
      if (code === -111) return '登录状态失效了（csrf 校验失败），刷新页面再试';
      if (code === -352) return '触发风控了，等几分钟再试';
      if (code === -509) return '请求过于频繁，已自动放慢';
      if (code === 22001) return '不能对自己操作';
      if (code === 22008) return '黑名单满了，得先清理';
      if (code === 22120) return null;      /* 已经在黑名单里，算成功 */
      if (code === 12022) return null;      /* 评论已经没了，算成功 */
      if (code === 12002) return '评论区已关闭';
      if (code === 12009) return '评论区类型不对，这个位置的评论删不了';
      if (code === 12006) return '这条评论不存在了';
      if (code === -403) return '没有权限：删除只能管理自己稿件下的评论区';
      if (code === -404) return '目标不存在（可能已被删除）';
      if (code === -999) return '网络错误';
      return message || ('失败（错误码 ' + code + '）');
    }

    /*
     * 哪些错误码要继续跑下去。登录态 / 权限 / 风控这类问题，
     * 后面每一条都会以同样的理由失败，继续只会白烧风控额度。
     */
    function isFatal(code) {
      return code === -101 || code === -111 || code === -403 || code === -352;
    }

    /*
     * 只有 -509（请求过快）重试有意义。
     * -352 是风控黑名单级别，几乎不可能在一次任务里恢复：
     * 重试间隔 1.2s/2.4s/3.6s 单条要耗 7 秒，100 条就是十几分钟，
     * 期间用户只看到进度条不动。所以 -352 不重试，直接让任务停下。
     */
    function shouldRetry(code, attempt) {
      return code === -509 && attempt < TIMING.retryMax;
    }

    /* ---------- 数据整形 ---------- */

    /* ['a', null, 1, '  ok  ', 'OK', ''] -> ['ok']，去空、去重、截断 */
    function cleanWords(raw, cap) {
      var out = [], seen = Object.create(null), i, w, lw;
      if (!Array.isArray(raw)) return out;
      if (!cap) cap = LIMITS.words;
      for (i = 0; i < raw.length && out.length < cap; i++) {
        w = raw[i];
        if (typeof w !== 'string') continue;
        w = w.replace(/^\s+|\s+$/g, '').slice(0, LIMITS.wordLen);
        if (!w) continue;
        lw = w.toLowerCase();
        if (seen[lw]) continue;
        seen[lw] = 1;
        out.push(w);
      }
      return out;
    }

    /*
     * 配置白名单。
     * 必须用 hasOwnProperty 查白名单。普通对象字面量继承 Object.prototype，
     * VALID_TIER['constructor'] 是真值 —— 配置里 tier 写成 'constructor' 会通过校验，
     * 而 isBlocked 里所有档位分支都落空，用户会莫名其妙发现「屏蔽强度自己变严了」。
     */
    function normalizeConfig(o) {
      var cfg = { tier: DEFAULT_CONFIG.tier, sub: DEFAULT_CONFIG.sub,
                  showCount: DEFAULT_CONFIG.showCount, showActs: DEFAULT_CONFIG.showActs,
                  words: [], names: [] };
      if (!o || typeof o !== 'object') return cfg;
      if (typeof o.tier === 'string' && hasOwn(VALID_TIER, o.tier)) cfg.tier = o.tier;
      if (typeof o.sub === 'string' && hasOwn(VALID_SUB, o.sub)) cfg.sub = o.sub;
      if (typeof o.showCount === 'boolean') cfg.showCount = o.showCount;
      if (typeof o.showActs === 'boolean') cfg.showActs = o.showActs;
      if (Array.isArray(o.words) && o.words.length) cfg.words = cleanWords(o.words, LIMITS.words);
      if (Array.isArray(o.names) && o.names.length) cfg.names = cleanWords(o.names, LIMITS.names);
      return cfg;
    }

    /* 新增条目只做「能不能加」的判断，不改任何状态。cap / unit 让词和用户名共用一套规则 */
    function validateWord(raw, existing, cap, unit) {
      var w = (raw == null ? '' : String(raw)).replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
      if (!w) return { ok: false, msg: (unit || '词') + '不能为空' };
      if (w.length > LIMITS.wordLen) return { ok: false, msg: '最多 ' + LIMITS.wordLen + ' 个字' };
      if (existing.length >= (cap || LIMITS.words)) {
        return { ok: false, msg: '最多 ' + (cap || LIMITS.words) + ' 个' + (unit || '词') };
      }
      for (var i = 0; i < existing.length; i++) {
        if (existing[i].toLowerCase() === w.toLowerCase()) return { ok: false, msg: '这个已经有了' };
      }
      return { ok: true, word: w };
    }

    /*
     * 账本清洗。账本可能被旧版本 / 手改 / 写到一半被打断搞脏，
     * 出现 {m:{111:null}} 这种值。读取方直接读 .t / .n，
     * 一个 null 就能抛 TypeError —— 而瘦身在落盘路径上，
     * 抛出去会把拉黑任务的收尾一起带崩。
     */
    function normalizeBook(raw) {
      var b = (raw && typeof raw === 'object') ? raw : {};
      if (!b.m || typeof b.m !== 'object') b.m = {};
      if (!b.r || typeof b.r !== 'object') b.r = {};
      var k, v;
      for (k in b.m) {
        v = b.m[k];
        if (!v || typeof v !== 'object') b.m[k] = { n: '', t: 0 };
        else if (typeof v.t !== 'number') v.t = 0;
      }
      for (k in b.r) {
        if (typeof b.r[k] !== 'number') b.r[k] = 0;
      }
      return b;
    }

    /* 取条目时间，脏数据（null / 非对象）一律当 0，别让排序抛异常 */
    function midTime(it) {
      return (it && typeof it === 'object' && it.t) || 0;
    }

    /* 账本瘦身。两个表各自按自己的上限裁，返回被删掉的键数。 */
    function pruneBookObject(b, midCap, delCap) {
      var keys = [], k, i, dropped = 0;
      for (k in b.m) keys.push(k);
      if (keys.length > midCap) {
        keys.sort(function (x, y) { return midTime(b.m[x]) - midTime(b.m[y]); });
        for (i = 0; i < keys.length - midCap; i++) { delete b.m[keys[i]]; dropped++; }
      }
      var rk = [];
      for (k in b.r) rk.push(k);
      if (rk.length > delCap) {
        rk.sort(function (x, y) { return (b.r[x] || 0) - (b.r[y] || 0); });
        for (i = 0; i < rk.length - delCap; i++) { delete b.r[rk[i]]; dropped++; }
      }
      return dropped;
    }

    /* 账本条目 -> 展示用的数组，按时间倒序 */
    function bookToArray(b) {
      var arr = [], k, it;
      for (k in b.m) {
        it = b.m[k];
        arr.push({
          mid: k,
          name: (it && typeof it === 'object' && it.n) || '',
          t: (it && typeof it === 'object' && it.t) || 0
        });
      }
      arr.sort(function (x, y) { return y.t - x.t; });
      return arr;
    }

    /* 评论对象 -> 池子里的紧凑条目。字段全部字符串化，省内存也省得后面反复判空。 */
    function makePoolItem(r) {
      return {
        rpid: '' + r.rpid,
        oid: (r.oid != null ? '' + r.oid : ''),
        type: (r.type != null ? '' + r.type : ''),
        mid: (r.mid != null ? '' + r.mid : (r.member && r.member.mid != null ? '' + r.member.mid : '')),
        name: (r.member && (r.member.uname || r.member.name)) || '',
        text: textOf(r),  /* 留原文：切换档位 / 改屏蔽词时要对已加载的评论重新判定 */
        hit: false,       /* 命中档位规则 */
        pinned: false     /* 置顶评论，写操作一律跳过 */
      };
    }

    /*
     * rpid 的合法性。被删 / 折叠的评论常见 rpid=0 或缺失。
     * 早期只判 !r.rpid，0 会被当成有效值放行，
     * 结果所有 rpid=0 的评论共用一个 poolSeen['0'] 槽位，互相覆盖。
     */
    function validRpid(rpid) {
      if (rpid == null) return '';
      var s = '' + rpid;
      if (!s || s === '0' || s === 'undefined' || s === 'null') return '';
      return s;
    }

    /* 页面类型：决定拉黑按钮放哪儿更有用 */
    function pageKind(loc) {
      var h = loc.hostname, p = loc.pathname;
      if (h === 'space.bilibili.com') return 'space';
      if (h === 't.bilibili.com' || p.indexOf('/opus/') === 0 || p.indexOf('/dynamic/') === 0) return 'dynamic';
      if (p.indexOf('/video/') === 0 || p.indexOf('/bangumi/') === 0 || p.indexOf('/list/') === 0) return 'video';
      return 'other';
    }

    /* 去重的 mid 列表（拉黑任务按它分批） */
    function uniqueMids(list) {
      var out = [], seen = Object.create(null), k, m;
      for (k = 0; k < list.length; k++) {
        m = list[k] && list[k].mid;
        if (!m || seen[m]) continue;
        seen[m] = 1;
        out.push(m);
      }
      return out;
    }

    return {
      TIMING: TIMING,
      LIMITS: LIMITS,
      BLOCK_BATCH: BLOCK_BATCH,
      POOL_CAP: POOL_CAP,
      BOOK_MID_CAP: BOOK_MID_CAP,
      BOOK_DEL_CAP: BOOK_DEL_CAP,
      DEFAULT_CONFIG: DEFAULT_CONFIG,
      S2T: S2T,
      hasOwn: hasOwn,
      parseS2T: parseS2T,
      escapeRe: escapeRe,
      expandWord: expandWord,
      buildWordsRe: buildWordsRe,
      textOf: textOf,
      hasAt: hasAt,
      isBlocked: isBlocked,
      normalizeUrl: normalizeUrl,
      apiKind: apiKind,
      isFirstPageReq: isFirstPageReq,
      explain: explain,
      isFatal: isFatal,
      shouldRetry: shouldRetry,
      cleanWords: cleanWords,
      normalizeConfig: normalizeConfig,
      validateWord: validateWord,
      normalizeBook: normalizeBook,
      midTime: midTime,
      pruneBookObject: pruneBookObject,
      bookToArray: bookToArray,
      makePoolItem: makePoolItem,
      validRpid: validRpid,
      pageKind: pageKind,
      uniqueMids: uniqueMids
    };
  })();

  /* ==================================================================
   * L1  状态层
   *
   * 可变状态全部收拢到下面 6 个对象里，外加一个存储适配器：
   *   Store    storage 读写（全脚本只有这一处 try/catch 包着 storage）
   *   Config   配置（tier / sub / showCount / showActs / words）
   *   Pool     评论池 + 环形游标 + 失效版本号
   *   Page     当前稿件上下文：oid / UP 主 mid / 置顶 rpid 集合
   *   Ledger   本地账本（拉黑表 m / 删除表 r）
   *   Counter  已清计数 + 去重表
   *   Me       自己的 mid 与 csrf
   *
   * 约定：字段只在各自模块的方法里改。外部读走查询方法，写走 setter / mark。
   * 模块之间不互相调用，需要联动的地方由 L5 用 onChange() 注入回调。
   * 这一层不碰 DOM —— 唯一的外部接触是 Store 里的 localStorage / GM_* 和 Me 里的 cookie。
   * ================================================================== */

  /* ---------- 存储适配器 ---------- */

  var Store = (function () {
    var HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    var SKEY = 'dafeiyu.config.v2';   /* 键名不变：老用户的档位 / 屏蔽词无缝升到 1.4 */
    var BKEY = 'dafeiyu.book.v1';     /* 拉黑账本，单独存，能随时清空 */

    /* 存 / 取只有两种后端（脚本管理器的存储或 localStorage）。
       原来 loadConfig / readConf / readBook 三处几乎逐字重复，合成两个小工具。 */
    function read(key) {
      try {
        var raw = HAS_GM ? GM_getValue(key, null) : W.localStorage.getItem(key);
        if (!raw) return null;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch (e) { return null; }
    }

    function write(key, obj) {
      try {
        var s = JSON.stringify(obj);
        if (HAS_GM) GM_setValue(key, s);
        else W.localStorage.setItem(key, s);
        return true;
      } catch (e) { return false; }
    }

    return {
      SKEY: SKEY,
      BKEY: BKEY,
      read: read,
      write: write,
      readConf: function () { return read(SKEY); },
      writeConf: function (cfg) { return write(SKEY, cfg); },
      readBook: function () { return read(BKEY); },
      writeBook: function (book) { return write(BKEY, book); }
    };
  })();

  /* ---------- 配置 ---------- */

  var Config = (function () {
    /* 启动时读一次盘。脏数据一律回落到默认值，不抛。 */
    var cfg = Pure.normalizeConfig(Store.readConf());

    /* 只改传进来的字段，其余原样保留 */
    function set(patch) {
      if (!patch) return cfg;
      if (patch.tier !== undefined) cfg.tier = patch.tier;
      if (patch.sub !== undefined) cfg.sub = patch.sub;
      if (patch.showCount !== undefined) cfg.showCount = patch.showCount;
      if (patch.showActs !== undefined) cfg.showActs = patch.showActs;
      if (patch.words !== undefined) cfg.words = patch.words;
      if (patch.names !== undefined) cfg.names = patch.names;
      return cfg;
    }

    function save() { return Store.writeConf(cfg); }

    /* 回读比对一组字符串，对不上就返回失败原因 */
    function compareList(back, mine, label) {
      var bw = back || [];
      if (bw.length !== mine.length) return { ok: false, msg: '保存失败，' + label + '数量对不上' };
      for (var i = 0; i < mine.length; i++) {
        if (bw[i] !== mine[i]) return { ok: false, msg: '保存失败，' + label + '没存全' };
      }
      return null;
    }

    /*
     * 保存 = 写盘 + 回读校验。
     * 设置项改了其实立刻就生效（改一下就落盘），这个按钮的意义是
     * 「确认刚才那些改动真的存住了」，所以真的再读一遍比对，
     * 对不上就报失败，不给假的「保存成功」。
     */
    function saveAndVerify() {
      if (!save()) return { ok: false, msg: '保存失败，浏览器拒绝了写入' };

      var back = Store.readConf();
      if (!back || typeof back !== 'object') return { ok: false, msg: '保存失败，没有读回来' };

      if (back.tier !== cfg.tier) return { ok: false, msg: '保存失败，档位没有存住' };
      if (back.sub !== cfg.sub) return { ok: false, msg: '保存失败，楼中楼设置没有存住' };
      if ((back.showCount ? 1 : 0) !== (cfg.showCount ? 1 : 0)) return { ok: false, msg: '保存失败，开关没有存住' };
      if ((back.showActs ? 1 : 0) !== (cfg.showActs ? 1 : 0)) return { ok: false, msg: '保存失败，按钮开关没有存住' };

      var bad = compareList(back.words, cfg.words, '屏蔽词');
      if (bad) return bad;
      bad = compareList(back.names, cfg.names, '屏蔽用户名');
      if (bad) return bad;
      return { ok: true };
    }

    return {
      set: set,
      save: save,
      saveAndVerify: saveAndVerify,
      tier: function () { return cfg.tier; },
      sub: function () { return cfg.sub; },
      showCount: function () { return cfg.showCount; },
      showActs: function () { return cfg.showActs; },
      words: function () { return cfg.words; },
      names: function () { return cfg.names; },
      /* 内部对象只读视图。测试用例直接改它来模拟「用户点了某个档位」，
         生产代码一律走上面的查询方法 + set()。 */
      raw: function () { return cfg; }
    };
  })();

  /* ---------- 评论池 ---------- */

  /*
   * 「页面已经加载出来的评论」是删除 / 拉黑的唯一候选来源。
   * 这个模块负责三件事：环形写入、rpid 索引、失效版本号。
   */
  var Pool = (function () {
    var items = [];
    var seen = Object.create(null);   /* rpid -> item，O(1) 查找 */
    var head = 0;                     /* 环形游标：池满后覆盖最旧的槽位，避免 shift 的 O(n) 搬移 */

    /*
     * 唯一的失效版本号。凡是池子内容、命中标记、删除账本、自己 mid 有变化，都走 bump()。
     * 原来用「length + hitVer」两个键，而且 hitVer++ 散在 8 处手写，
     * 改档位 / 改屏蔽词这几条路径全漏了，表现就是横幅上的「删除 N」一动不动。
     * 现在只要没人忘，缓存就永远是对的 —— 而忘的代价从「数字过期」变成「多算一次」。
     */
    var ver = 0;

    function bump() { ver++; }

    /* 首屏换稿件 / 换排序：整池清空，游标归零 */
    function reset() {
      items = [];
      seen = Object.create(null);
      /* 环形游标也要归零：不清的话下一轮会覆盖到残留槽位，把 seen 里仍在用的索引删掉 */
      head = 0;
      bump();
    }

    /*
     * 记一条。返回池子里的条目（已存在则返回已有的那条），rpid 非法返回 null。
     * 只记录、不发请求：候选集永远等于用户眼前这一份数据。
     */
    function add(r) {
      if (!r) return null;
      var id = Pure.validRpid(r.rpid);
      if (!id) return null;
      if (seen[id]) return seen[id];

      /* 先建对象，再决定放哪儿：池满分支也要用到 item，顺序反了会写进 undefined */
      var item = Pure.makePoolItem(r);

      /*
       * 池子满时不能直接丢弃新评论：长评论区滚动超过 POOL_CAP 条后，
       * 新评论永远进不来，按钮数字就冻住了。
       * 用环形覆盖而不是 Array.shift —— shift 对 2 万元素要整体搬移（O(n)），
       * 而这里正落在滚动热路径上。池子因此变成无序，
       * 但下游候选集都是纯筛选，不依赖顺序。
       */
      if (items.length >= Pure.POOL_CAP) {
        var slot = head % Pure.POOL_CAP;
        head++;
        var oldIt = items[slot];
        if (oldIt) delete seen[oldIt.rpid];
        items[slot] = item;
        seen[id] = item;
        bump();
        return item;
      }

      seen[id] = item;
      items.push(item);
      bump();
      return item;
    }

    function find(rpid) {
      return seen['' + rpid] || null;
    }

    /* 标命中。只有真翻转了才 bump，否则一次首屏解析会白 bump 几百次 */
    function markHit(rpid) {
      var it = find(rpid);
      if (it && !it.hit) { it.hit = true; bump(); return true; }
      return false;
    }

    /* 标置顶。置顶评论写操作一律跳过。 */
    function markPinned(rpid) {
      var it = find(rpid);
      if (it && !it.pinned) { it.pinned = true; bump(); return true; }
      return false;
    }

    /* 对已加载的评论重跑一遍判定。judge(item) 返回新的 hit 值。 */
    function rejudge(judge) {
      var i, it;
      for (i = 0; i < items.length; i++) {
        it = items[i];
        /* 置顶评论本来就写操作一律跳过，命中标记保持原样即可 */
        if (it.pinned) continue;
        it.hit = judge(it);
      }
      bump();
    }

    return {
      add: add,
      find: find,
      reset: reset,
      bump: bump,
      markHit: markHit,
      markPinned: markPinned,
      rejudge: rejudge,
      items: function () { return items; },
      length: function () { return items.length; },
      head: function () { return head; },
      ver: function () { return ver; },
      /* 测试注入口：直接换掉内部数组 / 游标 */
      __setItems: function (p) { items = p; },
      __setHead: function (h) { head = h; }
    };
  })();

  /* ---------- 当前稿件上下文 ---------- */

  /*
   * 一次页面会话里「现在看的是哪个稿件的评论」的全部上下文。
   * 换稿件（首屏请求）时必须整组清掉 —— 上一条稿件的 oid 留着会拿旧 oid 去删新稿件的评论，
   * 上一条稿件的 UP 主 mid 留着会把新稿件里同 mid 的人当成 UP 主跳过。
   */
  var Page = (function () {
    /*
     * 任务执行时每发一个请求都要比对它：用户点了「确认删除」之后完全可能马上切到另一个视频，
     * 而任务手里的 list 还是旧 pool 的元素引用，oid 也还是旧稿件的。
     */
    var oid = '';
    var upper = '';                     /* 当前稿件的 UP 主 mid，接口里叫 data.upper.mid */
    var pinned = Object.create(null);   /* 本轮见过的置顶 rpid。跨页有效，见 Filter */
    /*
     * 换稿件的代数。每次 onFirstPage 加一。
     * 任务在「点确认」那一刻把代数记下来，之后每发一个请求都比一次：
     * 代数变了就说明用户换了稿件 / 换了排序，手里的目标全部作废。
     * 比 oid 字符串可靠 —— 切到评论区为空的稿件时新页面根本没有 oid 可比。
     */
    var gen = 0;

    function setOid(v) {
      if (v != null && v !== '') oid = '' + v;
    }

    function setUpper(v) {
      if (v != null) upper = '' + v;
    }

    /*
     * 记下置顶评论的 rpid。
     * 置顶评论会重复出现在 replies 里，而「后面几页」那份数据没有 top_replies 字段 ——
     * 只在单份 payload 里认置顶的话，第二页就会把它当成普通命中评论，
     * 作者直接进拉黑候选。
     */
    /* 返回「这次新学到的」rpid 数组（已经见过的不会重复返回） */
    function addPinned(list) {
      var fresh = [], id, i;
      for (i = 0; i < list.length; i++) {
        if (list[i] == null) continue;
        id = '' + list[i];
        if (pinned[id]) continue;
        pinned[id] = 1;
        fresh.push(id);
      }
      return fresh;
    }

    function isPinned(rpid) { return !!pinned['' + rpid]; }

    /* 换稿件：整组清空。oid / upper / 置顶集合一个都不能留。 */
    function reset() {
      oid = '';
      upper = '';
      pinned = Object.create(null);
      gen++;
    }

    return {
      setOid: setOid,
      oid: function () { return oid; },
      gen: function () { return gen; },
      setUpper: setUpper,
      upper: function () { return upper; },
      addPinned: addPinned,
      isPinned: isPinned,
      reset: reset,
      /* 测试注入口 */
      __setOid: function (v) { oid = '' + v; },
      __setUpper: function (v) { upper = '' + v; }
    };
  })();

  /* ---------- 本地账本 ---------- */

  /*
   * 本地记账，只做两件事：
   *   1. 已经删掉 / 拉黑过的别再发请求（幂等，省请求也就等于省风控额度）
   *   2. 拉黑是不可见的，得让用户能回头看到「我到底拉黑了谁」
   * 数据量不大：只存 mid / rpid 和一点用于展示的名字与时间。
   */
  var Ledger = (function () {
    var book = null;                    /* { m: { mid: {n,t} }, r: { rpid: 时间 } } */
    var deleted = Object.create(null);  /* 本轮已删的 rpid */
    var dirty = false;                  /* 有未落盘的改动 */
    var nM = -1, nR = -1;               /* 两张表的条目数；-1 = 还没数过 */
    var mOrder = [], rOrder = [];       /* 本次会话的写入顺序，瘦身时按它淘汰 */
    var onChange = null;                /* L5 注入：账本变了要让候选缓存失效 */

    function notify() { if (onChange) onChange(); }

    function countKeys(o) { var n = 0, k; for (k in o) n++; return n; }

    function ensure() {
      if (book) return book;
      book = Pure.normalizeBook(Store.readBook());
      return book;
    }

    /*
     * 同 addMids：只记内存，落盘交给 flush 合并。
     * 原实现每批都瘦身 + 全量序列化 + 同步写盘（3000 条时约 5ms），
     * 拉黑 3000 人要 60 批，光写盘就 300ms 主线程。
     */
    /* names: 可选的 { mid: 用户名 }，用来把「本地黑名单」显示成人名而不是一串数字 */
    function addMids(mids, names) {
      var b = ensure(), now = Date.now(), i, nm, mid;
      if (nM < 0) nM = countKeys(b.m);
      for (i = 0; i < mids.length; i++) {
        mid = mids[i];
        nm = (names && names[mid]) || '';
        if (!b.m[mid]) { b.m[mid] = { n: nm, t: now }; nM++; mOrder.push(mid); }
        else {
          b.m[mid].t = now;
          if (nm) b.m[mid].n = nm;
        }
      }
      dirty = true;
      /* 拉黑过的人不该再出现在候选里，缓存必须失效，否则「拉黑 N」数字不动 */
      notify();
    }

    function markDeleted(rpid) {
      var id = '' + rpid, b = ensure();
      deleted[id] = 1;
      if (nR < 0) nR = countKeys(b.r);
      if (!b.r[id]) { nR++; rOrder.push(id); }
      b.r[id] = Date.now();
      dirty = true;
      /*
       * 必须让候选缓存失效。删一条既不改 pool 长度也不改 hit，
       * 只有版本号动了，删完一批按钮上的数字才会跟着减 ——
       * 否则用户以为没生效再点一次，白烧风控额度。
       */
      notify();
    }

    /*
     * 账本瘦身：超过上限就丢最旧的，避免把 storage 撑爆。
     *
     * 原实现每次落盘都把两张表的键全捞出来（2 万条约 2.0ms），
     * 超限就整表 sort（约 13.9ms）再删。而 flush 挂在 pagehide 上，
     * 合计 ~20ms 会直接拖住关页面。
     *
     * 现在按「本次会话的写入顺序」淘汰：顺序表天然就是时间顺序，
     * 当队列从头部消费，只淘汰真正溢出的那几条（均摊 O(1)）。
     * 只有「账本是从盘里读出来的、还没有顺序表」时才做一次全表排序重建。
     * 唯一的差异：同一个 mid 被重复拉黑时，原实现会按新时间把它排到后面，
     * 这里保持首次写入的位置 —— 只影响超限时淘汰谁，不影响正确性。
     */
    function pruneTable(which) {
      var b = ensure();
      var src, cap, order, n;
      if (which === 'm') { src = b.m; cap = Pure.BOOK_MID_CAP; order = mOrder; n = nM; }
      else { src = b.r; cap = Pure.BOOK_DEL_CAP; order = rOrder; n = nR; }
      if (n <= cap) return 0;

      /* 没有顺序表（账本是从盘里读出来的）就整表重排一次，rebuild 会顺便按上限裁好 */
      if (!order.length) return rebuild(which);

      var dropped = 0, i = 0, id;
      while (i < order.length && n > cap) {
        id = order[i++];
        if (Object.prototype.hasOwnProperty.call(src, id)) { delete src[id]; n--; dropped++; }
      }
      if (i) order.splice(0, i);
      if (n > cap) dropped += rebuild(which);   /* 兜底：顺序表和账本对不上（多半被手改过） */
      else if (which === 'm') nM = n; else nR = n;
      return dropped;
    }

    /* 按条目时间重排某张表的顺序表，并裁到上限以内 */
    function rebuild(which) {
      var b = ensure(), src, cap, keys = [], k, i, dropped = 0;
      if (which === 'm') { src = b.m; cap = Pure.BOOK_MID_CAP; }
      else { src = b.r; cap = Pure.BOOK_DEL_CAP; }
      for (k in src) keys.push(k);
      keys.sort(function (x, y) {
        return (which === 'm' ? Pure.midTime(src[x]) : (src[x] || 0)) -
               (which === 'm' ? Pure.midTime(src[y]) : (src[y] || 0));
      });
      for (i = 0; i < keys.length - cap; i++) { delete src[keys[i]]; dropped++; }
      keys = keys.slice(dropped);
      if (which === 'm') { mOrder = keys; nM = keys.length; }
      else { rOrder = keys; nR = keys.length; }
      return dropped;
    }

    /* 落盘（内存 -> storage）。平时只记内存，由任务收尾 / 页面卸载合并成一次。 */
    function flush() {
      if (!dirty) return;
      /*
       * 先写成功再清 dirty。
       * 原来反着来：一旦瘦身 / 写盘抛异常，dirty 已经被清掉，
       * 这一轮记录就永远丢了（而且下次也不会再尝试写）。
       */
      try {
        var b = ensure();
        if (nM < 0) nM = countKeys(b.m);
        if (nR < 0) nR = countKeys(b.r);
        if (nM > Pure.BOOK_MID_CAP) pruneTable('m');
        if (nR > Pure.BOOK_DEL_CAP) pruneTable('r');
        if (Store.writeBook(b)) dirty = false;
      } catch (e) {
        /* 保持 dirty，下次还有机会写进去 */
      }
    }

    function count() {
      var b = ensure();
      if (nM < 0) nM = countKeys(b.m);
      return nM;
    }

    function list() { return Pure.bookToArray(ensure()); }

    function hasMid(mid) { return !!ensure().m[mid]; }

    function isDeleted(rpid) {
      var id = '' + rpid;
      return !!deleted[id] || !!ensure().r[id];
    }

    function clear() {
      book = { m: {}, r: {} };
      nM = 0; nR = 0; mOrder = []; rOrder = [];
      Store.writeBook(book);
      dirty = false;
    }

    /* 显式瘦身（测试与「清空记录」路径用） */
    function prune() {
      var b = ensure(), dropped = 0;
      if (nM < 0) nM = countKeys(b.m);
      if (nR < 0) nR = countKeys(b.r);
      dropped += pruneTable('m');
      dropped += pruneTable('r');
      return dropped;
    }

    return {
      ensure: ensure,
      addMids: addMids,
      markDeleted: markDeleted,
      flush: flush,
      prune: prune,
      count: count,
      list: list,
      hasMid: hasMid,
      isDeleted: isDeleted,
      clear: clear,
      dirty: function () { return dirty; },
      onChange: function (fn) { onChange = fn; },
      /* 测试注入口 */
      __raw: function () { return ensure(); },
      __setDeleted: function (o) { deleted = o; },
      __deleted: function () { return deleted; },
      __countDeleted: function () {
        var n = 0, k;
        for (k in ensure().r) n++;
        return n;
      }
    };
  })();

  /* ---------- 计数 ---------- */

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
  var Counter = (function () {
    var stat = { r: 0, s: 0 };
    var counted = Object.create(null);   /* 去重表 */
    var countedN = 0;

    function state() { return stat; }
    function totalR() { return stat.r; }
    function totalS() { return stat.s; }
    function total() { return stat.r + stat.s; }

    function reset() {
      stat.r = 0;
      stat.s = 0;
      counted = Object.create(null);
      countedN = 0;
    }

    /* 记一条 id，返回 true 表示「这条是新见的」 */
    function track(id) {
      var key = '' + id;
      if (counted[key]) return false;
      /*
       * 去重表满了就不再往里记，但继续计数。
       * 原来这里是 break —— 表一满整个计数就永久冻住，
       * 首页挂着不刷新的重度用户会看到「已清 N 条」再也不动了。
       * 代价是超过 5 万条之后去重保证失效（可能重复计），比数字彻底不动要好。
       */
      if (countedN < Pure.LIMITS.countTrack) { counted[key] = 1; countedN++; }
      return true;
    }

    /* items: [{ id, r, s }]，id 为 null 时不去重。返回 true = 计数真的变了 */
    function add(items) {
      var k, it, changed = false, id;
      for (k = 0; k < items.length; k++) {
        it = items[k];
        /* id 为 0 / 空 时当作「不去重」，否则多个无效 id 会共用一个键，互相吞掉 */
        id = it.id;
        if (id != null && id !== 0 && id !== '0' && id !== '') track(id);
        if (it.r) { stat.r += it.r; changed = true; }
        if (it.s) { stat.s += it.s; changed = true; }
      }
      return changed;
    }

    /* 整楼被带走时，把楼中楼的 rpid 也记进去重表，避免后面重复展开又算一遍 */
    function mark(marks) {
      if (!marks) return;
      for (var k = 0; k < marks.length; k++) {
        if (!marks[k] || marks[k] === '0') continue;
        track(marks[k]);
      }
    }

    return {
      state: state,
      totalR: totalR,
      totalS: totalS,
      total: total,
      reset: reset,
      add: add,
      mark: mark
    };
  })();

  /* ---------- 自己 ---------- */

  var Me = (function () {
    var mid = '';
    var ready = false;   /* /nav 回来之前是 false，此时不能可靠地「跳过自己」 */
    var csrf = '';

    function setMid(v) { mid = '' + v; ready = true; }

    /*
     * csrf 从 cookie 读。
     * 读 document.cookie 是这脚本里最贵的单个操作（实测 ~5us/次），
     * 而且写在 DOM 之后读会强制一次同步样式重算。
     *
     * 但缓存要小心：只缓存「读到了」的情况。读空不能缓存 ——
     * 脚本是 document-start 跑的，那时登录 cookie 可能还没就绪，
     * 一旦把空串缓存住，整个页面生命周期都拿不到 csrf。
     */
    var CSRF_RE = /(?:^|;\s*)bili_jct=([^;]*)/;

    function token() {
      if (csrf) return csrf;
      var m = document.cookie.match(CSRF_RE);
      if (m && m[1]) {
        /* cookie 里出现非法转义时别抛，否则整条 drawBanner 链会断 */
        try { csrf = decodeURIComponent(m[1]); }
        catch (e) { csrf = m[1]; }
      }
      return csrf;
    }

    function resetToken() { csrf = ''; }

    return {
      setMid: setMid,
      mid: function () { return mid; },
      ready: function () { return ready; },
      token: token,
      resetToken: resetToken,
      /* 测试注入口 */
      __setCsrf: function (v) { csrf = v; }
    };
  })();

  /* ==================================================================
   * L2  服务层
   *
   * 判定、过滤、候选集、设置变更。这一层把「规则」和「状态」接起来，
   * 但自己既不发请求也不碰 DOM —— 返回值都是纯数据（{items, marks} 或数组），
   * 交给 L3 去发、L4 去画。
   * ================================================================== */

  /* ---------- 判定：给纯函数接上当前配置 ---------- */

  var Judge = (function () {
    /*
     * 自定义屏蔽词。
     * 旧写法是「每条评论 toLowerCase + 逐个 indexOf」，100 个词 × 几千条评论
     * 就是几十万次字符串扫描。改成合成一个正则：V8 的匹配器比 JS 循环快得多，
     * 而且只扫一遍，词越多越划算。词同样做繁体展开。
     *
     * 三态缓存：undefined = 还没构建，null = 没有词或构建失败。
     * 词一变就 invalidate()，下次判定时重建。
     */
    var cache;
    var nameCache;

    function re() {
      if (cache !== undefined) return cache;
      var words = Config.words();
      cache = words.length ? Pure.buildWordsRe(words) : null;
      return cache;
    }

    /* 自定义屏蔽用户名。和词同构，只是拿名字而不是正文去匹配。 */
    function namesRe() {
      if (nameCache !== undefined) return nameCache;
      var names = Config.names();
      nameCache = names.length ? Pure.buildWordsRe(names) : null;
      return nameCache;
    }

    function invalidate() { cache = undefined; nameCache = undefined; }

    /*
     * 判定上下文。
     *
     * 每个档位一个常驻对象，判定时只改 custom 字段，不新建。
     * 1.5.0 重构时这里是 check(r, tier) ? {tier, custom} : ...，一条评论造一个对象，
     * 一页 60 条就是 60 个短命对象 —— 实测 filterPayload 从 6.7us/页 涨到 8.3us/页（+24%）。
     * isBlocked 是同步纯函数、不重入，所以复用同一个 ctx 是安全的。
     *
     * （注意 isBlocked 内部「每条评论造临时对象」的写法是另一回事，那个不能改：
     *   实测复用壳子反而慢 25%，V8 对这种短命字面量有标量替换。）
     */
    var ctxByTier = Object.create(null);

    function ctxFor(tier) {
      var c = ctxByTier[tier];
      if (!c) c = ctxByTier[tier] = { tier: tier, custom: null, customName: null };
      c.custom = re();
      c.customName = namesRe();
      return c;
    }

    /* 原始评论对象 -> 是否命中 */
    function check(r, tier) {
      return Pure.isBlocked(r, ctxFor(tier || Config.tier()));
    }

    /* 池子条目 -> 是否命中。rejudge 用这个，避免为每条重建原始对象。 */
    function checkItem(it) {
      /*
       * 这里刻意保留「每条造一个临时对象」的写法。
       * 试过复用一个壳子对象再逐字段赋值，实测反而慢 25%
       * （V8 对这种短命字面量有标量替换，复用对象反倒要写真实内存）。
       */
      return Pure.isBlocked(
        { mid: it.mid, member: { uname: it.name }, content: { message: it.text } },
        ctxFor(Config.tier())
      );
    }

    /*
     * 有词但正则没构造出来（极端情况）：退回逐词比对，保证功能不丢。
     * 这条路径只在 buildWordsRe 抛异常时才会被走到。
     */
    function checkFallback(text) {
      var words = Config.words();
      var s = text.toLowerCase();
      for (var i = 0; i < words.length; i++) {
        if (s.indexOf(words[i].toLowerCase()) !== -1) return true;
      }
      return false;
    }

    /* 供 UI / 测试用：一个字符串是否命中自定义词 */
    function hitCustomWord(text) {
      var words = Config.words();
      if (!words.length) return false;
      var r = re();
      if (!r) return checkFallback(text);
      return r.test(text);
    }

    return {
      re: re,
      invalidate: invalidate,
      check: check,
      checkItem: checkItem,
      hitCustomWord: hitCustomWord,
      /* 测试注入口：强制下一次重建词正则 */
      __setCache: function (v) { cache = v; }
    };
  })();

  /* ---------- 过滤：改接口数据 + 记账单 ---------- */

  var Filter = (function () {

    /*
     * 记下「这一批」的置顶 rpid，并把池子里对应的条目标成 pinned。
     *
     * 为什么状态要挂在 Page 上：置顶评论会重复出现在 replies 里，
     * 而第二页那份数据没有 top_replies 字段。只在单份 payload 里认置顶的话，
     * 第二页就会把它当成普通命中评论 —— 命中标记被重新算成 true，
     * 作者于是进了拉黑候选，用户点「拉黑 N」就把 UP 主/置顶评论作者拉黑了。
     */
    function notePinned(data) {
      var fresh = [], tops = data.top_replies, i;
      if (tops && tops.length) {
        for (i = 0; i < tops.length; i++) {
          if (tops[i] && tops[i].rpid != null) fresh.push(tops[i].rpid);
        }
      }
      if (data.top && data.top.upper && data.top.upper.rpid != null) {
        fresh.push(data.top.upper.rpid);
      }
      /*
       * 只回填「这一轮新学到的」置顶 id（正常就 1~2 个），
       * 不做全池扫描 —— 那等于每页多扫 2 万条。
       */
      var added = Page.addPinned(fresh);
      for (i = 0; i < added.length; i++) Pool.markPinned(added[i]);
    }

    /* ---- 楼中楼接口 ---- */
    function filterSub(data, out) {
      var list = data.replies;
      var tier = Config.tier(), sub = Config.sub();
      if (!list || !list.length) return null;
      var i, p;

      /* 池子不关心 sub 设置，先把见过的都记下来 */
      for (i = 0; i < list.length; i++) Pool.add(list[i]);
      if (sub === 'none') return null;

      var items = [], kept = [];
      for (i = 0; i < list.length; i++) {
        if (Judge.check(list[i], tier)) {
          items.push({ id: list[i] && list[i].rpid, r: 0, s: 1 });
          /* 必须回写到池子，否则「只在楼中楼里出现」的评论永远进不了删除 / 拉黑候选 */
          Pool.markHit(list[i] && list[i].rpid);
          continue;
        }
        kept.push(list[i]);
      }
      if (!items.length) return null;
      data.replies = kept;

      /*
       * 楼中楼也把「共 N 条回复」同步减掉，和一级评论的 c.rcount 保持同一口径。
       * 不改的话展开楼中楼会显示「共 8 条」却只列出 3 条。
       *
       * data.total 是同一个数在三处的第三处（root.rcount / page.count / data.total），
       * 只改前两个的话，前端拿 total 算的那个「共 N 条」还是旧值。
       */
      var cut = items.length;
      if (data.root && typeof data.root.rcount === 'number') {
        data.root.rcount = Math.max(0, data.root.rcount - cut);
      }
      if (data.page && typeof data.page.count === 'number') {
        data.page.count = Math.max(0, data.page.count - cut);
      }
      if (typeof data.total === 'number') {
        data.total = Math.max(0, data.total - cut);
      }
      return { items: items, marks: null };
    }

    /* ---- 一级评论 ---- */
    function filterMain(data) {
      var roots = data.replies;
      if (!roots || !roots.length) return null;

      var tier = Config.tier(), sub = Config.sub();
      var items = [], marks = [], kept = [];
      var i, j, k, c, kids, hit, hitKids;

      /* 置顶不处理。先把这一批的置顶 rpid 收进集合（跨页有效），再回填池子标记 */
      notePinned(data);

      for (i = 0; i < roots.length; i++) {
        c = roots[i];
        Pool.add(c);
        if (c && c.replies && c.replies.length) {
          for (j = 0; j < c.replies.length; j++) Pool.add(c.replies[j]);
        }

        if (c && Page.isPinned(c.rpid)) {
          Pool.markPinned(c.rpid);
          kept.push(c);
          continue;
        }

        var rootHit = Judge.check(c, tier);
        if (rootHit) Pool.markHit(c && c.rpid);

        kids = (c && c.replies) || [];
        var hasKids = kids.length > 0;
        /* 整楼删除时楼中楼全没：接口只给预览，rcount 才是真条数 */
        var kidTotal = Math.max((c && c.rcount) || 0, kids.length);

        if (rootHit) {
          items.push({ id: c && c.rpid, r: 1, s: kidTotal });
          for (j = 0; j < kids.length; j++) {
            if (kids[j] && kids[j].rpid != null) marks.push('' + kids[j].rpid);
          }
          continue;
        }

        if (!hasKids || sub === 'none') { kept.push(c); continue; }

        /* 主楼未命中，看楼中楼（判定只跑一遍，命中列表留着后面用） */
        hitKids = [];
        for (j = 0; j < kids.length; j++) {
          if (Judge.check(kids[j], tier)) {
            hitKids.push(j);
            Pool.markHit(kids[j].rpid);
          }
        }
        hit = hitKids.length;
        if (!hit) { kept.push(c); continue; }

        if (sub === 'whole') {
          /*
           * 整楼删除时主楼也已经被藏起来了，必须一并标 hit。
           * 否则候选集里只有楼中楼、没有主楼：删完刷新，主楼又活了。
           */
          Pool.markHit(c && c.rpid);
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

      /*
       * 整页全被过滤时 data.replies 变成空数组，但 cursor 还写着「后面还有」。
       * B站前端有些路径用 replies.length === 0 判断没数据就停止加载，
       * 结果用户看到空评论区、也翻不了页。这里把 cursor 标成到底。
       * 只标 is_end，不动 next：改 next 会破坏 B站自己的翻页偏移。
       */
      if (data.replies && data.replies.length === 0 && roots.length > 0) {
        if (data.cursor && typeof data.cursor === 'object') data.cursor.is_end = true;
      }

      return { items: items, marks: marks.length ? marks : null };
    }

    /*
     * 过滤一份接口数据，只做「改数据 + 记池子」，不碰计数（计数交给 settle）。
     * 返回 null = 这份数据不用管；否则返回 { items, marks }。
     *
     * 注意：调用方必须先跑 onFirstPage（首屏时），顺序反了会把刚记进去的评论清掉。
     */
    function payload(json, kind) {
      var data = json && json.data;
      if (!data) return null;

      /* 顺手拿到 UP 主 mid：写操作要靠它判断「这是不是自己的稿件」 */
      if (kind === 1) {
        if (data.upper && data.upper.mid != null) Page.setUpper(data.upper.mid);
        if (data.replies && data.replies.length) Page.setOid(data.replies[0].oid);
      }

      return kind === 2 ? filterSub(data) : filterMain(data);
    }

    return { payload: payload };
  })();

  /* ---------- 计数提交 ---------- */

  /*
   * 计数变化后要刷横幅；不在这里直接调 UI，走 L5 注入的回调，
   * 免得 L2 反过来依赖 L4。
   */
  var CounterSink = (function () {
    var onChanged = null;
    var onNeedMount = null;

    function setHandlers(a, b) { onChanged = a; onNeedMount = b; }

    /*
     * 只有真把改过的数据交给页面才记数 —— 构造响应失败就不记，
     * 避免出现「数字涨了但评论还在」。
     * r: { items, marks }，由 Filter 产出。
     */
    function settle(r) {
      Counter.mark(r.marks);
      if (!Counter.add(r.items)) return false;
      if (onChanged) onChanged();
      if (onNeedMount) onNeedMount();
      return true;
    }

    return { setHandlers: setHandlers, settle: settle };
  })();

  /* ---------- 候选集 ---------- */

  var Candidates = (function () {
    /*
     * 范围只有两种，都建立在「页面已加载的评论」之上：
     *   命中  = 被档位规则判为要屏蔽的（用户本来也看不见它们）
     *   全部  = 当前已加载的全部评论
     * 置顶评论永远不进候选集，和自己有关的也跳过。
     */
    function forDelete() {
      var out = [], list = Pool.items(), i, it, self = Me.mid(), ready = Me.ready();
      for (i = 0; i < list.length; i++) {
        it = list[i];
        if (it.pinned) continue;
        if (!it.mid) continue;
        /*
         * 自己的 mid 还没拿到时不能放行：否则「自己的评论」会被当成可删目标，
         * 而删自己的评论接口是成功返回的，等于静默删了自己的楼。
         * 拿不到就一律排除，宁可少删，也不误删。
         */
        if (!ready) continue;
        if (it.mid === self) continue;
        if (!it.hit) continue;
        /* 已删过的排除：删完一批按钮数字要跟着减，否则用户会再点一次白烧风控额度 */
        if (Ledger.isDeleted(it.rpid)) continue;
        out.push(it);
      }
      return out;
    }

    /* 拉黑候选：去重到人。同一个人刷了一屏也只算一次 */
    function forBlock() {
      var out = [], seen = new Set();
      var list = Pool.items(), i, it;
      var self = Me.mid(), ready = Me.ready(), upper = Page.upper();
      /*
       * 用 Set 而不是 Object.create(null) 当去重表：
       * mid 是 1.5e9 量级的数字字符串，V8 会把这类键归一化成数组索引，
       * 落进字典元素存储，实测比 Set 慢 2.2 倍（0.118ms -> 0.054ms @ pool=5000）。
       */
      for (i = 0; i < list.length; i++) {
        it = list[i];
        if (!it.hit) continue;
        if (!it.mid || !ready) continue;
        if (it.mid === self || it.mid === upper) continue;
        if (seen.has(it.mid)) continue;
        seen.add(it.mid);
        if (Ledger.hasMid(it.mid)) continue;
        out.push(it);
      }
      return out;
    }

    /*
     * 候选数缓存。版本号没变就直接复用上一次的结果，
     * 这是横幅每次刷新都要读的两个数字，热路径上不能重复扫 2 万条。
     */
    var cache = { ver: -1, d: 0, b: 0 };

    function refresh() {
      var v = Pool.ver();
      if (cache.ver === v) return cache;
      cache.ver = v;
      cache.d = forDelete().length;
      cache.b = forBlock().length;
      return cache;
    }

    function resetCache() { cache.ver = -1; }

    function anyHit() {
      var c = refresh();
      return !!(c.d || c.b);
    }

    return {
      forDelete: forDelete,
      forBlock: forBlock,
      refresh: refresh,
      resetCache: resetCache,
      anyHit: anyHit
    };
  })();

  /* ---------- 设置变更 ---------- */

  /*
   * 改档位 / 改楼中楼 / 改屏蔽词之后统一走这里：
   *   重新判定已加载的评论 -> 计数清零 -> 落盘 -> 让候选缓存失效 -> 重画
   * 原来这段在三个 onclick 里各抄了一遍，漏一处就会出现「切了档位但数字不动」。
   */
  var Settings = (function () {
    var onChange = null;   /* L5 注入：设置变了重画横幅 */

    function bind(fn) { onChange = fn; }

    /* 词变了：判定正则要重建 */
    function wordsDirty() {
      Judge.invalidate();
      return apply();
    }

    function apply() {
      /* 命中规则变了，已加载的评论要重新判定，否则按钮数字停在旧值 */
      Counter.reset();
      Pool.rejudge(Judge.checkItem);
      Config.save();
      Pool.bump();
      if (onChange) onChange();
    }

    function setTier(tier) { Config.set({ tier: tier }); apply(); }
    function setSub(sub) { Config.set({ sub: sub }); apply(); }
    function setShowCount(v) { Config.set({ showCount: !!v }); Config.save(); if (onChange) onChange(); }
    function setShowActs(v) { Config.set({ showActs: !!v }); Config.save(); if (onChange) onChange(); }

    /* 加 / 删自定义词。返回 { ok, word? , msg? } */
    function addWord(raw) {
      var r = Pure.validateWord(raw, Config.words(), Pure.LIMITS.words, '词');
      if (!r.ok) return r;
      Config.words().push(r.word);
      wordsDirty();
      return r;
    }

    function removeWord(w) {
      var ws = Config.words();
      for (var i = 0; i < ws.length; i++) {
        if (ws[i] === w) { ws.splice(i, 1); wordsDirty(); return true; }
      }
      return false;
    }

    /* 加 / 删自定义屏蔽用户名。和词同一套规则，只是作用在账号名上 */
    function addName(raw) {
      var r = Pure.validateWord(raw, Config.names(), Pure.LIMITS.names, '用户名');
      if (!r.ok) return r;
      Config.names().push(r.word);
      wordsDirty();
      return r;
    }

    function removeName(n) {
      var ns = Config.names();
      for (var i = 0; i < ns.length; i++) {
        if (ns[i] === n) { ns.splice(i, 1); wordsDirty(); return true; }
      }
      return false;
    }

    return {
      bind: bind,
      apply: apply,
      wordsDirty: wordsDirty,
      setTier: setTier,
      setSub: setSub,
      setShowCount: setShowCount,
      setShowActs: setShowActs,
      addWord: addWord,
      removeWord: removeWord,
      addName: addName,
      removeName: removeName
    };
  })();

  /* ---------- 页面生命周期 ---------- */

  var Lifecycle = (function () {
    var resetListeners = [];

    /* 换稿件时要额外做点什么（目前只有「停掉正在跑的任务」），由 L5 注册 */
    function onReset(fn) { resetListeners.push(fn); }

    /*
     * 首屏请求 = 换了视频 / 换了排序 / 刷新。
     * 记住的评论池必须整组清掉：池子里每条都带着自己的 oid，写任务又是按 item.oid 发请求的。
     * 不清的话，在视频 B 上点「删除」，候选里会混进视频 A 的评论，然后真的去删 A 下面的评论。
     * 单页路由切换没有整页刷新，这条是唯一的防线。
     */
    function onFirstPage() {
      /* 换了稿件 / 换了排序，正在跑的任务手里的目标是上一批的，直接停掉 */
      for (var i = 0; i < resetListeners.length; i++) resetListeners[i]();
      Counter.reset();
      Pool.reset();
      /*
       * oid 和 UP 主 mid 也必须一起清。
       * 不清 oid：切到评论区为空的稿件时新首屏拿不到 oid，旧值还在，
       *           守卫「页面已切换就中断」直接失效，任务会拿旧 oid 继续发请求。
       * 不清 mid：上一次稿件的 UP 主会带到新稿件，
       *           新稿件里同 mid 的人被当成 UP 主跳过，永远拉黑不到。
       */
      Page.reset();
    }

    return { onFirstPage: onFirstPage, onReset: onReset };
  })();

  /* ==================================================================
   * L3  副作用层：网络
   *
   * 写接口全部走 rawFetch —— 脚本自己 hook 了 W.fetch，如果不绕开，
   * 自己的写请求会先被自己的钩子解析一遍，属于自己咬自己。
   * 原始引用在钩子之前就抓下来，这里只用那份。
   * ================================================================== */

  var Net = (function () {
    var rawFetch = (typeof W.fetch === 'function') ? W.fetch.bind(W) : null;

    function sleep(ms) {
      return new Promise(function (r) { setTimeout(r, ms); });
    }

    /* 发一个表单 POST，返回解析后的 json */
    function postForm(path, body) {
      var url = 'https://api.bilibili.com' + path;
      /*
       * 加超时：没有超时的话，一个卡住的请求会让执行器永远停在 await 上 ——
       * j.running 一直是 true，任务再也开不起来。
       */
      var ctrl = null, timer = 0;
      var init = {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body
      };
      try {
        if (typeof AbortController === 'function') {
          ctrl = new AbortController();
          init.signal = ctrl.signal;
          timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, Pure.TIMING.reqTimeout);
        }
      } catch (e) {}

      if (!rawFetch) return Promise.resolve({ code: -999, message: '网络错误' });
      return rawFetch(url, init).then(function (res) {
        if (timer) { clearTimeout(timer); timer = 0; }
        return res.text().then(function (txt) {
          try { return JSON.parse(txt); }
          catch (e) { return { code: -999, message: '返回的不是 JSON' }; }
        });
      });
    }

    /*
     * 带退避重试地发一次。只有 -509 重试有意义，判定在 Pure.shouldRetry 里。
     * 1.2s + 2.4s + 3.6s 逐次退避，总共不到 8 秒。
     */
    function postWithRetry(path, body, attempt) {
      attempt = attempt || 0;
      return postForm(path, body)['catch'](function () {
        return { code: -999, message: '网络错误' };
      }).then(function (j) {
        var code = j && j.code;
        if (code === 0) return j;
        if (Pure.shouldRetry(code, attempt)) {
          return sleep(Pure.TIMING.retryBase * (attempt + 1))
            .then(function () { return postWithRetry(path, body, attempt + 1); });
        }
        return j;
      });
    }

    function delReply(oid, type, rpid) {
      var body = 'oid=' + encodeURIComponent(oid) +
                 '&type=' + encodeURIComponent(type) +
                 '&rpid=' + encodeURIComponent(rpid) +
                 '&csrf=' + encodeURIComponent(Me.token());
      return postWithRetry('/x/v2/reply/del', body, 0);
    }

    /*
     * 批量拉黑，一次最多 50 个。
     * 用批量接口而不是逐个调：请求数从 N 降到 N/50，
     * 对本来就很敏感的风控来说，这个差别很关键。
     */
    function batchBlock(mids) {
      var body = 'fids=' + mids.join(',') +
                 '&act=5' +
                 '&re_src=11' +
                 '&csrf=' + encodeURIComponent(Me.token());
      return postWithRetry('/x/relation/batch/modify', body, 0);
    }

    /* 自己的 mid：登录接口最快，失败就算了（只影响「跳过自己」这一条） */
    function fetchSelf(onReady) {
      if (!rawFetch) return;
      try {
        rawFetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var d = j && j.data;
            if (!d || !d.mid) return;
            Me.setMid(d.mid);
            if (onReady) onReady();
          })['catch'](function () {});
      } catch (e) {}
    }

    return {
      raw: function () { return rawFetch; },
      sleep: sleep,
      postForm: postForm,
      postWithRetry: postWithRetry,
      delReply: delReply,
      batchBlock: batchBlock,
      fetchSelf: fetchSelf
    };
  })();

  /* ==================================================================
   * L3  执行器
   *
   * 一次只跑一个任务，随时可停。
   * 停止是第一优先的：在两条之间检查，不会出现「点了停还在执行」。
   *
   * 这个模块是唯一一个「状态就在自己身上」的地方（Job.current）：
   * 任务的生命周期天然是一个整体，拆成池子反而更难读。
   * 但它对外只暴露 start / stop / snapshot，UI 读不到内部字段的写入口。
   * ================================================================== */

  var Job = (function () {
    var current = null;
    var onUpdate = null;    /* L5 注入：进度变化时重画 */
    var onEnd = null;       /* L5 注入：任务收尾时重画 + 计数归零 */

    function bind(upd, end) { onUpdate = upd; onEnd = end; }

    function ping() { if (onUpdate) onUpdate(); }

    /* 读视图：UI 只拿得到这几个数，改不了 */
    function snapshot(j) {
      var t = j || current;
      if (!t) return null;
      return {
        kind: t.kind, total: t.total, done: t.done, ok: t.ok, fail: t.fail,
        running: t.running, stop: t.stop, note: t.note, err: t.err, errs: t.errs
      };
    }

    function isRunning() { return !!(current && current.running); }

    function pushErr(j, msg, who) {
      if (j.errs.length < Pure.LIMITS.errs) j.errs.push({ msg: msg, who: who || '' });
    }

    function start(kind, targets, gen) {
      if (current && current.running) return current;
      /* 顺手把 mid -> 用户名 存下来，拉黑成功后写进账本，黑名单页才有人名可显示 */
      var nameOf = Object.create(null), n;
      for (n = 0; n < targets.length; n++) {
        if (targets[n].mid && targets[n].name) nameOf[targets[n].mid] = targets[n].name;
      }
      current = {
        kind: kind,
        list: targets,
        /*
         * 目标是在哪个稿件上选出来的。UI 在「点确认」那一刻传进来，
         * 没传就用当前值（测试 / 直接调用）。请求前比对它，换了稿件立刻停。
         */
        gen: (gen == null ? Page.gen() : gen),
        total: targets.length,
        done: 0, ok: 0, fail: 0,
        running: true,
        stop: false,
        note: '',        /* 当前提示（限流、错误原因） */
        err: '',         /* 异常中断的原因 */
        errs: [],        /* 失败明细 */
        nameOf: nameOf
      };
      ping();
      pump(current);
      return current;
    }

    function stop() {
      if (current && current.running) { current.stop = true; current.note = '正在停止…'; ping(); }
    }

    /* 页面切走了：任务手里的目标属于上一个稿件，直接停 */
    function abortForPageChange() {
      if (current && current.running) {
        current.stop = true;
        current.note = '页面已切换，任务中断';
      }
    }

    /*
     * 收尾单独抽出来：不管任务怎么结束（正常、异常、被 stop），
     * 都必须走到这里。否则一旦中途抛异常，j.running 会永远停在 true，
     * stop 也唤不醒已经死掉的 promise，start 的守卫又会直接返回这个僵尸 job
     * —— 整个删除 / 拉黑功能在本次页面生命周期里就废了，只能刷新。
     */
    function finish(j) {
      j.running = false;
      Ledger.flush();
      if (j.stop) {
        j.note = '已停止';
      } else if (j.err && !j.note) {
        j.note = j.err;
      } else if (!j.note || j.note === '正在删除…' || j.note === '正在拉黑…' || j.note === '正在停止…') {
        j.note = '已完成';
      }
      if (onUpdate) onUpdate();
      if (onEnd) { try { onEnd(j); } catch (e) {} }
    }

    async function pump(j) {
      try {
        await run(j);
      } catch (e) {
        /* 任何没预料到的异常都不能让任务挂死 */
        j.err = '任务中断：' + ((e && e.message) || e);
        pushErr(j, j.err, '');
      } finally {
        finish(j);
      }
    }

    /* ---- 删除 ---- */
    async function runDel(j) {
      for (var i = 0; i < j.list.length; i++) {
        if (j.stop) break;
        var t = j.list[i];
        /*
         * 页面已经切到别的稿件了就立刻收工。
         * 继续跑下去等于拿旧 oid 去删上一个视频的评论 —— 删完就回不来了。
         *
         * 两道判据：
         *   1. 稿件代数变了（首选）。代数在 onFirstPage 里加一，
         *      切到「评论区为空」的稿件时也照样能判定出来 —— 那种情况新页面
         *      根本拿不到 oid，光比 oid 是比不出来的（1.5.0 之前就是这么漏的）。
         *   2. oid 对不上（兜底）。当前 oid 存在、目标也带 oid、两者不等 -> 停。
         */
        if (j.gen != null && j.gen !== Page.gen()) {
          j.note = '页面已切换到别的稿件，任务中断';
          break;
        }
        var cur = Page.oid();
        if (cur && t.oid && t.oid !== cur) {
          j.note = '页面已切换到别的稿件，任务中断';
          break;
        }
        j.note = '正在删除…';
        ping();

        var r = await Net.delReply(t.oid, t.type, t.rpid);
        var why = Pure.explain(r.code, r.message);

        if (!why) {
          j.ok++;
          Ledger.markDeleted(t.rpid);
        } else {
          j.fail++;
          pushErr(j, why, t.name);
          /* 登录态 / 权限这类问题，继续跑下去只会全军覆没，直接收工 */
          if (Pure.isFatal(r.code)) {
            j.note = why;
            j.done++;
            break;
          }
        }
        j.done++;
        ping();

        if (i < j.list.length - 1 && !j.stop) await Net.sleep(Pure.TIMING.delGap);
      }
    }

    /* ---- 拉黑：按 50 一组打包 ---- */
    async function runBlock(j) {
      var mids = Pure.uniqueMids(j.list);
      /*
       * 进度以「去重后的人数」为分母。
       * 原来 total 用的是去重前的 j.list.length，而 done 按去重后的批次累加，
       * 3 个目标里有 1 个重复时就会显示 done 2 / total 3、进度条停在 67% 却说「已完成」。
       */
      j.total = mids.length;
      var p, chunk, q, br, bwhy, failed, failedSet, good, goodNames;

      for (p = 0; p < mids.length; p += Pure.BLOCK_BATCH) {
        if (j.stop) break;
        /* 拉黑是账号级操作，换稿件不影响它，所以这里不判代数 —— 只有删除才绑稿件 */
        chunk = mids.slice(p, p + Pure.BLOCK_BATCH);
        j.note = '正在拉黑…';
        ping();

        br = await Net.batchBlock(chunk);
        bwhy = Pure.explain(br.code, br.message);

        if (!bwhy) {
          failed = (br.data && br.data.failed_fids) || [];
          failedSet = Object.create(null);
          for (q = 0; q < failed.length; q++) failedSet['' + failed[q]] = 1;

          good = []; goodNames = Object.create(null);
          for (q = 0; q < chunk.length; q++) {
            if (failedSet[chunk[q]]) {
              j.fail++;
            } else {
              j.ok++;
              good.push(chunk[q]);
              goodNames[chunk[q]] = j.nameOf[chunk[q]] || '';
            }
          }
          Ledger.addMids(good, goodNames);
        } else {
          j.fail += chunk.length;
          pushErr(j, bwhy, chunk.length + ' 人');
          if (Pure.isFatal(br.code)) { j.note = bwhy; j.done += chunk.length; break; }
        }
        j.done += chunk.length;
        ping();

        if (p + Pure.BLOCK_BATCH < mids.length && !j.stop) await Net.sleep(Pure.TIMING.blockGap);
      }
    }

    function run(j) {
      return j.kind === 'del' ? runDel(j) : runBlock(j);
    }

    return {
      bind: bind,
      start: start,
      stop: stop,
      abortForPageChange: abortForPageChange,
      isRunning: isRunning,
      snapshot: snapshot,
      /* 测试注入口：拿到底层对象（用例要等它收尾） */
      __current: function () { return current; },
      __setCurrent: function (j) { current = j; }
    };
  })();

  /* ==================================================================
   * L3  拦截
   *
   * 所有屏蔽都发生在接口数据层，不碰 DOM：
   *   fetch / XHR -> clone 响应 -> JSON.parse -> Filter.payload -> 改过的 JSON 塞回去
   * 评论从未进入渲染队列，所以不会闪。
   * ================================================================== */

  var Hooks = (function () {

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

    /*
     * 处理一份已经解析好的接口数据，是「数据进页面」的唯一入口。
     *
     * 顺序很重要：首屏要先清掉上一轮的池子和计数，再解析这份新数据。
     * 反过来（先解析再清）会把刚记录进去的评论一起清掉，结果候选数和计数永远是 0。
     * 另外「请求成功了就清」，而不是「有命中才清」——
     * 否则切到零评论 / 零命中的视频时，上一个视频的数字会残留。
     *
     * 首屏前后要刷横幅（哪怕一条都没过滤），这一步由 L5 注入，本层不碰 UI。
     */
    var sink = {
      onFirstPage: function () { Lifecycle.onFirstPage(); },
      beforeFirstPage: function () {},
      afterFirstPage: function () {},
      commit: function (r) { return CounterSink.settle(r); }
    };

    function bind(s) {
      if (s.onFirstPage) sink.onFirstPage = s.onFirstPage;
      if (s.beforeFirstPage) sink.beforeFirstPage = s.beforeFirstPage;
      if (s.afterFirstPage) sink.afterFirstPage = s.afterFirstPage;
      if (s.commit) sink.commit = s.commit;
    }

    function digest(json, kind, first) {
      if (first) { sink.onFirstPage(); sink.beforeFirstPage(); }
      var r = Filter.payload(json, kind);
      if (first) sink.afterFirstPage();
      return r;
    }

    function hookFetch() {
      var rawFetch = Net.raw();
      if (!rawFetch) return;

      var wrapped = function (input) {
        /*
         * url 有三种可能：字符串、Request 对象（有 .url）、URL 对象（只有 .href）。
         * 只读 .url 的话 fetch(new URL(...)) 会被当成「不是评论接口」直接放行。
         */
        var url = Pure.normalizeUrl(input);
        var kind = Pure.apiKind(url);
        var promise = rawFetch.apply(this, arguments);
        if (!kind) return promise;

        var first = Pure.isFirstPageReq(url, kind);

        return promise.then(function (res) {
          if (!res || !res.ok) return res;
          /*
           * clone() 在 body 已被消费（比如 302 跟随过）时会【同步】抛 TypeError。
           * 必须在这里就地包住：外层 .catch 挂在 then 内部，
           * 同步异常会逃逸出去让页面的 fetch() reject —— 正是最不该发生的「炸页面」。
           */
          var cloned = null;
          try { cloned = res.clone(); } catch (e) { return res; }
          if (!cloned) return res;
          return cloned.text().then(function (txt) {
            var json;
            try { json = JSON.parse(txt); } catch (e) { return res; }

            var r = null;
            try { r = digest(json, kind, first); } catch (e) { return res; }
            if (!r || !r.items.length) return res;

            var out;
            try { out = cloneRes(res, JSON.stringify(json)); }
            catch (e) { return res; }

            sink.commit(r);
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
        if (xhr.readyState !== 4) return null;
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
          /* 同 fetch：先清上一轮，再解析这一份，顺序反了会把新数据一起清掉 */
          var f = digest(obj, xhr.__dfyKind, xhr.__dfyFirst);
          if (!f || !f.items.length) return (xhr.__dfyCache = null);
          f.isJson = isJson;
          f.obj = obj;
          f.out = isJson ? obj : JSON.stringify(obj);
          sink.commit(f);
          r = f;
        } catch (err) { r = null; }
        return (xhr.__dfyCache = r);
      }

      var open = proto.open;
      proto.open = function (m, url) {
        this.__dfyKind = Pure.apiKind(url);
        this.__dfyFirst = Pure.isFirstPageReq(url, this.__dfyKind);
        this.__dfyDone = 0;
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
                if (xhr.responseType === 'json') return getText.call(xhr);
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

    return { hookFetch: hookFetch, hookXHR: hookXHR, digest: digest, bind: bind };
  })();

  /* ==================================================================
   * L4  界面层
   *
   * 三块 Shadow DOM，互不影响：
   *   ui.host     右上角浮层  主面板，「屏蔽设置」/「删除 / 拉黑」两个页签原地切换
   *   ui.subHost  同上        二级页：自定义屏蔽词
   *   ui.bHost    评论区顶部   横幅，「已清 N 条」+ 右侧一串
   *
   * 这一层只读状态层 / 服务层的查询函数（Pool.length() / Counter.state() /
   * Candidates.refresh() / Config.tier() ...），写一律走它们的 set / mark 接口。
   * 反过来，状态层和服务层不认识任何 DOM 节点 —— 这是本次重构切得最干净的一条边界。
   *
   * 界面自己的可变状态集中在一个 UIState 对象里（见下），
   * 不再散着 host / panel / bHost / bBar / bDel / bBlk / tab / actMode / rv ... 二十几个变量。
   * ================================================================== */

  /* 主面板 / 二级页 / toast 的样式。只有一份，三个 shadow root 共用。 */
  var CSS = ":host{all:initial}\n*{box-sizing:border-box;margin:0;padding:0}\n\n/* 主题变量 */\n.t{\n  --bg:rgba(252,251,249,.94);--bd:rgba(0,0,0,.07);--tx:#1f1f23;--dim:#8b8b94;\n  --sh:0 20px 48px -18px rgba(0,0,0,.34),0 2px 6px -2px rgba(0,0,0,.06),inset 0 1px 0 rgba(255,255,255,.9);\n  --hv:rgba(0,0,0,.05);--tg:rgba(0,0,0,.1);--line:rgba(0,0,0,.07)\n}\n.t.dk{\n  --bg:rgba(38,38,44,.94);--bd:rgba(255,255,255,.1);--tx:#f0f0f4;--dim:#9a9aa6;\n  --sh:0 20px 48px -18px rgba(0,0,0,.8),0 2px 6px -2px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.07);\n  --hv:rgba(255,255,255,.09);--tg:rgba(255,255,255,.16);--line:rgba(255,255,255,.09)\n}\n\n/* 面板 */\n.p{position:fixed;top:78px;right:18px;z-index:2147483600;width:300px;\nmax-height:calc(100vh - 96px);display:flex;flex-direction:column;\npadding:20px 20px 14px;border-radius:20px;\nbackground:var(--bg);\nbackdrop-filter:blur(40px) saturate(180%);-webkit-backdrop-filter:blur(40px) saturate(180%);\nborder:1px solid var(--bd);box-shadow:var(--sh);\nfont-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"HarmonyOS Sans SC\",\"Microsoft YaHei\",sans-serif;\n-webkit-font-smoothing:antialiased;\ntransform-origin:top right;animation:pop .18s cubic-bezier(.2,.9,.3,1)}\n@keyframes pop{from{opacity:0;transform:scale(.93) translateY(-6px)}to{opacity:1;transform:none}}\n\n/* 关闭 */\n.x{position:absolute;top:13px;right:14px;width:26px;height:26px;\ndisplay:flex;align-items:center;justify-content:center;\nfont-size:19px;line-height:1;color:var(--dim);cursor:pointer;border-radius:8px;\ntransition:background .14s,color .14s;user-select:none}\n.x:hover{background:var(--hv);color:var(--tx)}\n\n/* 分组标题 */\n.g{font-size:11.5px;font-weight:600;color:var(--dim);letter-spacing:.1em;\npadding:16px 8px 7px}\n.g:first-of-type{padding-top:2px}\n\n/* 选项 */\n.o{font-size:16px;line-height:1.2;color:var(--tx);padding:12px 14px;border-radius:11px;cursor:pointer;\ntransition:background .14s,color .14s,transform .1s}\n.o:hover{background:var(--hv)}\n.o:active{transform:scale(.985)}\n.o.on{background:#fb7299;color:#fff;font-weight:600;\nbox-shadow:0 4px 14px -4px rgba(251,114,153,.7)}\n\n/* 开关行 */\n.s{display:flex;align-items:center;justify-content:space-between;\nfont-size:15px;color:var(--tx);\npadding:16px 8px 8px;margin-top:10px;border-top:1px solid var(--line)}\n.sw{width:42px;height:24px;border-radius:12px;background:var(--tg);position:relative;cursor:pointer;\ntransition:background .2s;flex:none}\n.sw.on{background:#fb7299}\n.sw:after{content:\"\";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;\nbackground:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);transition:left .2s cubic-bezier(.3,1.2,.5,1)}\n.sw.on:after{left:21px}\n\n/* 评论区那行字 */\n.b{display:inline-block;padding:12px 22px;margin:6px 0 20px;border-radius:12px;\nfont-size:16px;line-height:1.4;letter-spacing:.01em;user-select:none;font-weight:600;\nfont-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"HarmonyOS Sans SC\",\"Microsoft YaHei\",sans-serif;\n-webkit-font-smoothing:antialiased;\ncolor:#59616d;background:rgba(0,0,0,.055);\nborder:1px solid rgba(0,0,0,.055)}\n\n/* 气泡：已加的屏蔽词 */\n/* 词多了要能滚，否则面板会顶穿屏幕、保存按钮点不到。\n   只有真的溢出时才加 .more 显示底部渐隐，短列表不加，免得把内容淡掉 */\n.ws{display:flex;flex-wrap:wrap;gap:7px;padding:2px 6px 10px;min-height:8px;\nmax-height:min(46vh,340px);overflow-y:auto;overscroll-behavior:contain}\n.ws:empty{display:none}\n.ws.more{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 18px),transparent 100%);\nmask-image:linear-gradient(to bottom,#000 calc(100% - 18px),transparent 100%)}\n/* 滚动条做得轻一点，别抢视觉 */\n.ws::-webkit-scrollbar{width:6px}\n.ws::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:3px}\n.ws::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.28)}\n.ws::-webkit-scrollbar-track{background:transparent}\n.dk .ws::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2)}\n.dk .ws::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.34)}\n.w{display:inline-flex;align-items:center;gap:5px;\nmax-width:100%;padding:6px 6px 6px 11px;border-radius:9px;\nfont-size:13.5px;line-height:1.25;color:var(--tx);\nbackground:rgba(251,114,153,.12);\nborder:1px solid rgba(251,114,153,.3);\nword-break:break-all;animation:tin .16s cubic-bezier(.2,.9,.3,1)}\n@keyframes tin{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:none}}\n.w span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.w i{flex:none;width:17px;height:17px;display:flex;align-items:center;justify-content:center;\nfont-style:normal;font-size:13px;line-height:1;border-radius:5px;cursor:pointer;\ncolor:#fb7299;opacity:.75;transition:background .14s,opacity .14s}\n.w i:hover{background:rgba(251,114,153,.2);opacity:1}\n.w.dk{background:rgba(251,114,153,.16);border-color:rgba(251,114,153,.34)}\n\n/* 输入行：输入框 + 确定 */\n.r{display:flex;gap:8px;padding:2px 6px 4px}\n.in{flex:1;min-width:0;height:38px;padding:0 12px;border-radius:10px;\nfont-size:14.5px;font-family:inherit;color:var(--tx);\nbackground:var(--hv);border:1px solid var(--bd);outline:none;\ntransition:border-color .14s,background .14s}\n.in::placeholder{color:var(--dim)}\n.in:focus{border-color:rgba(251,114,153,.55);background:var(--tg)}\n.btn{flex:none;height:38px;padding:0 15px;border-radius:10px;\nfont-size:14.5px;font-weight:600;line-height:38px;cursor:pointer;\ncolor:var(--tx);background:var(--hv);border:1px solid var(--bd);\ntransition:background .14s,opacity .14s,transform .1s}\n.btn:hover{background:var(--tg)}\n.btn:active{transform:scale(.97)}\n.btn.pri{color:#fff;background:#fb7299;border-color:#fb7299;\nbox-shadow:0 4px 14px -6px rgba(251,114,153,.8)}\n.btn.pri:hover{background:#fa5c8b}\n\n\n/* 内容区：两页共用，内容长了自己滚；页签和底部按钮固定 */\n.p>.bd{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}\n.p>.bd::-webkit-scrollbar{width:6px}\n.p>.bd::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:3px}\n.dk .p>.bd::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2)}\n.p>.nav,.p>.f,.p>.x{flex:none}\n\n/* 底部操作区 */\n.f{display:flex;justify-content:flex-end;gap:8px;\npadding:14px 6px 2px;margin-top:8px;border-top:1px solid var(--line)}\n\n\n.tip{font-size:12px;line-height:1.5;color:var(--dim);padding:8px 6px 0}\n\n/* 保存成功提示：贴在面板上方出现，位置由 JS 算 */\n.toast{position:fixed;z-index:2147483647;padding:11px 22px;border-radius:12px;\nmax-width:min(360px,80vw);\nfont-size:14.5px;font-weight:600;line-height:1.35;\nbackground:rgba(38,38,44,.94);color:#fff;\nborder:1px solid rgba(255,255,255,.14);\nbox-shadow:0 16px 40px -14px rgba(0,0,0,.6);\nopacity:0;pointer-events:none;\ntransform:translateY(6px);\ntransition:opacity .2s ease,transform .2s cubic-bezier(.2,.9,.3,1)}\n.toast.on{opacity:1;transform:translateY(0)}\n.toast.dk{background:rgba(252,251,249,.96);color:#1f1f23;\nborder:1px solid rgba(0,0,0,.08)}\n/* ===== 1.4 新增：导航 / 操作页 / 风险提示 ===== */\n\n/* 顶部导航：两个页签 */\n.nav{display:flex;gap:6px;padding:0 2px 6px}\n.nv{flex:1;text-align:center;font-size:13.5px;padding:8px 0;border-radius:9px;\ncursor:pointer;color:var(--dim);transition:background .14s,color .14s;user-select:none}\n.nv:hover{background:var(--hv)}\n.nv.on{background:var(--hv);color:var(--tx);font-weight:600}\n\n/* 操作页里的条目：标题 + 一句说明 */\n.op{padding:11px 12px;border-radius:11px;cursor:pointer;\ntransition:background .14s,transform .1s}\n.op:hover{background:var(--hv)}\n.op:active{transform:scale(.99)}\n.op.off{opacity:.45;cursor:default}\n.op.off:hover{background:transparent}\n.op .t1{font-size:15px;line-height:1.3;color:var(--tx);display:flex;\nalign-items:center;justify-content:space-between;gap:8px}\n.op .t2{font-size:12px;line-height:1.5;color:var(--dim);margin-top:4px}\n.op .cnt{font-size:12px;font-weight:600;color:#fb7299;background:rgba(251,114,153,.13);\npadding:2px 8px;border-radius:20px;flex:none}\n\n/* 危险条目：删除 / 拉黑 */\n.op.dg .t1{color:#e0324f}\n.t.dk .op.dg .t1{color:#ff7b8f}\n\n/* 关键词误判警告：操作页顶部那一块，比 risk 更醒目 */\n.warn{font-size:12px;line-height:1.6;font-weight:700;color:#fff;\nbackground:#e0324f;border-radius:10px;padding:12px 14px;margin:2px 2px 8px}\n.t.dk .warn{background:#c72a44;color:#fff}\n\n/* 风险提示块 */\n.risk{font-size:12px;line-height:1.6;color:#c2334d;\nbackground:rgba(251,114,153,.09);border:1px solid rgba(251,114,153,.22);\nborder-radius:10px;padding:9px 11px;margin:4px 2px 0}\n.t.dk .risk{color:#ff8fa0;background:rgba(251,114,153,.13);border-color:rgba(251,114,153,.3)}\n.risk b{font-weight:600}\n\n/* 进度 */\n.pg{height:6px;border-radius:3px;background:var(--tg);overflow:hidden;margin:10px 2px 6px}\n.pg i{display:block;height:100%;width:0;background:#fb7299;border-radius:3px;\ntransition:width .25s ease}\n.pgn{font-size:12px;color:var(--dim);padding:0 2px;display:flex;\njustify-content:space-between;gap:8px}\n.pgn b{color:var(--tx);font-weight:600}\n\n/* 小号列表（黑名单） */\n.sc{padding:2px 2px 0}\n.sc::-webkit-scrollbar{width:6px}\n.sc::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:3px}\n.dk .sc::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2)}\n.li{display:flex;align-items:center;justify-content:space-between;gap:10px;\nfont-size:13px;color:var(--tx);padding:8px 8px;border-radius:8px}\n.li:hover{background:var(--hv)}\n.li .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.li .mid{font-size:11px;color:var(--dim);flex:none;font-variant-numeric:tabular-nums}\n\n/* 空状态 */\n.empty{font-size:12.5px;color:var(--dim);text-align:center;padding:20px 8px;line-height:1.6}\n\n/* 危险确认：主按钮换成红 */\n.btn.dg{color:#fff;background:#e0324f;border-color:#e0324f;\nbox-shadow:0 4px 14px -6px rgba(224,50,79,.8)}\n.btn.dg:hover{background:#c72a44}\n.btn.gh{background:transparent}\n\n/* 两按钮并排 */\n.f2{display:flex;gap:8px;padding:14px 2px 2px;margin-top:8px;border-top:1px solid var(--line)}\n.f2 .btn{flex:1;text-align:center;padding:0}\n";

  /* 评论区顶部横幅的样式。它挂在 B站自己的 shadow 里，所以单独一份、全部 dfy- 前缀。 */
  var INJ_CSS =
    '.dfy-b{display:flex;align-items:center;justify-content:flex-start;gap:10px;' +
      'padding:10px 2px;margin:4px 0 14px;border-bottom:1px solid rgba(0,0,0,.06)}' +
    '.dfy-b .dfy-n{font-size:15px;line-height:1.4;color:#59616d;font-weight:600;' +
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC",' +
      '"Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}' +
    '.dfy-b .dfy-w{font-size:12px;line-height:1.3;color:#c2334d;font-weight:600;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:0 1 auto}' +
    '.dfy-b.dfy-dk .dfy-w{color:#ff8fa0}' +
    '.dfy-b .dfy-a{display:flex;gap:8px;flex:none}' +
    '.dfy-b .dfy-btn{font-size:13px;font-weight:600;line-height:1;padding:9px 13px;' +
      'border-radius:9px;cursor:pointer;border:1px solid rgba(0,0,0,.09);' +
      'background:rgba(0,0,0,.04);color:#59616d;user-select:none;white-space:nowrap;' +
      'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;' +
      'transition:background .14s,color .14s}' +
    '.dfy-b .dfy-btn:hover{background:rgba(0,0,0,.08);color:#1f1f23}' +
    '.dfy-b .dfy-btn.dfy-dg{color:#e0324f;border-color:rgba(224,50,79,.32);background:rgba(224,50,79,.07)}' +
    '.dfy-b .dfy-btn.dfy-dg:hover{background:rgba(224,50,79,.15)}' +
    '.dfy-b .dfy-btn[data-off]{opacity:.4;cursor:default;pointer-events:none}' +
    '.dfy-b.dfy-dk .dfy-n{color:#a8b0ba}' +
    '.dfy-b.dfy-dk{border-bottom-color:rgba(255,255,255,.09)}' +
    '.dfy-b.dfy-dk .dfy-btn{color:#c9cfd6;border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.07)}' +
    '.dfy-b.dfy-dk .dfy-btn:hover{background:rgba(255,255,255,.13);color:#fff}' +
    '.dfy-b.dfy-dk .dfy-btn.dfy-dg{color:#ff8fa0;border-color:rgba(255,143,160,.34);' +
      'background:rgba(255,143,160,.1)}' +
    '@media (max-width:640px){.dfy-b .dfy-n{font-size:14px}.dfy-b .dfy-btn{padding:8px 10px;font-size:12px}}';

  /* ---------- 界面状态：所有 DOM 引用和「当前画到哪一页」都收在这里 ---------- */

  var UIState = {
    /* 三块宿主的节点引用，建过才有 */
    host: null, panel: null, bodyEl: null, navEl: null, swEl: null,
    subHost: null, subPanel: null, listEl: null, inputEl: null,
    nameListEl: null, nameInputEl: null,
    toastHost: null, toastEl: null, toastTimer: 0,
    bHost: null, bBar: null, bDel: null, bBlk: null, bName: null, bWarn: null, bActs: null,
    /* 「删除 / 拉黑」页 */
    tab: 'set',          /* 'set' 屏蔽设置 | 'act' 删除 / 拉黑 */
    actMode: 'confirm',  /* confirm / running / done / danger / list */
    actKind: '',         /* 'del' | 'block' */
    actTargets: [],
    rv: null,            /* 进度页的常驻节点，paintRunning 只改它们，不重建 */
    /* 横幅的「上次画成什么样」签名，没变就一个 DOM 都不碰 */
    bannerSig: '',
    mountTimer: 0, mountTries: 0, dogTimer: 0,
    themeTimer: null
  };

  /* ---------- DOM 小工具 ---------- */

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function ensureStyleIn(root) {
    var st = el('style');
    st.textContent = CSS;
    root.appendChild(st);
  }

  function reattach(h) {
    if (!h) return;
    if (!h.isConnected) (document.body || document.documentElement).appendChild(h);
  }

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

  function pageKind() { return Pure.pageKind(location); }

  /* 关键词判定的固有局限，两处都要显式告诉用户 */
  var WARN_TEXT = '本插件根据关键词屏蔽，会出现误判。谨慎使用！';

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


  /* ---------- 主题 ---------- */

  function syncTheme() {
    var dk = isDark();
    if (UIState.panel) applyTheme(UIState.panel);
    if (UIState.subPanel) applyTheme(UIState.subPanel);
    if (UIState.bBar) UIState.bBar.classList.toggle('dfy-dk', dk);
    if (UIState.toastEl) UIState.toastEl.classList.toggle('dk', dk);
    var listEl = UIState.listEl;
    if (listEl && listEl.children) {
      for (var i = 0; i < listEl.children.length; i++) {
        listEl.children[i].classList.toggle('dk', dk);
      }
    }
  }

  function watchTheme() {
    if (UIState.themeTimer || !W.MutationObserver) return;
    UIState.themeTimer = new W.MutationObserver(syncTheme);
    UIState.themeTimer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme']
    });
  }

  /* ---------- toast ---------- */

  /* 提示条固定贴在「用户正在看的那个面板」上方 */
  function placeToast(anchor) {
    var toastEl = UIState.toastEl;
    if (!toastEl) return;

    var de = document.documentElement;
    var vw = W.innerWidth || (de && de.clientWidth) || 0;
    var vh = W.innerHeight || (de && de.clientHeight) || 0;
    if (!vw || !vh) return;

    var tw = toastEl.offsetWidth || 0;
    var th = toastEl.offsetHeight || 0;
    var GAP = 12, EDGE = 12;

    var rect = null;
    try {
      if (anchor && anchor.getBoundingClientRect) {
        var b = anchor.getBoundingClientRect();
        if (b && b.width) rect = b;
      }
    } catch (e) { rect = null; }

    var left, top;
    if (rect) {
      left = Math.round(rect.left + (rect.width - tw) / 2);
      top = Math.round(rect.top - GAP - th);
      if (top < EDGE) top = Math.round(rect.bottom + GAP);
    } else {
      left = Math.round(vw - 18 - 300 + (300 - tw) / 2);
      top = 78 - GAP - th;
      if (top < EDGE) top = 78 + GAP;
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
    if (!UIState.toastHost) {
      UIState.toastHost = el('div');
      UIState.toastHost.style.cssText = 'all:initial';
      var sh = UIState.toastHost.attachShadow({ mode: 'open' });
      ensureStyleIn(sh);
      UIState.toastEl = el('div', 'toast');
      sh.appendChild(UIState.toastEl);
      (document.body || document.documentElement).appendChild(UIState.toastHost);
    }
    if (!UIState.toastHost.isConnected) (document.body || document.documentElement).appendChild(UIState.toastHost);

    var toastEl = UIState.toastEl;
    toastEl.textContent = msg;
    toastEl.classList.toggle('dk', isDark());

    /* 先确保有布局再量尺寸：刚创建时 offsetWidth 是 0，位置会算偏 */
    void toastEl.offsetWidth;
    placeToast(anchor);
    toastEl.classList.remove('on');
    void toastEl.offsetWidth;
    toastEl.classList.add('on');

    if (UIState.toastTimer) clearTimeout(UIState.toastTimer);
    UIState.toastTimer = setTimeout(function () {
      UIState.toastTimer = 0;
      if (UIState.toastEl) UIState.toastEl.classList.remove('on');
    }, 1800);
  }

  /* 保存并提示：成功才说成功 */
  function saveAndToast(alsoClose) {
    var r = Config.saveAndVerify();
    var anchor = (UIState.subHost && UIState.subHost.style.display !== 'none') ? UIState.subPanel : UIState.panel;
    toast(r.ok ? '保存成功' : r.msg, anchor);
    /* 保存只关面板，不切页签 —— 在「删除 / 拉黑」页点保存，
       原来会先跳回设置页再关，看起来像按钮点错了 */
    if (r.ok && alsoClose) { closeSub(false); closePanel(); }
  }

  function header(onClose) {
    var h = el('div', 'x', '×');
    h.title = '关闭';
    h.onclick = onClose;
    return h;
  }

  /* ---------- 二级界面：自定义屏蔽词 ---------- */

  function buildSub() {
    if (UIState.subHost) return;

    UIState.subHost = el('div');
    UIState.subHost.style.cssText = 'all:initial;display:none';
    var sh = UIState.subHost.attachShadow({ mode: 'open' });
    ensureStyleIn(sh);

    UIState.subPanel = el('div', 'p t');   /* 用 .p 拿定位；.p2 从来没在 CSS 里定义过 */
    applyTheme(UIState.subPanel);
    UIState.subPanel.appendChild(header(function () { closeSub(true); }));

    /* ---- 第一组：自定义屏蔽词 ---- */
    UIState.subPanel.appendChild(el('div', 'g', '自定义屏蔽词'));
    UIState.listEl = el('div', 'ws');
    UIState.subPanel.appendChild(UIState.listEl);
    UIState.inputEl = buildInputRow('输入一个词，回车添加', commitInput);
    UIState.subPanel.appendChild(UIState.inputEl.row);
    UIState.subPanel.appendChild(el('div', 'tip',
      '命中任意一个词就屏蔽（不分大小写，包含即命中），简体和繁体都会命中。所有档位都生效，' +
      Pure.LIMITS.words + ' 个词以内。'));

    /* ---- 第二组：自定义屏蔽用户名 ---- */
    UIState.subPanel.appendChild(el('div', 'g', '自定义屏蔽用户名'));
    UIState.nameListEl = el('div', 'ws');
    UIState.subPanel.appendChild(UIState.nameListEl);
    UIState.nameInputEl = buildInputRow('输入一个用户名，回车添加', commitNameInput);
    UIState.subPanel.appendChild(UIState.nameInputEl.row);
    UIState.subPanel.appendChild(el('div', 'tip',
      '账号名包含任意一个就屏蔽（不分大小写，包含即命中），所有档位都生效，' +
      Pure.LIMITS.names + ' 个以内。和上面的屏蔽词一样，只看名字不看内容。'));

    var foot = el('div', 'f');
    var ok = el('div', 'btn pri', '保存');
    ok.onclick = function () { saveAndToast(true); };
    foot.appendChild(ok);
    UIState.subPanel.appendChild(foot);

    sh.appendChild(UIState.subPanel);
    (document.body || document.documentElement).appendChild(UIState.subHost);
  }

  /*
   * 一组「输入框 + 确定」。词和用户名两组结构完全一样，抽出来免得抄两遍。
   * 返回 { row, input }，回车和点确定都走同一个 onSubmit。
   */
  function buildInputRow(placeholder, onSubmit) {
    var row = el('div', 'r');
    var input = el('input', 'in');
    input.type = 'text';
    input.maxLength = Pure.LIMITS.wordLen;
    input.placeholder = placeholder;
    input.onkeydown = function (e) {
      if (e.keyCode === 13 || e.key === 'Enter') { e.preventDefault(); onSubmit(); }
    };
    row.appendChild(input);

    var add = el('div', 'btn', '确定');
    add.onclick = onSubmit;
    row.appendChild(add);
    return { row: row, input: input };
  }

  function commitInput() {
    var inputEl = UIState.inputEl;
    if (!inputEl) return;
    var r = Settings.addWord(inputEl.value);
    if (!r.ok) { toast(r.msg, UIState.subPanel); return; }
    inputEl.value = '';
    drawWords();
    inputEl.focus();
  }

  function commitNameInput() {
    var inputEl = UIState.nameInputEl;
    if (!inputEl) return;
    var r = Settings.addName(inputEl.value);
    if (!r.ok) { toast(r.msg, UIState.subPanel); return; }
    inputEl.value = '';
    drawNames();
    inputEl.focus();
  }

  function openSub() {
    buildSub();
    applyTheme(UIState.subPanel);
    reattach(UIState.subHost);
    drawWords();
    drawNames();
    if (UIState.host) UIState.host.style.display = 'none';
    UIState.subHost.style.display = 'block';
    syncFade(UIState.listEl);
    syncFade(UIState.nameListEl);
    if (UIState.inputEl) { try { UIState.inputEl.focus(); } catch (e) {} }
  }

  function closeSub(back) {
    if (UIState.subHost) UIState.subHost.style.display = 'none';
    if (back !== false) openPanel();
  }

  function pick(group, id) {
    var all = group.children;
    for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i].dataset.v === id);
  }

  function drawWords() {
    fillList(UIState.listEl, Config.words(), false);
  }

  function drawNames() {
    fillList(UIState.nameListEl, Config.names(), true);
  }

  /* 把一组条目画成气泡。isName 决定删的时候走哪个 Setting。 */
  function fillList(listEl, items, isName) {
    if (!listEl) return;
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    var dk = isDark();
    for (var i = 0; i < items.length; i++) {
      listEl.appendChild(makeBubble(items[i], dk, isName));
    }
    syncFade(listEl);
  }

  function syncFade(listEl) {
    if (!listEl) return;
    try {
      listEl.classList.toggle('more', listEl.scrollHeight > listEl.clientHeight + 1);
    } catch (e) {}
  }

  function makeBubble(w, dk, isName) {
    var b = el('div', 'w' + (dk ? ' dk' : ''));
    b.appendChild(el('span', null, w));
    var x = el('i', null, '×');
    x.title = '删除';
    x.onclick = function () {
      if (isName) { Settings.removeName(w); drawNames(); }
      else { Settings.removeWord(w); drawWords(); }
    };
    b.appendChild(x);
    return b;
  }

  /* ---------- 主面板 ---------- */

  function buildPanel() {
    if (UIState.panel) return;

    UIState.host = el('div');
    UIState.host.style.cssText = 'all:initial';
    var sh = UIState.host.attachShadow({ mode: 'open' });
    ensureStyleIn(sh);

    UIState.panel = el('div', 'p t');
    applyTheme(UIState.panel);

    var x = el('div', 'x', '×');
    x.title = '关闭';
    x.onclick = closePanel;
    UIState.panel.appendChild(x);

    /* 页签 */
    UIState.navEl = el('div', 'nav');
    UIState.panel.appendChild(UIState.navEl);

    UIState.bodyEl = el('div', 'bd');
    UIState.panel.appendChild(UIState.bodyEl);

    var foot = el('div', 'f');
    var ok = el('div', 'btn pri', '保存');
    ok.onclick = function () { saveAndToast(true); };
    foot.appendChild(ok);
    UIState.panel.appendChild(foot);

    sh.appendChild(UIState.panel);
    (document.body || document.documentElement).appendChild(UIState.host);
  }

  function drawNav() {
    var navEl = UIState.navEl;
    if (!navEl) return;
    while (navEl.firstChild) navEl.removeChild(navEl.firstChild);

    var t1 = el('div', 'nv' + (UIState.tab === 'set' ? ' on' : ''), '屏蔽设置');
    t1.onclick = function () { showTab('set'); };
    navEl.appendChild(t1);

    var t2 = el('div', 'nv' + (UIState.tab === 'act' ? ' on' : ''), '删除 / 拉黑');
    t2.onclick = function () { showTab('act'); };
    navEl.appendChild(t2);
  }

  /*
   * 切页签。两个页都是画进同一个 bodyEl 里的，
   * 所以字号、宽度、返回路径都跟「屏蔽设置」完全一致 ——
   * 原来「删除 / 拉黑」是另起一个同位置的弹窗，切换像跳转，也不好返回。
   */
  function showTab(name) {
    UIState.tab = name;
    drawPanel();
  }

  function drawPanel() {
    if (!UIState.bodyEl) return;
    drawNav();
    UIState.rv = null;   /* 内容区要被清空，常驻的进度节点一并作废 */
    while (UIState.bodyEl.firstChild) UIState.bodyEl.removeChild(UIState.bodyEl.firstChild);
    if (UIState.tab === 'act') drawAct();
    else drawSettings();
  }

  function drawSettings() {
    var bodyEl = UIState.bodyEl;
    bodyEl.appendChild(el('div', 'g', '屏蔽强度'));
    var tg = el('div');
    TIERS.forEach(function (t) {
      var o = el('div', 'o' + (Config.tier() === t.id ? ' on' : ''), t.label);
      o.dataset.v = t.id;
      o.onclick = function () {
        Settings.setTier(t.id);
        pick(tg, t.id);
      };
      tg.appendChild(o);
    });
    bodyEl.appendChild(tg);

    bodyEl.appendChild(el('div', 'g', '楼中楼'));
    var sg = el('div');
    SUBS.forEach(function (t) {
      var o = el('div', 'o' + (Config.sub() === t.id ? ' on' : ''), t.label);
      o.dataset.v = t.id;
      o.onclick = function () {
        Settings.setSub(t.id);
        pick(sg, t.id);
      };
      sg.appendChild(o);
    });
    bodyEl.appendChild(sg);

    bodyEl.appendChild(el('div', 'g', '自定义屏蔽词'));
    var wr = el('div', 'o', '编辑屏蔽词…');
    wr.onclick = openSub;
    bodyEl.appendChild(wr);

    var sr = el('div', 's');
    sr.appendChild(el('span', null, '显示已清条数'));
    UIState.swEl = el('div', 'sw' + (Config.showCount() ? ' on' : ''));
    UIState.swEl.onclick = function () {
      var next = !Config.showCount();
      Settings.setShowCount(next);
      UIState.swEl.classList.toggle('on', next);
      drawBanner();
      if (next && !bannerShown()) watchMount();
      else if (!next) stopWatch();
    };
    sr.appendChild(UIState.swEl);
    bodyEl.appendChild(sr);
  }

  /* ---------- 操作页：删除 / 拉黑 ---------- */

  /*
   * 「删除 / 拉黑」这一页的重绘入口。
   * 内容画进主面板的 bodyEl —— 和「屏蔽设置」共用同一个容器，
   * 所以两边字号、宽度天然一致，也不用再来回切 display。
   */
  function drawAct() { drawActions(UIState.bodyEl); }

  /* 重画当前页（操作页内部状态变化时用） */
  function renderOp() {
    if (!UIState.bodyEl) return;
    UIState.tab = 'act';
    drawPanel();
  }

  /* 一个条目：标题 + 右侧计数 + 一句说明 */
  function opRow(title, count, desc, danger, onclick) {
    var o = el('div', 'op' + (danger ? ' dg' : '') + (onclick ? '' : ' off'));
    var t1 = el('div', 't1');
    t1.appendChild(el('span', null, title));
    if (count != null) t1.appendChild(el('span', 'cnt', '' + count));
    o.appendChild(t1);
    if (desc) o.appendChild(el('div', 't2', desc));
    if (onclick) o.onclick = onclick;
    return o;
  }

  /*
   * 显式 switch。原来是一串 if + 末尾 return drawConfirm() 兜底，
   * 非法 actMode 会静默回落到确认页，而 actTargets 还留着上一次的目标。
   */
  function drawActions(box) {
    switch (UIState.actMode) {
      case 'running': return drawRunning(box);
      case 'done': return drawDone(box);
      case 'danger': return drawDanger(box);
      case 'list': return drawBlockList(box);
      case 'confirm': return drawConfirm(box);
    }
    UIState.actMode = 'confirm';
    return drawConfirm(box);
  }

  /*
   * 横幅右侧（误判提醒 + 删除 / 拉黑按钮）的显示开关。
   * 放在「删除 / 拉黑」页而不是「屏蔽设置」页 —— 它管的是这一页的两个入口，
   * 用户在这里找它最顺手。和「显示已清条数」共用同一套 .s / .sw 样式。
   */
  function bannerActsRow() {
    var sr = el('div', 's');
    sr.appendChild(el('span', null, '评论区显示删除 / 拉黑'));
    var sw = el('div', 'sw' + (Config.showActs() ? ' on' : ''));
    sw.onclick = function () {
      var next = !Config.showActs();
      Settings.setShowActs(next);
      sw.classList.toggle('on', next);
      syncBannerActs();
      /*
       * 原来关着、现在要露出来：横幅可能压根没建（关掉「显示已清条数」且无命中时
       * drawBanner 会提前 return），也有可能是 display:none 藏着的。
       * drawBanner 两条路径都会处理，再补一次 watchMount 兜住「DOM 还没挂上」。
       */
      drawBanner();
      if (next && !bannerShown()) watchMount();
    };
    sr.appendChild(sw);

    /* tip 不能塞进 .s —— 那是个 flex 行，塞进去会跟开关并排。单独包一层 */
    var wrap = el('div');
    wrap.appendChild(sr);
    wrap.appendChild(el('div', 'tip',
      '打开后，评论区顶部「已清 N 条」右边会显示误判提醒和删除 / 拉黑两个按钮。' +
      '关掉就只能从这个面板进来。'));
    return wrap;
  }

  function drawConfirm(box) {
    var bodyEl = box;
    var delN = Candidates.forDelete().length;
    var blkN = Candidates.forBlock().length;
    var lockDel = !!Me.token();     /* 没登录就别给点 */

    /* 先摆警告：这一页所有操作都不可逆，进来第一眼就该看到 */
    bodyEl.appendChild(el('div', 'warn', WARN_TEXT));

    /* 入口开关跟在警告后面，不抢警告的位置 */
    bodyEl.appendChild(bannerActsRow());

    /* --- 删除 --- */
    bodyEl.appendChild(el('div', 'g', '删除评论'));
    bodyEl.appendChild(opRow(
      '删除命中的评论',
      delN,
      delN
        ? '把这次已加载、被判为要屏蔽的评论真正删掉。'
        : '当前没有命中的评论。先往下滚加载评论，或加个屏蔽词。',
      true,
      delN && lockDel ? function () { askDanger('del'); } : null
    ));

    /* --- 拉黑 --- */
    bodyEl.appendChild(el('div', 'g', '拉黑用户'));
    bodyEl.appendChild(opRow(
      '拉黑发言者',
      blkN,
      blkN
        ? '把发这些评论的人加进黑名单，之后你看不到他们的评论。'
        : '没有要拉黑的用户。',
      true,
      blkN && lockDel ? function () { askDanger('block'); } : null
    ));

    bodyEl.appendChild(opRow(
      '已拉黑 ' + Ledger.count() + ' 人',
      null,
      '看看本地记下的黑名单，方便回头手动解除。',
      false,
      function () { UIState.actMode = 'list'; renderOp(); }
    ));

    /* --- 风险说明 --- */
    var rk = el('div', 'risk');
    rk.innerHTML = '';
    rk.appendChild(el('b', null, '删除会直接调用 B 站接口'));
    rk.appendChild(document.createTextNode(
      '，只能删自己稿件下的评论；不是自己的稿件会立刻失败，不会误删。' +
      '删掉的评论没法恢复。'));
    bodyEl.appendChild(rk);

    if (!lockDel) {
      var w1 = el('div', 'risk');
      w1.textContent = '没读到登录信息（bili_jct），这两个功能用不了。刷新页面、确认已登录后再试。';
      bodyEl.appendChild(w1);
    }
  }

  function askDanger(kind) {
    UIState.actKind = kind;
    UIState.actTargets = kind === 'del' ? Candidates.forDelete() : Candidates.forBlock();
    if (!UIState.actTargets.length) { toast('没有可操作的目标', UIState.panel); return; }
    UIState.actMode = 'danger';
    renderOp();          /* 重画的是操作页，不是主面板 */
  }

  function drawDanger(box) {
    var bodyEl = box;
    var n = UIState.actTargets.length;
    var isDel = UIState.actKind === 'del';

    bodyEl.appendChild(el('div', 'g', isDel ? '确认删除' : '确认拉黑'));

    var bx = el('div');
    var p1 = el('div', 'op');
    p1.appendChild(el('div', 't1', (isDel ? '删除 ' : '拉黑 ') + n + (isDel ? ' 条评论' : ' 位用户')));
    p1.appendChild(el('div', 't2', isDel
      ? '这一步不可撤销。删完如果还想屏蔽，靠的是屏蔽规则，不是删。'
      : '拉黑立刻生效，之后你在这台账号上再也看不到这些人。'));
    bx.appendChild(p1);
    bodyEl.appendChild(bx);

    var rk = el('div', 'risk');
    rk.textContent = isDel
      ? '删除调用的是 B 站的真实删除接口。如果不是你自己的稿件，接口会拒绝，下面的进度里会显示失败，不会造成误删。'
      : '拉黑调用的是真实的黑名单接口，会改变你的账号关系。想撤回要去个人空间的黑名单里一个个移除。';
    bodyEl.appendChild(rk);

    var f = el('div', 'f2');
    var back = el('div', 'btn gh', '取消');
    back.onclick = function () { UIState.actMode = 'confirm'; renderOp(); };
    f.appendChild(back);
    var go = el('div', 'btn dg', isDel ? '确认删除' : '确认拉黑');
    go.onclick = function () {
      /* 面板可能搁了一夜，登录态失效了就别白跑一批（会刷风控额度） */
      Me.resetToken();
      if (!Me.token()) { toast('登录状态失效了，刷新页面再试', UIState.panel); return; }
      if (Job.isRunning()) { toast('已经有一个任务在跑了', UIState.panel); return; }
      /*
       * 目标是在哪个稿件上选出来的，开工时记下来交给执行器。
       * 用户点完确认再切视频，代数就变了，任务会立刻停 ——
       * 原来这个信息是「当前稿件 oid」，而 oid 在切到空评论区时压根拿不到。
       */
      var gen = Page.gen();
      UIState.actMode = 'running';
      if (!isDel) { Job.start('block', UIState.actTargets); return; }
      /*
       * 删除前等一拍再开工。
       * 用户点完确认后常常紧接着就切视频，而第一枪是在点击后的下一帧就打出去的 ——
       * 那时候新页面的首屏请求还没到，currentOid 仍是旧值，比对拦不住。
       * 等等看这一小段时间里有没有发生页面切换，能挡住绝大多数误删。
       */
      toast('即将开始删除，若切走页面会自动中止', UIState.panel);
      setTimeout(function () {
        Job.start('del', UIState.actTargets, gen);
      }, Pure.TIMING.delStartDelay);
    };
    f.appendChild(go);
    bodyEl.appendChild(f);
  }

  function drawRunning(box) {
    var j = Job.snapshot();
    if (!j) return;

    UIState.rv = { kind: j.kind };
    UIState.rv.title = el('div', 'g', j.kind === 'del' ? '正在删除' : '正在拉黑');
    box.appendChild(UIState.rv.title);

    UIState.rv.pg = el('div', 'pg');
    UIState.rv.bar = el('i');
    UIState.rv.pg.appendChild(UIState.rv.bar);
    box.appendChild(UIState.rv.pg);

    UIState.rv.pn = el('div', 'pgn');
    UIState.rv.left = el('span');
    UIState.rv.right = el('b');
    UIState.rv.pn.appendChild(UIState.rv.left);
    UIState.rv.pn.appendChild(UIState.rv.right);
    box.appendChild(UIState.rv.pn);

    UIState.rv.tip = el('div', 'tip');
    box.appendChild(UIState.rv.tip);

    var rk = el('div', 'risk');
    rk.textContent = '批量操作有被限流的可能，遇到会自己等一下再试。中途可以随时停。';
    box.appendChild(rk);

    var f = el('div', 'f2');
    var st = el('div', 'btn', '停止');
    st.onclick = function () { Job.stop(); };
    f.appendChild(st);
    box.appendChild(f);

    paintRunning();
  }

  /*
   * 只改数字。返回 false 表示常驻节点不在了（页面重建 / 换了任务），
   * 让调用方退回整页重画。
   */
  function paintRunning() {
    var j = Job.snapshot(), pct;
    var rv = UIState.rv;
    /*
     * 常驻节点必须还挂在 bodyEl 上才敢改。
     * 面板被关掉重开、或者换了任务类型，节点就被换掉了，直接改会改到孤儿节点。
     */
    if (!rv || !j || rv.kind !== j.kind || rv.pg.parentNode !== UIState.bodyEl) return false;
    pct = j.total ? Math.round(j.done / j.total * 100) : 0;
    rv.bar.style.width = pct + '%';
    rv.left.textContent = j.done + ' / ' + j.total;
    rv.right.textContent = '成功 ' + j.ok + ' · 失败 ' + j.fail;
    if (rv.tip.textContent !== (j.note || '')) rv.tip.textContent = j.note || '';
    return true;
  }

  function drawDone(box) {
    var bodyEl = box;
    var j = Job.snapshot();
    if (!j) return;

    bodyEl.appendChild(el('div', 'g', j.kind === 'del' ? '删除结束' : '拉黑结束'));

    /* 收尾状态（已完成 / 已停止 / 某个失败原因）单独一行，别只留在提示里 */
    if (j.note) bodyEl.appendChild(el('div', 'tip', j.note));

    var pg = el('div', 'pg');
    var bar = el('i');
    bar.style.width = (j.total ? Math.round(j.done / j.total * 100) : 100) + '%';
    pg.appendChild(bar);
    bodyEl.appendChild(pg);

    var pn = el('div', 'pgn');
    pn.appendChild(el('span', null, '成功 ' + j.ok));
    pn.appendChild(el('b', null, '失败 ' + j.fail));
    bodyEl.appendChild(pn);

    if (j.errs.length) {
      var wrap = el('div', 'risk');
      wrap.appendChild(el('b', null, '失败原因'));
      for (var i = 0; i < Math.min(j.errs.length, 4); i++) {
        wrap.appendChild(document.createElement('br'));
        wrap.appendChild(document.createTextNode(
          (j.errs[i].who ? j.errs[i].who + '：' : '') + j.errs[i].msg));
      }
      if (j.errs.length > 4) {
        wrap.appendChild(document.createElement('br'));
        wrap.appendChild(document.createTextNode('…还有 ' + (j.errs.length - 4) + ' 条'));
      }
      bodyEl.appendChild(wrap);
    } else if (j.ok) {
      bodyEl.appendChild(el('div', 'tip', j.kind === 'del'
        ? '删掉的评论不会再出现。想连人一起治，切到拉黑那一栏。'
        : '这 ' + j.ok + ' 位用户已经进黑名单了，可以在下面看到。'));
    }

    var f = el('div', 'f2');
    var back = el('div', 'btn', '返回');
    back.onclick = function () { UIState.actMode = 'confirm'; renderOp(); };
    f.appendChild(back);
    var cl = el('div', 'btn pri', '完成');
    cl.onclick = function () { UIState.actMode = 'confirm'; closeOp(); };
    f.appendChild(cl);
    bodyEl.appendChild(f);
  }

  function drawBlockList(box) {
    var bodyEl = box;
    var arr = Ledger.list();

    bodyEl.appendChild(el('div', 'g', '本地黑名单记录'));
    bodyEl.appendChild(el('div', 'tip',
      '这只是本地记下的「脚本拉黑过谁」，方便你回个人空间一个个解除。' +
      '真正的黑名单以 B 站为准。'));

    if (!arr.length) {
      bodyEl.appendChild(el('div', 'empty', '还没拉黑过任何人'));
    } else {
      var sc = el('div', 'sc');
      for (var i = 0; i < arr.length && i < 200; i++) {
        var li = el('div', 'li');
        li.appendChild(el('span', 'nm', arr[i].name || '（未知用户）'));
        li.appendChild(el('span', 'mid', arr[i].mid));
        sc.appendChild(li);
      }
      bodyEl.appendChild(sc);
      if (arr.length > 200) {
        bodyEl.appendChild(el('div', 'tip', '只显示最近 200 条，共 ' + arr.length + ' 条'));
      }
    }

    var f = el('div', 'f2');
    var back = el('div', 'btn', '返回');
    back.onclick = function () { UIState.actMode = 'confirm'; renderOp(); };
    f.appendChild(back);
    var clr = el('div', 'btn gh', '清空记录');
    clr.onclick = function () {
      Ledger.clear();
      toast('记录已清空（不影响 B 站上的黑名单）', UIState.panel);
      renderOp();
    };
    f.appendChild(clr);
    bodyEl.appendChild(f);
  }

  /* ---------- 操作页的可见性 / 进度刷新 ---------- */

  /* 「删除 / 拉黑」这一页现在正开着吗（主面板可见 + 停在这一页） */
  function actVisible() {
    return !!(UIState.host && UIState.host.style.display !== 'none' && UIState.tab === 'act');
  }

  /*
   * 进度刷新。
   * 原来是每次（每条评论、每批拉黑）都整页重建：清空内容区 + 重新创建
   * 十几个节点 + shadow 里重排。删 300 条就是 300 次整页重建。
   * 现在进度页首次进入时把节点建成常驻的，之后只改 bar 宽度和两处文字。
   */
  function updateJobUI() {
    if (!actVisible() || UIState.actMode !== 'running') return;
    if (!paintRunning()) renderOp();
  }

  function onJobEnd(j) {
    /* 面板没开着就别改成 done：用户关掉去干别的，回来应该看到候选页而不是上个任务的完成页 */
    UIState.actMode = actVisible() ? 'done' : 'confirm';
    if (actVisible()) renderOp();
    if (j.kind === 'del' && j.ok) { Counter.reset(); drawBanner(); }
  }

  /* 打开主面板并停到「删除 / 拉黑」这一页 */
  function openOp() {
    openPanel();
    /* 有任务在跑就停在进度页，别把用户踢回复选框 */
    UIState.actMode = Job.isRunning() ? 'running' : 'confirm';
    showTab('act');
  }

  /* 从操作页回到「屏蔽设置」 */
  function closeOp() {
    showTab('set');
    openPanel();
  }

  function openPanel() {
    buildPanel();
    applyTheme(UIState.panel);
    reattach(UIState.host);
    /* 三个面板位置完全重叠，从菜单进来时也必须把另外两个收起来，否则会叠在一起「关不掉」 */
    if (UIState.subHost) UIState.subHost.style.display = 'none';
    UIState.host.style.display = 'block';
    drawPanel();
  }

  function closePanel() {
    if (UIState.host) UIState.host.style.display = 'none';
  }

  /* ---------- 评论区顶部横幅 ---------- */

  /* 插到有评论区的那个容器里，样式也得挂到同一个 root 上 */
  function findMount() {
    var c = document.querySelector('#commentapp bili-comments');
    if (c && c.shadowRoot) {
      var feed = c.shadowRoot.querySelector('#feed');
      if (feed && feed.parentNode) return { parent: feed.parentNode, before: feed };
    }
    var host2 = document.querySelector('#comment .reply-warp') || document.querySelector('.reply-warp');
    if (host2) {
      var list = host2.querySelector('.reply-list') || host2.querySelector('.comment-list');
      if (list && list.parentNode) return { parent: list.parentNode, before: list };
      return { parent: host2, before: host2.firstChild };
    }
    /* 个人空间的动态流：没有 bili-comments，退而求其次插在动态列表上面 */
    if (pageKind() === 'space') {
      var dyn = document.querySelector('.bili-dyn-list') || document.querySelector('.bili-dyn-item');
      if (dyn && dyn.parentNode) return { parent: dyn.parentNode, before: dyn };
    }
    return null;
  }

  function buildBanner() {
    if (UIState.bHost) return;
    UIState.bHost = el('div');
    UIState.bHost.style.cssText = 'display:block;width:100%';

    var sh = UIState.bHost.attachShadow({ mode: 'open' });
    var st = el('style');
    st.textContent = CSS + INJ_CSS;
    sh.appendChild(st);

    var bar = el('div', 'dfy-b');
    UIState.bBar = bar;
    UIState.bName = el('span', 'dfy-n');
    bar.appendChild(UIState.bName);

    /*
     * 「已清 N 条」右边紧跟一句警告，宽度不够时自动换行到下一行。
     * 警告和按钮组默认是收起的（config.showActs），露不露由 syncBannerActs
     * 决定 —— 建的时候只保证节点齐备，别在这里写死可见性。
     */
    UIState.bWarn = el('span', 'dfy-w', WARN_TEXT);
    UIState.bWarn.title = WARN_TEXT;
    bar.appendChild(UIState.bWarn);

    UIState.bActs = el('div', 'dfy-a');
    UIState.bDel = el('span', 'dfy-btn dfy-dg', '删除');
    UIState.bDel.title = '把命中的评论真正删掉（只能删自己稿件下的）';
    UIState.bDel.onclick = function () { quickAct('del'); };
    UIState.bActs.appendChild(UIState.bDel);

    UIState.bBlk = el('span', 'dfy-btn', '拉黑');
    UIState.bBlk.title = '把发这些评论的人加进黑名单';
    UIState.bBlk.onclick = function () { quickAct('block'); };
    UIState.bActs.appendChild(UIState.bBlk);

    bar.appendChild(UIState.bActs);
    sh.appendChild(bar);
    syncBannerActs();
  }

  /*
   * 横幅右侧（误判提醒 + 删除 / 拉黑按钮）显不显示，只看 config.showActs 一个来源。
   *
   * 藏起来用 display:none 而不是摘节点，和 drawBanner 里「整条横幅该藏」是同一套做法：
   * 摘掉再插回来要重新走一遍 Shadow DOM 里的布局，而且节点在 JS 里还有引用
   * （bDel / bBlk 的置灰状态、updateBannerText 的签名守卫都依赖它们）。
   * 这里只在状态真的变了才碰 style，避免每次 drawBanner 都写一次 DOM。
   */
  function syncBannerActs() {
    /* 显示时不写死 flex，留给 CSS 里的 .dfy-a{display:flex} —— 一处定义，别两处维护 */
    var v = Config.showActs() ? '' : 'none';
    if (UIState.bWarn && UIState.bWarn.style.display !== v) UIState.bWarn.style.display = v;
    if (UIState.bActs && UIState.bActs.style.display !== v) UIState.bActs.style.display = v;
  }

  /* 从评论区顶部按钮直接进确认页：不开主面板，少两步点击 */
  function quickAct(kind) {
    /* 任务在跑的时候，点顶部按钮只应该是「回去看进度」，不能把进度页覆盖成确认页 */
    if (Job.isRunning()) { openOp(); return; }
    UIState.actKind = kind;
    UIState.actTargets = kind === 'del' ? Candidates.forDelete() : Candidates.forBlock();
    if (!UIState.actTargets.length) { toast('没有可操作的目标', UIState.panel); return; }
    if (!Me.token()) { toast('没读到登录信息，先刷新页面', UIState.panel); return; }
    UIState.actMode = 'danger';
    openPanel();
    showTab('act');
  }

  /*
   * 刷横幅要合并到下一个微任务：一次首屏解析会连着 settle / bump 好几次，
   * 每次都同步重画等于白跑。bannerQ 让同一轮里的多次请求只画一次。
   */
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

  function updateBannerText() {
    var bName = UIState.bName;
    if (!bName) return;
    /*
     * 先把 cookie 读完再写 DOM。反过来（写完 DOM 再读 document.cookie）
     * 会强制一次同步样式重算，实测单次成本从 3.7us 涨到 17.3us。
     * 这也是为什么 canAct 必须在所有 DOM 写之前取。
     */
    var canAct = !!Me.token();
    var c = Candidates.refresh();
    var dk = isDark();

    /*
     * 整条横幅的「上次画成什么样」由一个签名概括：
     * 计数、候选数、开关、登录态、主题。签名没变就一个 DOM 都不碰。
     * 原来只守卫了左半边文案，按钮的 textContent / data-off / 主题类
     * 每次 updateBannerText 都无条件重写（实测约 3.6us/次）。
     */
    var sig = Counter.totalR() + '/' + Counter.totalS() + '/' + c.d + '/' + c.b + '/' +
              (Config.showCount() ? 1 : 0) + (Config.showActs() ? 1 : 0) +
              (canAct ? 1 : 0) + (dk ? 1 : 0);
    if (sig === UIState.bannerSig) return;
    UIState.bannerSig = sig;

    /* 开关是签名的一部分，走到这里的路径里可能已经翻过面了，顺手对齐一次 */
    syncBannerActs();

    var txt = Config.showCount() ? ('已清 ' + Counter.total() + ' 条') : '大肥鱼工具';
    var tip = '一级评论 ' + Counter.totalR() + ' 条 · 楼中楼 ' + Counter.totalS() + ' 条';
    if (bName.textContent !== txt) bName.textContent = txt;
    if (bName.title !== tip) bName.title = tip;

    setActBtn(UIState.bDel, '删除', c.d, canAct);
    setActBtn(UIState.bBlk, '拉黑', c.b, canAct);

    /*
     * 深色主题的类必须加在 shadow 内部的 .dfy-b 上。
     * 原来加在 bHost（shadow 宿主）上，而 CSS 写的是 .dfy-b.dfy-dk ——
     * 宿主在 shadow 外面，选择器永远匹配不到，深色模式下横幅一直是浅色。
     */
    if (UIState.bBar) UIState.bBar.classList.toggle('dfy-dk', dk);
  }

  /* 横幅上「删除 N / 拉黑 N」按钮：没目标或没登录就置灰 */
  function setActBtn(btn, label, n, canAct) {
    if (!btn) return;
    var txt = n ? (label + ' ' + n) : label;
    if (btn.textContent !== txt) btn.textContent = txt;
    var off = !(n && canAct);
    if (off !== !!btn.__dfyOff) {
      btn.__dfyOff = off;
      if (off) btn.setAttribute('data-off', '1');
      else btn.removeAttribute('data-off');
    }
  }

  /*
   * 横幅「现在看得见吗」。
   * 注意不能只看 isConnected：为了省掉重建 Shadow DOM 的开销，
   * 该隐藏的时候我们是把它 display:none 留着的，节点照样连着。
   */
  function bannerShown() {
    return !!(UIState.bHost && UIState.bHost.isConnected && UIState.bHost.style.display !== 'none');
  }

  function drawBanner() {
    /*
     * 关掉「显示已清条数」之后，这一条就不该天天挂在评论区顶上；
     * 但只要有东西可删 / 可拉黑，还是要露出来当入口。
     */
    if (!Config.showCount() && !Candidates.anyHit()) {
      /*
       * 藏起来而不是摘掉：bHost 里是 Shadow DOM + 十几 KB 的 CSS，
       * 一旦置空，下次有命中就要重新 attachShadow 并重新解析整份样式
       * （实测一次 ≈114us，其中绝大部分是 CSS 解析）。
       */
      if (UIState.bHost) { syncBannerActs(); UIState.bHost.style.display = 'none'; UIState.bannerSig = ''; }
      return;
    }
    /*
     * 该显示。先统一把「藏起来」那个状态清掉 ——
     * 下面两条路径（还挂着 / 要重新挂）都可能碰到之前 display:none 留下的节点，
     * 只在其中一条里恢复的话，另一条就会把横幅挂上去却看不见。
     */
    if (UIState.bHost && UIState.bHost.style.display === 'none') UIState.bHost.style.display = 'block';

    if (UIState.bHost && UIState.bHost.isConnected) { updateBannerText(); return; }

    var m = findMount();
    if (!m) return;

    buildBanner();
    updateBannerText();
    if (m.before) m.parent.insertBefore(UIState.bHost, m.before);
    else m.parent.appendChild(UIState.bHost);
  }

  var MOUNT_MS = 300;
  var MOUNT_MAX = 50;      /* 50 × 300ms = 15 秒 */

  function watchMount() {
    if (UIState.mountTimer) return;
    UIState.mountTries = 0;
    UIState.mountTimer = setTimeout(tickMount, MOUNT_MS);
  }

  function tickMount() {
    UIState.mountTimer = 0;
    if (!Config.showCount() && !Candidates.anyHit()) return;
    if (bannerShown()) return;
    if (++UIState.mountTries > MOUNT_MAX) return;
    drawBanner();
    if (bannerShown()) return;
    UIState.mountTimer = setTimeout(tickMount, MOUNT_MS);
  }

  function stopWatch() {
    if (UIState.mountTimer) { clearTimeout(UIState.mountTimer); UIState.mountTimer = 0; }
    UIState.mountTries = 0;
  }

  /*
   * 常驻看门狗。
   *
   * 原来只有 watchMount 那条「15 秒内重试 50 次」的一次性窗口：
   * 窗口用完就不再调度任何东西。而 B 站在切换视频 / 换排序 / 翻页时会重建
   * #feed，把我们的横幅一起摘掉 —— 那一瞬间如果早过了 15 秒窗口，
   * 横幅就永久消失了，用户只能刷新页面。
   *
   * 这里用很低频的轮询兜底（2 秒一次，几乎零成本）：
   * 发现横幅该在却不在，就重新挂一次。
   */
  var DOG_MS = 2000;

  function watchDog() {
    if (UIState.dogTimer) return;
    UIState.dogTimer = setTimeout(tickDog, DOG_MS);
  }

  function tickDog() {
    UIState.dogTimer = 0;
    if (!Config.showCount() && !Candidates.anyHit()) { watchDog(); return; }
    if (!bannerShown()) {
      UIState.mountTries = 0;          /* 重新给一次短窗口的密集重试 */
      drawBanner();
      if (!bannerShown()) watchMount();
    }
    watchDog();
  }

  function stopDog() {
    if (UIState.dogTimer) { clearTimeout(UIState.dogTimer); UIState.dogTimer = 0; }
  }

  /* ---------- 对外出口 ---------- */

  var UI = {
    toast: toast,
    openPanel: openPanel,
    closePanel: closePanel,
    openSub: openSub,
    closeSub: closeSub,
    openOp: openOp,
    closeOp: closeOp,
    showTab: showTab,
    renderOp: renderOp,
    drawBanner: drawBanner,
    updateJobUI: updateJobUI,
    onJobEnd: onJobEnd,
    actVisible: actVisible,
    syncTheme: syncTheme,
    watchTheme: watchTheme,
    watchMount: watchMount,
    stopWatch: stopWatch,
    watchDog: watchDog,
    stopDog: stopDog,
    bannerShown: bannerShown,
    /* 状态层的变更回调要用来刷横幅，但不想让状态层认识 drawBanner */
    refresh: function () { drawBanner(); },
    queueBanner: queueBanner,
    quickAct: quickAct,
    saveAndToast: saveAndToast,
    /* 测试 / 设置页要读的界面状态 */
    state: function () { return UIState; }
  };

  /* ==================================================================
   * L5  启动层
   *
   * 到这里才把所有层接起来：注入回调、装页面级钩子、跑第一个横幅。
   * 上面每一层都不认识下一层，唯一知道全部的是这一段 —— 想看「谁在什么时候调用谁」，
   * 只需要读这一节。
   * ================================================================== */

  /* ---- 把「状态变了要干嘛」注入给下层 ---- */

  /* 账本一变（删了一条 / 拉黑了一批）候选数就过期了 */
  Ledger.onChange(function () { Pool.bump(); });

  /* 计数变了：刷横幅，并且如果横幅还没挂上就安排一次重挂 */
  CounterSink.setHandlers(
    function () {
      UI.queueBanner();
      if (Config.showCount() && !UI.bannerShown()) UI.watchMount();
    },
    null
  );

  /* 设置一变就重画横幅 */
  Settings.bind(function () { UI.drawBanner(); });

  /* 任务进度 / 收尾 -> 重画操作页 */
  Job.bind(function () { UI.updateJobUI(); }, function (j) { UI.onJobEnd(j); });

  /* 换稿件时把正在跑的任务停掉（任务手里的目标是上一个稿件的） */
  Lifecycle.onReset(function () { Job.abortForPageChange(); });

  /* 拦截层：首屏前后各刷一次横幅，命中之后提交计数 */
  Hooks.bind({
    onFirstPage: function () { Lifecycle.onFirstPage(); },
    beforeFirstPage: function () { UI.queueBanner(); },
    afterFirstPage: function () { UI.queueBanner(); },
    commit: function (r) { CounterSink.settle(r); }
  });

  /* ---- 页面级钩子 ---- */

  /*
   * 账本是攒批写的，所以必须有卸载钩子兜底：
   * 删到一半关标签页 / 切走，内存里的记录会整个丢掉，
   * 下次重新加载时 deleted 也是空的，会把同一批评论再删一遍（白耗风控额度）。
   * pagehide / visibilitychange 里做同步存储是标准做法。
   */
  try {
    if (typeof W.addEventListener === 'function') {
      W.addEventListener('pagehide', function () { UI.stopDog(); Ledger.flush(); }, true);
      W.addEventListener('beforeunload', function () { Ledger.flush(); }, true);
      W.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') Ledger.flush();
      }, true);
    }
  } catch (e) {}

  /* Esc 关闭面板：二级页 / 操作页开着就先关它们 */
  try {
    (W.addEventListener ? W : document).addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.keyCode !== 27) return;
      var st = UI.state();
      if (st.subHost && st.subHost.style.display !== 'none') { UI.closeSub(true); return; }
      if (UI.actVisible()) { UI.closeOp(); return; }
      UI.closePanel();
    }, true);
  } catch (e) {}

  if (typeof GM_registerMenuCommand === 'function') {
    try { GM_registerMenuCommand('设置', UI.openPanel); } catch (e) {}
  }

  /* ---- 装钩子 ---- */

  Hooks.hookFetch();
  Hooks.hookXHR();

  /* ---- 首屏 ---- */

  function boot() {
    UI.watchTheme();
    UI.watchDog();
    Net.fetchSelf(function () {
      /* 就绪前候选是「全部排除」的，这里把数字刷一遍 */
      Pool.bump();
      UI.queueBanner();
      var st = UI.state();
      if (UI.actVisible() && st.actMode === 'confirm') UI.renderOp();
    });
    /* 关掉计数时也要插，只是没有命中就不显示 —— 露不露由 drawBanner 自己判断 */
    UI.drawBanner();
    if (!UI.bannerShown()) UI.watchMount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

})();
