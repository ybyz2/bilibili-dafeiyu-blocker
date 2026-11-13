'use strict';
const { makeEnv } = require('./harness.js');
let pass = true;
function ok(n, c, extra) { if (!c) { pass = false; console.log('FAIL ' + n + (extra !== undefined ? ' | ' + extra : '')); } else console.log('ok   ' + n); }

// 只统计删除接口的调用次数（boot 阶段 /nav 也会走同一个 fetch 桩）
async function scenario(name, codes, expectCode) {
  let n = 0;
  const w = makeEnv({ fetch: function (u) {
    if (String(u).indexOf('/x/v2/reply/del') === -1) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: 0, data: {} }), text: () => Promise.resolve('{"code":0}') });
    }
    const code = codes[n] !== undefined ? codes[n] : 0;
    n++;
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ code })) });
  } });
  const r = await w.__t.delReply('9', '1', '1');
  ok(name, r.code === expectCode, 'code=' + r.code + ' 删除请求=' + n);
  return n;
}

(async function () {
  const n1 = await scenario('-509 一次后成功', [-509, 0], 0);
  ok('重试 1 次（共 2 次删除请求）', n1 === 2, n1);
  const n2 = await scenario('-352 不重试', [-352, 0], -352);
  ok('-352 只发 1 次', n2 === 1, n2);
  const n3 = await scenario('-403 不重试', [-403, 0], -403);
  ok('-403 只发 1 次', n3 === 1, n3);
  const n4 = await scenario('持续 -509 打满上限', [-509, -509, -509, -509, 0], -509);
  ok('上限 = 1 + RETRY_MAX 次', n4 === 4, n4);
  console.log(pass ? '\nRETRY OK' : '\nRETRY FAIL');
  process.exit(pass ? 0 : 1);
})();
