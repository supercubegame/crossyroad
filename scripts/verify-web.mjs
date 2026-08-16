#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { run, TUNING } from '../src/engine.mjs';
import { PALETTE } from '../src/palette.mjs';

const FPS_FLOOR = 13;
const FPS_BASELINE = 40;
const BOT_FRAMES = 420;
const DEATH_ATTEMPTS = 60;
const fail = [];
const pass = [];
const metrics = {};

function ok(name) { pass.push(name); }
function no(name, detail) { fail.push(name + ' - ' + detail); }
function expect(cond, name, detail) { cond ? ok(name) : no(name, detail); }
function expectEq(actual, expected, name, detail) {
  if (actual === expected) ok(name);
  else no(name, detail + ' (actual ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')');
}
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/* 参考光栅器。从快照出发，用自己一份绘制代码真画一张位图，然后数颜色。

   上一版是算面积账，连错两轮（车少算、木头多算），根因同一个：面积账要手工重现
   绘制顺序和遮挡关系，而那是一笔算不清的账。画一遍再数，遮挡由构造正确。

   它不验什么：不验配色好看、不验布局合理。它验三件事，画出来了、几何没歪、
   画面已经追上了状态。好不好玩机器判不了，也不该假装能判。

   取整语义必须和 src/render.mjs 的 rectPx 逐字一致。快闸门里有一条断言钉住那一行，
   改它必须改这里。 */
function referenceRaster(snap, phase) {
  const cell = snap.cell;
  const w = snap.cols * cell;
  const h = snap.viewRows * cell;
  const buf = new Uint8Array(w * h);
  const ID = { band: 1, tree: 2, car: 3, log: 4, player: 5, dead: 6, menu: 7 };
  function rect(id, x, y, rw, rh) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    const iw = Math.round(rw);
    const ih = Math.round(rh);
    const x0 = Math.max(0, ix);
    const y0 = Math.max(0, iy);
    const x1 = Math.min(w, ix + iw);
    const y1 = Math.min(h, iy + ih);
    for (let yy = y0; yy < y1; yy += 1) {
      const base = yy * w;
      for (let xx = x0; xx < x1; xx += 1) buf[base + xx] = id;
    }
  }
  for (const row of snap.rows) {
    const top = h - cell - (row.index * cell - snap.camPx);
    if (top >= h || top + cell <= 0) continue;
    rect(ID.band, 0, top, w, cell);
    if (row.type === 'grass') {
      for (const tree of row.trees) rect(ID.tree, tree * cell, top, cell, cell);
    } else if (row.type === 'river') {
      for (const x of row.entities) rect(ID.log, (x - row.len / 2) * cell, top + 6, row.len * cell, cell - 12);
    } else {
      for (const x of row.entities) rect(ID.car, (x - row.len / 2) * cell, top + 8, row.len * cell, cell - 16);
    }
  }
  rect(ID.player, snap.player.visualX * cell + 8, h - cell - (snap.player.visualRow * cell - snap.camPx) + 8, cell - 16, cell - 16);
  if (snap.status === 'dead') rect(ID.dead, 0, Math.round(h / 2) - 72, w, 144);
  if (phase === 'menu') rect(ID.menu, 0, 0, w, h);
  const counts = { tree: 0, car: 0, log: 0, player: 0, dead: 0, menu: 0 };
  const byId = { 2: 'tree', 3: 'car', 4: 'log', 5: 'player', 6: 'dead', 7: 'menu' };
  for (let i = 0; i < buf.length; i += 1) {
    const key = byId[buf[i]];
    if (key) counts[key] += 1;
  }
  return { w: w, h: h, counts: counts };
}

async function countColor(page, hex) {
  return page.evaluate((color) => {
    const s = color.replace('#', '');
    const target = [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 255];
    const canvas = document.getElementById('stage');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === target[0] && data[i + 1] === target[1] && data[i + 2] === target[2] && data[i + 3] === target[3]) count += 1;
    }
    return count;
  }, hex);
}

async function main() {
  const server = await startServer(process.cwd(), 0);
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 432, height: 690 }, deviceScaleFactor: 1 });
  const shots = [];
  try {
    await page.goto(server.url + '/index.html', { waitUntil: 'networkidle' });
    await page.bringToFront();
    await page.waitForFunction(() => !!window.__diag && window.__diag.version === 1);
    const geo = await page.evaluate(() => window.__diag.geometry());
    metrics.canvas = geo.w + 'x' + geo.h;
    expectEq(geo.w, 432, 'canvas-width', '宽度不对，像素等号会全歪');
    expectEq(geo.h, 624, 'canvas-height', '高度不对，像素等号会全歪');

    const menu = await page.locator('#menu').screenshot();
    shots.push({ name: 'menu.png', bytes: menu.length, sha: sha(menu) });
    await page.evaluate(() => window.__diag.draw());
    const menuSnap = await page.evaluate(() => window.__diag.snapshot());
    const menuRef = referenceRaster(menuSnap, 'menu');
    metrics.menuPixels = await countColor(page, PALETTE.menu);
    metrics.expectedMenuPixels = menuRef.counts.menu;
    expectEq(metrics.menuPixels, menuRef.counts.menu, 'menu-overlay-pixels', '菜单遮罩应该盖满整个画布');
    expect(menuRef.counts.menu === geo.w * geo.h, 'menu-reference-selftest', '参考光栅器自己就算错了菜单遮罩');

    await page.evaluate(() => window.__diag.reset(1));
    await page.evaluate(frames => window.__diag.advance(frames, true), BOT_FRAMES);
    const live = await page.evaluate(() => ({ digest: window.__diag.digest(), score: window.__diag.score(), snap: window.__diag.snapshot(), phase: window.__diag.phase() }));
    const nodeRun = run(1, BOT_FRAMES);
    metrics.browserDigest = live.digest;
    metrics.nodeDigest = nodeRun.digest;
    expectEq(live.digest, nodeRun.digest, 'browser-vs-node-digest', '浏览器和 Node 同帧数摘要不同，说明壳和核心漂了');

    const ref = referenceRaster(live.snap, live.phase);
    metrics.playerPixels = await countColor(page, PALETTE.player);
    metrics.expectedPlayerPixels = ref.counts.player;
    metrics.carPixels = await countColor(page, PALETTE.car);
    metrics.expectedCarPixels = ref.counts.car;
    metrics.logPixels = await countColor(page, PALETTE.log);
    metrics.expectedLogPixels = ref.counts.log;
    metrics.treePixels = await countColor(page, PALETTE.tree);
    metrics.expectedTreePixels = ref.counts.tree;
    metrics.deadPixels = await countColor(page, PALETTE.dead);
    metrics.expectedDeadPixels = ref.counts.dead;
    metrics.menuPixelsInPlay = await countColor(page, PALETTE.menu);
    expectEq(metrics.playerPixels, ref.counts.player, 'player-pixels', '玩家像素数不对');
    expectEq(metrics.carPixels, ref.counts.car, 'car-pixels', '车像素数不对');
    expectEq(metrics.logPixels, ref.counts.log, 'log-pixels', '木头像素数不对');
    expectEq(metrics.treePixels, ref.counts.tree, 'tree-pixels', '树像素数不对');
    expectEq(metrics.deadPixels, 0, 'dead-strip-absent-while-alive', '活着时不该有死亡横带');
    expectEq(metrics.menuPixelsInPlay, 0, 'menu-overlay-absent-while-playing', '开局后菜单遮罩应该消失');
    expect(ref.counts.car > 0 && ref.counts.log > 0 && ref.counts.tree > 0, 'reference-raster-non-empty', '参考光栅器一个实体都没画，那后面每条等号都是免费通过');

    metrics.bestRunScore = live.score;
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__diag);
    const afterReload = await page.evaluate(() => window.__diag.storage());
    metrics.bestAfterReload = afterReload.best;
    metrics.storageDegraded = !!afterReload.degraded;
    expectEq(afterReload.best, live.score, 'best-persists', '最高分没有写回存储');

    await page.evaluate(() => window.__diag.reset(1));
    let deathState = null;
    for (let i = 0; i < DEATH_ATTEMPTS; i += 1) {
      deathState = await page.evaluate(hop => window.__diag.stepWith('up', hop + 2), TUNING.hopFrames);
      if (deathState.phase === 'dead') break;
    }
    metrics.deathReason = deathState && deathState.reason;
    metrics.deathAttempts = DEATH_ATTEMPTS;
    const died = !!deathState && deathState.phase === 'dead';
    expect(died, 'reach-death-state', '直往前冲 ' + DEATH_ATTEMPTS + ' 次都没死，夹具没把输入注入进去');
    if (died) {
      const deadSnap = await page.evaluate(() => window.__diag.snapshot());
      const deadRef = referenceRaster(deadSnap, 'dead');
      metrics.deadPixels = await countColor(page, PALETTE.dead);
      metrics.expectedDeadPixels = deadRef.counts.dead;
      expectEq(metrics.deadPixels, deadRef.counts.dead, 'dead-strip-pixels', '死亡横带像素数不对');
      expect(deadRef.counts.dead > 0, 'dead-reference-non-empty', '参考光栅器没画死亡横带，上一条等号就是空的');
    } else {
      no('dead-strip-pixels', '根因在前面那条 reach-death-state，先看它的证据');
      no('dead-reference-non-empty', '根因在前面那条 reach-death-state，先看它的证据');
    }

    const f0 = await page.evaluate(() => window.__diag.frames());
    await page.waitForTimeout(1000);
    const f1 = await page.evaluate(() => window.__diag.frames());
    const fps = f1 - f0;
    metrics.fps = fps;
    metrics.fpsFloor = FPS_FLOOR;
    metrics.fpsBaseline = FPS_BASELINE;
    expect(fps >= FPS_FLOOR, 'fps-floor', '帧率太低，像是循环卡住了');
    expect(FPS_FLOOR <= Math.floor(FPS_BASELINE / 3), 'fps-floor-not-too-tight', '帧率下限太紧，会制造假红');

    const playShot = await page.locator('#stage').screenshot();
    shots.push({ name: 'play.png', bytes: playShot.length, sha: sha(playShot) });
    const deadShot = await page.locator('#wrap').screenshot();
    shots.push({ name: 'dead.png', bytes: deadShot.length, sha: sha(deadShot) });
    metrics.shots = shots;
    expect(shots.every(s => s.bytes > 0), 'shots-non-empty', '截图有空壳');
    expect(new Set(shots.map(s => s.sha)).size === shots.length, 'shots-distinct', '几张图居然一模一样，像是截图采在同一帧冻结状态');

    fs.mkdirSync('artifacts', { recursive: true });
    fs.writeFileSync('artifacts/menu.png', menu);
    fs.writeFileSync('artifacts/play.png', playShot);
    fs.writeFileSync('artifacts/dead.png', deadShot);
  } finally {
    await page.close().catch(() => null);
    await browser.close().catch(() => null);
    await server.close().catch(() => null);
  }

  const report = { total: pass.length + fail.length, passed: pass.length, failures: fail, metrics };
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/verify-web-report.json', JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (fail.length) process.exit(1);
}

main().catch(err => {
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/verify-web-report.json', JSON.stringify({ total: 1, passed: 0, failures: [String(err && err.stack || err)], metrics }, null, 2) + '\n');
  throw err;
});
