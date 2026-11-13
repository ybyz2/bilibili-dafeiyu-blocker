'use strict';
const { makeEnv } = require('./harness.js');

// 账本脏数据：直接写进 storage，验证加载后不崩
const dirty = { m: { '111': null, '222': { n: 'ok', t: 5 }, '333': 'string' }, r: { '444': null, '555': 123 } };
const w = makeEnv({ store: { 'dafeiyu.book.v1': JSON.stringify(dirty) } });
const T = w.__t;
let pass = true;
function t(name, fn) {
  try { const v = fn(); console.log((v ? 'ok   ' : 'FAIL ') + name + ' -> ' + JSON.stringify(v)); if (!v) pass = false; }
  catch (e) { console.log('FAIL ' + name + ' THREW ' + e.message); pass = false; }
}
t('脏账本 pruneBook 不抛', () => { T.pruneBook(); return true; });
t('脏账本 超上限 pruneBook 排序不崩', () => {
  const big = { m: {}, r: {} };
  for (let i = 0; i < 3100; i++) big.m['k' + i] = (i % 3 === 0) ? null : { n: 'x' + i, t: i };
  const ww = makeEnv({ store: { 'dafeiyu.book.v1': JSON.stringify(big) } });
  ww.__t.pruneBook();
  return ww.__t.bookCount() === 3000;
});
t('脏账本 bookList 不抛', () => T.bookList().length === 3);
t('脏账本 bookCount', () => T.bookCount() === 3);
t('脏账本 flushBook 不抛', () => { T.flushBook(); return true; });
t('脏条目被清洗成对象', () => { const l = T.bookList(); return l.every(x => typeof x.name === 'string'); });

// 配置脏数据
const badCfg = { tier: 'constructor', sub: '__proto__', showCount: 'yes', words: 'nope' };
const w2 = makeEnv({ store: { 'dafeiyu.config.v2': JSON.stringify(badCfg) } });
t('脏配置 tier 回落', () => w2.__t.config.tier === 'standard');
t('脏配置 sub 回落', () => w2.__t.config.sub === 'only');
t('脏配置 showCount 回落', () => w2.__t.config.showCount === true);
t('脏配置 words 回落', () => Array.isArray(w2.__t.config.words) && w2.__t.config.words.length === 0);

// 存储写失败（配额满）不崩
const w3 = makeEnv({ gmSetFail: true });
t('写盘失败 save 返回错误', () => { const r = w3.__t.save(); return r.ok === false && !!r.msg; });
t('写盘失败 flushBook 不抛', () => { w3.__t.markDeleted('77'); w3.__t.flushBook(); return true; });

// 接口返回奇形怪状
const w4 = makeEnv(); const T4 = w4.__t; T4.setSelf(1);
t('null json 不崩', () => T4.filterPayload(null, 1) === null);
t('空 data 不崩', () => T4.filterPayload({}, 1) === null);
t('replies 非数组不崩', () => { try { T4.filterPayload({ data: { replies: 'x' } }, 1); return true; } catch (e) { return false; } });
t('rpid=0 不进池', () => { const before = T4.pool().length; T4.intoPool({ rpid: 0, mid: 1 }); return T4.pool().length === before; });
t('rpid=null 不进池', () => { const before = T4.pool().length; T4.intoPool({ rpid: null, mid: 1 }); return T4.pool().length === before; });
t('无 member 不崩', () => { try { T4.isBlocked({ content: { message: 'x' } }, 'kill'); return true; } catch (e) { return false; } });

console.log(pass ? '\nALL EDGE PASS' : '\nEDGE FAILURES');
process.exit(pass ? 0 : 1);
