'use strict';
const { makeEnv } = require('./harness.js');
let pass = true;
function ok(n, c, extra) { if (!c) { pass = false; console.log('FAIL ' + n + (extra !== undefined ? ' | ' + extra : '')); } else console.log('ok   ' + n); }

// 1. fetch(new URL(...)) 应该被识别成评论接口
{
  const calls = [];
  const w = makeEnv({ fetch: function (u) { calls.push(String(u)); return Promise.resolve({ ok: true, status: 200 }); } });
  const T = w.__t;
  const u = new URL('https://api.bilibili.com/x/v2/reply?pn=1&type=1&oid=9');
  ok('URL 对象被识别', T.apiKind(u) === 1, u.href);
  ok('Request 被识别', T.apiKind({ url: 'https://api.bilibili.com/x/v2/reply?pn=1&oid=9&type=1' }) === 1);
}

// 2. 自己的写请求不会被自己的钩子二次解析
{
  const seen = [];
  const w = makeEnv({ fetch: function (u, init) {
    seen.push(String(u));
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"code":0}'), clone() { return this; } });
  } });
  const T = w.__t;
  T.setSelf(1);
  ok('del 接口不被拦截', T.apiKind('https://api.bilibili.com/x/v2/reply/del') === 0);
  ok('batch/modify 不被拦截', T.apiKind('https://api.bilibili.com/x/relation/batch/modify') === 0);
}

// 3. 空输入不崩
{
  const w = makeEnv();
  const T = w.__t;
  ok('null url', T.apiKind(null) === 0);
  ok('undefined url', T.apiKind(undefined) === 0);
  ok('数字 url', T.apiKind(12345) === 0);
  ok('对象无 url', T.apiKind({}) === 0);
}

// 4. isFirstPageReq
{
  const w = makeEnv();
  const T = w.__t;
  ok('楼中楼永远不是首屏', T.isFirstPageReq('https://api.bilibili.com/x/v2/reply/reply?pn=1', 2) === false);
  ok('非评论接口', T.isFirstPageReq('https://api.bilibili.com/x/v2/reply/del', 0) === false);
  ok('wbi 非首屏', T.isFirstPageReq('https://api.bilibili.com/x/v2/reply/wbi/main?pagination_str=%7B%22offset%22%3A%22abc%22%7D', 1) === false);
  ok('next=0 首屏', T.isFirstPageReq('https://api.bilibili.com/x/v2/reply?next=0&type=1', 1) === true);
  ok('next=20 非首屏', T.isFirstPageReq('https://api.bilibili.com/x/v2/reply?next=20&type=1', 1) === false);
  ok('无翻页参数按首屏', T.isFirstPageReq('https://api.bilibili.com/x/v2/reply/main?oid=1&type=1', 1) === true);
}

console.log(pass ? '\nHOOKS OK' : '\nHOOKS FAIL');
process.exit(pass ? 0 : 1);
