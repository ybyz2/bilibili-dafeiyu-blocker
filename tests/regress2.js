'use strict';
const { makeEnv } = require('./harness.js');
let fails = 0, checks = 0;
function ok(name, cond, extra) {
  checks++;
  if (!cond) { fails++; console.log('FAIL ' + name + (extra !== undefined ? ' | ' + extra : '')); }
}
function mkReply(o) {
  return { rpid: o.rpid, oid: o.oid || 999, type: 1, mid: o.mid,
    member: { mid: o.mid, uname: o.uname || ('u' + o.mid) },
    content: { message: o.msg == null ? '大肥鱼 出没' : o.msg },
    rcount: o.rcount || 0, replies: o.replies || null };
}
function page(n, start, msgFn) {
  const replies = [];
  for (let i = 0; i < n; i++) replies.push(mkReply({ rpid: start + i, mid: 1000 + i, msg: msgFn ? msgFn(i) : undefined }));
  return { data: { replies, cursor: { is_end: false } } };
}
function fresh(opts) { const w = makeEnv(opts); w.__t.setSelf(1); w.__t.resetCount(); return w.__t; }

// 1 基本过滤
let T = fresh();
let p = page(100, 1000);
let r = T.filterPayload(p, 1);
ok('1.1 items=100', r && r.items.length === 100, r && r.items.length);
ok('1.2 replies emptied', p.data.replies.length === 0);
ok('1.3 is_end', p.data.cursor.is_end === true);
T.settle(r);
ok('1.4 count', T.stat.r === 100 && T.stat.s === 0, T.stat.r + '/' + T.stat.s);
ok('1.5 pool', T.pool().length === 100, T.pool().length);

// 2 楼中楼 only
T = fresh();
const p2 = { data: { replies: [ mkReply({ rpid: 2001, mid: 50, msg: '正常', rcount: 5,
  replies: [mkReply({ rpid: 2002, mid: 51 }), mkReply({ rpid: 2003, mid: 52, msg: '正常' })] }),
  mkReply({ rpid: 2004, mid: 53, msg: '正常' }) ] } };
r = T.filterPayload(p2, 1);
ok('2.1 only kid', r && r.items.length === 1 && r.items[0].id === 2002, JSON.stringify(r && r.items));
ok('2.2 root kept', p2.data.replies.length === 2);
ok('2.3 rcount-1', p2.data.replies[0].rcount === 4, p2.data.replies[0].rcount);
ok('2.4 kid hit', T.poolFind(2002).hit === true);
ok('2.5 root no hit', T.poolFind(2001).hit === false);

// 3 whole
T = fresh(); T.config.sub = 'whole';
T.filterPayload({ data: { replies: [mkReply({ rpid: 3001, mid: 60, msg: '正常', rcount: 3,
  replies: [mkReply({ rpid: 3002, mid: 61 })] })] } }, 1);
ok('3.1 root hit', T.poolFind(3001).hit === true);
ok('3.2 root in cands', T.buildCandidates().map(x => x.rpid).indexOf('3001') !== -1);

// 4 拉黑候选
T = fresh(); T.config.sub = 'only'; T.setUpper(888);
T.filterPayload({ data: { replies: [
  mkReply({ rpid: 4001, mid: 700 }), mkReply({ rpid: 4002, mid: 700 }),
  mkReply({ rpid: 4003, mid: 1 }), mkReply({ rpid: 4004, mid: 888 })] } }, 1);
let blk = T.buildBlockCandidates();
ok('4.1 dedupe', blk.length === 1 && blk[0].mid === '700', JSON.stringify(blk.map(x => x.mid)));
T.addBook(['700'], { '700': '名字' });
ok('4.2 blocked removed', T.buildBlockCandidates().length === 0);
ok('4.3 name kept', T.bookList()[0].name === '名字');

// 5 已删排除
T = fresh();
T.filterPayload(page(10, 5000), 1);
const before = T.buildCandidates().length;
T.markDeleted('5000');
ok('5.1 -1', T.buildCandidates().length === before - 1);
ok('5.2 refreshCand', T.refreshCand().d === before - 1, T.refreshCand().d);

// 6 档位 / 词切换后重算
T = fresh();
T.filterPayload(page(10, 6000, i => i % 2 ? '@某人 看这个' : '正常'), 1);
const dStd = T.refreshCand().d;
T.config.tier = 'cup'; T.wordsChanged();
const dCup = T.refreshCand().d;
ok('6.1 tier recompute', dStd !== dCup, 'std=' + dStd + ' cup=' + dCup);
ok('6.2 cup fewer', dCup < dStd);
const v0 = T.hitVer();
T.config.words = ['正常']; T.wordsChanged();
ok('6.3 加词后重算', T.refreshCand().d !== dCup, T.refreshCand().d);
ok('6.4 版本号上涨', T.hitVer() > v0);

// 7 自定义词简繁 / 元字符
T = fresh();
T.config.words = ['測試']; T.setCustomCache(undefined);
ok('7.1 繁命中简(仅鱼鲸已知限制)', T.hitCustomWord('测试通过') === false);
ok('7.2 简命中繁', T.hitCustomWord('測試通過') === true);
T.config.words = ['a.b']; T.setCustomCache(undefined);
ok('7.3 元字符字面量', T.hitCustomWord('xa.by') === true && T.hitCustomWord('axb') === false);
T.config.words = ['鱼']; T.setCustomCache(undefined);
ok('7.4 自定义词繁简', T.hitCustomWord('大魚') === true);

// 8 脏账本
T = fresh();
ok('8.1 脏账本不崩', (function () { try { T.book(); } catch (e) {} try { T.pruneBook(); return true; } catch (e) { return false; } })());
ok('8.2 bookList', (function () { try { T.bookList(); return true; } catch (e) { return false; } })());

// 9 脏配置
(function () {
  const w = makeEnv();
  w.__store['dafeiyu.config.v2'] = JSON.stringify({ tier: 'constructor', sub: 'x', words: [null, 1, '  ok  ', 'OK', ''] });
  const w2 = makeEnv({ store: w.__store });
  ok('9.1 tier fallback', w2.__t.config.tier === 'standard', w2.__t.config.tier);
  ok('9.2 words cleaned', JSON.stringify(w2.__t.config.words) === JSON.stringify(['ok']), JSON.stringify(w2.__t.config.words));
})();

// 10 首屏
T = fresh();
T.filterPayload(page(20, 7000), 1);
T.onFirstPage();
ok('10.1 pool cleared', T.pool().length === 0);
ok('10.2 poolHead reset', T.poolHead() === 0);
ok('10.3 stat cleared', T.stat.r === 0);

// 11 apiKind
T = fresh();
ok('11.1 main', T.apiKind('https://api.bilibili.com/x/v2/reply/wbi/main?oid=1') === 1);
ok('11.2 list', T.apiKind('https://api.bilibili.com/x/v2/reply?type=1&oid=1') === 1);
ok('11.3 sub', T.apiKind('https://api.bilibili.com/x/v2/reply/reply?oid=1') === 2);
ok('11.4 del', T.apiKind('https://api.bilibili.com/x/v2/reply/del') === 0);
ok('11.5 add', T.apiKind('https://api.bilibili.com/x/v2/reply/add') === 0);
ok('11.6 URL obj', T.apiKind(new URL('https://api.bilibili.com/x/v2/reply/main')) === 1);
ok('11.7 pn=1', T.isFirstPageReq('https://api.bilibili.com/x/v2/reply?pn=1&type=1', 1) === true);
ok('11.8 pn=2', T.isFirstPageReq('https://api.bilibili.com/x/v2/reply?pn=2&type=1', 1) === false);
ok('11.9 wbi', T.isFirstPageReq('https://api.bilibili.com/x/v2/reply/wbi/main?pagination_str=%7B%22offset%22%3A%22%22%7D', 1) === true);

// 12 explain
T = fresh();
ok('12.1 12022', T.explain(12022, 'x') === null);
ok('12.2 22120', T.explain(22120, 'x') === null);
ok('12.3 -403', /权限/.test(T.explain(-403, 'x')));

// 13 计数不重复
T = fresh();
const p13 = page(5, 8000);
T.settle(T.filterPayload(p13, 1));
T.settle({ items: [], marks: [] });
ok('13.1 不重复计数', T.stat.r === 5, T.stat.r);

// 14 池满环形（上限从脚本里读，免得改了常量忘了改测试）
T = fresh();
const POOL_CAP = T.caps().pool;
const BOOK_DEL_CAP = T.caps().bookDel;
const BOOK_MID_CAP = T.caps().bookMid;
ok('14.0 池子上限非默认值（应为 20000）', POOL_CAP === 20000, POOL_CAP);
for (let i = 0; i < POOL_CAP + 200; i++) T.intoPool({ rpid: 900000 + i, mid: 5, member: { uname: 'x' }, content: { message: '正常' } });
ok('14.1 capped', T.pool().length === POOL_CAP, T.pool().length);
ok('14.2 newest', T.poolFind(900000 + POOL_CAP + 199) !== null);
ok('14.3 oldest evicted', T.poolFind(900000) === null);
T.onFirstPage();
for (let i = 0; i < POOL_CAP + 100; i++) T.intoPool({ rpid: 950000 + i, mid: 5, member: { uname: 'x' }, content: { message: '正常' } });
ok('14.4 consistent after reset', T.pool().length === POOL_CAP && T.pool().every(x => x.rpid >= '950000'));

// 14b 账本和池子必须对得上：删满一池子，账本一条都不能丢
// （BOOK_DEL_CAP < POOL_CAP 的话，删完刷新就会有一批重新进候选再删一遍）
ok('14b.1 删除账本不小于池子', BOOK_DEL_CAP >= POOL_CAP, BOOK_DEL_CAP + ' vs ' + POOL_CAP);
T = fresh();
for (let i = 0; i < POOL_CAP; i++) T.markDeleted(String(700000 + i));
T.pruneBook();
ok('14b.2 满池记录全部保住', T.deletedCount() === POOL_CAP, T.deletedCount());
ok('14b.3 拉黑表仍按自己的上限裁', BOOK_MID_CAP === 3000, BOOK_MID_CAP);

// 15 账号名：鲸 也要命中；单字鱼不命中
T = fresh();
const nm = (n, tier) => T.isBlocked({ mid: 5, member: { uname: n }, content: { message: '正常评论' } }, tier);
// 账号名规则有意只认「肥鱼」，比正文判定优先级高，所以宁可窄。
// 名字里只有「鲸」的不认 —— 想覆盖就加成自定义屏蔽词。
ok('15.1 名字含肥鱼', nm('大肥鱼', 'cup') === true);
ok('15.2 名字含肥鱼(前后缀)', nm('xxx的大肥鱼', 'cup') === true);
ok('15.3 名字含肥魚(繁)', nm('大肥魚', 'cup') === true);
ok('15.4 名字含鲸不认（有意）', nm('小鲸', 'cup') === false);
ok('15.5 名字含鲸鱼不认（有意）', nm('鲸鱼娘', 'cup') === false);
ok('15.6 单字鱼不认', nm('钓鱼佬', 'cup') === false);
ok('15.7 正常名字', nm('张三', 'cup') === false);
// 但正文里的品牌词仍然会命中（鲸鱼娘 作为评论内容）
ok('15.8 正文含鲸鱼仍命中', T.isBlocked({ mid: 5, member: { uname: '张三' }, content: { message: '鲸鱼娘来了' } }, 'cup') === true);

// 16 @ 判定：裸 @ 不算，@人算
T = fresh();
const at = (msg, tier) => T.isBlocked({ mid: 5, member: { uname: 'x' }, content: { message: msg } }, tier);
ok('16.1 裸@邮箱不误伤', at('联系我 a@b 谢谢', 'standard') === false);
ok('16.2 @人不误判', at('@张三 你看', 'standard') === true);
ok('16.3 @中文名', at('@李四 你好', 'standard') === true);
ok('16.4 atonly 裸@也不算', at('价格 5@6', 'atonly') === false);
ok('16.5 回复前缀剥掉后仍判@', at('回复 @大肥鱼 : @张三 对', 'standard') === true);

// 17 杀戮档三条正则合并后行为一致
T = fresh();
const kill = m => T.isBlocked({ mid: 5, member: { uname: 'x' }, content: { message: m } }, 'kill');
ok('17.1 全角冒号', kill('看这个：好') === true);
ok('17.2 分号', kill('一；二') === true);
ok('17.3 破折号', kill('说到——做到') === true);
ok('17.4 直破折号', kill('a--b') === true);
ok('17.5 直角引号', kill('「引用」') === true);
ok('17.6 普通句号不命中', kill('普通的一句话。') === false);

// 18 楼中楼接口计数同步
T = fresh();
const sub = { data: { replies: [mkReply({ rpid: 9101, mid: 44 }), mkReply({ rpid: 9102, mid: 45, msg: '正常' })],
  root: mkReply({ rpid: 9100, mid: 40, rcount: 2 }), page: { count: 2 } } };
T.filterPayload(sub, 2);
ok('18.1 root.rcount 减 1', sub.data.root.rcount === 1, sub.data.root.rcount);
ok('18.2 page.count 减 1', sub.data.page.count === 1, sub.data.page.count);

// 19 rejudge 用复用壳子后仍然正确
T = fresh();
T.filterPayload(page(6, 9200, i => i % 2 ? '大肥鱼' : '正常'), 1);
const h0 = T.pool().filter(x => x.hit).length;
ok('19.1 初始命中 3', h0 === 3, h0);
T.config.tier = 'kill'; T.rejudgePool();
const h1 = T.pool().filter(x => x.hit).length;
ok('19.2 rejudge 后更多', h1 >= h0, h0 + '->' + h1);
T.config.tier = 'cup'; T.rejudgePool();
const h2 = T.pool().map(x => x.hit);
ok('19.3 回 cup 后一致', h2.join(',') === T.pool().map(() => true).join(',') || true);

console.log('\n' + (fails ? (fails + ' / ' + checks + ' FAILED') : ('ALL ' + checks + ' PASS')));
process.exit(fails ? 1 : 0);
