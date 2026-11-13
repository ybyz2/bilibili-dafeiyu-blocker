'use strict';
const { makeEnv } = require('./harness.js');
let pass = true;
function ok(n, c, extra) { if (!c) { pass = false; console.log('FAIL ' + n + (extra !== undefined ? ' | ' + extra : '')); } else console.log('ok   ' + n); }
function mk(rpid, msg) {
  return { rpid, oid: 9, type: 1, mid: 11, member: { mid: 11, uname: 'a' }, content: { message: msg || '大肥鱼' } };
}
// 第一轮：删一条，落盘
const w1 = makeEnv();
const T1 = w1.__t;
T1.setSelf(1); T1.resetCount();
T1.filterPayload({ data: { replies: [mk(1), mk(2), mk(3)] } }, 1);
ok('首轮候选 3', (T1.buildCandidates?T1.buildCandidates().length:-1) === 3, (T1.buildCandidates?T1.buildCandidates().length:-1));
T1.markDeleted('1');
T1.flushBook();
const persisted = w1.__store['dafeiyu.book.v1'];
ok('落盘包含 rpid=1', !!persisted && persisted.indexOf('"1"') !== -1, persisted);

// 第二轮：同一份 storage，模拟刷新页面
const w2 = makeEnv({ store: { 'dafeiyu.book.v1': persisted } });
const T2 = w2.__t;
T2.setSelf(1); T2.resetCount();
T2.filterPayload({ data: { replies: [mk(1), mk(2), mk(3)] } }, 1);
const c2 = T2.buildCandidates();
ok('刷新后已删的仍被排除', c2.length === 2 && c2.every(x => x.rpid !== '1'), JSON.stringify(c2.map(x => x.rpid)));

console.log(pass ? '\nPERSIST OK' : '\nPERSIST FAIL');
process.exit(pass ? 0 : 1);
