# 实现说明（v1.5.0）

面向改代码的人。用户向的安装 / 使用说明在 [README.md](README.md)。

## 一、文件

| 文件 | 说明 |
|---|---|
| `dafeiyu.user.js` | 全部实现。单文件、零构建、零依赖，改完直接覆盖就能测 |
| `README.md` | 用户向文档 |
| `tests/` | 本地回归用例（不进仓库），用 Node 的 `vm` 把脚本原样加载进假 DOM，调的是线上真跑的那份代码 |

## 二、分层

单个 IIFE 内部按职责分 6 层，靠命名空间和分节注释体现，不是打包产物。

```
L5 启动      把各层接起来：注入回调、装页面钩子、跑第一帧
L4 界面      主面板 / 二级页 / 横幅 / toast，三块 Shadow DOM
L3 副作用    网络（写接口）、执行器（任务）、拦截（fetch / XHR）
L2 服务      判定 / 过滤 / 候选集 / 设置变更，只返回纯数据
L1 状态      7 个对象持有全部可变状态
L0 纯逻辑    纯函数与常量
```

**依赖单向：L5 → L4 → L3 → L2 → L1 → L0。** 下层不认识上层。唯一的反向通路是 L1 的变更回调
（`Ledger.onChange` / `Settings.onChange` / `CounterSink.setHandlers` / `Job.bind`），
由 L5 在启动时注入。所以状态层完全不知道 UI 的存在。

边界是实测过的：L0–L3 区间只有一处 `document`，是 `Me` 读 cookie；没有一处引用 `UI` / `UIState`。

## 三、模块

### L0 `Pure`

纯函数与常量，不碰 DOM / 网络 / storage / 全局状态。

| 内容 | 说明 |
|---|---|
| `TIMING` `LIMITS` `DEFAULT_CONFIG` `BLOCK_BATCH` | 全部魔数 |
| `S2T` / `expandWord` / `buildWordsRe` / `escapeRe` | 简繁展开与正则构建 |
| `RE_NAME` `RE_BRAND` `RE_CHAR` `RE_QUOTE` `RE_KILLP` `RE_AT` | 判定正则 |
| `isBlocked(reply, ctx)` | 判定内核 |
| `apiKind` `isFirstPageReq` | URL 分类与首屏判定 |
| `explain` `shouldRetry` `isFatal` | 错误码 |
| `normalizeConfig` `cleanWords` `addWord` | 数据整形 |

### L1 状态（7 个对象）

字段只在各自方法里改，外部读走查询、写走 set / mark。

| 模块 | 职责 | 主要 API |
|---|---|---|
| `Store` | storage 读写，全脚本唯一一处 try/catch 包 storage | `readConf` `writeConf` `readBook` `writeBook` |
| `Config` | tier / sub / showCount / showActs / words | `set` `save` `saveAndVerify` + 各字段查询 |
| `Pool` | 评论池、环形游标、rpid 索引、失效版本号 | `add` `find` `reset` `bump` `markHit` `markPinned` `rejudge` `items` `length` `ver` |
| `Page` | 稿件上下文：oid / 代数 gen / UP 主 / 置顶集合 | `setOid` `gen` `setUpper` `addPinned` `isPinned` `reset` |
| `Ledger` | 账本（拉黑表 m / 删除表 r） | `addMids` `markDeleted` `flush` `prune` `list` `hasMid` `isDeleted` `clear` `onChange` |
| `Counter` | 已清计数 + 去重表 | `state` `total` `reset` `add` `mark` |
| `Me` | 自己的 mid / csrf | `mid` `ready` `token` |

### L2 服务

不发请求、不碰 DOM，返回值都是纯数据。

| 模块 | 职责 |
|---|---|
| `Judge` | 给纯函数接上当前配置：判定上下文、自定义屏蔽词 / 用户名的正则三态缓存 |
| `Filter` | `payload(json, kind)` 改接口数据 + 记池子，是「数据进页面」的核心 |
| `Candidates` | 删除 / 拉黑候选集，带版本号缓存 |
| `CounterSink` | 计数提交，通过注入的回调触发重画 |
| `Settings` | 改档位 / 楼中楼 / 屏蔽词 / 屏蔽用户名的统一入口 |
| `Lifecycle` | 首屏、换稿件 |

### L3 副作用

| 模块 | 职责 |
|---|---|
| `Net` | `rawFetch`（钩子之前的原始引用）、`postForm`、`postWithRetry`、`delReply`、`batchBlock`、`fetchSelf` |
| `Job` | 任务执行器，`current` 生命周期完整，对外只有 `start` / `stop` / `snapshot` |
| `Hooks` | `hookFetch` / `hookXHR` |

### L4 界面 / L5 启动

界面状态集中在 `UIState` 一个对象（三块宿主、面板节点、`tab` `actMode` `rv` `bannerSig`）。
L5 做三件事：注入回调、装页面钩子（`pagehide` / `visibilitychange` / `Esc`）、跑首帧。

## 四、拦截：评论为什么不会闪

屏蔽发生在**接口数据层**，评论从未进入渲染队列。

```
fetch / XHR → clone 响应 → JSON.parse → Filter.payload → 改过的 JSON 塞回去
```

- `hookFetch`：`res.clone()` 必须用 try 包住 —— body 已消费（302 跟随过）时 `clone()` 是**同步抛**，
  外层 `.catch` 挂在 `then` 内部救不了，逃逸出去会让页面的 `fetch()` reject。
- `hookXHR`：`responseText` / `response` 是只读原型属性，只能在实例上挂 getter。
  **必须挂在 `send()` 而不是 `readystatechange`** —— 否则依赖监听器注册顺序，
  页面比我们早注册就读到原始数据（评论没删掉，数字却涨了）。
- 写请求走 `rawFetch`，否则会被自己的钩子拦一遍。
- `apiKind` 认 4 种：`main` / `wbi/main` / `reply?` / `reply/reply`；`del` `add` `action` `report` 一律放行。
- 首屏判定：新版用 `pagination_str={"offset":""}`，旧版用 `next=0` / `pn=1`。

## 五、判定优先级

`Pure.isBlocked(reply, ctx)`，命中即返回：

| 顺序 | 规则 | 作用档位 |
|---|---|---|
| 0 | 自定义屏蔽用户名、账号名含「肥鱼」 | 全部（只看名字） |
| 1 | 自定义屏蔽词 | 全部 |
| 3 | `@` | 到此为止（atonly） |
| 4 | 品牌词（大肥鱼 / 肥鱼 / 鲸鱼 / 大肥鲸 / 鲸鱼娘 / 本鲸 / 本鱼 / 本肥鱼 / 主人） | cup 以上 |
| 5 | `@` | 到此为止（cup） |
| 6 | 单字 `鱼` / `鲸` | 到此为止（standard） |
| 7 | 全角标点 / 破折号 / 直角引号 | kill |

`@` 必须真的圈到人：`RE_AT` 要求 `@` 前不是 `\w.+-`、后跟像人名的字符，
所以 `12345@qq.com` 这类裸 `@` 不算。判 `@` 前会先剥掉 B站自动拼的「回复 @xxx :」前缀。

**账号名有意只认「肥鱼」**：它优先级最高（命中就不看档位），宁可窄。名字只有「鲸」的靠正文兜底。

## 六、简繁

不做文本转换，把字扩成字符类：`/鱼/` → `/[鱼魚]/`。`S2T_RAW = '鱼魚鲸鯨'`，
只收真有繁体写法的字，编码 `<简><繁>`，多繁体用 `~` 接。

**局限**：表里没有的字，自定义词只按原字匹配。所以输入简体「测试」不会被繁体「測試」命中；反向也不会。

## 七、状态设计要点

**`Pool.ver()` 是唯一失效版本号。** 池子内容、命中标记、账本、自己 mid 任何变化都走 `bump()`。
缓存忘失效的代价从「数字过期」变成「多算一次」，方向安全。

**池满用环形覆盖而非 shift**：shift 对 2 万元素是 O(n) 搬移，而这在滚动热路径上。池子因此无序，但下游候选集都是纯筛选。

**`Page.gen()` 稿件代数。** 每次首屏加一，任务在点确认时记下代数并按此比对。比 oid 可靠 —— 切到评论区为空的稿件时，新页面根本没有 oid 可比。

**账本攒批落盘。** `markDeleted` / `addMids` 只改内存 + 置 dirty，由 `flush` 合并成一次写
（任务收尾、`pagehide`、`visibilitychange`）。瘦身按「本次会话写入顺序」淘汰，均摊 O(1)；
只有账本刚从盘里读出来、还没有顺序表时才整表排序重建。

## 八、执行器

一次只跑一个任务，随时可停，停止检查在两条之间。

| 参数 | 值 |
|---|---|
| `delGap` | 350ms |
| `blockGap` | 260ms |
| `retryMax` | 3（只对 `-509`） |
| `blockBatch` | 50 人 / 批 |
| 确认后延迟 | 500ms |

**`-352` 不重试**：风控黑名单级别，重试间隔会让 100 条的目标空转十几分钟。
**`pump` 必须 try/finally**：中途抛异常会让 `j.running` 永远为 true，之后 `start` 的守卫一直返回这个僵尸 job。

## 九、容量

| 常量 | 值 | 理由 |
|---|---|---|
| `POOL_CAP` | 20000 | 候选集能回溯多远，约 9.8MB 堆 |
| `BOOK_DEL_CAP` | 20000 | 删除表必须 ≥ 池子，否则删满一池刷新后会重复处理 |
| `BOOK_MID_CAP` | 3000 | 拉黑表存名字，用户会回头查 |
| `COUNT_CAP` | 50000 | 计数去重表 |
| `words` | 1000 | 自定义屏蔽词个数 |
| `names` | 1000 | 自定义屏蔽用户名个数 |
| `wordLen` | 24 | 单个条目字数（词与用户名共用） |

## 十、配置

键 `dafeiyu.config.v2`（从 1.2 起没变，老用户无缝升级），账本键 `dafeiyu.book.v1`。

```js
{
  tier: 'standard',   // cup | standard | kill | atonly
  sub: 'only',        // only | whole | none
  showCount: true,    // 评论区顶部显示「已清 N 条」
  showActs: false,    // 横幅右侧（误判提醒 + 删除 / 拉黑按钮）
  words: [],          // 自定义屏蔽词
  names: []           // 自定义屏蔽用户名（包含即命中，所有档位生效）
}
```

**白名单必须用 `hasOwnProperty`**：普通对象继承 `Object.prototype`，
`VALID_TIER['constructor']` 是真值 —— tier 写成 `'constructor'` 会通过校验，而所有档位分支都落空。

## 十一、界面要点

三块 Shadow DOM 互不影响：`host`（主面板）、`subHost`（屏蔽词二级页）、`bHost`（横幅）。

- **横幅右侧默认收起**（`showActs`）。收起用 `display:none` 而非摘节点 —— 摘了再插要重走 Shadow DOM 布局，
  而且 `bDel` / `bBlk` 的置灰状态、签名守卫还引用着它们。
- **`updateBannerText` 签名守卫**：计数 / 候选数 / 两个开关 / 登录态 / 主题全没变就一个 DOM 都不碰。
  并且先把 `document.cookie` 读完再写 DOM —— 反过来会强制一次同步样式重算（约 3.7us → 17us）。
- **横幅频繁被摘**：B站重建 `#feed` 会连横幅一起摘掉，所以有 `watchMount`（300ms × 50）和 `watchDog`（2 秒常驻）两条重挂路径。
- 深色主题类必须加在 shadow 内部的 `.dfy-b` 上，加在宿主上选择器匹配不到。

## 十二、测试

```sh
sh tests/run-all.sh
```

| 文件 | 覆盖 |
|---|---|
| `regress2.js` | 判定、过滤、计数、候选集、环形缓冲、脏配置 |
| `refactor15.js` | 分层约束（Pure 不碰 DOM/storage、无 console、版本号）+ 各层联通 |
| `jobflow.js` | 任务完整生命周期 |
| `edge.js` | 脏账本、脏配置、写盘失败、畸形数据 |
| `tabs.js` `banner2.js` `banneracts.js` `remount.js` | 页签、横幅显隐、右侧开关、重挂 |
| `hooks.js` `persist.js` `retry.js` `countcap.js` `caps.js` | 钩子、账本持久化、重试、上限 |

`tests/probe.js` 注入到 IIFE 尾部，把内部函数挂到 `W.__t`，用例直接调真函数。新增用例需要新内部函数时在这里加一行。

> 假 DOM 不是真浏览器：布局、样式重算、Shadow DOM 的真实行为测不到，只能人肉看。

## 十三、改代码容易踩的坑

1. **转义顺序**：`buildWordsRe` 必须先转义再繁体展开，反了会把展开出的 `[ ]` 转义掉。
2. **首屏顺序**：`Lifecycle.onFirstPage()` 必须在 `Filter.payload()` 之前跑，反了候选数和计数永远是 0。
3. **环形游标归零**：`Pool.reset()` 里 head 要归零，否则游标会落在本轮没写过的槽位，把 seen 里还在用的索引删掉。
4. **整页滤空要标 is_end**：只标 `is_end`，**不要动 `next`** —— 改 next 会破坏 B站自己的翻页偏移。
5. **置顶要跨页持久**：`top_replies` 只在第一页有，置顶评论会重复出现在 `replies` 里，集合必须挂在 `Page` 上。
6. **改容量常量同步跑 `caps.js`**：删除表比池子小会导致「删完刷新又冒出来」。
7. **加 `@grant` 要同时改 `Store` 的分支**，否则会静默回落到 localStorage。
8. **不要在 L0–L3 里碰 DOM**，也不要在 L2 里直接调 L4 —— 用 `onChange` 注入。
