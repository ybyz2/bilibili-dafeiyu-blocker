'use strict';
const { makeEnv, makeEl } = require('./harness.js');
function makeMount() {
  const feedParent = makeEl('div');
  const feed = makeEl('div');
  feedParent.appendChild(feed);
  const shadow = makeEl('#shadow');
  const comments = makeEl('bili-comments');
  comments.shadowRoot = shadow;
  shadow.querySelector = function (sel) { return sel === '#feed' ? feed : null; };
  return { comments, feed, parent: feedParent };
}
let pass = true;
function ok(n, c, extra) { if (!c) { pass = false; console.log('FAIL ' + n + (extra !== undefined ? ' | ' + extra : '')); } else console.log('ok   ' + n); }

// 场景：把「显示已清条数」关掉，且没有任何命中 -> 横幅应隐藏但 DOM 保留；
// 之后出现命中 -> 徽标要重新显示出来（且不重建 shadow）
const w = makeEnv({ mount: makeMount() });
const T = w.__t;
T.setSelf(1); T.resetCount();
T.config.showCount = true;
T.drawBanner();
let b1 = T.debugBanner();
ok('初始显示', b1 && b1.shown, JSON.stringify(b1));

T.config.showCount = false;
T.drawBanner();
let b2 = T.debugBanner();
ok('关计数且无命中 -> 隐藏', b2 && !b2.shown, JSON.stringify(b2));
ok('隐藏时节点仍保留（不重建）', !!b2);

// 造命中
T.filterPayload({ data: { replies: [
  { rpid: 1, oid: 9, type: 1, mid: 11, member: { mid: 11, uname: 'a' }, content: { message: '大肥鱼' } }
] } }, 1);
T.drawBanner();
let b3 = T.debugBanner();
ok('有命中 -> 重新显示', b3 && b3.shown, JSON.stringify(b3));

// 关掉 showCount 但有命中，横幅文案应该是「大肥鱼工具」而不是「已清 N 条」
ok('关计数时文案不带条数', b3 && !/已清/.test(b3.text || ''), b3 && b3.text);

// 同内容重复 drawBanner 不应该改 DOM（签名守卫）
T.drawBanner();
const t1 = T.debugBanner().text;
T.drawBanner();
const t2 = T.debugBanner().text;
ok('重复 drawBanner 稳定', t1 === t2);

console.log(pass ? '\nBANNER2 OK' : '\nBANNER2 FAIL');
process.exit(pass ? 0 : 1);
