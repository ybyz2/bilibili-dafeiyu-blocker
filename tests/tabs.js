'use strict';
// 「屏蔽设置」和「删除 / 拉黑」必须是同一个面板里左右切换，
// 不是另起一个弹窗 —— 否则字号对不齐、也不好返回。
const { makeEnv, makeEl } = require('./harness.js');
function makeMount() {
  const parent = makeEl('div'); const feed = makeEl('div');
  parent.appendChild(feed);
  const shadow = makeEl('#shadow'); const comments = makeEl('bili-comments');
  comments.shadowRoot = shadow;
  shadow.querySelector = function (s) { return s === '#feed' ? feed : null; };
  return { comments: comments, feed: feed, parent: parent };
}
let pass = true;
function ok(n, c, extra) {
  if (!c) { pass = false; console.log('FAIL ' + n + (extra !== undefined ? ' | ' + extra : '')); }
  else console.log('ok   ' + n);
}
function textOf(n) {
  if (!n) return '';
  let s = n.textContent || '';
  (n.children || []).forEach(function (c) { s += textOf(c); });
  return s;
}
const w = makeEnv({ cookie: 'bili_jct=ABC123', mount: makeMount() });
const T = w.__t;
T.setSelf(1); T.resetCount();
T.filterPayload({ data: { replies: [
  { rpid: 1, oid: 9, type: 1, mid: 11, member: { mid: 11, uname: '大肥鱼' }, content: { message: '大肥鱼' }, rcount: 0, replies: [] }
] } }, 1);

// 1 默认在设置页
T.openPanelPublic();
ok('1.1 默认停在设置页', T.tab() === 'set', T.tab());
ok('1.2 页签有两个', T.navText().length === 2, JSON.stringify(T.navText()));
ok('1.3 设置页内容出来', textOf(T.bodyNode()).indexOf('屏蔽强度') >= 0);

// 2 切到删除 / 拉黑
T.openOpPublic();
ok('2.1 切到 act', T.tab() === 'act', T.tab());
ok('2.2 面板仍然可见', T.panelVisible());
ok('2.3 同一份页签（没有新弹窗）', T.navText().length === 2, JSON.stringify(T.navText()));
const body = textOf(T.bodyNode());
ok('2.4 出现删除条目', body.indexOf('删除命中的评论') >= 0);
ok('2.5 出现拉黑条目', body.indexOf('拉黑发言者') >= 0);

// 3 警告必须在这一页
ok('3.1 顶部有误判警告', body.indexOf('本插件根据关键词屏蔽，会出现误判。谨慎使用！') >= 0);
ok('3.2 警告在最前面', body.indexOf('误判') < body.indexOf('删除评论'));

// 4 已删掉的文案不该再出现
ok('4.1 没有「拉黑是真的拉黑」', body.indexOf('拉黑是真的拉黑') < 0);

// 5 切回设置
T.showTabPublic('set');
ok('5.1 切回 set', T.tab() === 'set');
ok('5.2 设置内容回来', textOf(T.bodyNode()).indexOf('屏蔽强度') >= 0);
ok('5.3 操作内容清掉了', textOf(T.bodyNode()).indexOf('删除命中的评论') < 0);

// 5b 面板结构：内容区可滚，页签/按钮不滚
T.openPanelPublic();
const panel = T.panelNode();
ok('5b.1 内容区带 bd 类', T.bodyNode().className === 'bd', T.bodyNode().className);
ok('5b.2 内容区是面板直接子节点', T.bodyNode().parentNode === panel);
const kids = panel.children.map(function (c) { return c.className; });
ok('5b.3 面板结构 x/nav/bd/f', JSON.stringify(kids) === JSON.stringify(['x', 'nav', 'bd', 'f']), JSON.stringify(kids));

// 6 横幅：已清 → 警告 → 按钮，顺序和位置
T.drawBanner();
const bar = T.bannerHost().shadowRoot.children.filter(function (c) {
  return String(c.className).indexOf('dfy-b') >= 0;
})[0];
ok('6.1 横幅里找得到条', !!bar);
if (bar) {
  const kids = bar.children.map(function (c) { return String(c.className).split(' ')[0]; });
  ok('6.2 顺序：数字 → 警告 → 按钮', JSON.stringify(kids) === JSON.stringify(['dfy-n', 'dfy-w', 'dfy-a']), JSON.stringify(kids));
  ok('6.3 警告文案对', bar.children[1].textContent === '本插件根据关键词屏蔽，会出现误判。谨慎使用！', bar.children[1].textContent);
  ok('6.4 靠左排（不再被推到最右）', T.bannerJustify() === 'flex-start', T.bannerJustify());
  ok('6.5 按钮还在', bar.children[2].children.length === 2, bar.children[2].children.length);
}

console.log(pass ? '\nTABS OK' : '\nTABS FAIL');
process.exit(pass ? 0 : 1);
