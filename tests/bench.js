'use strict';
// 性能基线：报告里的数字就是它跑出来的。用法 node tests/bench.js
const path = require('path');
const { makeEnv } = require('./harness.js');

function mkReply(i) {
  return {
    rpid: 1000000 + i, oid: 555, type: 1, mid: 200000 + (i % 3000),
    member: { mid: 200000 + (i % 3000), uname: '用户' + i },
    content: { message: i % 8 === 0 ? '大肥鱼出没' : ('普通评论内容，长度大概三十个字左右，编号' + i) },
    rcount: 2,
    replies: [
      { rpid: 2000000 + i * 2, oid: 555, type: 1, mid: 300000, member: { mid: 300000, uname: 'a' }, content: { message: '正常回复' }, rcount: 0 },
      { rpid: 2000000 + i * 2 + 1, oid: 555, type: 1, mid: 300001, member: { mid: 300001, uname: 'b' }, content: { message: '正常回复2' }, rcount: 0 }
    ]
  };
}
const TXT = [];
for (let p = 0; p < 250; p++) {
  const rs = [];
  for (let i = 0; i < 20; i++) rs.push(mkReply(p * 20 + i));
  TXT.push(JSON.stringify({ data: { replies: rs, cursor: { is_end: false }, upper: { mid: 777 } } }));
}
function best(fn, n) {
  let m = Infinity;
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    fn();
    const d = Number(process.hrtime.bigint() - t) / 1e6;
    if (d < m) m = d;
  }
  return m;
}
function bench(fn, iters, reps) {
  let m = Infinity;
  for (let r = 0; r < (reps || 5); r++) {
    fn();
    const t = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const d = Number(process.hrtime.bigint() - t) / iters / 1000;
    if (d < m) m = d;
  }
  return m;
}
const w = makeEnv();
const T = w.__t;
T.setSelf(1);
const total = best(function () {
  T.resetCount(); T.onFirstPage(); T.setSelf(1);
  for (let p = 0; p < 250; p++) {
    const o = JSON.parse(TXT[p]);
    const r = T.filterPayload(o, 1);
    if (r) T.settle(r);
    T.drawBanner();
  }
}, 12);
const rr = { rpid: 42, oid: 1, type: 1, mid: 9, member: { uname: 'x' }, content: { message: '普通评论内容' } };
const rows = [
  ['250 页完整链路', total.toFixed(2) + ' ms', (total / 250 * 1000).toFixed(1) + ' us/页'],
  ['pool / 已清计数', T.pool().length + ' 条', T.stat.r + ' 一级 / ' + T.stat.s + ' 楼中楼'],
  ['rejudgePool（切档位）', bench(function () { T.rejudgePool(); }, 30).toFixed(1) + ' us', ''],
  ['refreshCand 强制重算', bench(function () { T.wordsChanged(); T.refreshCand(); }, 60).toFixed(1) + ' us', ''],
  ['buildCandidates', bench(function () { T.buildCandidates(); }, 400).toFixed(1) + ' us', ''],
  ['buildBlockCandidates', bench(function () { T.buildBlockCandidates(); }, 400).toFixed(1) + ' us', ''],
  ['isBlocked standard', (bench(function () { T.isBlocked(rr, 'standard'); }, 200000) * 1000).toFixed(0) + ' ns', ''],
  ['isBlocked kill', (bench(function () { T.isBlocked(rr, 'kill'); }, 200000) * 1000).toFixed(0) + ' ns', ''],
  ['drawBanner（无变化）', bench(function () { T.drawBanner(); }, 5000).toFixed(2) + ' us', '']
];
for (const r of rows) console.log(r[0].padEnd(22) + String(r[1]).padStart(12) + '   ' + r[2]);
