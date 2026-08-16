# CROSSYROAD

## 项目结构
- `src/engine.mjs`: 纯核心。地图生成、碰撞、得分、机器人、诊断摘要。
- `src/render.mjs`: 只把快照画成平色整数矩形，不做任何业务判断。
- `src/main.mjs`: 浏览器壳。输入、循环、DOM 文案、存档、诊断出口。
- `scripts/verify.mjs`: 快闸门。零依赖，守纯核心、结构不变量、义务和三条变异体。
- `scripts/verify-web.mjs`: 浏览器闸门。真起页面，对账 canvas 像素、摘要、截图。
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
- `window.__diag` 的字段名只能加不能改：浏览器闸门认这些名字。
- 回写 workflow 固定用 `supercubegame/ci-workflows/.github/workflows/report.yml@main`。
- 有 `| tee` 的脚本段必须同段开 `set -o pipefail`。
- 心跳只在 `schedule` 或显式手动请求时写，防自触发靠结构，不靠提交信息。
- `AGENTS.md` 和 `CLAUDE.md` 必须逐字相同。

## 耦合参数
- `TUNING.carLen`、`row.count` 上限、`TUNING.carMinGap`: 改车长或密度，必须重算安全间距。
- `TUNING.hopFrames` 与 `safeToLand()` 的落地窗口: 改 hop 帧数必须重算安全窗口。
- `TUNING.cell`、`render()` 的矩形内边距、`scripts/verify-web.mjs` 的独立光栅器: 三边必须一起改，不然像素等号会红。
- cron `17 3 * * *` 与 `MAX_HEARTBEAT_AGE_DAYS = 3`: 改频率必须改新鲜度上限。
- `FPS_BASELINE` 与 `FPS_FLOOR`: 地板只抓卡死，下限不能高于基线三分之一。
- `BOT_FRAMES = 420` 同时存在于快闸门和浏览器闸门: 改固定预算，两边一起改。
- `marker = <!-- verify-gate -->` 在 workflow 和回写评论查找器里必须逐字相同。

## 断言纪律
- 快闸门优先等号，少用拍脑袋下限。
- 每条关键断言最好有负向那侧，或者配一个变异体自证它真的会红。
- 报告必须自带证据：失败项要能只靠评论定位，不许只报“失败 1 项”。
- 红了先查尺子，再查产品。夹具坏比产品坏常见得多。
- 一条规矩被违反两次，就把它变成断言，别只写在文档里。

## 还没做完的一半
- `docs/obligations.json` 里那两条义务还活着：性能预算要用首轮 CI 实测值收紧，PNG 内容断言还欠一条解码后逐像素对账。
