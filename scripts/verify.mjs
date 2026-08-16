#!/usr/bin/env node
import fs from 'node:fs';
import { createState, step, snapshot, digest, run, makeRow, rowType, entitiesAt, TUNING, safeToLand } from '../src/engine.mjs';
import { PALETTE, PROBE_COLORS } from '../src/palette.mjs';

const PERF_FRAMES = 20000;
const PERF_BUDGET_MS = 180;
const PERF_MEASURED_MS = null;
const MAX_RULE_LINES = 200;
const MAX_HEARTBEAT_AGE_DAYS = 3;
const OBLIGATION_GRACE_DAYS = 30;
const BOT_FRAMES = 420;
const MUTANT_EXPECTATIONS = 3;
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
function countOccurrences(text, re) { return (text.match(re) || []).length; }

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
const hb = json('heartbeat.json');
const obligations = json('docs/obligations.json');
const rules = read('AGENTS.md');
const strippedEngine = stripComments(engineSrc);

expect(strippedEngine.length >= engineSrc.length * 0.4, 'strip-comments-selftest', '剥完注释后剩下的代码太少，扫描器可能把真东西一起剥掉了');
expect(!/\bDate\b|performance\.|requestAnimationFrame|Math\.random|document\.|window\.|localStorage|fetch\(|XMLHttpRequest/.test(strippedEngine), 'engine-pure', '纯核心碰了时间、DOM、存储或网络');
expect(!/^import\s/m.test(strippedEngine), 'engine-no-imports', '纯核心不许 import，变异体靠 data: URL 加载它');
expect(PROBE_COLORS.length === new Set(PROBE_COLORS.map(k => PALETTE[k])).size, 'probe-colors-unique', '探针色必须互不相同，不然像素计数会串台');
expect(['grass', 'road', 'river'].every(t => rowType(123, t === 'grass' ? 0 : t === 'road' ? 5 : 8)), 'row-types-selftest', 'row type 取值自己就坏了');

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

const carState = createState(1);
let foundRoad = null;
for (let r = 3; r < 40; r += 1) {
  const row = makeRow(1, r);
  if (row.type === 'road') { foundRoad = row; break; }
}
expect(!!foundRoad, 'find-road-row', '种子里找不到 road 行，夹具坏了');
if (foundRoad) {
  const cars = entitiesAt(foundRoad, 100);
  expect(cars.length === foundRoad.count, 'cars-count-matches', '实体数不等于 count');
}

let foundRiver = null;
for (let r = 3; r < 60; r += 1) {
  const row = makeRow(7, r);
  if (row.type === 'river') { foundRiver = r; break; }
}
expect(foundRiver !== null, 'find-river-row', '夹具没找到河');
if (foundRiver !== null) {
  const base = createState(7);
  const col = Math.floor(TUNING.cols / 2);
  expect(typeof safeToLand(base, foundRiver, col) === 'boolean', 'safe-to-land-returns-bool', '轮询条件必须返回布尔，不许返回计数');
}

expect(/report\.yml@main/.test(workflowSrc), 'shared-report-main', '回写 workflow 必须跟随上游 @main');
expect(!/report\.yml@[0-9a-f]{40}/.test(workflowSrc), 'shared-report-not-sha', '这里不许再钉 SHA');
expect(/set -o pipefail/.test(workflowSrc) && /\| tee /.test(workflowSrc), 'pipefail-with-tee', '| tee 会吃退出码，必须同段出现 pipefail');
expect(/schedule:\s*[\s\S]*17 3 \* \* \*/.test(workflowSrc), 'schedule-minute-not-zero', 'cron 故意不取整点，有断言守它');
expect(/uses:\s+supercubegame\/ci-workflows\/.github\/workflows\/report\.yml@main/.test(workflowSrc), 'uses-shared-report', '回写必须走共享 workflow');
expect(/marker:\s+'<!-- verify-gate -->'/.test(workflowSrc), 'marker-stable', 'marker 变了就找不到同一条评论');

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
metrics.heartbeat = {
  state: last ? 'seen' : 'pending-first-schedule',
  ageDays: ageDays,
  maxAgeDays: MAX_HEARTBEAT_AGE_DAYS,
  crons: ['17 3 * * *'],
  lastScheduledRun: hb.last_scheduled_run,
  lastManualRun: hb.last_manual_run
};
if (last) {
  expect(ageDays <= MAX_HEARTBEAT_AGE_DAYS, 'heartbeat-fresh-enough', '定时心跳太旧，像是 cron 已经死了');
} else {
  ok('heartbeat-pending-first-schedule');
}

const start = process.hrtime.bigint();
run(123, PERF_FRAMES);
const perfMs = Number(process.hrtime.bigint() - start) / 1e6;
metrics.perfFrames = PERF_FRAMES;
metrics.perfMs = Number(perfMs.toFixed(2));
metrics.perfBudgetMs = PERF_BUDGET_MS;
expect(perfMs <= PERF_BUDGET_MS, 'perf-budget', '快闸门压测超预算，循环会变钝');
expect(PERF_MEASURED_MS === null, 'perf-measured-still-open', '第一轮先留空，让 CI 产实测值，别拍脑袋写个数字冒充实测');

expect(countOccurrences(renderSrc, /fillRect\(/g) === 2, 'single-fillrect-helper', 'render 里应该只有 helper 定义 + helper 调用那一处 fillRect 字面量');
expect(!/strokeRect|createLinearGradient|createRadialGradient|fillText|strokeText/.test(renderSrc), 'render-flat-rect-only', 'render 不许描边、渐变、文字');
expect(/textContent/.test(mainSrc) && !/fillText|strokeText/.test(mainSrc), 'dom-text-not-canvas', '文字只能进 DOM，不能画进 canvas');
expect(/canvas\.width = size\.w[\s\S]*canvas\.height = size\.h/.test(mainSrc), 'canvas-1x1-pixels', 'canvas 必须保持 1:1 像素，不做 DPR 缩放');
expect(/window\.__diag/.test(mainSrc), 'diag-exists', '浏览器闸门要靠只读诊断出口');
expect(/snapshot:\s*function/.test(mainSrc) && /digest:\s*function/.test(mainSrc) && /advance:\s*function/.test(mainSrc), 'diag-shape', '诊断出口少字段了');

expect(/expectedPlayerPixels/.test(verifyWebSrc) && /expectedCarPixels/.test(verifyWebSrc) && /expectedLogPixels/.test(verifyWebSrc), 'web-counts-all-probe-colors', '浏览器闸门漏了一类探针色');
expect(/data:text\/javascript/.test(verifyWebSrc), 'mutants-via-data-url', '变异体应该走同一个检查器，而不是另写一套');

async function killMutants() {
  const baseUrl = 'data:text/javascript;charset=utf-8,';
  let killed = 0;
  async function loadMutant(find, replace) {
    expect(engineSrc.includes(find), 'mutant-precondition-' + find.slice(0, 12), '变异体替换没命中，得到的会是假变异体');
    const src = engineSrc.replace(find, replace) + '\nexport default { TUNING, createState, step, snapshot, digest, run, makeRow, rowType, entitiesAt, safeToLand };';
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

  const m3 = await loadMutant("const settle = TUNING.hopFrames + 12;", 'const settle = 0;');
  const safe = m3.default.safeToLand(m3.default.createState(7), 10, 4);
  if (safe === false) killed += 1; else no('mutant-safe-to-land', '删掉安全窗口后，断言没抓到');
  return killed;
}

metrics.mutantsTotal = MUTANT_EXPECTATIONS;
metrics.mutantsKilled = await killMutants();
expectEq(metrics.mutantsKilled, MUTANT_EXPECTATIONS, 'mutants-all-killed', '有变异体活下来了，说明断言只是装饰');
metrics.unitPass = pass.length;
writeReport();
