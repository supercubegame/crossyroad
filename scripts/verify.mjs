#!/usr/bin/env node
import fs from 'node:fs';
import { createState, step, run, makeRow, rowType, entitiesAt, TUNING, safeToLand } from '../src/engine.mjs';
import { PALETTE, PROBE_COLORS } from '../src/palette.mjs';
import { crc32, decodePng, encodePng, comparePixels, distinctColors } from './png.mjs';
import { ANCHORS, checkPageHtml } from './pages-check.mjs';

const PERF_FRAMES = 20000;
const PERF_BUDGET_MS = 60;
const PERF_MEASURED_MS = 18;
const MAX_RULE_LINES = 200;
const MAX_HEARTBEAT_AGE_DAYS = 3;
const OBLIGATION_GRACE_DAYS = 30;
const BOT_FRAMES = 420;
const MUTANT_EXPECTATIONS = 3;
const PNG_FILTERS = [0, 1, 2, 3, 4];
const CRC32_IEND = 0xae426082;
const PAGES_NEGATIVE_MIN = 4;
/* 两份 workflow 里都会出现的官方 action。它们的大版本必须逐个相等,
   只升一边是这类 bump 最容易的失败方式，而它全绿。 */
const SHARED_ACTIONS = ['actions/checkout', 'actions/setup-node'];
const fail = [];
const pass = [];
const metrics = {};

function ok(name, detail) { pass.push(name); if (detail) metrics[name] = detail; }
function no(name, detail) { fail.push(name + ' - ' + detail); }
function expect(cond, name, detail) { cond ? ok(name) : no(name, detail); }
function expectEq(actual, expected, name, detail) {
  if (actual === expected) ok(name);
  else no(name, detail + ' (actual ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')');
}
function expectMatch(value, re, name, detail) {
  if (re.test(String(value))) ok(name);
  else no(name, detail + ' (actual ' + JSON.stringify(value) + ')');
}
function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function throwsWith(fn) {
  try { fn(); return null; } catch (err) { return String(err && err.message || err); }
}

/* 从一份 YAML 里抽出某个 action 用到的大版本集合。返回排序后的字串，方便做等号。 */
function actionMajors(yaml, action) {
  const found = new Set();
  const lines = yaml.split('\n');
  for (const line of lines) {
    const idx = line.indexOf(action + '@v');
    if (idx < 0) continue;
    const rest = line.slice(idx + action.length + 2);
    const m = rest.match(/^(\d+)/);
    if (m) found.add(m[1]);
  }
  return Array.from(found).sort().join(',');
}

function stripComments(js) {
  let out = '';
  let mode = 'code';
  for (let i = 0; i < js.length; i += 1) {
    const c = js[i], n = js[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '*') { mode = 'block'; i += 1; continue; }
      if (c === '/' && n === '/') { mode = 'line'; i += 1; continue; }
      if (c === "'") { mode = 'sq'; out += c; continue; }
      if (c === '"') { mode = 'dq'; out += c; continue; }
      if (c === '`') { mode = 'tpl'; out += c; continue; }
      out += c;
    } else if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 1; }
    } else if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; }
    } else if (mode === 'sq') {
      out += c;
      if (c === '\\') { out += js[i + 1] || ''; i += 1; }
      else if (c === "'") mode = 'code';
    } else if (mode === 'dq') {
      out += c;
      if (c === '\\') { out += js[i + 1] || ''; i += 1; }
      else if (c === '"') mode = 'code';
    } else if (mode === 'tpl') {
      out += c;
      if (c === '\\') { out += js[i + 1] || ''; i += 1; }
      else if (c === '`') mode = 'code';
    }
  }
  return out;
}

function read(path) { return fs.readFileSync(path, 'utf8'); }
function json(path) { return JSON.parse(read(path)); }
function writeReport() {
  fs.mkdirSync('artifacts', { recursive: true });
  const report = { total: pass.length + fail.length, passed: pass.length, failures: fail, metrics };
  fs.writeFileSync('artifacts/verify-report.json', JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (fail.length) process.exit(1);
}

const engineSrc = read('src/engine.mjs');
const mainSrc = read('src/main.mjs');
const renderSrc = read('src/render.mjs');
const verifyWebSrc = read('scripts/verify-web.mjs');
const workflowSrc = read('.github/workflows/verify.yml');
const pagesWorkflow = read('.github/workflows/pages.yml');
const indexHtml = read('index.html');
const hb = json('heartbeat.json');
const obligations = json('docs/obligations.json');
const rules = read('AGENTS.md');
const strippedEngine = stripComments(engineSrc);

expect(strippedEngine.length >= engineSrc.length * 0.4, 'strip-comments-selftest', '剥完注释后剩下的代码太少，扫描器可能把真东西一起剥掉了');
expect(!/\bDate\b|performance\.|requestAnimationFrame|Math\.random|document\.|window\.|localStorage|fetch\(|XMLHttpRequest/.test(strippedEngine), 'engine-pure', '纯核心碰了时间、DOM、存储或网络');
expect(!/^import\s/m.test(strippedEngine), 'engine-no-imports', '纯核心不许 import，变异体靠 data: URL 加载它');
expect(PROBE_COLORS.length === new Set(PROBE_COLORS.map(k => PALETTE[k])).size, 'probe-colors-unique', '探针色必须互不相同，不然像素计数会串台');

for (let i = 1; i < 60; i += 1) {
  if (rowType(17, i) === 'river' && rowType(17, i - 1) === 'river') {
    no('no-double-river', '连续两条河会把路线做成硬死局');
    break;
  }
}
if (!fail.find(f => f.startsWith('no-double-river'))) ok('no-double-river');

for (let i = 3; i < 40; i += 1) {
  const row = makeRow(42, i);
  if (row.type === 'road' || row.type === 'river') {
    const span = TUNING.cols + row.len + TUNING.edgeMargin;
    const gap = span / row.count;
    if (gap < row.len + TUNING.carMinGap) no('entity-gap-safe', '实体间距小于长度 + 最小安全间隔');
  }
}
if (!fail.find(f => f.startsWith('entity-gap-safe'))) ok('entity-gap-safe');

const seeds = [1, 2, 3, 4, 5, 99, 777, 2026];
const scores = [];
let digestAtBudget = null;
for (const seed of seeds) {
  const out = run(seed, BOT_FRAMES);
  scores.push(out.score);
  if (seed === seeds[0]) digestAtBudget = out.digest;
  expect(out.steps > 0, 'bot-runs-' + seed, '机器人一帧都没跑起来');
  expect(out.score >= 2, 'bot-min-score-' + seed, '固定预算下连 2 行都过不去，难度坡度太离谱');
}
metrics.seeds = seeds.length;
metrics.minScore = Math.min(...scores);
metrics.maxScore = Math.max(...scores);
metrics.medianScore = median(scores);
metrics.digestAtBudget = digestAtBudget;

const st = createState(123);
step(st, 'up');
for (let i = 0; i < TUNING.hopFrames; i += 1) step(st, null);
expectEq(st.score, 1, 'score-updates-on-landing', '得分应该在落地后增加');

let foundRiverRow = null;
let foundSafeCol = null;
for (let r = 3; r < 60 && foundRiverRow === null; r += 1) {
  const row = makeRow(7, r);
  if (row.type !== 'river') continue;
  for (let col = 0; col < TUNING.cols; col += 1) {
    if (safeToLand(createState(7), r, col)) {
      foundRiverRow = r;
      foundSafeCol = col;
      break;
    }
  }
}
expect(foundRiverRow !== null, 'find-safe-river-landing', '夹具没找到一个原版 safeToLand 为真的河面落点');
if (foundRiverRow !== null) expect(typeof safeToLand(createState(7), foundRiverRow, foundSafeCol) === 'boolean', 'safe-to-land-returns-bool', '轮询条件必须返回布尔，不许返回计数');

/* ---------- PNG 解码器：它自己先得被验一遍 ---------- */

expectEq(crc32(Buffer.from('IEND', 'ascii')), CRC32_IEND, 'crc32-known-constant', 'crc32 连公认常量都对不上，后面每条 CRC 负向断言都不算数');

const PW = 7;
const PH = 5;
const pngFixture = Buffer.alloc(PW * PH * 4);
for (let y = 0; y < PH; y += 1) {
  for (let x = 0; x < PW; x += 1) {
    const i = (y * PW + x) * 4;
    pngFixture[i] = (x * 37 + y * 11) & 0xff;
    pngFixture[i + 1] = (x * 5 + y * 61) & 0xff;
    pngFixture[i + 2] = (x * x + y * y * 3) & 0xff;
    pngFixture[i + 3] = 255;
  }
}
expect(distinctColors(pngFixture, PW, PH, 0) > 10, 'png-fixture-not-flat', 'PNG 夹具颜色太少，过滤器分支验不出东西');

const pngBytes = encodePng(PW, PH, pngFixture, PNG_FILTERS);
const pngDecoded = decodePng(pngBytes);
metrics.pngSelfTest = { width: pngDecoded.width, height: pngDecoded.height, filtersSeen: pngDecoded.filtersSeen, bytes: pngBytes.length };
expectEq(pngDecoded.width, PW, 'png-width-roundtrip', 'IHDR 宽度没转对');
expectEq(pngDecoded.height, PH, 'png-height-roundtrip', 'IHDR 高度没转对');
expectEq(pngDecoded.filtersSeen.join(','), PNG_FILTERS.join(','), 'png-all-filter-branches-exercised', '五种过滤器分支没全跑到，没跑到的那几条和空断言是一个形状');
const pngRoundTrip = comparePixels(pngDecoded.data, pngFixture, PW, PH, 0);
expectEq(pngRoundTrip.diff, 0, 'png-roundtrip-exact', '编码再解码之后像素变了');
expectEq(pngRoundTrip.compared, PW * PH, 'png-roundtrip-covered-all', '比较器没把整张图都比到');

expect(!!throwsWith(() => decodePng(Buffer.concat([Buffer.alloc(8), pngBytes.subarray(8)]))), 'png-rejects-bad-signature', '签名坏了居然能解码');
const pngCorrupt = Buffer.from(pngBytes);
pngCorrupt[pngCorrupt.length - 20] ^= 0xff;
expect(!!throwsWith(() => decodePng(pngCorrupt)), 'png-rejects-corrupt-crc', '改了 IDAT 一个字节居然没抛错，CRC 校验是装饰');
expect(!!throwsWith(() => decodePng(pngBytes.subarray(0, pngBytes.length - 8))), 'png-rejects-truncated', '截断的 PNG 居然能解码');

const pngPalette = Buffer.from(pngBytes);
pngPalette[8 + 8 + 9] = 3;
const ihdrBody = pngPalette.subarray(8 + 4, 8 + 8 + 13);
pngPalette.writeUInt32BE(crc32(ihdrBody), 8 + 8 + 13);
const paletteErr = throwsWith(() => decodePng(pngPalette));
expect(!!paletteErr && /colorType/.test(paletteErr), 'png-rejects-unsupported-colortype', '不支持的 colorType 没被单独拓出来，报的可能是 CRC 而不是 colorType (actual ' + JSON.stringify(paletteErr) + ')');

const pngFlipped = Buffer.from(pngDecoded.data);
pngFlipped[(2 * PW + 3) * 4] ^= 0xff;
const pngMutant = comparePixels(pngFlipped, pngFixture, PW, PH, 0);
expectEq(pngMutant.diff, 1, 'png-comparator-catches-one-pixel', '翻一个像素比较器没拓出来，那上面那条逐像素等号是装饰');
expect(!!pngMutant.first && pngMutant.first.x === 3 && pngMutant.first.y === 2, 'png-comparator-reports-location', '比较器没报出不同的坐标，报告里就只有一句不相等，定不了位');

expect(/decodePng\(/.test(verifyWebSrc), 'web-gate-decodes-png', '浏览器闸门没调 decodePng，解码器白写了');
expect(/comparePixels\(/.test(verifyWebSrc), 'web-gate-compares-pixels', '浏览器闸门没逐像素对账');
expect(/png-vs-canvas/.test(verifyWebSrc), 'web-gate-has-png-equality', '浏览器闸门里找不到那条 PNG 与 canvas 等号断言');
expect(/png-comparator-not-decorative/.test(verifyWebSrc), 'web-gate-has-png-mutant', '浏览器闸门那条等号没配变异体');
expect(/borderTopLeftRadius/.test(verifyWebSrc), 'png-inset-coupled-to-radius', '内边距必须从真实的 border-radius 推导，不能拍一个数字');

/* ---------- Pages 守卫：用必然失败的样本证明它会红 ----------

   之前它是 YAML 里的一段 grep 循环，离线触发不了，所以它在 main 上跑过一次并通过，
   却从没被观察到红过。而一条从没红过的断言和一条空断言，在面板上分不出来。

   正向样本用的是仓里真实的 index.html，不是手写夹具,后者会跟着我一起改，
   而那正是这个病本身。改 canvas 的 id 或改脚本路径，下面第一条会红。

   负向样本数是**数出来的**，不是凭印象填的。摆在报告里的 undefined 没人会看。 */

const pagesOk = checkPageHtml(indexHtml);
let pagesNegatives = 0;
metrics.pagesAnchors = ANCHORS.map(a => a.id);
metrics.pagesPositiveBytes = pagesOk.bytes;
expect(pagesOk.ok, 'pages-guard-accepts-real-index', '守卫把仓里真实的 index.html 判成不合格，锥子和页面已经对不上了（缺 ' + pagesOk.missing.join(',') + '）');
expect(ANCHORS.length >= 2, 'pages-guard-has-two-anchors', '只留一个锥子的话，404 页恰巧含有那个字串就能免费通过');

const sample404 = '<!doctype html><html><head><title>404</title></head><body><h1>404</h1><p>File not found</p><p>The site configured at this address does not contain the requested file.</p></body></html>';
const res404 = checkPageHtml(sample404);
pagesNegatives += 1;
expect(!res404.ok, 'pages-guard-rejects-404', '404 页居然被判成部署成功');
expectEq(res404.missing.length, ANCHORS.length, 'pages-guard-404-misses-all-anchors', '404 页应该两个锥子都缺');

for (const anchor of ANCHORS) {
  const partial = '<!doctype html><html><body>' + anchor.needle + '</body></html>';
  const res = checkPageHtml(partial);
  pagesNegatives += 1;
  expect(!res.ok, 'pages-guard-rejects-only-' + anchor.id, '只有 ' + anchor.id + ' 一个锥子的页居然被判成成功，单一 grep 就是这么被骗的');
  expectEq(res.missing.length, 1, 'pages-guard-reports-which-anchor-' + anchor.id, '应该恰好报缺一个锥子，否则报告定不了位');
}

const resEmpty = checkPageHtml('');
pagesNegatives += 1;
expect(!resEmpty.ok, 'pages-guard-rejects-empty', '空响应居然被判成部署成功，那整个网络失败都会静默通过');

metrics.pagesNegativeSamples = pagesNegatives;
expect(Number.isFinite(pagesNegatives) && pagesNegatives >= PAGES_NEGATIVE_MIN, 'pages-negative-sample-count', '负向样本数不对：404 + 两个单锥子 + 空响应应该至少 ' + PAGES_NEGATIVE_MIN + ' 个 (actual ' + JSON.stringify(pagesNegatives) + ')');

expect(/node scripts\/pages-check\.mjs/.test(pagesWorkflow), 'pages-workflow-calls-script', 'Pages workflow 没调那个脚本，上面那几个样本验的就不是真跑的那段');
expect(!/grep -q/.test(pagesWorkflow), 'pages-workflow-no-inline-grep', '行内 grep 回来了：那段离线触发不了，也就永远不会被观察到红');

/* ---------- 心跳提交信息：它已经说过一次谎 ----------

   手动跑的那次，提交信息也写着「定时闸门跑过了」。而 git log 恰好是这个仓里
   最没人复核的那份散文。

   四条里**负向那条是承重的**：光断言「用了变量」是空的,一行字面量加一行变量
   并存同样通过。 */

const commitCmdLines = workflowSrc.split('\n').filter(l => l.includes('git commit -m'));
metrics.heartbeatCommitCommands = commitCmdLines.length;
expectEq(commitCmdLines.length, 1, 'heartbeat-one-commit-command', '心跳只该有一条提交命令，多出来的那条会绕过下面几条断言');
expect(/git commit -m "\$msg"/.test(workflowSrc), 'heartbeat-message-from-variable', '提交信息必须来自变量，不能是写死的一句话');
expect(!commitCmdLines.some(l => /[\u4e00-\u9fff]/.test(l)), 'heartbeat-message-not-literal', '提交命令那行里出现中文了，那就是写死的措辞：手动跑时它会谢「定时闸门跑过了」');
expect(/if \[ "\$EVENT" = 'schedule' \]/.test(workflowSrc), 'heartbeat-message-branches-on-event', '措辞必须按 $EVENT 分叉，否则两种触发写出同一句话');

/* ---------- 两份 workflow 的 action 大版本要钉在一起 ----------

   只升一边是这类 bump 最容易的失败方式，而它全绿：两条流水线跑在不同 Node
   大版本上，行为已经分叉而没任何东西在喊。

   写成**集合相等**而不是分开断言“各自是 v5”：后者每次 bump 都要改两处常量，
   而改漏一处的后果恰好是静默的。另加一条自证：抽取器不能返回空集合,
   空集合相等于空集合会免费通过。 */

const actionVersions = {};
for (const action of SHARED_ACTIONS) {
  const inVerify = actionMajors(workflowSrc, action);
  const inPages = actionMajors(pagesWorkflow, action);
  actionVersions[action] = { verify: inVerify, pages: inPages };
  expect(inVerify.length > 0, 'action-extractor-found-' + action, '抽取器在 verify.yml 里一个 ' + action + ' 都没找到，那下面那条等号是空的');
  expectEq(inVerify, inPages, 'action-major-matches-' + action, action + ' 的大版本在两份 workflow 里不一致，两条流水线跑在不同 Node 上而两边都绿');
  expectEq(inVerify, '5', 'action-major-is-v5-' + action, action + ' 还在 v4（Node 20 已 deprecated，今天只是 warning）');
}
metrics.actionVersions = actionVersions;

expect(!/actions\/(checkout|setup-node|upload-artifact)@v4/.test(workflowSrc + pagesWorkflow), 'no-node20-actions-left', '还有 action 钉在 v4 上，它跑 Node 20');

expect(/report\.yml@main/.test(workflowSrc), 'shared-report-main', '回写 workflow 必须跟随上游 @main');
expect(!/report\.yml@[0-9a-f]{40}/.test(workflowSrc), 'shared-report-not-sha', '这里不许再钉 SHA');
expect(/set -o pipefail/.test(workflowSrc) && /\| tee /.test(workflowSrc), 'pipefail-with-tee', '| tee 会吃退出码，必须同段出现 pipefail');
expect(/schedule:\s*[\s\S]*17 3 \* \* \*/.test(workflowSrc), 'schedule-minute-not-zero', 'cron 故意不取整点，有断言守它');
expect(/uses:\s+supercubegame\/ci-workflows\/.github\/workflows\/report\.yml@main/.test(workflowSrc), 'uses-shared-report', '回写必须走共享 workflow');
expect(/marker:\s+'<!-- verify-gate -->'/.test(workflowSrc), 'marker-stable', 'marker 变了就找不到同一条评论');
expect(/actions\/deploy-pages@v4/.test(pagesWorkflow), 'pages-deploy-exists', '在线试玩的 Pages workflow 还没接上');
expect(/branches: \[main\]/.test(pagesWorkflow), 'pages-only-on-main', 'Pages 只能挂 main：github-pages 环境默认只允许默认分支部署');

const rulesLines = rules.trimEnd().split('\n').length;
metrics.rulesLines = rulesLines;
expect(rulesLines <= MAX_RULE_LINES, 'rules-under-cap', 'AGENTS.md 超过 200 行了，该压措辞或拆分，不许调宽上限');
expectEq(rules, read('CLAUDE.md'), 'claude-matches-agents', 'AGENTS.md 和 CLAUDE.md 必须逐字相同');

const dueItems = obligations.items || [];
metrics.obligationsOpen = dueItems.length;
let nextDue = Infinity;
for (const item of dueItems) {
  expectMatch(item.due, /^\d{4}-\d{2}-\d{2}$/, 'obligation-date-' + item.id, '义务必须有明确到期日');
  const days = Math.floor((Date.parse(item.due + 'T00:00:00Z') - Date.now()) / 86400000);
  nextDue = Math.min(nextDue, days);
  expect(days >= 0, 'obligation-not-overdue-' + item.id, '义务过期了：' + item.id);
  expect(days <= OBLIGATION_GRACE_DAYS, 'obligation-not-too-far-' + item.id, '义务写太远等于没有期限：' + item.id);
}
metrics.nextDueInDays = Number.isFinite(nextDue) ? nextDue : null;

const now = Date.now();
const last = hb.last_scheduled_run ? Date.parse(hb.last_scheduled_run) : null;
const ageDays = last ? Math.floor((now - last) / 86400000) : null;
metrics.heartbeat = { state: last ? 'seen' : 'pending-first-schedule', ageDays: ageDays, maxAgeDays: MAX_HEARTBEAT_AGE_DAYS, crons: ['17 3 * * *'], lastScheduledRun: hb.last_scheduled_run, lastManualRun: hb.last_manual_run, runs: hb.runs };
if (last) expect(ageDays <= MAX_HEARTBEAT_AGE_DAYS, 'heartbeat-fresh-enough', '定时心跳太旧，像是 cron 已经死了');
else ok('heartbeat-pending-first-schedule');

const start = process.hrtime.bigint();
run(123, PERF_FRAMES);
const perfMs = Number(process.hrtime.bigint() - start) / 1e6;
metrics.perfFrames = PERF_FRAMES;
metrics.perfMs = Number(perfMs.toFixed(2));
metrics.perfBudgetMs = PERF_BUDGET_MS;
metrics.perfMeasuredMs = PERF_MEASURED_MS;
expect(perfMs <= PERF_BUDGET_MS, 'perf-budget', '快闸门压测超预算，循环会变钝');
expect(PERF_BUDGET_MS >= PERF_MEASURED_MS * 3, 'perf-budget-has-3x-headroom', '性能预算没有留到三倍余量');
expect(PERF_BUDGET_MS <= PERF_MEASURED_MS * 4, 'perf-budget-not-sloppy', '性能预算放得太松，等于不守');

expect((renderSrc.match(/fillRect\(/g) || []).length === 1, 'single-fillrect-helper', 'render 里应该只有 helper 定义这一处 fillRect 字面量');
expect(!/strokeRect|createLinearGradient|createRadialGradient|fillText|strokeText/.test(renderSrc), 'render-flat-rect-only', 'render 不许描边、渐变、文字');
expect(/textContent/.test(mainSrc) && !/fillText|strokeText/.test(mainSrc), 'dom-text-not-canvas', '文字只能进 DOM，不能画进 canvas');
expect(/canvas\.width = size\.w[\s\S]*canvas\.height = size\.h/.test(mainSrc), 'canvas-1x1-pixels', 'canvas 必须保持 1:1 像素，不做 DPR 缩放');
expect(/window\.__diag/.test(mainSrc), 'diag-exists', '浏览器闸门要靠只读诊断出口');
expect(/snapshot:\s*function/.test(mainSrc) && /digest:\s*function/.test(mainSrc) && /advance:\s*function/.test(mainSrc), 'diag-shape', '诊断出口少字段了');
expect(/stepWith:\s*function/.test(mainSrc), 'diag-has-step-with', 'stepWith 不能删：press 只设 pending，advance 不消费它，没它输入注入不进去');

async function killMutants() {
  const baseUrl = 'data:text/javascript;charset=utf-8,';
  let killed = 0;
  async function loadMutant(find, replace) {
    expect(engineSrc.includes(find), 'mutant-precondition-' + find.slice(0, 12), '变异体替换没命中，得到的会是假变异体');
    const src = engineSrc.replace(find, replace) + '\nexport default { TUNING, createState, step, run, makeRow, rowType, entitiesAt, safeToLand };';
    return import(baseUrl + encodeURIComponent(src));
  }
  const m1 = await loadMutant('if (t === \'river\' && index >= 1 && rawType(seed, index - 1) === \'river\') return \'grass\';', 'if (false) return \'grass\';');
  let doubleRiver = false;
  for (let i = 1; i < 60; i += 1) {
    if (m1.default.rowType(17, i) === 'river' && m1.default.rowType(17, i - 1) === 'river') doubleRiver = true;
  }
  if (doubleRiver) killed += 1; else no('mutant-double-river', '去掉防双河后，断言居然没红');

  const m2 = await loadMutant('if (p.hopT === 0 && p.row > state.score) state.score = p.row;', 'if (p.hopT === 0 && p.row > state.score) state.score = p.row - 1;');
  const s2 = m2.default.createState(1);
  m2.default.step(s2, 'up');
  for (let i = 0; i < m2.default.TUNING.hopFrames; i += 1) m2.default.step(s2, null);
  if (s2.score !== 1) killed += 1; else no('mutant-score-landing', '改坏落地加分后，断言没抓到');

  const m3 = await loadMutant('if (Math.abs(col - logs[i]) <= row.len / 2 - 0.2) onBoard = true;', 'if (false) onBoard = true;');
  const safe = m3.default.safeToLand(m3.default.createState(7), foundRiverRow, foundSafeCol);
  if (safe === false) killed += 1; else no('mutant-safe-to-land', '删掉上板判定后，断言没抓到');
  return killed;
}

metrics.mutantsTotal = MUTANT_EXPECTATIONS;
metrics.mutantsKilled = await killMutants();
expectEq(metrics.mutantsKilled, MUTANT_EXPECTATIONS, 'mutants-all-killed', '有变异体活下来了，说明断言只是装饰');
metrics.unitPass = pass.length;
writeReport();
