'use strict';
// 三个容量上限的实际值，以及它们之间必须成立的约束。
// 改上限时先跑这个 —— 池子和删除账本脱钩会导致「删完刷新又冒出来」。
const { makeEnv } = require('./harness.js');
let pass = true;
function ok(n, c, extra) {
  if (!c) { pass = false; console.log('FAIL ' + n + (extra !== undefined ? ' | ' + extra : '')); }
  else console.log('ok   ' + n);
}
const T = makeEnv().__t;
const caps = T.caps();
console.log('实际上限：', JSON.stringify(caps));
console.log('');

ok('池子 = 20000', caps.pool === 20000, caps.pool);
ok('删除账本 = 20000', caps.bookDel === 20000, caps.bookDel);
ok('拉黑账本 = 3000', caps.bookMid === 3000, caps.bookMid);
ok('计数去重表 = 50000', caps.count === 50000, caps.count);

// 核心约束：删满一整池子，账本必须一条不少地记住
// 否则刷新后这批评论重新进候选，再删一次 = 白烧风控额度
ok('删除账本 >= 池子', caps.bookDel >= caps.pool, caps.bookDel + ' vs ' + caps.pool);

T.setSelf(1);
T.resetCount();
for (let i = 0; i < caps.pool; i++) T.markDeleted('88' + (100000000 + i));
T.pruneBook();
ok('满池记录全部保住', T.deletedCount() === caps.pool, T.deletedCount() + ' / ' + caps.pool);

// 拉黑表独立，不受删除表影响
for (let i = 0; i < caps.bookMid + 500; i++) T.addBook(['mid' + i], {});
T.pruneBook();
ok('拉黑表按自己的上限裁', T.bookCount() === caps.bookMid, T.bookCount());
ok('裁拉黑表不影响删除表', T.deletedCount() === caps.pool, T.deletedCount());

// 池子确实按新上限工作
T.onFirstPage();
for (let i = 0; i < caps.pool + 500; i++) {
  T.intoPool({ rpid: '99' + (200000000 + i), mid: 5, member: { uname: 'x' }, content: { message: '正常' } });
}
ok('池子按新上限截断', T.pool().length === caps.pool, T.pool().length);

console.log(pass ? '\nCAPS OK' : '\nCAPS FAIL');
process.exit(pass ? 0 : 1);
