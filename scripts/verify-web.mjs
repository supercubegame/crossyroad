#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { run } from '../src/engine.mjs';
import { PALETTE } from '../src/palette.mjs';

const FPS_FLOOR = 13;
const FPS_BASELINE = 40;
const BOT_FRAMES = 420;
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
function rgba(hex) {
  const s = hex.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 255];
}
function samePx(data, i, color) {
  return data[i] === color[0] && data[i + 1] === color[1] && data[i + 2] === color[2] && data[i + 3] === color[3];
}

/* 独立光栅器。它和 src/render.mjs 各写一遍，是故意的：同一份逻辑复制过来不叫验证，
   叫复读。两边要逐色对账，所以几何必须能人工读懂。 */
function rasterExpected(snap, palette) {
  const cell = snap.cell;
  const w = snap.cols * cell;
  const h = snap.viewRows * cell;
  const counts = { player: 0, car: 0, log: 0, tree: 0, dead: 0, menu: 0 };
  for (const row of snap.rows) {
    const top = h - cell - (row.index * cell - snap.camPx);
    if (top >= h || top + cell <= 0) continue;
    if (row.type === 'grass') {
      counts.tree += row.trees.length * cell * cell;
    } else if (row.type === 'river') {
      for (const x of row.entities) counts.log += Math.round(row.len * cell) * (cell - 12);
    } else {
      for (const x of row.entities) counts.car += Math.round(row.len * cell) * (cell - 16);
    }
  }
  counts.player = (cell - 16) * (cell - 16);
  return { w, h, counts, expectedMenuPixels: w * h, expectedDeadPixels: w * 144 };
}

async function main() {
  const server = await startServer(process.cwd(), 0);
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader']
  });
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
    const menuMetrics = await page.evaluate(() => {
      const snap = window.__diag.snapshot();
      const canvas = document.getElementById('stage');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const rgba = hex => {
        const s = hex.replace('#', '');
        return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 255];
      };
      const target = rgba(window.__diag.palette().menu);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === target[0] && data[i + 1] === target[1] && data[i + 2] === target[2] && data[i + 3] === target[3]) count += 1;
      }
      return { menuPixels: count, snap };
    });
    const menuExpected = rasterExpected(menuMetrics.snap, PALETTE);
    metrics.menuPixels = menuMetrics.menuPixels;
    metrics.expectedMenuPixels = menuExpected.expectedMenuPixels;
    expectEq(menuMetrics.menuPixels, menuExpected.expectedMenuPixels, 'menu-overlay-pixels', '菜单遮罩应该盖满整个画布');

    await page.click('#play');
    await page.waitForFunction(() => window.__diag.phase() === 'play');
    await page.evaluate(frames => window.__diag.advance(frames, true), BOT_FRAMES);
    await page.waitForFunction((frames) => window.__diag.snapshot().frame >= frames, BOT_FRAMES);
    const live = await page.evaluate(() => {
      const snap = window.__diag.snapshot();
      const pal = window.__diag.palette();
      const canvas = document.getElementById('stage');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const countColor = hex => {
        const s = hex.replace('#', '');
        const target = [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 255];
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === target[0] && data[i + 1] === target[1] && data[i + 2] === target[2] && data[i + 3] === target[3]) count += 1;
        }
        return count;
      };
      return {
        digest: window.__diag.digest(),
        score: window.__diag.score(),
        snap,
        playerPixels: countColor(pal.player),
        carPixels: countColor(pal.car),
        logPixels: countColor(pal.log),
        treePixels: countColor(pal.tree),
        deadPixels: countColor(pal.dead),
        menuPixels: countColor(pal.menu),
        storage: window.__diag.storage()
      };
    });
    const nodeRun = run(1, BOT_FRAMES);
    metrics.browserDigest = live.digest;
    metrics.nodeDigest = nodeRun.digest;
    expectEq(live.digest, nodeRun.digest, 'browser-vs-node-digest', '浏览器和 Node 同帧数摘要不同，说明壳和核心漂了');

    const expected = rasterExpected(live.snap, PALETTE);
    metrics.playerPixels = live.playerPixels;
    metrics.expectedPlayerPixels = expected.counts.player;
    metrics.carPixels = live.carPixels;
    metrics.expectedCarPixels = expected.counts.car;
    metrics.logPixels = live.logPixels;
    metrics.expectedLogPixels = expected.counts.log;
    metrics.treePixels = live.treePixels;
    metrics.expectedTreePixels = expected.counts.tree;
    metrics.deadPixels = live.deadPixels;
    metrics.expectedDeadPixels = 0;
    expectEq(live.playerPixels, expected.counts.player, 'player-pixels', '玩家像素数不对');
    expectEq(live.carPixels, expected.counts.car, 'car-pixels', '车像素数不对');
    expectEq(live.logPixels, expected.counts.log, 'log-pixels', '木头像素数不对');
    expectEq(live.treePixels, expected.counts.tree, 'tree-pixels', '树像素数不对');
    expectEq(live.deadPixels, 0, 'dead-strip-absent-while-alive', '活着时不该有死亡横带');
    expectEq(live.menuPixels, 0, 'menu-overlay-absent-while-playing', '开局后菜单遮罩应该消失');

    metrics.bestRunScore = live.score;
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__diag);
    const afterReload = await page.evaluate(() => window.__diag.storage());
    metrics.bestAfterReload = afterReload.best;
    metrics.storageDegraded = !!afterReload.degraded;
    expectEq(afterReload.best, live.score, 'best-persists', '最高分没有写回存储');

    await page.evaluate(() => window.__diag.reset(1));
    await page.evaluate(() => window.__diag.settle());
    let died = false;
    for (let i = 0; i < 30 && !died; i += 1) {
      await page.keyboard.press('ArrowDown');
      await page.evaluate(() => window.__diag.advance(8, false));
      died = await page.evaluate(() => window.__diag.phase() === 'dead');
    }
    expect(died, 'reach-death-state', '夹具没能触发死亡，后面的死亡断言全会变空');
    const dead = await page.evaluate(() => {
      const snap = window.__diag.snapshot();
      const pal = window.__diag.palette();
      const canvas = document.getElementById('stage');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const s = pal.dead.replace('#', '');
      const target = [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), 255];
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === target[0] && data[i + 1] === target[1] && data[i + 2] === target[2] && data[i + 3] === target[3]) count += 1;
      }
      return { count, snap };
    });
    metrics.deadPixels = dead.count;
    metrics.expectedDeadPixels = rasterExpected(dead.snap, PALETTE).expectedDeadPixels;
    expectEq(dead.count, metrics.expectedDeadPixels, 'dead-strip-pixels', '死亡横带像素数不对');

    const t0 = Date.now();
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
