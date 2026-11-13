'use strict';
// 去重表（COUNT_CAP）满了之后，计数必须继续涨，不能永久冻住
const { makeEnv } = require('./harness.js');
const T = makeEnv().__t;
T.setSelf(1);
T.resetCount();
function bulk(start, n) {
  const items = [];
  for (let i = 0; i < n; i++) items.push({ id: String(start + i), r: 1, s: 0 });
  return { items: items, marks: null };
}
let pass = true;
function ok(n, c, extra) { if (!c) { pass = false; console.log('FAIL ' + n + (extra !== undefined ? ' | ' + extra : '')); } else console.log('ok   ' + n); }
T.settle(bulk(1, 60000));
const capped = T.stat.r;
ok('越过上限后计数正常', capped === 60000, capped);
T.settle({ items: [{ id: 'overflow-1', r: 1, s: 0 }], marks: null });
ok('上限之后仍在累加', T.stat.r === 60001, T.stat.r);
T.settle({ items: [{ id: 'overflow-2', r: 5, s: 3 }], marks: ['mark-1'] });
ok('一级 + 楼中楼都继续累加', T.stat.r === 60006 && T.stat.s === 3, T.stat.r + '/' + T.stat.s);
console.log(pass ? '\nCOUNT CAP OK' : '\nCOUNT CAP FAIL');
process.exit(pass ? 0 : 1);
