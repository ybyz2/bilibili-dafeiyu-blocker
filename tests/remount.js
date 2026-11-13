'use strict';
const { makeEnv, makeEl } = require('./harness.js');
function makeMount() {
  const parent = makeEl('div');
  const feed = makeEl('div');
  parent.appendChild(feed);
  const shadow = makeEl('#shadow');
  const comments = makeEl('bili-comments');
  comments.shadowRoot = shadow;
  shadow.querySelector = function (sel) { return sel === '#feed' ? feed : null; };
  return { comments, feed, parent };
}
let pass = true;
function ok(n, c, extra) { if (!c) { pass = false; console.log('FAIL ' + n + (extra !== undefined ? ' | ' + extra : '')); } else console.log('ok   ' + n); }
const w = makeEnv({ mount: makeMount() });
const T = w.__t;
T.setSelf(1); T.resetCount();
T.config.showCount = false;
T.drawBanner();                 // 无命中 -> 不建
ok('无命中不建横幅', T.debugBanner() === null || !T.debugBanner().shown, JSON.stringify(T.debugBanner()));
T.filterPayload({ data: { replies: [{ rpid: 1, oid: 9, type: 1, mid: 11, member: { mid: 11, uname: 'a' }, content: { message: '大肥鱼' } }] } }, 1);
T.drawBanner();
ok('有命中建出来', T.debugBanner() && T.debugBanner().shown);
// 模拟 B 站把 #feed 整块重建，把 bHost 一起摘掉
const host = T.bannerHost();
host.isConnected = false;
T.drawBanner();
const b = T.debugBanner();
ok('摘掉后能重新挂上并且可见', b && b.shown, JSON.stringify(b));
console.log(pass ? '\nREMOUNT OK' : '\nREMOUNT FAIL');
process.exit(pass ? 0 : 1);
