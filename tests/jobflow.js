'use strict';
const { makeEnv } = require('./harness.js');

// 用一个可控的 fetch 桩，模拟真实删除 / 拉黑接口，跑完整任务生命周期
function makeStubFetch(spec) {
  return function (url, init) {
    const u = String(url);
    const body = (init && init.body) || '';
    let code = 0;
    if (u.indexOf('/x/v2/reply/del') !== -1) {
      const m = /rpid=([^&]*)/.exec(body);
      const rpid = m ? decodeURIComponent(m[1]) : '';
      code = (spec.del && spec.del[rpid] !== undefined) ? spec.del[rpid] : 0;
    } else if (u.indexOf('/x/relation/batch/modify') !== -1) {
      code = spec.block === undefined ? 0 : spec.block;
    }
    return Promise.resolve({
      ok: true, status: 200,
      text: function () { return Promise.resolve(JSON.stringify({ code: code, message: code === 0 ? '0' : 'err', data: spec.blockData || null })); },
      json: function () { return Promise.resolve({ code: code, data: spec.blockData || {} }); }
    });
  };
}

async function run(name, spec, kind, targets, expect) {
  const w = makeEnv({ fetch: makeStubFetch(spec) });
  const T = w.__t;
  T.setSelf(1);
  T.resetCount();
  const j = T.startJob(kind, targets);
  // 等任务收尾
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, 5));
    if (!j.running) break;
  }
  const got = { running: j.running, ok: j.ok, fail: j.fail, note: j.note, done: j.done };
  const pass = got.running === false &&
    got.ok === expect.ok && got.fail === expect.fail;
  console.log((pass ? 'ok   ' : 'FAIL ') + name + '  -> ' + JSON.stringify(got));
  return pass;
}

(async function () {
  let allPass = true;
  const delTargets = [
    { rpid: '1', oid: '9', type: '1', mid: '11', name: 'a' },
    { rpid: '2', oid: '9', type: '1', mid: '12', name: 'b' },
    { rpid: '3', oid: '9', type: '1', mid: '13', name: 'c' }
  ];
  allPass &= await run('删除 3 条全成功', {}, 'del', delTargets, { ok: 3, fail: 0 });
  allPass &= await run('删除 2 成功 1 失败(12006)', { del: { '2': 12006 } }, 'del', delTargets, { ok: 2, fail: 1 });
  allPass &= await run('删除遇到 -403 立即收工', { del: { '1': -403 } }, 'del', delTargets, { ok: 0, fail: 1 });

  const blockTargets = [
    { mid: '201', name: 'u201' }, { mid: '202', name: 'u202' },
    { mid: '201', name: 'u201' }
  ];
  allPass &= await run('拉黑 2 人（去重）', { blockData: { failed_fids: [] } }, 'block', blockTargets, { ok: 2, fail: 0 });
  allPass &= await run('拉黑部分失败', { blockData: { failed_fids: [202] } }, 'block', blockTargets, { ok: 1, fail: 1 });

  console.log(allPass ? '\nALL JOB FLOWS PASS' : '\nSOME JOB FLOWS FAILED');
  process.exit(allPass ? 0 : 1);
})();
