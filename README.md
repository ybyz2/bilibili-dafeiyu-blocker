# 屏蔽大肥鱼

<a href="https://github.com/ybyz2/bilibili-dafeiyu-blocker/releases/latest"><img alt="version" src="https://img.shields.io/github/v/release/ybyz2/bilibili-dafeiyu-blocker?style=flat-square"></a> <a href="https://github.com/ybyz2/bilibili-dafeiyu-blocker/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/ybyz2/bilibili-dafeiyu-blocker?style=flat-square"></a> <a href="https://github.com/ybyz2/bilibili-dafeiyu-blocker/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/ybyz2/bilibili-dafeiyu-blocker?style=flat-square"></a>

屏蔽 B站评论区里「大肥鱼」这类 AI 人格账号的油猴脚本。简体和繁体都能识别，另外可以顺手把命中的评论删掉、把发言的人拉黑。

## 安装

### 1. 装脚本管理器

| 浏览器 | 推荐 | 备选 |
|---|---|---|
| Chrome / Edge | [篡改猴 Tampermonkey](https://www.tampermonkey.net/) | [脚本猫 ScriptCat](https://docs.scriptcat.org/)、[暴力猴 Violentmonkey](https://violentmonkey.github.io/) |
| Firefox | [篡改猴 Tampermonkey](https://www.tampermonkey.net/) | [暴力猴 Violentmonkey](https://violentmonkey.github.io/) |

### 2. 允许脚本运行

**Chrome / Edge 138 及以上必须做，否则脚本管理器里所有脚本都不执行。**

右键脚本管理器图标 → 管理扩展程序 → 打开「允许运行用户脚本」（没有这项就打开「开发者模式」）→ 重启浏览器。

Firefox 不用设置。

### 3. 装脚本

[点击安装大肥鱼屏蔽脚本](https://raw.githubusercontent.com/ybyz2/bilibili-dafeiyu-blocker/main/dafeiyu.user.js)

国内打不开 GitHub 的话，用 [jsDelivr 镜像](https://cdn.jsdelivr.net/gh/ybyz2/bilibili-dafeiyu-blocker@main/dafeiyu.user.js)。

也可以手动装：下载 [dafeiyu.user.js](https://github.com/ybyz2/bilibili-dafeiyu-blocker/blob/main/dafeiyu.user.js)，在脚本管理器里新建脚本，粘贴全文，Ctrl+S 保存。

装好自动生效。

## 使用

点浏览器工具栏的脚本管理器图标 → **屏蔽大肥鱼** → **设置**。面板从右上角弹出，点 × 或按 Esc 关闭。

面板顶部有两个页签：**屏蔽设置** 和 **删除 / 拉黑**，点一下就在原地切换，不会另开窗口。

改完立即生效。已加载的评论不会回溯，刷新后新设置才完全生效。

### 屏蔽强度

| 档位 | 规则 |
|---|---|
| 小杯 | 账号名含 `肥鱼`，或评论含 `大肥鱼` `肥鱼` `鲸鱼` `本鲸` `本鱼` `主人` |
| **标准**（默认） | 小杯 + 所有 `@某人` |
| 杀戮 | 标准 + 单字 `鱼` `鲸` + 全角标点 `：` `；` + 破折号 `——` + 直角引号 `「` `」` |
| 只屏蔽 @ | 只看有没有 `@某人` |

「@」必须真的圈到人（`@` 后面跟着名字）才算命中。`qq邮箱`、`12345@qq.com` 这类正文里的裸 `@` 不会被当成 @ 别人。

杀戮档会删掉大量正常评论，连「评论区全是肥鱼」这种吐槽也一起删，还会屏蔽真人发的 @。觉得删太多就换回标准。

### 简繁通吃

所有判定词（账号名、品牌词、单字、自定义屏蔽词）都同时匹配简体与繁体写法：

- `大肥鱼` / `大肥魚` / `肥魚` / `鯨魚` / `本鯨` / `鲸鱼娘` / `鯨魚娘` 都会命中
- 只看词，不做文本转换，所以不会误伤正常繁体评论

### 楼中楼

| 档位 | 主楼命中 | 主楼没命中、楼中楼命中 |
|---|---|---|
| **只删楼中楼**（默认） | 整楼删除 | 只删命中的楼中楼，其余保留 |
| 整楼删除 | 整楼删除 | 整楼删除 |
| 不管楼中楼 | 整楼删除 | 楼中楼原样保留 |

「只删楼中楼」会出现空楼：主楼还在，点开回复是空的。想避免就用「整楼删除」。

### 自定义屏蔽词

设置里点「编辑屏蔽词…」，输入一个词后回车或点「确定」，它就会以气泡显示；点气泡上的 × 删除。

命中的评论会被删掉，所有档位都生效，不分大小写，包含即命中，同样简繁通吃。最多 100 个词。

### 已清条数

打开后，在发评论的输入框和第一条评论之间显示 `已清 N 条`，紧跟着是「删除 / 拉黑」两个按钮和一句误判提醒。可以关掉。

数字的含义是「当前这份评论列表里，被删掉的评论有多少条」，鼠标悬停能看一级评论和楼中楼各多少条。所以：

- 往下滚动加载更多，数字跟着变大；切换「最热 / 最新」时数字会归零重算，不会继续累加
- 同一页来回滚动、反复展开楼中楼不会重复计数
- 主楼被整楼删掉时，它下面的楼中楼按 B站给的 `rcount` 计数（接口只返回前 2~3 条预览，用预览数会少算）

关掉之后，这一条只在真有东西可删或可拉黑的时候才出现，不会再天天挂在评论区顶上。

## 删除评论 / 拉黑用户

面板页签切到 **删除 / 拉黑**，或者直接点评论区顶上那一行的「删除 / 拉黑」按钮。

这一页顶部有一条红底的提醒：**本插件根据关键词屏蔽，会出现误判。谨慎使用！** 删除和拉黑都不可逆，看清楚再点。

**先看清这一条：**

- **删除**是直接调用 B站的真实删除接口。它只能删**自己稿件下**评论区里的评论；不是自己的稿件，接口会立刻拒绝，进度里会显示失败，**不会误删**。删掉的评论没法恢复。

### 过程

1. 点条目 → 弹出二次确认，写明这次要处理多少条 / 多少人
2. 确认后显示进度条、成功数、失败数，随时可以停
3. 删除每条之间间隔 0.35 秒；拉黑走批量接口，一次最多 50 人
4. 遇到限流（`-509`）会自动退避重试；遇到「没权限」「没登录」会立刻停下，不会连环失败
5. 遇到 `-352`（强风控）也是立刻停，不硬刚——它基本不可能在一次任务里恢复，重试只会让进度条空转，还多烧风控额度

拉黑过的人会记在本地，在「已拉黑 N 人」里能看到，方便回头去 B站解除。

本地会记住最近 2 万条「已删除」和 3000 个「已拉黑」，下次打开不会重复处理。想清空就在操作页里点「清空记录」（不影响 B站上的黑名单）。

## 几个要点

- **置顶评论始终保留**，包括 UP 主置顶。
- **跟随 B站夜间模式**（`<html class="dark">`），不是跟随系统。
- **无闪烁**：删除发生在接口返回数据的那一刻，评论从未进入页面。

## 兼容性

| | |
|---|---|
| 浏览器 | Chrome / Edge 105+，Firefox 121+ |
| 脚本管理器 | [篡改猴](https://www.tampermonkey.net/)、[脚本猫](https://docs.scriptcat.org/)、[暴力猴](https://violentmonkey.github.io/) |
| 手机浏览器 | 不支持，只适配 PC 版网页 |

## 不生效时

1. 「允许运行用户脚本」开关开了吗？Chrome / Edge 138+ 必做，大部分问题都在这
2. 打开 B站，按 F12，控制台输入 `window.__dfy`，返回 `1` 说明脚本在跑
3. 域名必须是 `www.bilibili.com`、`t.bilibili.com` 或 `space.bilibili.com`
4. 脚本管理器里确认脚本是启用状态
5. 删除 / 拉黑点不动：多半是没读到登录信息（`bili_jct`），刷新页面确认已登录

还是不行的话，去 [Issues](https://github.com/ybyz2/bilibili-dafeiyu-blocker/issues) 反馈，附上浏览器版本和 F12 控制台的报错。

## 开发

脚本本身没有构建步骤，改完直接覆盖 `dafeiyu.user.js` 就能测。

回归用例用 Node 自带的 `vm` 把脚本原样加载进一个假 DOM，直接调用它的内部函数，测的是线上真正跑的那份代码，不是另写一份逻辑。零依赖，需要 Node 18+。

```sh
sh tests/run-all.sh
```

单独跑某一个：`node tests/tabs.js`

| 文件 | 覆盖 |
|---|---|
| `regress2.js` | 判定规则、过滤、计数、候选集、池子环形缓冲、脏配置 |
| `jobflow.js` | 删除 / 拉黑任务的完整生命周期 |
| `edge.js` | 脏账本、脏配置、写盘失败、畸形接口数据 |
| `tabs.js` | 两个页签原地切换、面板结构、误判警告 |
| `banner2.js` / `remount.js` | 横幅显隐、被 B站摘掉后重新挂上 |
| `hooks.js` | `apiKind` / `isFirstPageReq` 对三种入参 |
| `persist.js` | 删除账本跨刷新仍然生效 |
| `retry.js` | `-509` 退避重试、`-352` 立刻停 |
| `countcap.js` / `caps.js` | 计数上限、各容量上限之间的一致性 |
| `bench.js` | 性能基线（不是用例，改动前后对比用） |

> 假 DOM 不是真浏览器：布局、样式重算、Shadow DOM 的真实行为都测不到，这几项只能人肉在真页面上看。

## 许可

[MIT](https://github.com/ybyz2/bilibili-dafeiyu-blocker/blob/main/LICENSE)
