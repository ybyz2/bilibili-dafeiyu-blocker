# 屏蔽大肥鱼

屏蔽 B站评论区里「大肥鱼」这类 AI 人格账号的油猴脚本。

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

装好自动生效，页面上不会多出按钮。

## 使用

点浏览器工具栏的脚本管理器图标 → **屏蔽大肥鱼** → **设置**。面板从右上角弹出，点 × 或按 Esc 关闭。

改完立即保存。已加载的评论不会回溯，刷新页面后新设置才完全生效。

### 屏蔽强度

| 档位 | 规则 |
|---|---|
| 小杯 | 账号名含「鱼」或「鲸」，或评论含 `大肥鱼` `肥鱼` `鲸鱼` `本鲸` `本鱼` `主人` |
| **标准**（默认） | 小杯 + 所有 `@` |
| 杀戮 | 标准 + 单字 `鱼` `鲸` + 全角标点 `：` `；` + 破折号 `——` |
| 只屏蔽 @ | 只看有没有 `@` |

杀戮档会删掉大量正常评论，连「评论区全是肥鱼」这种吐槽也一起删，还会屏蔽真人发的 @。觉得删太多就换回标准。

### 楼中楼

| 档位 | 主楼命中 | 主楼没命中、楼中楼命中 |
|---|---|---|
| **只删楼中楼**（默认） | 整楼删除 | 只删命中的楼中楼，其余保留 |
| 整楼删除 | 整楼删除 | 整楼删除 |
| 不管楼中楼 | 整楼删除 | 楼中楼原样保留 |

「只删楼中楼」会出现空楼：主楼还在，点开回复是空的。想避免就用「整楼删除」。

### 已清条数

打开后，在发评论的输入框和第一条评论之间显示一行 `已清 N 条`。可以关掉。

## 几个要点

- **账号名含「鱼」或「鲸」的评论，所有档位一律屏蔽。** 这条最准，大肥鱼账号部署后几乎都会改名成 `xxx的大肥鱼`，正常用户不会这样起名。
- **楼中楼的 `回复 @某某某 :` 是 B站自动拼的前缀，不是用户写的。** 判断 `@` 时会先剥掉它，否则被回复的人名字带鱼，整条回复都会被误删。关键词判定仍然看完整原文。
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

还是不行的话，去 [Issues](https://github.com/ybyz2/bilibili-dafeiyu-blocker/issues) 反馈，附上浏览器版本和 F12 控制台的报错。

## 许可

[MIT](https://github.com/ybyz2/bilibili-dafeiyu-blocker/blob/main/LICENSE)
