# CROSSYROAD

## 项目结构
- `src/engine.mjs`: 纯核心。地图生成、碰撞、得分、机器人、诊断摘要。
- `src/render.mjs`: 只把快照画成平色整数矩形，不做任何业务判断。
- `src/main.mjs`: 浏览器壳。输入、循环、DOM 文案、存档、诊断出口。
- `scripts/verify.mjs`: 快闸门。零依赖，守纯核心、结构不变量、义务、PNG 解码器、Pages 守卫、心跳提交信息、三条变异体。
- `scripts/verify-web.mjs`: 浏览器闸门。真起页面，对账 canvas 像素、摘要、PNG 与 canvas 同帧。
- `scripts/png.mjs`: 零依赖 PNG 解码器 + 比较器 + 夹具编码器。zlib 是 Node 自带。
- `scripts/pages-check.mjs`: 部署后的正向核对。纯函数部分给快闸门拿样本验，CLI 部分给 Pages workflow 调。
- `scripts/compose-report.mjs`: 合成评论。回写 workflow 会拉它，不 checkout 整仓。
- `heartbeat.json`: 定时链路的正向痕迹。
- `docs/obligations.json`: 带期限的义务。宽限期内报剩余天数，过期判红。

## 命令
- `npm run verify`: 快闸门，必须保持零依赖和秒级反馈。
- `npm run verify:web`: 浏览器闸门，真起页面 + Playwright。
- `npm run serve`: 本地静态服务器。
- `npm run report`: 在下载下来的 reports 目录上合成评论正文。
- 改完必须跑闸门。先绿再合，别把用户当 CI。

## 关键不变量
- 纯核心不碰 DOM、存储、网络、系统时间、未播种随机。
- `src/engine.mjs` 不许 import：变异体从 data URL 加载它，import 会让自证路径直接死掉。
- 渲染只画平色整数矩形，不许描边、渐变、半透明、canvas 文字。
- 文字只进 DOM，不进 canvas。像素等号断言靠这条活着。
- canvas 保持 1:1 像素，不做 devicePixelRatio 缩放。
- `window.__diag` 的字段名只能加不能改。`stepWith` 不能删,`press` 只设 pending，`advance` 不消费它，没它输入注入不进去。
- 量像素之前必须先 `setPaused(true)`，而且冻结与 reset、advance 要在**同一次** evaluate 里：分两次往返会让一帧 rAF 溢进来。
- PNG 解码器不许静默降级：位深 / 色彩类型 / 隔行 / CRC 不对一律抛错。一个尽力而为的解码器会把逐像素等号变成近似。
- Pages 守卫的判定逻辑必须待在 `scripts/pages-check.mjs` 里，不许退回成 workflow 里的行内 grep：写在 YAML 里的那种离线触发不了，也就永远不会被观察到红。锥子至少两个。
- 心跳提交信息必须从 `$EVENT` 派生，提交命令里不许出现字面量。它已经说过一次谎（手动跑却写「定时闸门跑过了」）。
- 回写 workflow 固定用 `supercubegame/ci-workflows/.github/workflows/report.yml@main`。
- 有 `| tee` 的脚本段必须同段开 `set -o pipefail`。
- Pages 只能挂 `main`：`github-pages` 环境默认只允许默认分支部署。
- 心跳只在 `schedule` 或显式手动请求时写，防自触发靠结构，不靠提交信息。已实测：心跳提交触发的那次 push 没再写。
- `AGENTS.md` 和 `CLAUDE.md` 必须逐字相同。

## 耦合参数
- `TUNING.carLen`、`row.count` 上限、`TUNING.carMinGap`: 改车长或密度，必须重算安全间距。
- `TUNING.hopFrames` 与 `safeToLand()` 的落地窗口: 改 hop 帧数必须重算安全窗口。
- `TUNING.cell`、`render()` 的矩形内边距、`verify-web.mjs` 的参考光栅器: 三边一起改，取整语义要逐字一致。
- `PNG_INSET = 12` 与 canvas 的 `border-radius`: 内边距必须 >= 半径 + 2，有断言从计算后样式读真值。
- `pages-check.mjs` 的锥子与 `index.html`: 正向样本用的就是仓里真实的 `index.html`，改 canvas 的 id 或脚本路径会红。
- **心跳提交信息的措辞与 `github.event_name`**: 两种触发必须写出不同的话，有四条断言守着，负向那条（不许出现字面量）是承重的。
- cron `17 3 * * *` 与 `MAX_HEARTBEAT_AGE_DAYS = 3`: 改频率必须改新鲜度上限。实测平台延迟过 49 分钟，所以别把两个时刻凑近。
- `FPS_BASELINE` 与 `FPS_FLOOR`: 地板只抓卡死，下限不能高于基线三分之一。
- `PERF_MEASURED_MS = 18` 与 `PERF_BUDGET_MS = 60`: 预算留三倍余量，但别松到四倍以上。
- `BOT_FRAMES = 420` 同时存在于两条闸门: 改固定预算，两边一起改。
- `marker = <!-- verify-gate -->` 在 workflow 和回写评论查找器里必须逐字相同。

## 断言纪律
- 快闸门优先等号，少用拍脑袋下限。
- 每条关键断言最好有负向那侧，或者配一个变异体自证它真的会红。
- 夹具自己要先自证：纯色图验不出过滤器分支，空集合验不出任何东西。
- 负向样本尽量用仓里真实存在的文件做正向对照，而不是手写夹具,手写的那份会跟着我一起改。
- 光断言「用了变量」是空的：一行字面量加一行变量并存同样通过。要数数量，并断言字面量一个都没有。
- 报告必须自带证据：失败项要能只靠评论定位，不许只报“失败 1 项”。
- 红了先查尺子，再查产品。夹具坏比产品坏常见得多。
- 一条规矩被违反两次，就把它变成断言，别只写在文档里。

## 读取通道的坑（已实测）
- **主干推送的报告我读不到。** 没有 PR 时回写落在 commit 评论上，而 agent 手上没工具读得到 commit 评论。权宜办法是一律走 PR；但合并那一次在主干上重跑的闸门，结果我看不见。
- **带过滤器的运行列表 URL 会给陈旧结果。** 实测：`event:schedule` 回 0 条，而同一时刻 `heartbeat.json` 里已经有 schedule 盖的戳，未过滤列表里也看得见那条运行。
- **而我当时的“正向对照”是无效的**：我拿 `event:push` 那个 URL 去给 `event:schedule` 做对照，但它们是两个不同的查询。**对照必须跑在同一个查询上**，否则它只证明域名可达。
- 两个读取通道打架时，带时间戳的正向痕迹赢了,这正是 `heartbeat.json` 存在的全部理由。
