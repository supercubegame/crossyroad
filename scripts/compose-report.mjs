#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith('--')) || 'reports';
const checkOnly = args.includes('--check');
const GATES = [
  { slug: 'eng', label: '引擎闸门', file: 'verify-report.json' },
  { slug: 'web', label: '浏览器闸门', file: 'verify-web-report.json' }
];
const LOG_TAIL_LINES = 80;

function walk(d, hits = []) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) walk(p, hits);
    else hits.push(p);
  }
  return hits;
}

function findFile(name) {
  try { return walk(dir).find(p => path.basename(p) === name) || null; }
  catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function tail(text, lines = LOG_TAIL_LINES) {
  return String(text || '').replace(/\s+$/, '').split('\n').slice(-lines).join('\n');
}

function fold(summary, text) {
  return '<details><summary>' + summary + '</summary>\n\n```\n' + text + '\n```\n\n</details>';
}

function missingSection(gate) {
  const logFile = findFile('stdout-' + gate.slug + '.log');
  const log = logFile ? tail(fs.readFileSync(logFile, 'utf8')) : '';
  return [
    '### ❌ ' + gate.label + ' - 没有产出报告',
    '',
    '闸门在写出报告之前就崩了，或者 artifact 根本没上传。这算失败。',
    '',
    log ? fold('stdout 末尾', log.slice(-8000)) : '连 stdout 也没拿到，去看 workflow，不是看闸门。',
    ''
  ].join('\n');
}

function engSection(data) {
  const m = data.metrics || {};
  const hb = m.heartbeat || {};
  const png = m.pngSelfTest || {};
  return [
    '### ' + (data.failures.length ? '❌' : '✅') + ' 引擎闸门 - ' + data.passed + '/' + data.total,
    '',
    '- 单元 / 结构检查: ' + m.unitPass + ' 项',
    '- 机器人种子: ' + m.seeds + '，中位分 ' + m.medianScore + '，范围 ' + m.minScore + '-' + m.maxScore,
    '- 机器人固定帧摘要: `' + m.digestAtBudget + '`',
    '- 压测: ' + m.perfMs + ' ms / ' + m.perfFrames + ' steps（预算 ' + m.perfBudgetMs + ' ms，实测基线 ' + m.perfMeasuredMs + '）',
    '- PNG 解码器自证: ' + png.width + 'x' + png.height + '，过滤器分支 ' + JSON.stringify(png.filtersSeen) + '，夹具 ' + png.bytes + 'B',
    '- 规矩文件: ' + m.rulesLines + ' 行',
    '- 义务: ' + m.obligationsOpen + ' 条，最早到期还剩 ' + m.nextDueInDays + ' 天',
    '- 变异体: ' + m.mutantsKilled + '/' + m.mutantsTotal,
    '- 心跳: `' + hb.state + '`，' + hb.ageDays + ' 天（上限 ' + hb.maxAgeDays + '）· 定时 ' + JSON.stringify(hb.crons) + ' · 上次定时 ' + hb.lastScheduledRun + ' · 上次手动 ' + hb.lastManualRun,
    ''
  ].join('\n');
}

function webSection(data) {
  const m = data.metrics || {};
  const firstDiff = m.pngFirstDiff
    ? '首个不同 (' + m.pngFirstDiff.x + ',' + m.pngFirstDiff.y + ') PNG ' + JSON.stringify(m.pngFirstDiff.a) + ' vs canvas ' + JSON.stringify(m.pngFirstDiff.b)
    : '无差异';
  return [
    '### ' + (data.failures.length ? '❌' : '✅') + ' 浏览器闸门 - ' + data.passed + '/' + data.total,
    '',
    '- 画布: ' + m.canvas + '，测量时帧号 ' + m.frameAtMeasure + '/' + m.frameBudget + '（量完 ' + m.frameAfterMeasure + '）',
    '- 浏览器摘要: `' + m.browserDigest + '`，Node 同帧摘要: `' + m.nodeDigest + '`',
    '- 像素对账: 玩家 ' + m.playerPixels + '/' + m.expectedPlayerPixels + '，车 ' + m.carPixels + '/' + m.expectedCarPixels + '，木头 ' + m.logPixels + '/' + m.expectedLogPixels + '，树 ' + m.treePixels + '/' + m.expectedTreePixels,
    '- 菜单遮罩: ' + m.menuPixels + '/' + m.expectedMenuPixels + '，死亡横带 ' + m.deadPixels + '/' + m.expectedDeadPixels + '（死因 ' + m.deathReason + '）',
    '- **PNG 与 canvas**: 比了 ' + m.pngCompared + ' 个像素，差异 ' + m.pngDiff + '（' + firstDiff + '）',
    '- PNG 自身: ' + m.pngSize + ' ' + m.pngBytes + 'B，过滤器 ' + JSON.stringify(m.pngFiltersSeen) + '，内部颜色 ' + m.pngDistinctColors + ' 种，内边距 ' + m.pngInset + '（半径 ' + m.canvasRadius + '）',
    '- PNG 变异体: 翻一个像素拓出 ' + m.pngMutantDiff + ' 处（必须是 1）',
    '- 帧率: ' + m.fps + '（下限 ' + m.fpsFloor + '，基线 ' + m.fpsBaseline + '）',
    '- 最高分: 跑出 ' + m.bestRunScore + '，重载后 ' + m.bestAfterReload + '（存储降级: ' + (m.storageDegraded ? '是' : '否') + '）',
    '- 截图: ' + (m.shots || []).map(s => s.name + ' ' + s.bytes + 'B ' + s.sha.slice(0, 8)).join(' · '),
    ''
  ].join('\n');
}

let failed = false;
let passedCount = 0;
let totalCount = 0;
const sections = [];
const failures = [];

for (const gate of GATES) {
  const file = findFile(gate.file);
  const data = file ? readJson(file) : null;
  if (!data) {
    failed = true;
    sections.push(missingSection(gate));
    continue;
  }
  passedCount += data.passed;
  totalCount += data.total;
  if (data.passed !== data.total) failed = true;
  sections.push(gate.slug === 'eng' ? engSection(data) : webSection(data));
  for (const f of data.failures || []) failures.push(gate.label + ' · ' + f);
}

if (failures.length) {
  sections.push(['### 失败项', '', ...failures.map(f => '- ' + f), ''].join('\n'));
}

const sha = (process.env.GITHUB_SHA || 'local').slice(0, 7);
const runLink = process.env.GITHUB_RUN_ID
  ? ' · [完整日志](' + (process.env.GITHUB_SERVER_URL || 'https://github.com') + '/' +
    (process.env.GITHUB_REPOSITORY || '') + '/actions/runs/' + process.env.GITHUB_RUN_ID + ')'
  : '';
const body = [
  (failed ? '## 验证闸门有失败' : '## 验证闸门全部通过'),
  '',
  passedCount + '/' + totalCount + ' 项通过 · 提交 `' + sha + '`' + runLink,
  '',
  ...sections
].join('\n');

if (checkOnly) {
  process.stdout.write((failed ? 'FAILED' : 'PASSED') + ': ' + passedCount + '/' + totalCount + '\n');
  process.exit(failed ? 1 : 0);
}

fs.writeFileSync('comment.md', body.slice(0, 60000));
process.stdout.write(body + '\n');
