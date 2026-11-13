// ==UserScript==
// @name         屏蔽大肥鱼
// @namespace    dafeiyu
// @version      1.4.3
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

(function () {
  'use strict';

  var W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  if (W.__dfy) return;
  W.__dfy = 1;

  /* ============ 常量 ============ */

  var HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  var SKEY = 'dafeiyu.config.v2';   /* 键名不变：老用户的档位 / 屏蔽词无缝升到 1.4 */
  var BKEY = 'dafeiyu.book.v1';     /* 拉黑账本，单独存，能随时清空 */

  var VALID_TIER = { cup: 1, standard: 1, kill: 1, atonly: 1 };
  var VALID_SUB  = { only: 1, whole: 1, none: 1 };

  var MAX_WORDS = 100;
  var MAX_LEN   = 24;

  /* 写接口的节奏。B站会限流（-509），这些数字偏保守：
     宁可慢一点，也别把账号搞进风控。 */
  var DEL_GAP   = 350;    /* 两条删除之间的间隔 */
  var BLOCK_GAP = 260;    /* 两批拉黑之间的间隔 */
  var RETRY_MAX = 3;      /* 单个目标的最多重试次数 */
  var DEL_START_DELAY = 500;  /* 点确认后先等这么久再发第一条，给「刚点完就切页」留出拦截窗口 */

  /*
   * 本地账本上限。拉黑表和删除表分开算 —— 原来共用一个 BOOK_CAP：
   *   - 拉黑表 m：每条 {mid, {n 名字, t 时间}}，占 ~48 字节，用户真正会回头查，留 3000 条
   *   - 删除表 r：每条 {rpid: 时间}，占 ~30 字节，纯粹用来「别再删一遍」，不需要名字
   * 共用 3000 本来就跟 POOL_CAP=5000 对不上：池子里能装 5000 条，
   * 账本只记得 3000 条，中间 2000 条删完刷新就被忘了，会重新进候选再删一遍。
   * 池子调到 2 万之后这个缺口会变成 1.7 万，所以删除表必须跟着放大。
   */
  var BOOK_MID_CAP = 3000;    /* 拉黑表：3000 条 ≈ 140KB */
  var BOOK_DEL_CAP = 20000;   /* 删除表：2 万条 ≈ 605KB，和 POOL_CAP 对齐 */

  var config = { tier: 'standard', sub: 'only', showCount: true, words: [] };

  /*
   * 写操作能碰到的评论，只来自「页面自己已经加载出来的那份数据」。
   * 不去翻页、不发额外请求，所以不会踩到 -352 风控（实测翻页必踩），
   * 而且删掉的正好是用户当前看得见的那些，不会误删视野外的东西。
   */
  var pool = [];
  var poolSeen = Object.create(null);
  /*
   * 池子能装多少条「页面已加载出来的评论」。
   *
   * 这是删除 / 拉黑候选集的唯一来源，所以它直接决定了
   * 「滚很久之后回头还能处理多少」。
   * 2 万条 ≈ 9.8MB 堆内存（实测），换来的是长评论区不用来回滚。
   *
   * 代价（实测 @pool=20000）：
   *   rejudgePool 236us -> 896us（切档位时卡一下，约 1 帧）
   *   buildCandidates 35us -> 154us（每次候选数变化时）
   * 都还在可接受范围；再往上翻倍就开始掉帧了，所以停在 2 万。
   */
  var POOL_CAP = 20000;
  var poolHead = 0;   /* 环形游标：池满后覆盖最旧的槽位，避免 shift 的 O(n) 搬移 */

  /*
   * 候选数缓存。
   *
   * 原来用「pool.length + hitVer」两个键，问题有两个：
   *   1. 池子满（环形覆盖）之后 length 恒定，光靠它判断不出来；
   *   2. hitVer++ 散在 8 处手写，改档位 / 改屏蔽词 / 加屏蔽词这几条路径都漏了，
   *      表现就是切了档位横幅上的「删除 N」一动不动，直到滚动加载新评论才更新。
   *
   * 现在只剩 poolVer 一个单调递增版本号：凡是 pool 的内容、命中标记、
   * 删除账本、自己的 mid 有任何变化，都走 bumpPool() 加一次。
   * 只要没人忘，缓存就永远是对的 —— 而忘的代价从「数字过期」变成
   * 「多算一次」，方向是安全的。
   */
  var poolVer = 0;
  var candCache = { ver: -1, d: 0, b: 0 };

  function bumpPool() { poolVer++; }
  var upperMid = '';    /* 当前稿件的 UP 主 mid，接口里叫 data.upper.mid */
  var selfMid = '';           /* 自己的 mid */
  var selfMidReady = false;   /* /nav 回来之前是 false，此时不能可靠地「跳过自己」 */

  /*
   * 存 / 取只有两种后端（脚本管理器的存储或 localStorage）。
   * 原来 loadConfig / readConf / readBook 三处几乎逐字重复，
   * 合成两个小工具，以后加一个 key 不用再抄一遍 try/catch。
   */
  function readJSON(key) {
    try {
      var raw = HAS_GM ? GM_getValue(key, null) : W.localStorage.getItem(key);
      if (!raw) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) { return null; }
  }

  function writeJSON(key, obj) {
    try {
      var s = JSON.stringify(obj);
      if (HAS_GM) GM_setValue(key, s);
      else W.localStorage.setItem(key, s);
      return true;
    } catch (e) { return false; }
  }

  (function loadConfig() {
    var raw = readJSON(SKEY);
    if (!raw) return;
    try {
      var o = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!o || typeof o !== 'object') return;
      /*
       * 必须用 hasOwnProperty 查白名单。
       * 普通对象字面量继承 Object.prototype，VALID_TIER['constructor'] 是真值 ——
       * 一旦配置里 tier 写成 'constructor'，校验会放行，
       * 而 isBlocked 里所有档位分支都落空，等价于直接跑到 kill 档的逻辑，
       * 用户会莫名其妙发现「屏蔽强度自己变严了」。
       */
      var own = function (o2, k) { return Object.prototype.hasOwnProperty.call(o2, k); };
      if (typeof o.tier === 'string' && own(VALID_TIER, o.tier)) config.tier = o.tier;
      if (typeof o.sub === 'string' && own(VALID_SUB, o.sub)) config.sub = o.sub;
      if (typeof o.showCount === 'boolean') config.showCount = o.showCount;
      if (Array.isArray(o.words) && o.words.length) {
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

  function writeOut() { return writeJSON(SKEY, config); }
  function readConf() { return readJSON(SKEY); }
  function readBook() { return readJSON(BKEY); }
  function writeBook(book) { return writeJSON(BKEY, book); }

  /*
   * 保存 = 写盘 + 回读校验。
   * 设置项改了其实立刻就生效（改一下就落盘），这个按钮的意义是
   * 「确认刚才那些改动真的存住了」，所以真的再读一遍比对，
   * 对不上就报失败，不给假的「保存成功」。
   */
  function save() {
    if (!writeOut()) return { ok: false, msg: '保存失败，浏览器拒绝了写入' };

    var back = readConf();
    if (!back || typeof back !== 'object') return { ok: false, msg: '保存失败，没有读回来' };

    if (back.tier !== config.tier) return { ok: false, msg: '保存失败，档位没有存住' };
    if (back.sub !== config.sub) return { ok: false, msg: '保存失败，楼中楼设置没有存住' };
    if ((back.showCount ? 1 : 0) !== (config.showCount ? 1 : 0)) return { ok: false, msg: '保存失败，开关没有存住' };

    var bw = back.words || [];
    if (bw.length !== config.words.length) return { ok: false, msg: '保存失败，屏蔽词数量对不上' };
    for (var i = 0; i < config.words.length; i++) {
      if (bw[i] !== config.words[i]) return { ok: false, msg: '保存失败，屏蔽词没存全' };
    }
    return { ok: true };
  }

  /* ============ 繁体支持 ============ */

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
  var S2T_RAW =
      '鱼魚鲸鯨';   /* 鱼->魚, 鲸->鯨（判定词里只有这两个字有繁体） */

  /* 解析成 { 简: '繁繁...' } */
  var S2T = (function () {
    var d = Object.create(null), i = 0, n = S2T_RAW.length, k, v;
    while (i < n) {
      k = S2T_RAW.charAt(i++);
      v = S2T_RAW.charAt(i++);
      while (i < n && S2T_RAW.charAt(i) === '~') {
        v += S2T_RAW.charAt(i + 1);
        i += 2;
      }
      if (k && v) d[k] = v;
    }
    return d;
  })();

  /* 把正则元字符转义，供拼装用。必须在展开之前作用于原始词。 */
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\/|-]/g, '\\$&');
  }

  /* '大肥鱼' -> '大肥[鱼魚]'；没有繁体变体的字原样保留 */
  function expandWord(w) {
    var out = '', i, ch, t;
    for (i = 0; i < w.length; i++) {
      ch = w.charAt(i);
      t = S2T[ch];
      out += t ? '[' + ch + t + ']' : ch;
    }
    return out;
  }

  /*
   * 把一组词合成一个正则。
   * 先对每个原始词做元字符转义，再做繁体展开 —— 顺序不能反，
   * 否则展开出来的 [ ] 会被当成元字符转义掉。
   */
  function buildWordsRe(list) {
    var parts = [], i, re;
    for (i = 0; i < list.length; i++) {
      if (list[i]) parts.push(expandWord(escapeRe(list[i])));
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

  /* ============ 判定 ============ */

  /*
   * 账号名判定：只认「肥鱼」。
   *
   * 这条比正文判定优先级高（命中就不再看档位），所以宁可窄。
   * 演变过程：1.2 版是 /鱼|鲸/，误伤面太大；
   * 1.3 收窄成「肥鱼」，一直沿用到现在 —— 这是有意为之，不是漏写。
   *
   * 注意它只认「肥鱼」这两个字连在一起：
   *   「大肥鱼」「xxx的大肥鱼」「肥魚」 -> 命中
   *   「小鲸」「鲸鱼娘」「鲸落」        -> 命中不了
   * 名字里只有「鲸」的账号，靠正文里的品牌词（RE_BRAND）兜底，
   * 或者在设置里把它加成自定义屏蔽词。
   */
  var RE_NAME  = buildWordsRe(['肥鱼']);
  var RE_BRAND = buildWordsRe(['大肥鱼', '肥鱼', '鲸鱼', '大肥鲸', '鲸鱼娘', '本鲸', '本鱼', '本肥鱼', '主人']);
  var RE_CHAR  = buildWordsRe(['鱼', '鲸']);   /* 杀戮档：单字 */
  var RE_QUOTE = /^回复\s*@[\s\S]{0,40}?\s*[:：]\s*/;
  /*
   * 杀戮档的「全角标点 / 破折号 / 直角引号」合并成一条字符类。
   * 原来拆成三个正则逐条 test，没命中的评论要多扫两遍；
   * 合成一次扫描，判定结果和原来完全一致。
   */
  var RE_KILLP = /[：；「」]|[\u2014\u2015\u2500]|--/;

  /*
   * 自定义屏蔽词。
   * 旧写法是「每条评论 toLowerCase + 逐个 indexOf」，100 个词 × 几千条评论
   * 就是几十万次字符串扫描。改成合成一个正则：V8 的匹配器比 JS 循环快得多，
   * 而且只扫一遍，词越多越划算。词同样做繁体展开。
   *
   * customCache 三态：undefined = 还没构建，null = 没有词或构建失败。
   */
  var customCache;

  function customRe() {
    if (customCache !== undefined) return customCache;
    customCache = config.words.length ? buildWordsRe(config.words) : null;
    return customCache;
  }

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

  /*
   * 有没有真的 @ 到人。
   * 原来只判 indexOf('@') !== -1，连「QQ 邮箱」「@所有人」这种正文里的
   * 裸 @ 也算命中 —— 标准档下就是一条误删。
   */
  var RE_AT = /(?:^|[^\w.+-])@[\w\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af-]/;

  /*
   * 先走 indexOf 的快速路径：绝大多数评论压根没有 @，
   * 没必要为它们跑一遍正则（这是每条评论都要过的热路径）。
   */
  function hasAt(body) {
    return body.indexOf('@') !== -1 && RE_AT.test(body);
  }

  function isBlocked(r, tier) {
    var full = textOf(r);
    var m;

    /* @ 只看剥掉系统前缀后的正文；关键词看完整原文 */
    var body = full;
    if (full.charCodeAt(0) === 0x56DE /* 回 */ && full.charCodeAt(1) === 0x590D /* 复 */) {
      var q = RE_QUOTE.exec(full);
      if (q) body = full.slice(q[0].length);
    }

    /* 账号名含「肥鱼」：所有档位一律屏蔽，这条精度最高，不参与档位取舍 */
    m = r && r.member;
    if (m && RE_NAME.test(m.uname || m.name || '')) return true;

    /* 自定义屏蔽词：所有档位都生效 */
    if (hitCustomWord(full)) return true;

    if (tier === 'atonly') return hasAt(body);

    if (RE_BRAND.test(full)) return true;
    if (tier === 'cup') return false;
    if (hasAt(body)) return true;
    if (tier === 'standard') return false;
    if (RE_CHAR.test(full)) return true;
    return RE_KILLP.test(full);
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
  var stat = { r: 0, s: 0 };
  var bannerCache = '';
  var counted = Object.create(null);

  var countedN = 0;
  var COUNT_CAP = 50000;

  function statTotal() { return stat.r + stat.s; }

  function resetCount() {
    stat.r = 0;
    stat.s = 0;
    counted = Object.create(null);
    countedN = 0;
    bannerCache = '';
  }

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
      /* id 为 0 / 空 时当作「不去重」，否则多个无效 id 会共用一个键，互相吞掉 */
      if (it.id != null && it.id !== 0 && it.id !== '0' && it.id !== '') {
        key = '' + it.id;
        if (counted[key]) continue;
        /*
         * 去重表满了就不再往里记，但继续计数。
         * 原来这里是 break —— 表一满整个计数就永久冻住，
         * 首页挂着不刷新的重度用户会看到「已清 N 条」再也不动了。
         * 代价是超过 5 万条之后去重保证失效（可能重复计），
         * 比数字彻底不动要好。
         */
        if (countedN < COUNT_CAP) { counted[key] = 1; countedN++; }
      }
      if (it.r) { stat.r += it.r; changed = true; }
      if (it.s) { stat.s += it.s; changed = true; }
    }
    if (!changed) return;
    queueBanner();
    if (config.showCount && !bannerShown()) watchMount();
  }

  /*
   * 首屏请求 = 换了视频 / 换了排序 / 刷新。
   * 记住的评论池必须清掉：池子里每条都带着自己的 oid，写任务又是按 item.oid 发请求的。
   * 不清的话，在视频 B 上点「删除」，候选里会混进视频 A 的评论，然后真的去删 A 下面的评论。
   * 单页路由切换没有整页刷新，这条是唯一的防线。
   */
  function onFirstPage() {
    /* 换了稿件 / 换了排序，正在跑的任务手里的目标是上一批的，直接停掉 */
    if (job && job.running) {
      job.stop = true;
      job.note = '页面已切换，任务中断';
    }
    resetCount();
    pool = [];
    poolSeen = Object.create(null);
    // 环形游标也要归零：不清的话下一轮会覆盖到残留槽位，把 poolSeen 里仍在用的索引删掉
    poolHead = 0;
    bumpPool();
  }

  function settle(r) {
    var mk = r.marks;
    if (mk) {
      for (var k = 0; k < mk.length; k++) {
        if (!mk[k] || mk[k] === '0') continue;
        if (counted[mk[k]]) continue;
        if (countedN < COUNT_CAP) { counted[mk[k]] = 1; countedN++; }
      }
    }
    commitCount(r.items);
  }

  /* ============ 评论池 ============ */
  /*
   * 记下「页面已经加载出来的评论」，给删除 / 拉黑当候选集。
   * 只记录、不发请求：候选集永远等于用户眼前这一份数据。
   */
  function intoPool(r) {
    /*
     * rpid 可能是 0 或缺失（被删 / 折叠的评论常见）。
     * 早期只判 !r.rpid，0 会被当成有效值放行，
     * 结果所有 rpid=0 的评论共用一个 poolSeen['0'] 槽位，互相覆盖。
     */
    if (!r || r.rpid == null) return;
    var raw = '' + r.rpid;
    if (!raw || raw === '0' || raw === 'undefined' || raw === 'null') return;
    var id = raw;
    if (poolSeen[id]) return;

    /* 先建对象，再决定放哪儿：池满分支也要用到 item，顺序反了会写进 undefined */
    var item = {
      rpid: id,
      oid: (r.oid != null ? '' + r.oid : ''),
      type: (r.type != null ? '' + r.type : ''),
      mid: (r.mid != null ? '' + r.mid : (r.member && r.member.mid != null ? '' + r.member.mid : '')),
      name: (r.member && (r.member.uname || r.member.name)) || '',
      text: textOf(r),  /* 留原文：切换档位 / 改屏蔽词时要对已加载的评论重新判定 */
      hit: false,       /* 命中档位规则 */
      pinned: false     /* 置顶评论，写操作一律跳过 */
    };

    /*
     * 池子满时不能直接丢弃新评论：长评论区滚动超过 POOL_CAP 条后，
     * 新评论永远进不来，按钮数字就冻住了。
     * 用环形覆盖而不是 Array.shift —— shift 对 2 万元素要整体搬移（O(n)），
     * 而这里正落在滚动热路径上。池子因此变成无序，
     * 但下游 buildCandidates / buildBlockCandidates 都是纯筛选，不依赖顺序。
     */
    if (pool.length >= POOL_CAP) {
      var slot = poolHead % POOL_CAP;
      poolHead++;
      var oldIt = pool[slot];
      if (oldIt) delete poolSeen[oldIt.rpid];
      pool[slot] = item;
      poolSeen[id] = item;
      bumpPool();
      return;
    }

    poolSeen[id] = item;   /* 顺手当索引，查找 O(1) */
    pool.push(item);
    /* 新评论可能命中，也淘汰了旧的，候选数必须重算 */
    bumpPool();
  }

  function recordUpper(json) {
    var d = json && json.data;
    var u = d && d.upper;
    if (u && u.mid != null) upperMid = '' + u.mid;
  }

  /*
   * 当前这批评论属于哪个稿件。任务执行时每发一个请求都要比对它：
   * 用户点了「确认删除」之后完全可能马上切到另一个视频，
   * 而任务手里的 list 还是旧 pool 的元素引用，oid 也还是旧稿件的。
   * 不比对的话就是「看着视频 B，删着视频 A 的评论」——不可逆。
   */
  var currentOid = '';

  function noteOid(oid) {
    if (oid != null && oid !== '') currentOid = '' + oid;
  }

  /* ============ 处理接口数据 ============ */

  function apiKind(url) {
    /*
     * url 在真实页面里不一定是字符串：xhr.open('GET', new URL(...)) 很常见，
     * Request 对象也会被直接传进 fetch。这里必须先归一化再判断，
     * 否则 indexOf 会抛 TypeError —— 而它是在页面调用 open/send 的栈里抛的，
     * 等于我们把人家的请求打断了。
     */
    if (url && typeof url !== 'string') {
      /*
       * Request 对象有 .url，URL 对象有 .href，两者都得认。
       * 原来只认 .href，fetch(new Request(...)) 会被 String() 成
       * "[object Object]"，于是首屏判断失灵、评论也过滤不掉。
       */
      if (typeof url.url === 'string' && url.url) url = url.url;
      else if (typeof url.href === 'string') url = url.href;
      else url = String(url);
    }
    if (!url || url.indexOf('/x/v2/reply') === -1) return 0;
    if (url.indexOf('/x/v2/reply/reply') !== -1) return 2;
    if (url.indexOf('/x/v2/reply/wbi/main') !== -1) return 1;
    if (url.indexOf('/x/v2/reply/main') !== -1) return 1;
    if (url.indexOf('/x/v2/reply?') !== -1) return 1;
    return 0;   /* add / del / action / subject / report 等一律跳过 */
  }

  /*
   * 过滤一份接口数据，只做「改数据 + 记账单」，不碰全局计数（交给 settle）。
   * 返回 null = 这份数据不用管；否则返回 { items }。
   */
  function filterPayload(json, kind) {
    var data = json && json.data;
    if (!data) return null;

    /* 顺手拿到 UP 主 mid：写操作要靠它判断「这是不是自己的稿件」 */
    if (kind === 1) {
      recordUpper(json);
      if (data.replies && data.replies.length) noteOid(data.replies[0].oid);
    }

    var tier = config.tier;
    var sub = config.sub;
    var items = [], marks = [], kept, i, j, c, kids, hit, hitKids, k;

    /* ---- 楼中楼接口 ---- */
    if (kind === 2) {
      var list = data.replies;
      if (!list || !list.length) return null;
      /* 池子不关心 sub 设置，先把见过的都记下来 */
      for (i = 0; i < list.length; i++) intoPool(list[i]);
      if (sub === 'none') return null;
      kept = [];
      for (i = 0; i < list.length; i++) {
        if (isBlocked(list[i], tier)) {
          items.push({ id: list[i] && list[i].rpid, r: 0, s: 1 });
          /* 必须回写到池子，否则「只在楼中楼里出现」的评论永远进不了删除 / 拉黑候选 */
          var p2 = poolFind(list[i] && list[i].rpid);
          if (p2 && !p2.hit) { p2.hit = true; bumpPool(); }
          continue;
        }
        kept.push(list[i]);
      }
      if (!items.length) return null;
      data.replies = kept;
      /*
       * 楼中楼也把「共 N 条回复」同步减掉，和一级评论的 c.rcount 保持同一口径。
       * 不改的话展开楼中楼会显示「共 8 条」却只列出 3 条。
       */
      var cut = items.length;
      if (data.root && typeof data.root.rcount === 'number') {
        data.root.rcount = Math.max(0, data.root.rcount - cut);
      }
      if (data.page && typeof data.page.count === 'number') {
        data.page.count = Math.max(0, data.page.count - cut);
      }
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
      intoPool(c);
      if (c && c.replies && c.replies.length) {
        for (j = 0; j < c.replies.length; j++) intoPool(c.replies[j]);
      }

      if (pinned && c && pinned[c.rpid]) {
        var pn = poolFind(c.rpid);
        if (pn) pn.pinned = true;
        kept.push(c);
        continue;
      }

      var rootHit = isBlocked(c, tier);
      if (rootHit) markHit(c && c.rpid);

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
        if (isBlocked(kids[j], tier)) {
          hitKids.push(j);
          markHit(kids[j].rpid);
        }
      }
      hit = hitKids.length;
      if (!hit) { kept.push(c); continue; }

      if (sub === 'whole') {
        /*
         * 整楼删除时主楼也已经被藏起来了，必须一并标 hit。
         * 否则候选集里只有楼中楼、没有主楼：删完刷新，主楼又活了。
         */
        markHit(c && c.rpid);
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
     */
    if (data.replies && data.replies.length === 0 && roots.length > 0) {
      if (data.cursor && typeof data.cursor === 'object') data.cursor.is_end = true;
      /* 只标 is_end，不动 next：改 next 会破坏 B站自己的翻页偏移 */
    }

    return { items: items, marks: marks.length ? marks : null };
  }

  function poolFind(rpid) {
    return poolSeen['' + rpid] || null;
  }

  /* 标命中。只有真翻转了才 bump，否则一次首屏解析会白 bump 几百次 */
  function markHit(rpid) {
    var it = poolFind(rpid);
    if (it && !it.hit) { it.hit = true; bumpPool(); }
  }

  /*
   * 对池子里已经加载的评论重新跑一遍判定。
   *
   * 为什么需要它：hit 标记是「数据流进页面那一刻」算出来的快照。
   * 用户随手把档位从标准切到杀戮、或者加了一个屏蔽词之后，
   * 已经加载出来的那批评论不会重新过一遍判定 ——
   * 于是按钮上的候选数一直停在旧值，直到滚动加载新评论才更新。
   */
  function rejudgePool() {
    var tier = config.tier, i, it;
    for (i = 0; i < pool.length; i++) {
      it = pool[i];
      /* 置顶评论本来就写操作一律跳过，命中标记保持原样即可 */
      if (it.pinned) continue;
      /*
       * 这里刻意保留「每条造一个临时对象」的写法。
       * 试过复用一个壳子对象再逐字段赋值，实测反而慢 25%
       * （V8 对这种短命字面量有标量替换，复用对象反倒要写真实内存）。
       */
      it.hit = isBlocked(
        { mid: it.mid, member: { uname: it.name }, content: { message: it.text } },
        tier
      );
    }
    bumpPool();
  }

  /*
   * 首屏请求判定：换了排序、换了视频、刷新，都会重新拉第一页。
   * wbi/main 用 pagination_str={"offset":""}，旧版用 next=0 / pn=1。
   */
  function isFirstPageReq(url, kind) {
    /*
     * kind 收进函数内部判断。原来靠调用方写 kind === 1 短路，
     * 语义上很危险：以后多加一处调用漏写，展开楼中楼时就会清空整个池子。
     */
    if (kind !== undefined && kind !== 1) return false;
    if (!url) return false;
    var u = url;
    try { u = decodeURIComponent(url); } catch (e) {}
    if (u.indexOf('pagination_str') !== -1) return u.indexOf('"offset":""') !== -1;
    if (!/[?&]next=/.test(u) && !/[?&]pn=/.test(u)) return true;
    return /[?&]next=0(&|$)/.test(u) || /[?&]pn=1(&|$)/.test(u);
  }
  /* ============ 写接口 ============ */
  /*
   * 这里全部走 rawFetch —— 脚本自己 hook 了 W.fetch，如果不绕开，
   * 自己的写请求会先被自己的钩子解析一遍，属于自己咬自己。
   * hook 之前先把原始引用存下来，这里只用那份。
   */

    /*
   * 读 document.cookie 是这脚本里最贵的单个操作（实测 ~5us/次），
   * 而且写在 DOM 之后读会强制一次同步样式重算。
   *
   * 但缓存要小心：只缓存「读到了」的情况。读空不能缓存 ——
   * 脚本是 document-start 跑的，那时登录 cookie 可能还没就绪，
   * 一旦把空串缓存住，整个页面生命周期都拿不到 csrf。
   */
  var CSRF_RE = /(?:^|;\s*)bili_jct=([^;]*)/;
  var csrfCache = '';

  function csrfToken() {
    if (csrfCache) return csrfCache;
    var m = document.cookie.match(CSRF_RE);
    if (m && m[1]) {
      // cookie 里出现非法转义时别抛，否则整条 drawBanner 链会断
      try { csrfCache = decodeURIComponent(m[1]); }
      catch (e) { csrfCache = m[1]; }
    }
    return csrfCache;
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /* 发一个表单 POST，返回解析后的 json */
  function postForm(path, body) {
    var url = 'https://api.bilibili.com' + path;
    /*
     * 加超时：没有超时的话，一个卡住的请求会让 pumpJob 永远停在 await 上 ——
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
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, 15000);
      }
    } catch (e) {}

    return rawFetch(url, init).then(function (res) {
      if (timer) { clearTimeout(timer); timer = 0; }
      return res.text().then(function (txt) {
        try { return JSON.parse(txt); }
        catch (e) { return { code: -999, message: '返回的不是 JSON' }; }
      });
    });
  }

  /*
   * 错误码翻译成人话。宁可说清楚，也别把 -509 这种数字直接丢给用户。
   *   -101 未登录  -111 csrf 失效  -352 / -509 风控限流
   *   -403 没权限  22008 黑名单满  22120 已在黑名单  12022 已经删了
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
   * 带退避重试地发一次。
   *
   * 只有 -509（请求过快）重试有意义。
   * -352 是风控黑名单级别，几乎不可能在一次任务里恢复：
   * 重试间隔 4s/8s/12s，单条就要耗 24 秒，100 条就是 40 分钟，
   * 期间用户只看到进度条不动。所以 -352 不重试，直接让任务停下，
   * 由用户过几十分钟自己回来重开 —— 比死磕更体面，也更省风控额度。
   *
   * 权限不足、目标不存在这类同样不重试：重试也没用，
   * 对着删不掉的目标连发三次只会把账号更快送进风控。
   */
  function postWithRetry(path, body, attempt) {
    attempt = attempt || 0;
    return postForm(path, body)['catch'](function () {
      return { code: -999, message: '网络错误' };
    }).then(function (j) {
      var code = j && j.code;
      if (code === 0) return j;
      /* 429 风格限流：1.2s + 2.4s + 3.6s 逐次退避，总共不到 8 秒 */
      if (code === -509 && attempt < RETRY_MAX) {
        return sleep(1200 * (attempt + 1))
          .then(function () { return postWithRetry(path, body, attempt + 1); });
      }
      return j;
    });
  }

  function delReply(oid, type, rpid) {
    var body = 'oid=' + encodeURIComponent(oid) +
               '&type=' + encodeURIComponent(type) +
               '&rpid=' + encodeURIComponent(rpid) +
               '&csrf=' + encodeURIComponent(csrfToken());
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
               '&csrf=' + encodeURIComponent(csrfToken());
    return postWithRetry('/x/relation/batch/modify', body, 0);
  }

  /* ============ 执行器 ============ */
  /*
   * 一次只跑一个任务，随时可停。
   * 停止是第一优先的：在两条之间检查，不会出现「点了停还在删」。
   */
  var job = null;

  function startJob(kind, targets) {
    if (job && job.running) return job;
    /* 顺手把 mid -> 用户名 存下来，拉黑成功后写进账本，黑名单页才有人名可显示 */
    var nameOf = Object.create(null), n;
    for (n = 0; n < targets.length; n++) {
      if (targets[n].mid && targets[n].name) nameOf[targets[n].mid] = targets[n].name;
    }
    job = {
      kind: kind,
      list: targets,
      total: targets.length,
      done: 0, ok: 0, fail: 0,
      running: true,
      stop: false,
      note: '',        /* 当前提示（限流、错误原因） */
      err: '',         /* 异常中断的原因 */
      errs: [],        /* 失败明细，最多留 20 条 */
      nameOf: nameOf
    };
    updateJobUI();
    pumpJob();
    return job;
  }

  function stopJob() {
    if (job && job.running) { job.stop = true; job.note = '正在停止…'; updateJobUI(); }
  }

  function pushErr(j, msg, who) {
    if (j.errs.length < 20) j.errs.push({ msg: msg, who: who || '' });
  }

  /*
   * 收尾单独抽出来：不管任务怎么结束（正常、异常、被 stop），
   * 都必须走到这里。否则一旦中途抛异常，j.running 会永远停在 true，
   * stopJob 也唤不醒已经死掉的 promise，startJob 的守卫又会直接返回这个僵尸 job
   * —— 整个删除 / 拉黑功能在本次页面生命周期里就废了，只能刷新。
   */
  function finishJob(j) {
    j.running = false;
    flushBook();
    if (j.stop) {
      j.note = '已停止';
    } else if (j.err && !j.note) {
      j.note = j.err;
    } else if (!j.note || j.note === '正在删除…' || j.note === '正在拉黑…' || j.note === '正在停止…') {
      j.note = '已完成';
    }
    updateJobUI();
    try { onJobEnd(j); } catch (e) {}
  }

  async function pumpJob() {
    var j = job;
    if (!j) return;

    try {
      await runJob(j);
    } catch (e) {
      /* 任何没预料到的异常都不能让任务挂死 */
      j.err = '任务中断：' + ((e && e.message) || e);
      pushErr(j, j.err, '');
    } finally {
      finishJob(j);
    }
  }

  async function runJob(j) {
    if (j.kind === 'del') {
      for (var i = 0; i < j.list.length; i++) {
        if (j.stop) break;
        var t = j.list[i];
        /*
         * 页面已经切到别的稿件了就立刻收工。
         * 继续跑下去等于拿旧 oid 去删上一个视频的评论 —— 删完就回不来了。
         */
        if (currentOid && t.oid && t.oid !== currentOid) {
          j.note = '页面已切换到别的稿件，任务中断';
          break;
        }
        j.note = '正在删除…';
        updateJobUI();

        var r = await delReply(t.oid, t.type, t.rpid);
        var why = explain(r.code, r.message);

        if (!why) {
          j.ok++;
          markDeleted(t.rpid);
        } else {
          j.fail++;
          pushErr(j, why, t.name);
          /* 登录态 / 权限这类问题，继续跑下去只会全军覆没，直接收工 */
          if (r.code === -101 || r.code === -111 || r.code === -403 || r.code === -352) {
            j.note = why;
            j.done++;
            break;
          }
        }
        j.done++;
        updateJobUI();

        if (i < j.list.length - 1 && !j.stop) await sleep(DEL_GAP);
      }
    } else {
      /* ---- 拉黑：按 50 一组打包 ---- */
      var mids = [], seen = Object.create(null), k;
      for (k = 0; k < j.list.length; k++) {
        var m = j.list[k].mid;
        if (!m || seen[m]) continue;
        seen[m] = 1;
        mids.push(m);
      }

      for (var p = 0; p < mids.length; p += 50) {
        if (j.stop) break;
        var chunk = mids.slice(p, p + 50);
        j.note = '正在拉黑…';
        updateJobUI();

        var br = await batchBlock(chunk);
        var bwhy = explain(br.code, br.message);

        if (!bwhy) {
          var failed = (br.data && br.data.failed_fids) || [];
          var failedSet = Object.create(null), q;
          for (q = 0; q < failed.length; q++) failedSet['' + failed[q]] = 1;

          var good = [], goodNames = Object.create(null);
          for (q = 0; q < chunk.length; q++) {
            if (failedSet[chunk[q]]) {
              j.fail++;
            } else {
              j.ok++;
              good.push(chunk[q]);
              goodNames[chunk[q]] = j.nameOf[chunk[q]] || '';
            }
          }
          addBook(good, goodNames);
        } else {
          j.fail += chunk.length;
          pushErr(j, bwhy, chunk.length + ' 人');
          if (br.code === -101 || br.code === -111 || br.code === -352) {
            j.note = bwhy; j.done += chunk.length; break;
          }
        }
        j.done += chunk.length;
        updateJobUI();

        if (p + 50 < mids.length && !j.stop) await sleep(BLOCK_GAP);
      }
    }

  }

  /* ============ 账本 ============ */
  /*
   * 本地记账，只做两件事：
   *   1. 已经删掉 / 拉黑过的别再发请求（幂等，省请求也就等于省风控额度）
   *   2. 拉黑是不可见的，得让用户能回头看到「我到底拉黑了谁」
   * 数据量不大：只存 mid / rpid 和一点用于展示的名字与时间。
   */

  var book = null;          /* { m: { mid: {n:名字, t:时间} }, r: { rpid: 时间 } } */
  var deleted = Object.create(null);   /* 本轮已删的 rpid */

  function loadBook() {
    if (book) return book;
    var b = readBook();
    if (!b || typeof b !== 'object') b = {};
    if (!b.m || typeof b.m !== 'object') b.m = {};
    if (!b.r || typeof b.r !== 'object') b.r = {};
    /*
     * 逐个清洗。账本可能被旧版本 / 手改 / 写到一半被打断搞脏，
     * 出现 {m:{111:null}} 这种值。pruneBook / bookList 直接读 .t / .n，
     * 一个 null 就能抛 TypeError —— 而 pruneBook 在 flushBook 里，
     * 抛出去会把拉黑任务的收尾一起带崩。
     */
    var k, v;
    for (k in b.m) {
      v = b.m[k];
      if (!v || typeof v !== 'object') b.m[k] = { n: '', t: 0 };
      else if (typeof v.t !== 'number') v.t = 0;
    }
    for (k in b.r) {
      if (typeof b.r[k] !== 'number') b.r[k] = 0;
    }
    book = b;
    return book;
  }

  /* 账本瘦身：超过上限就按时间丢最旧的，避免把 storage 撑爆 */
  /* 取条目时间，脏数据（null / 非对象）一律当 0，别让排序抛异常 */
  function bookTime(it) {
    return (it && typeof it === 'object' && it.t) || 0;
  }

  function pruneBook() {
    var b = loadBook(), keys = [], k, i;
    /* 拉黑表：用户会回头查，留名字，按时间丢最旧 */
    for (k in b.m) keys.push(k);
    if (keys.length > BOOK_MID_CAP) {
      keys.sort(function (x, y) { return bookTime(b.m[x]) - bookTime(b.m[y]); });
      for (i = 0; i < keys.length - BOOK_MID_CAP; i++) delete b.m[keys[i]];
    }
    /* 删除表：只用来判「删过没有」，数量跟着 POOL_CAP 走 */
    var rk = [];
    for (k in b.r) rk.push(k);
    if (rk.length > BOOK_DEL_CAP) {
      rk.sort(function (x, y) { return (b.r[x] || 0) - (b.r[y] || 0); });
      for (i = 0; i < rk.length - BOOK_DEL_CAP; i++) delete b.r[rk[i]];
    }
  }

  /*
   * 同 markDeleted：只记内存，落盘交给 flushBook 合并。
   * 原实现每批都 pruneBook + 全量序列化 + 同步写盘（3000 条时约 5ms），
   * 拉黑 3000 人要 60 批，光写盘就 300ms 主线程。
   * 顺带说明：flushBook 的成本随账本规模线性涨
   * （实测 r=3000 → 5.1ms，r=20000 → 11.2ms），
   * 而它挂在 pagehide 上，太慢会拖住关页面，所以删除表没敢放开到 5 万。
   */
  /* names: 可选的 { mid: 用户名 }，用来把「本地黑名单」显示成人名而不是一串数字 */
  function addBook(mids, names) {
    var b = loadBook(), now = Date.now(), i, nm;
    for (i = 0; i < mids.length; i++) {
      nm = (names && names[mids[i]]) || '';
      if (!b.m[mids[i]]) b.m[mids[i]] = { n: nm, t: now };
      else {
        b.m[mids[i]].t = now;
        if (nm) b.m[mids[i]].n = nm;
      }
    }
    bookDirty = true;
    /* 拉黑过的人不该再出现在候选里，缓存必须失效，否则「拉黑 N」数字不动 */
    bumpPool();
  }

  function bookCount() { var b = loadBook(), n = 0, k; for (k in b.m) n++; return n; }

  function bookList() {
    var b = loadBook(), arr = [], k, it;
    for (k in b.m) {
      /* 账本可能被别的版本写脏（{m:{1:null}}），这里不能假设每项都是对象 */
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

  /*
   * 账本写盘很贵：整本 JSON.stringify + 同步 storage 写入。
   * 批量删 1000 条时如果每条都写，那就是 1000 次全量序列化，主线程会被拖住。
   * 所以这里只记内存，落盘合并成一次（flushBook），由任务收尾或页面卸载时触发。
   */
  var bookDirty = false;

  function markDeleted(rpid) {
    deleted['' + rpid] = 1;
    var b = loadBook();
    b.r['' + rpid] = Date.now();
    bookDirty = true;
    /*
     * 必须让候选缓存失效。删一条既不改 pool 长度也不改 hit，
     * 只有版本号动了，删完一批按钮上的数字才会跟着减 ——
     * 否则用户以为没生效再点一次，白烧风控额度。
     */
    bumpPool();
  }

  function flushBook() {
    if (!bookDirty) return;
    /*
     * 先写成功再清 dirty。
     * 原来反着来：一旦 pruneBook/writeBook 抛异常，dirty 已经被清掉，
     * 这一轮记录就永远丢了（而且下次也不会再尝试写）。
     */
    try {
      pruneBook();
      if (writeBook(loadBook())) bookDirty = false;
    } catch (e) {
      /* 保持 dirty，下次还有机会写进去 */
    }
  }

  /*
   * 账本是攒批写的，所以必须有卸载钩子兜底：
   * 删到一半关标签页 / 切走，内存里的记录会整个丢掉，
   * 下次重新加载时 deleted 也是空的，会把同一批评论再删一遍（白耗风控额度）。
   * pagehide / visibilitychange 里做同步存储是标准做法。
   */
  try {
    if (typeof W.addEventListener === 'function') {
      W.addEventListener('pagehide', function () { stopDog(); flushBook(); }, true);
      W.addEventListener('beforeunload', flushBook, true);
      W.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushBook();
      }, true);
    }
  } catch (e) {}

  /* ============ 候选集 ============ */
  /*
   * 范围只有两种，都建立在「页面已加载的评论」之上：
   *   命中  = 被档位规则判为要屏蔽的（用户本来也看不见它们）
   *   全部  = 当前已加载的全部评论
   * 置顶评论永远不进候选集，和自己有关的也跳过。
   */
  function buildCandidates() {
    var out = [], i, it;
    /*
     * 删除账本分两本：deleted 是本次会话内删的，book.r 是历史落盘的。
     * 两本都要查 —— 只查内存的话刷新页面后就全忘了，同一批评论会重新进候选，
     * 用户再点一次删除，白刷一遍风控额度。
     * 提到循环外，一次筛选只取一遍账本。
     */
    var gone = loadBook().r;
    for (i = 0; i < pool.length; i++) {
      it = pool[i];
      if (it.pinned) continue;
      if (!it.mid) continue;
      /*
       * selfMid 还没拿到时不能放行：否则「自己的评论」会被当成可删目标，
       * 而删自己的评论接口是成功返回的，等于静默删了自己的楼。
       * 拿不到就一律排除，宁可少删，也不误删。
       */
      if (!selfMidReady) continue;
      if (it.mid === selfMid) continue;
      if (!it.hit) continue;
      /* 已删过的排除：删完一批按钮数字要跟着减，否则用户会再点一次白烧风控额度 */
      if (deleted[it.rpid] || gone[it.rpid]) continue;
      out.push(it);
    }
    return out;
  }

  /* 拉黑候选：去重到人。同一个人刷了一屏也只算一次 */
  function buildBlockCandidates() {
    var out = [], i, it;
    /* 账本提出来：原来每条命中评论都调一次 loadBook() */
    var bm = loadBook().m;
    /*
     * 用 Set 而不是 Object.create(null) 当去重表：
     * mid 是 1.5e9 量级的数字字符串，V8 会把这类键归一化成数组索引，
     * 落进字典元素存储，实测比 Set 慢 2.2 倍（0.118ms -> 0.054ms @ pool=5000）。
     */
    var seen = new Set();
    for (i = 0; i < pool.length; i++) {
      it = pool[i];
      if (!it.hit) continue;
      if (!it.mid || !selfMidReady) continue;
      if (it.mid === selfMid || it.mid === upperMid) continue;
      if (seen.has(it.mid)) continue;
      seen.add(it.mid);
      if (bm[it.mid]) continue;
      out.push(it);
    }
    return out;
  }

  /* ============ 环境判定 ============ */
  /* 页面类型：决定拉黑按钮放哪儿更有用 */
  function pageKind() {
    var h = location.hostname, p = location.pathname;
    if (h === 'space.bilibili.com') return 'space';
    if (h === 't.bilibili.com' || p.indexOf('/opus/') === 0 || p.indexOf('/dynamic/') === 0) return 'dynamic';
    if (p.indexOf('/video/') === 0 || p.indexOf('/bangumi/') === 0 || p.indexOf('/list/') === 0) return 'video';
    return 'other';
  }

  /* ============ 界面 ============ */

  var CSS = ":host{all:initial}\n*{box-sizing:border-box;margin:0;padding:0}\n\n/* 主题变量 */\n.t{\n  --bg:rgba(252,251,249,.94);--bd:rgba(0,0,0,.07);--tx:#1f1f23;--dim:#8b8b94;\n  --sh:0 20px 48px -18px rgba(0,0,0,.34),0 2px 6px -2px rgba(0,0,0,.06),inset 0 1px 0 rgba(255,255,255,.9);\n  --hv:rgba(0,0,0,.05);--tg:rgba(0,0,0,.1);--line:rgba(0,0,0,.07)\n}\n.t.dk{\n  --bg:rgba(38,38,44,.94);--bd:rgba(255,255,255,.1);--tx:#f0f0f4;--dim:#9a9aa6;\n  --sh:0 20px 48px -18px rgba(0,0,0,.8),0 2px 6px -2px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.07);\n  --hv:rgba(255,255,255,.09);--tg:rgba(255,255,255,.16);--line:rgba(255,255,255,.09)\n}\n\n/* 面板 */\n.p{position:fixed;top:78px;right:18px;z-index:2147483600;width:300px;\nmax-height:calc(100vh - 96px);display:flex;flex-direction:column;\npadding:20px 20px 14px;border-radius:20px;\nbackground:var(--bg);\nbackdrop-filter:blur(40px) saturate(180%);-webkit-backdrop-filter:blur(40px) saturate(180%);\nborder:1px solid var(--bd);box-shadow:var(--sh);\nfont-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"HarmonyOS Sans SC\",\"Microsoft YaHei\",sans-serif;\n-webkit-font-smoothing:antialiased;\ntransform-origin:top right;animation:pop .18s cubic-bezier(.2,.9,.3,1)}\n@keyframes pop{from{opacity:0;transform:scale(.93) translateY(-6px)}to{opacity:1;transform:none}}\n\n/* 关闭 */\n.x{position:absolute;top:13px;right:14px;width:26px;height:26px;\ndisplay:flex;align-items:center;justify-content:center;\nfont-size:19px;line-height:1;color:var(--dim);cursor:pointer;border-radius:8px;\ntransition:background .14s,color .14s;user-select:none}\n.x:hover{background:var(--hv);color:var(--tx)}\n\n/* 分组标题 */\n.g{font-size:11.5px;font-weight:600;color:var(--dim);letter-spacing:.1em;\npadding:16px 8px 7px}\n.g:first-of-type{padding-top:2px}\n\n/* 选项 */\n.o{font-size:16px;line-height:1.2;color:var(--tx);padding:12px 14px;border-radius:11px;cursor:pointer;\ntransition:background .14s,color .14s,transform .1s}\n.o:hover{background:var(--hv)}\n.o:active{transform:scale(.985)}\n.o.on{background:#fb7299;color:#fff;font-weight:600;\nbox-shadow:0 4px 14px -4px rgba(251,114,153,.7)}\n\n/* 开关行 */\n.s{display:flex;align-items:center;justify-content:space-between;\nfont-size:15px;color:var(--tx);\npadding:16px 8px 8px;margin-top:10px;border-top:1px solid var(--line)}\n.sw{width:42px;height:24px;border-radius:12px;background:var(--tg);position:relative;cursor:pointer;\ntransition:background .2s;flex:none}\n.sw.on{background:#fb7299}\n.sw:after{content:\"\";position:absolute;left:3px;top:3px;width:18px;height:18px;border-radius:50%;\nbackground:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25);transition:left .2s cubic-bezier(.3,1.2,.5,1)}\n.sw.on:after{left:21px}\n\n/* 评论区那行字 */\n.b{display:inline-block;padding:12px 22px;margin:6px 0 20px;border-radius:12px;\nfont-size:16px;line-height:1.4;letter-spacing:.01em;user-select:none;font-weight:600;\nfont-family:-apple-system,BlinkMacSystemFont,\"PingFang SC\",\"HarmonyOS Sans SC\",\"Microsoft YaHei\",sans-serif;\n-webkit-font-smoothing:antialiased;\ncolor:#59616d;background:rgba(0,0,0,.055);\nborder:1px solid rgba(0,0,0,.055)}\n\n/* 气泡：已加的屏蔽词 */\n/* 词多了要能滚，否则面板会顶穿屏幕、保存按钮点不到。\n   只有真的溢出时才加 .more 显示底部渐隐，短列表不加，免得把内容淡掉 */\n.ws{display:flex;flex-wrap:wrap;gap:7px;padding:2px 6px 10px;min-height:8px;\nmax-height:min(46vh,340px);overflow-y:auto;overscroll-behavior:contain}\n.ws:empty{display:none}\n.ws.more{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 18px),transparent 100%);\nmask-image:linear-gradient(to bottom,#000 calc(100% - 18px),transparent 100%)}\n/* 滚动条做得轻一点，别抢视觉 */\n.ws::-webkit-scrollbar{width:6px}\n.ws::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:3px}\n.ws::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.28)}\n.ws::-webkit-scrollbar-track{background:transparent}\n.dk .ws::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2)}\n.dk .ws::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.34)}\n.w{display:inline-flex;align-items:center;gap:5px;\nmax-width:100%;padding:6px 6px 6px 11px;border-radius:9px;\nfont-size:13.5px;line-height:1.25;color:var(--tx);\nbackground:rgba(251,114,153,.12);\nborder:1px solid rgba(251,114,153,.3);\nword-break:break-all;animation:tin .16s cubic-bezier(.2,.9,.3,1)}\n@keyframes tin{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:none}}\n.w span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.w i{flex:none;width:17px;height:17px;display:flex;align-items:center;justify-content:center;\nfont-style:normal;font-size:13px;line-height:1;border-radius:5px;cursor:pointer;\ncolor:#fb7299;opacity:.75;transition:background .14s,opacity .14s}\n.w i:hover{background:rgba(251,114,153,.2);opacity:1}\n.w.dk{background:rgba(251,114,153,.16);border-color:rgba(251,114,153,.34)}\n\n/* 输入行：输入框 + 确定 */\n.r{display:flex;gap:8px;padding:2px 6px 4px}\n.in{flex:1;min-width:0;height:38px;padding:0 12px;border-radius:10px;\nfont-size:14.5px;font-family:inherit;color:var(--tx);\nbackground:var(--hv);border:1px solid var(--bd);outline:none;\ntransition:border-color .14s,background .14s}\n.in::placeholder{color:var(--dim)}\n.in:focus{border-color:rgba(251,114,153,.55);background:var(--tg)}\n.btn{flex:none;height:38px;padding:0 15px;border-radius:10px;\nfont-size:14.5px;font-weight:600;line-height:38px;cursor:pointer;\ncolor:var(--tx);background:var(--hv);border:1px solid var(--bd);\ntransition:background .14s,opacity .14s,transform .1s}\n.btn:hover{background:var(--tg)}\n.btn:active{transform:scale(.97)}\n.btn.pri{color:#fff;background:#fb7299;border-color:#fb7299;\nbox-shadow:0 4px 14px -6px rgba(251,114,153,.8)}\n.btn.pri:hover{background:#fa5c8b}\n\n\n/* 内容区：两页共用，内容长了自己滚；页签和底部按钮固定 */\n.p>.bd{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding-right:2px}\n.p>.bd::-webkit-scrollbar{width:6px}\n.p>.bd::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:3px}\n.dk .p>.bd::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2)}\n.p>.nav,.p>.f,.p>.x{flex:none}\n\n/* 底部操作区 */\n.f{display:flex;justify-content:flex-end;gap:8px;\npadding:14px 6px 2px;margin-top:8px;border-top:1px solid var(--line)}\n\n\n.tip{font-size:12px;line-height:1.5;color:var(--dim);padding:8px 6px 0}\n\n/* 保存成功提示：贴在面板上方出现，位置由 JS 算 */\n.toast{position:fixed;z-index:2147483647;padding:11px 22px;border-radius:12px;\nmax-width:min(360px,80vw);\nfont-size:14.5px;font-weight:600;line-height:1.35;\nbackground:rgba(38,38,44,.94);color:#fff;\nborder:1px solid rgba(255,255,255,.14);\nbox-shadow:0 16px 40px -14px rgba(0,0,0,.6);\nopacity:0;pointer-events:none;\ntransform:translateY(6px);\ntransition:opacity .2s ease,transform .2s cubic-bezier(.2,.9,.3,1)}\n.toast.on{opacity:1;transform:translateY(0)}\n.toast.dk{background:rgba(252,251,249,.96);color:#1f1f23;\nborder:1px solid rgba(0,0,0,.08)}\n/* ===== 1.4 新增：导航 / 操作页 / 风险提示 ===== */\n\n/* 顶部导航：两个页签 */\n.nav{display:flex;gap:6px;padding:0 2px 6px}\n.nv{flex:1;text-align:center;font-size:13.5px;padding:8px 0;border-radius:9px;\ncursor:pointer;color:var(--dim);transition:background .14s,color .14s;user-select:none}\n.nv:hover{background:var(--hv)}\n.nv.on{background:var(--hv);color:var(--tx);font-weight:600}\n\n/* 操作页里的条目：标题 + 一句说明 */\n.op{padding:11px 12px;border-radius:11px;cursor:pointer;\ntransition:background .14s,transform .1s}\n.op:hover{background:var(--hv)}\n.op:active{transform:scale(.99)}\n.op.off{opacity:.45;cursor:default}\n.op.off:hover{background:transparent}\n.op .t1{font-size:15px;line-height:1.3;color:var(--tx);display:flex;\nalign-items:center;justify-content:space-between;gap:8px}\n.op .t2{font-size:12px;line-height:1.5;color:var(--dim);margin-top:4px}\n.op .cnt{font-size:12px;font-weight:600;color:#fb7299;background:rgba(251,114,153,.13);\npadding:2px 8px;border-radius:20px;flex:none}\n\n/* 危险条目：删除 / 拉黑 */\n.op.dg .t1{color:#e0324f}\n.t.dk .op.dg .t1{color:#ff7b8f}\n\n/* 关键词误判警告：操作页顶部那一块，比 risk 更醒目 */\n.warn{font-size:12px;line-height:1.6;font-weight:700;color:#fff;\nbackground:#e0324f;border-radius:10px;padding:12px 14px;margin:2px 2px 8px}\n.t.dk .warn{background:#c72a44;color:#fff}\n\n/* 风险提示块 */\n.risk{font-size:12px;line-height:1.6;color:#c2334d;\nbackground:rgba(251,114,153,.09);border:1px solid rgba(251,114,153,.22);\nborder-radius:10px;padding:9px 11px;margin:4px 2px 0}\n.t.dk .risk{color:#ff8fa0;background:rgba(251,114,153,.13);border-color:rgba(251,114,153,.3)}\n.risk b{font-weight:600}\n\n/* 进度 */\n.pg{height:6px;border-radius:3px;background:var(--tg);overflow:hidden;margin:10px 2px 6px}\n.pg i{display:block;height:100%;width:0;background:#fb7299;border-radius:3px;\ntransition:width .25s ease}\n.pgn{font-size:12px;color:var(--dim);padding:0 2px;display:flex;\njustify-content:space-between;gap:8px}\n.pgn b{color:var(--tx);font-weight:600}\n\n/* 小号列表（黑名单） */\n.sc{padding:2px 2px 0}\n.sc::-webkit-scrollbar{width:6px}\n.sc::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:3px}\n.dk .sc::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2)}\n.li{display:flex;align-items:center;justify-content:space-between;gap:10px;\nfont-size:13px;color:var(--tx);padding:8px 8px;border-radius:8px}\n.li:hover{background:var(--hv)}\n.li .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.li .mid{font-size:11px;color:var(--dim);flex:none;font-variant-numeric:tabular-nums}\n\n/* 空状态 */\n.empty{font-size:12.5px;color:var(--dim);text-align:center;padding:20px 8px;line-height:1.6}\n\n/* 危险确认：主按钮换成红 */\n.btn.dg{color:#fff;background:#e0324f;border-color:#e0324f;\nbox-shadow:0 4px 14px -6px rgba(224,50,79,.8)}\n.btn.dg:hover{background:#c72a44}\n.btn.gh{background:transparent}\n\n/* 两按钮并排 */\n.f2{display:flex;gap:8px;padding:14px 2px 2px;margin-top:8px;border-top:1px solid var(--line)}\n.f2 .btn{flex:1;text-align:center;padding:0}\n";

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
  var bHost = null;
  var subHost = null, subPanel = null;     /* 自定义屏蔽词 */
  var listEl = null, inputEl = null;
  var toastHost = null, toastEl = null, toastTimer = 0;

  var actMode = 'confirm'; /* 操作页：confirm 选范围 / running 进行中 / done 完成 / danger 二次确认 */
  var actKind = '';        /* 'del' | 'block' */
  var actTargets = [];

  /*
   * 主面板当前显示哪一页。
   * 原来是「两个独立弹窗叠在同一位置，靠 display 切换」，
   * 看起来像跳转、字号也对不齐；现在改成同一个面板里左右切换。
   */
  var tab = 'set';   /* 'set' 屏蔽设置 | 'act' 删除 / 拉黑 */

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
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

  function syncTheme() {
    var dk = isDark();
    if (panel) applyTheme(panel);
    if (subPanel) applyTheme(subPanel);
    if (bBar) bBar.classList.toggle('dfy-dk', dk);
    if (toastEl) toastEl.classList.toggle('dk', dk);
    if (listEl && listEl.children) {
      for (var i = 0; i < listEl.children.length; i++) {
        listEl.children[i].classList.toggle('dk', dk);
      }
    }
  }

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

  function wordsChanged() {
    customCache = undefined;
    resetCount();
    /* 命中规则变了，已加载的评论要重新判定，否则按钮数字停在旧值 */
    rejudgePool();
    touchSettings();
    drawBanner();
  }

  /* 改了档位 / 楼中楼 / 屏蔽词之后统一走这里：落盘 + 让候选数失效 */
  function touchSettings() {
    writeOut();
    bumpPool();
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

  function ensureStyleIn(root) {
    var st = el('style');
    st.textContent = CSS;
    root.appendChild(st);
  }

  /* 提示条固定贴在「用户正在看的那个面板」上方 */
  function placeToast(anchor) {
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

    /* 先确保有布局再量尺寸：刚创建时 offsetWidth 是 0，位置会算偏 */
    void toastEl.offsetWidth;
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

  /* 保存并提示：成功才说成功 */
  function saveAndToast(alsoClose) {
    var r = save();
    var anchor = (subHost && subHost.style.display !== 'none') ? subPanel : panel;
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

    subPanel.appendChild(el('div', 'tip',
      '命中任意一个词就屏蔽（不分大小写，包含即命中），简体和繁体都会命中。所有档位都生效，' +
      MAX_WORDS + ' 个词以内。'));

    var foot = el('div', 'f');
    var ok = el('div', 'btn pri', '保存');
    ok.onclick = function () { saveAndToast(true); };
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
    if (host) host.style.display = 'none';
    subHost.style.display = 'block';
    syncFade();
    if (inputEl) { try { inputEl.focus(); } catch (e) {} }
  }

  function closeSub(back) {
    if (subHost) subHost.style.display = 'none';
    if (back !== false) openPanel();
  }

  function pick(group, id) {
    var all = group.children;
    for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i].dataset.v === id);
  }

  /* ---------- 主面板 ---------- */
  var bodyEl = null;         /* 主面板内容区，切换页签时只重画这里 */
  var navEl = null;

  function buildPanel() {
    if (panel) return;

    host = el('div');
    host.style.cssText = 'all:initial';
    var sh = host.attachShadow({ mode: 'open' });
    ensureStyleIn(sh);

    panel = el('div', 'p t');
    applyTheme(panel);

    var x = el('div', 'x', '×');
    x.title = '关闭';
    x.onclick = closePanel;
    panel.appendChild(x);

    /* 页签 */
    navEl = el('div', 'nav');
    panel.appendChild(navEl);

    bodyEl = el('div', 'bd');
    panel.appendChild(bodyEl);

    var foot = el('div', 'f');
    var ok = el('div', 'btn pri', '保存');
    ok.onclick = function () { saveAndToast(true); };
    foot.appendChild(ok);
    panel.appendChild(foot);

    sh.appendChild(panel);
    (document.body || document.documentElement).appendChild(host);
  }

  function drawNav() {
    if (!navEl) return;
    while (navEl.firstChild) navEl.removeChild(navEl.firstChild);

    var t1 = el('div', 'nv' + (tab === 'set' ? ' on' : ''), '屏蔽设置');
    t1.onclick = function () { showTab('set'); };
    navEl.appendChild(t1);

    var t2 = el('div', 'nv' + (tab === 'act' ? ' on' : ''), '删除 / 拉黑');
    t2.onclick = function () { showTab('act'); };
    navEl.appendChild(t2);
  }

  /*
   * 切页签。两个页都是画进同一个 bodyEl 里的，
   * 所以字号、宽度、返回路径都跟「屏蔽设置」完全一致 ——
   * 原来「删除 / 拉黑」是另起一个同位置的弹窗，切换像跳转，也不好返回。
   */
  function showTab(name) {
    tab = name;
    drawPanel();
  }

  function drawPanel() {
    if (!bodyEl) return;
    drawNav();
    rv = null;   /* 内容区要被清空，常驻的进度节点一并作废 */
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    if (tab === 'act') drawAct();
    else drawSettings();
  }

  function drawSettings() {
    bodyEl.appendChild(el('div', 'g', '屏蔽强度'));
    var tg = el('div');
    TIERS.forEach(function (t) {
      var o = el('div', 'o' + (config.tier === t.id ? ' on' : ''), t.label);
      o.dataset.v = t.id;
      o.onclick = function () {
        config.tier = t.id; pick(tg, t.id);
        resetCount(); rejudgePool(); touchSettings(); drawBanner();
      };
      tg.appendChild(o);
    });
    bodyEl.appendChild(tg);

    bodyEl.appendChild(el('div', 'g', '楼中楼'));
    var sg = el('div');
    SUBS.forEach(function (t) {
      var o = el('div', 'o' + (config.sub === t.id ? ' on' : ''), t.label);
      o.dataset.v = t.id;
      o.onclick = function () {
        config.sub = t.id; pick(sg, t.id);
        resetCount(); rejudgePool(); touchSettings(); drawBanner();
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
    swEl = el('div', 'sw' + (config.showCount ? ' on' : ''));
    swEl.onclick = function () {
      config.showCount = !config.showCount;
      writeOut();
      swEl.classList.toggle('on', config.showCount);
      drawBanner();
      if (config.showCount && !bannerShown()) watchMount();
      else if (!config.showCount) stopWatch();
    };
    sr.appendChild(swEl);
    bodyEl.appendChild(sr);
  }

  /* ---------- 操作页：删除 / 拉黑 ---------- */

  /*
   * 「删除 / 拉黑」这一页的重绘入口。
   * 内容画进主面板的 bodyEl —— 和「屏蔽设置」共用同一个容器，
   * 所以两边字号、宽度天然一致，也不用再来回切 display。
   */
  function drawAct() {
    drawActions(bodyEl);
  }

  /* 重画当前页（操作页内部状态变化时用） */
  function renderOp() {
    if (!bodyEl) return;
    tab = 'act';
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
    switch (actMode) {
      case 'running': return drawRunning(box);
      case 'done': return drawDone(box);
      case 'danger': return drawDanger(box);
      case 'list': return drawBlockList(box);
      case 'confirm': return drawConfirm(box);
    }
    actMode = 'confirm';
    return drawConfirm(box);
  }

  function drawConfirm(box) {
    var bodyEl = box;
    var delN = buildCandidates().length;
    var blkN = buildBlockCandidates().length;
    var lockDel = !!csrfToken();     /* 没登录就别给点 */

    /* 先摆警告：这一页所有操作都不可逆，进来第一眼就该看到 */
    bodyEl.appendChild(el('div', 'warn', WARN_TEXT));

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
      '已拉黑 ' + bookCount() + ' 人',
      null,
      '看看本地记下的黑名单，方便回头手动解除。',
      false,
      function () { actMode = 'list'; renderOp(); }
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
    actKind = kind;
    actTargets = kind === 'del' ? buildCandidates() : buildBlockCandidates();
    if (!actTargets.length) { toast('没有可操作的目标', panel); return; }
    actMode = 'danger';
    renderOp();          /* 重画的是操作页，不是主面板 */
  }

  function drawDanger(box) {
    var bodyEl = box;
    var n = actTargets.length;
    var isDel = actKind === 'del';

    bodyEl.appendChild(el('div', 'g', isDel ? '确认删除' : '确认拉黑'));

    var box = el('div');
    var p1 = el('div', 'op');
    p1.appendChild(el('div', 't1', (isDel ? '删除 ' : '拉黑 ') + n + (isDel ? ' 条评论' : ' 位用户')));
    p1.appendChild(el('div', 't2', isDel
      ? '这一步不可撤销。删完如果还想屏蔽，靠的是屏蔽规则，不是删。'
      : '拉黑立刻生效，之后你在这台账号上再也看不到这些人。'));
    box.appendChild(p1);
    bodyEl.appendChild(box);

    var rk = el('div', 'risk');
    rk.textContent = isDel
      ? '删除调用的是 B 站的真实删除接口。如果不是你自己的稿件，接口会拒绝，下面的进度里会显示失败，不会造成误删。'
      : '拉黑调用的是真实的黑名单接口，会改变你的账号关系。想撤回要去个人空间的黑名单里一个个移除。';
    bodyEl.appendChild(rk);

    var f = el('div', 'f2');
    var back = el('div', 'btn gh', '取消');
    back.onclick = function () { actMode = 'confirm'; renderOp(); };
    f.appendChild(back);
    var go = el('div', 'btn dg', isDel ? '确认删除' : '确认拉黑');
    go.onclick = function () {
      /* 面板可能搁了一夜，登录态失效了就别白跑一批（会刷风控额度） */
      csrfCache = '';
      if (!csrfToken()) { toast('登录状态失效了，刷新页面再试', panel); return; }
      if (job && job.running) { toast('已经有一个任务在跑了', panel); return; }
      actMode = 'running';
      if (!isDel) { startJob('block', actTargets); return; }
      /*
       * 删除前等一拍再开工。
       * 用户点完确认后常常紧接着就切视频，而第一枪是在点击后的下一帧就打出去的 ——
       * 那时候新页面的首屏请求还没到，currentOid 仍是旧值，比对拦不住。
       * 等等看这一小段时间里有没有发生页面切换，能挡住绝大多数误删。
       */
      toast('即将开始删除，若切走页面会自动中止', panel);
      setTimeout(function () {
        startJob('del', actTargets);
      }, DEL_START_DELAY);
    };
    f.appendChild(go);
    bodyEl.appendChild(f);
  }

  /* 进度页的常驻节点，paintRunning 只改它们，不重建 */
  var rv = null;

  function drawRunning(box) {
    var j = job;
    if (!j) return;

    rv = { kind: j.kind };
    rv.title = el('div', 'g', j.kind === 'del' ? '正在删除' : '正在拉黑');
    box.appendChild(rv.title);

    rv.pg = el('div', 'pg');
    rv.bar = el('i');
    rv.pg.appendChild(rv.bar);
    box.appendChild(rv.pg);

    rv.pn = el('div', 'pgn');
    rv.left = el('span');
    rv.right = el('b');
    rv.pn.appendChild(rv.left);
    rv.pn.appendChild(rv.right);
    box.appendChild(rv.pn);

    rv.tip = el('div', 'tip');
    box.appendChild(rv.tip);

    var rk = el('div', 'risk');
    rk.textContent = '批量操作有被限流的可能，遇到会自己等一下再试。中途可以随时停。';
    box.appendChild(rk);

    var f = el('div', 'f2');
    var st = el('div', 'btn', '停止');
    st.onclick = function () { stopJob(); };
    f.appendChild(st);
    box.appendChild(f);

    paintRunning();
  }

  /*
   * 只改数字。返回 false 表示常驻节点不在了（页面重建 / 换了任务），
   * 让调用方退回整页重画。
   */
  function paintRunning() {
    var j = job, pct;
    /*
     * 常驻节点必须还挂在 bodyEl 上才敢改。
     * 面板被关掉重开、或者换了任务类型，节点就被换掉了，直接改会改到孤儿节点。
     */
    if (!rv || !j || rv.kind !== j.kind || rv.pg.parentNode !== bodyEl) return false;
    pct = j.total ? Math.round(j.done / j.total * 100) : 0;
    rv.bar.style.width = pct + '%';
    rv.left.textContent = j.done + ' / ' + j.total;
    rv.right.textContent = '成功 ' + j.ok + ' · 失败 ' + j.fail;
    if (rv.tip.textContent !== (j.note || '')) rv.tip.textContent = j.note || '';
    return true;
  }

  function drawDone(box) {
    var bodyEl = box;
    var j = job;
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
    back.onclick = function () { actMode = 'confirm'; renderOp(); };
    f.appendChild(back);
    var cl = el('div', 'btn pri', '完成');
    cl.onclick = function () { actMode = 'confirm'; closeOp(); };
    f.appendChild(cl);
    bodyEl.appendChild(f);
  }

  function drawBlockList(box) {
    var bodyEl = box;
    var arr = bookList();

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
    back.onclick = function () { actMode = 'confirm'; renderOp(); };
    f.appendChild(back);
    var clr = el('div', 'btn gh', '清空记录');
    clr.onclick = function () {
      book = { m: {}, r: {} };
      writeBook(book);
      toast('记录已清空（不影响 B 站上的黑名单）', panel);
      renderOp();
    };
    f.appendChild(clr);
    bodyEl.appendChild(f);
  }

  /* 任务进度刷新。只有操作页开着才重画，避免无意义开销 */
  /*
   * 进度刷新。
   * 原来是每次（每条评论、每批拉黑）都整页重建：清空内容区 + 重新创建
   * 十几个节点 + shadow 里重排。删 300 条就是 300 次整页重建。
   * 现在进度页首次进入时把节点建成常驻的，之后只改 bar 宽度和两处文字。
   */
  /* 「删除 / 拉黑」这一页现在正开着吗（主面板可见 + 停在这一页） */
  function actVisible() {
    return !!(host && host.style.display !== 'none' && tab === 'act');
  }

  function updateJobUI() {
    if (!actVisible() || actMode !== 'running') return;
    if (!paintRunning()) renderOp();
  }

  function onJobEnd(j) {
    /* 面板没开着就别改成 done：用户关掉去干别的，回来应该看到候选页而不是上个任务的完成页 */
    actMode = actVisible() ? 'done' : 'confirm';
    if (actVisible()) renderOp();
    if (j.kind === 'del' && j.ok) { resetCount(); drawBanner(); }
  }

  /* 打开主面板并停到「删除 / 拉黑」这一页 */
  function openOp() {
    openPanel();
    /* 有任务在跑就停在进度页，别把用户踢回复选框 */
    actMode = (job && job.running) ? 'running' : 'confirm';
    showTab('act');
  }

  /* 从操作页回到「屏蔽设置」 */
  function closeOp() {
    showTab('set');
    openPanel();
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
    /* 三个面板位置完全重叠，从菜单进来时也必须把另外两个收起来，否则会叠在一起「关不掉」 */
    if (subHost) subHost.style.display = 'none';
    host.style.display = 'block';
    drawPanel();
  }

  function closePanel() {
    if (host) host.style.display = 'none';
  }
  /* ============ 评论区顶部：已清条数 + 操作按钮 ============ */
  /*
   * 这一条要插进 B 站自己的评论区 DOM 里。
   * 宿主元素上开了 Shadow DOM，样式写在 shadow 内部，
   * 但类名依然统一加 dfy- 前缀：B 站的全局 CSS 里没有这个概念，
   * 万一 shadow 不可用（老浏览器降级）也不会和站内样式打架。
   */
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

  /* 关键词判定的固有局限，两处都要显式告诉用户 */
  var WARN_TEXT = '本插件根据关键词屏蔽，会出现误判。谨慎使用！';

  var bDel = null, bBlk = null, bName = null;
  var bBar = null;   /* 横幅里那个 .dfy-b 元素（在 shadow 内部，主题类要加在它身上） */

  /* 插到有评论区的那个容器里，样式也得挂到同一个 root 上 */
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
    /* 个人空间的动态流：没有 bili-comments，退而求其次插在动态列表上面 */
    if (pageKind() === 'space') {
      var dyn = document.querySelector('.bili-dyn-list') || document.querySelector('.bili-dyn-item');
      if (dyn && dyn.parentNode) return { parent: dyn.parentNode, before: dyn };
    }
    return null;
  }

  function buildBanner() {
    if (bHost) return;
    bHost = el('div');
    bHost.style.cssText = 'display:block;width:100%';

    var sh = bHost.attachShadow({ mode: 'open' });
    var st = el('style');
    st.textContent = CSS + INJ_CSS;
    sh.appendChild(st);

    var bar = el('div', 'dfy-b');
    bBar = bar;
    bName = el('span', 'dfy-n');
    bar.appendChild(bName);

    /* 「已清 N 条」右边紧跟一句警告，宽度不够时自动换行到下一行 */
    var warn = el('span', 'dfy-w', WARN_TEXT);
    warn.title = WARN_TEXT;
    bar.appendChild(warn);

    var acts = el('div', 'dfy-a');
    bDel = el('span', 'dfy-btn dfy-dg', '删除');
    bDel.title = '把命中的评论真正删掉（只能删自己稿件下的）';
    bDel.onclick = function () { quickAct('del'); };
    acts.appendChild(bDel);

    bBlk = el('span', 'dfy-btn', '拉黑');
    bBlk.title = '把发这些评论的人加进黑名单';
    bBlk.onclick = function () { quickAct('block'); };
    acts.appendChild(bBlk);

    bar.appendChild(acts);
    sh.appendChild(bar);
  }


  /* 从评论区顶部按钮直接进确认页：不开主面板，少两步点击 */
  function quickAct(kind) {
    /* 任务在跑的时候，点顶部按钮只应该是「回去看进度」，不能把进度页覆盖成确认页 */
    if (job && job.running) { openOp(); return; }
    actKind = kind;
    actTargets = kind === 'del' ? buildCandidates() : buildBlockCandidates();
    if (!actTargets.length) { toast('没有可操作的目标', panel); return; }
    if (!csrfToken()) { toast('没读到登录信息，先刷新页面', panel); return; }
    actMode = 'danger';
    openPanel();
    showTab('act');
  }

  function refreshCand() {
    if (candCache.ver === poolVer) return candCache;
    candCache.ver = poolVer;
    candCache.d = buildCandidates().length;
    candCache.b = buildBlockCandidates().length;
    return candCache;
  }

  function updateBannerText() {
    if (!bName) return;
    /*
     * 先把 cookie 读完再写 DOM。反过来（写完 DOM 再读 document.cookie）
     * 会强制一次同步样式重算，实测单次成本从 3.7us 涨到 17.3us。
     * 这也是为什么 canAct 必须在所有 DOM 写之前取。
     */
    var canAct = !!csrfToken();
    var c = refreshCand();
    var dk = isDark();

    /*
     * 整条横幅的「上次画成什么样」由一个签名概括：
     * 计数、候选数、开关、登录态、主题。签名没变就一个 DOM 都不碰。
     * 原来只守卫了左半边文案，按钮的 textContent / data-off / 主题类
     * 每次 updateBannerText 都无条件重写（实测约 3.6us/次）。
     */
    var sig = stat.r + '/' + stat.s + '/' + c.d + '/' + c.b + '/' +
              (config.showCount ? 1 : 0) + (canAct ? 1 : 0) + (dk ? 1 : 0);
    if (sig === bannerCache) return;
    bannerCache = sig;

    var txt = config.showCount ? ('已清 ' + statTotal() + ' 条') : '大肥鱼工具';
    var tip = '一级评论 ' + stat.r + ' 条 · 楼中楼 ' + stat.s + ' 条';
    if (bName.textContent !== txt) bName.textContent = txt;
    if (bName.title !== tip) bName.title = tip;

    setActBtn(bDel, '删除', c.d, canAct);
    setActBtn(bBlk, '拉黑', c.b, canAct);

    /*
     * 深色主题的类必须加在 shadow 内部的 .dfy-b 上。
     * 原来加在 bHost（shadow 宿主）上，而 CSS 写的是 .dfy-b.dfy-dk ——
     * 宿主在 shadow 外面，选择器永远匹配不到，深色模式下横幅一直是浅色。
     */
    if (bBar) bBar.classList.toggle('dfy-dk', dk);
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
    return !!(bHost && bHost.isConnected && bHost.style.display !== 'none');
  }

  function drawBanner() {
    /*
     * 关掉「显示已清条数」之后，这一条就不该天天挂在评论区顶上；
     * 但只要有东西可删 / 可拉黑，还是要露出来当入口。
     */
    if (!config.showCount && !anyHit()) {
      /*
       * 藏起来而不是摘掉：bHost 里是 Shadow DOM + 十几 KB 的 CSS，
       * 一旦置空，下次有命中就要重新 attachShadow 并重新解析整份样式
       * （实测一次 ≈114us，其中绝大部分是 CSS 解析）。
       */
      if (bHost) { bHost.style.display = 'none'; bannerCache = ''; }
      return;
    }
    /*
     * 该显示。先统一把「藏起来」那个状态清掉 ——
     * 下面两条路径（还挂着 / 要重新挂）都可能碰到之前 display:none 留下的节点，
     * 只在其中一条里恢复的话，另一条就会把横幅挂上去却看不见。
     */
    if (bHost && bHost.style.display === 'none') bHost.style.display = 'block';

    if (bHost && bHost.isConnected) { updateBannerText(); return; }

    var m = findMount();
    if (!m) return;

    buildBanner();
    updateBannerText();
    if (m.before) m.parent.insertBefore(bHost, m.before);
    else m.parent.appendChild(bHost);
  }

  function anyHit() {
    var c = refreshCand();
    return !!(c.d || c.b);
  }

  var mountTimer = 0, mountTries = 0;
  var MOUNT_MS = 300;
  var MOUNT_MAX = 50;      /* 50 × 300ms = 15 秒 */

  function watchMount() {
    if (mountTimer) return;
    mountTries = 0;
    mountTimer = setTimeout(tickMount, MOUNT_MS);
  }

  function tickMount() {
    mountTimer = 0;
    if (!config.showCount && !anyHit()) return;
    if (bannerShown()) return;
    if (++mountTries > MOUNT_MAX) return;
    drawBanner();
    if (bannerShown()) return;
    mountTimer = setTimeout(tickMount, MOUNT_MS);
  }

  function stopWatch() {
    if (mountTimer) { clearTimeout(mountTimer); mountTimer = 0; }
    mountTries = 0;
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
  var dogTimer = 0;
  var DOG_MS = 2000;

  function watchDog() {
    if (dogTimer) return;
    dogTimer = setTimeout(tickDog, DOG_MS);
  }

  function tickDog() {
    dogTimer = 0;
    if (!config.showCount && !anyHit()) { watchDog(); return; }
    if (!bannerShown()) {
      mountTries = 0;          /* 重新给一次短窗口的密集重试 */
      drawBanner();
      if (!bannerShown()) watchMount();
    }
    watchDog();
  }

  function stopDog() {
    if (dogTimer) { clearTimeout(dogTimer); dogTimer = 0; }
  }

  /* ============ 拦截 ============ */
  /*
   * 原始引用要在 hook 之前抓下来：写接口必须走这一份，
   * 否则脚本自己的删除 / 拉黑请求会先被自己的钩子解析一遍。
   */
  var rawFetch = (typeof W.fetch === 'function') ? W.fetch.bind(W) : null;

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

  function hookFetch() {
    if (!rawFetch) return;
    var wrapped = function (input) {
      /*
       * url 有三种可能：字符串、Request 对象（有 .url）、URL 对象（只有 .href）。
       * 只读 .url 的话 fetch(new URL(...)) 会被当成「不是评论接口」直接放行。
       */
      var url = typeof input === 'string'
        ? input
        : (input && (input.url || input.href)) || '';
      var kind = apiKind(url);
      var promise = rawFetch.apply(this, arguments);
      if (!kind) return promise;

      var first = isFirstPageReq(url, kind);

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

          /*
           * 顺序很重要：首屏要先清掉上一轮的池子和计数，再解析这份新数据。
           * 反过来（先 filterPayload 再清）会把刚记录进去的评论一起清掉，
           * 结果就是候选数和计数永远是 0。
           * 另外「请求成功了就清」，而不是「有命中才清」——
           * 否则切到零评论 / 零命中的视频时，上一个视频的数字会残留。
           */
          if (first) { onFirstPage(); queueBanner(); }

          var r = null;
          try { r = filterPayload(json, kind); } catch (e) { return res; }
          if (first) queueBanner();
          if (!r || !r.items.length) { if (first) drawBanner(); return res; }

          var out;
          try { out = cloneRes(res, JSON.stringify(json)); }
          catch (e) { return res; }

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
        if (xhr.__dfyFirst) { onFirstPage(); queueBanner(); }
        var f = filterPayload(obj, xhr.__dfyKind);
        if (xhr.__dfyFirst) drawBanner();
        if (!f || !f.items.length) return (xhr.__dfyCache = null);
        f.isJson = isJson;
        f.obj = obj;
        f.out = isJson ? obj : JSON.stringify(obj);
        settle(f);
        r = f;
      } catch (err) { r = null; }
      return (xhr.__dfyCache = r);
    }

    var open = proto.open;
    proto.open = function (m, url) {
      this.__dfyKind = apiKind(url);
      this.__dfyFirst = isFirstPageReq(url, this.__dfyKind);
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

  /* ============ 启动 ============ */

  hookFetch();
  hookXHR();

  /* 自己的 mid：登录接口最快，失败就算了（只影响「跳过自己」这一条） */
  function fetchSelf() {
    if (!rawFetch) return;
    try {
      rawFetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var d = j && j.data;
          if (!d || !d.mid) return;
          selfMid = '' + d.mid;
          selfMidReady = true;
          /* 就绪前候选是「全部排除」的，这里把数字刷一遍 */
          bumpPool();
          queueBanner();
          if (actVisible() && actMode === 'confirm') renderOp();
        })['catch'](function () {});
    } catch (e) {}
  }

  function boot() {
    watchTheme();
    watchDog();
    fetchSelf();
    /* 关掉计数时也要插，只是没有命中就不显示 —— 露不露由 drawBanner 自己判断 */
    drawBanner();
    if (!bannerShown()) watchMount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  /* Esc 关闭面板：二级页 / 操作页开着就先关它们 */
  try {
    (W.addEventListener ? W : document).addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.keyCode !== 27) return;
      if (subHost && subHost.style.display !== 'none') { closeSub(true); return; }
      if (actVisible()) { closeOp(); return; }
      closePanel();
    }, true);
  } catch (e) {}

  if (typeof GM_registerMenuCommand === 'function') {
    try { GM_registerMenuCommand('设置', openPanel); } catch (e) {}
  }

})();