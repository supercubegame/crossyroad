#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { run, TUNING } from '../src/engine.mjs';
import { PALETTE } from '../src/palette.mjs';
import { decodePng, comparePixels, distinctColors } from './png.mjs';

const FPS_FLOOR = 13;
const FPS_BASELINE = 40;
const BOT_FRAMES = 420;
const DEATH_ATTEMPTS = 60;
/* canvas 带 border-radius，元素截图的四个角会被裁掉，所以逐像素对账只比内部矩形。
   这个数不是拍的：下面有一条断言把它和真实的计算后半径钉在一起，改 CSS 就会红。 */
const PNG_INSET = 12;
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

   上一版是算面积账，连错两轮，根因同一个：面积账要手工重现绘制顺序和遮挡关系，
   而那是一笔算不清的账。画一遍再数，遮挡由构造正确。

   取整语义必须和 src/render.mjs 的 rectPx 逐字一致。 */
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

/* 把 canvas 的真像素搞出来。走 base64 而不是数组：100 多万个数字序列化成 JSON 会很难看。 */
async function readCanvasPixels(page) {
  const b64 = await page.evaluate(() => {
    const canvas = document.getElementById('stage');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let s = '';
    const step = 0x8000;
    for (let i = 0; i < d.length; i += step) {
      s += String.fromCharCode.apply(null, d.subarray(i, Math.min(i + step, d.length)));
    }
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
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

    /* 三个动作必须在同一次 evaluate 里，而且冻结要在 reset 之前。两个坑都在 CI 上
       真红过，而且方向相反：不冻结时 rAF 在我读完摘要后继续推帧（两轮摘要逐字
       相同而车像素 32736 vs 32960）；分两次往返时中间那一帧溢进来，停在 421。 */
    const startFrame = await page.evaluate(frames => {
      window.__diag.setPaused(true);
      window.__diag.reset(1);
      return window.__diag.advance(frames, true);
    }, BOT_FRAMES);
    const live = await page.evaluate(() => ({ digest: window.__diag.digest(), score: window.__diag.score(), snap: window.__diag.snapshot(), phase: window.__diag.phase(), frame: window.__diag.snapshot().frame }));
    const nodeRun = run(1, BOT_FRAMES);
    metrics.browserDigest = live.digest;
    metrics.nodeDigest = nodeRun.digest;
    metrics.frameAtMeasure = live.frame;
    metrics.frameBudget = BOT_FRAMES;
    expectEq(startFrame, BOT_FRAMES, 'frame-equals-budget', '推完固定预算后帧号不等于预算，说明有一帧 rAF 溢进来了');
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

    /* ---------- PNG 里画的和 canvas 里画的是同一帧吗 ----------

       之前三张截图只有「互不相同 + 字节非空」两条弱断言，真正的内容断言全在
       canvas 像素上,PNG 编码那一层没人看着。那不是空断言，是覆盖缺口，
       而两者在报告上长得一模一样：全绿。

       世界现在是冻住的，所以截图和 getImageData 拿到的必须是同一帧,下面那条
       frame-stable 断言跨过这整段，就是为了守这个前提。 */
    const radius = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('stage')).borderTopLeftRadius) || 0);
    metrics.canvasRadius = radius;
    metrics.pngInset = PNG_INSET;
    expect(PNG_INSET >= radius + 2, 'png-inset-covers-radius', '内边距盖不住 border-radius 的裁切，四个角会制造假红');

    const stageShot = await page.locator('#stage').screenshot();
    const decoded = decodePng(stageShot);
    const canvasPixels = await readCanvasPixels(page);
    metrics.pngBytes = stageShot.length;
    metrics.pngSize = decoded.width + 'x' + decoded.height;
    metrics.pngFiltersSeen = decoded.filtersSeen;
    expectEq(decoded.width, geo.w, 'png-width-matches-canvas', 'PNG 宽度和 canvas 不一样，后面逐像素比不了');
    expectEq(decoded.height, geo.h, 'png-height-matches-canvas', 'PNG 高度和 canvas 不一样，后面逐像素比不了');
    expectEq(canvasPixels.length, geo.w * geo.h * 4, 'canvas-readback-length', 'canvas 读回来的字节数不对');

    const pngColors = distinctColors(decoded.data, geo.w, geo.h, PNG_INSET);
    metrics.pngDistinctColors = pngColors;
    expect(pngColors > 3, 'png-not-flat', 'PNG 内部几乎是纯色，那下面那条逐像素等号会免费通过');

    const cmp = comparePixels(decoded.data, canvasPixels, geo.w, geo.h, PNG_INSET);
    metrics.pngDiff = cmp.diff;
    metrics.pngCompared = cmp.compared;
    metrics.pngFirstDiff = cmp.first;
    expectEq(cmp.diff, 0, 'png-vs-canvas', 'PNG 里画的和 canvas 里画的不是同一帧');
    expectEq(cmp.compared, (geo.w - 2 * PNG_INSET) * (geo.h - 2 * PNG_INSET), 'png-compared-whole-interior', '比较器没把整个内部矩形都比到');

    /* 变异体：翻一个像素，上面那条等号必须拓得出来。不配它的话，
       一个永远返回 0 的比较器会让 png-vs-canvas 变成纯装饰。 */
    const flipped = Buffer.from(decoded.data);
    const probe = ((PNG_INSET + 5) * geo.w + (PNG_INSET + 7)) * 4;
    flipped[probe] ^= 0xff;
    const pngMutant = comparePixels(flipped, canvasPixels, geo.w, geo.h, PNG_INSET);
    metrics.pngMutantDiff = pngMutant.diff;
    expectEq(pngMutant.diff, 1, 'png-comparator-not-decorative', '翻了一个像素居然没被拓出来，说明上面那条等号是装饰');

    const carAgain = await countColor(page, PALETTE.car);
    const frameAfter = await page.evaluate(() => window.__diag.snapshot().frame);
    metrics.frameAfterMeasure = frameAfter;
    expectEq(frameAfter, live.frame, 'frame-stable-during-measurement', '量像素期间世界又跑了，摘要和画面不是同一帧');
    expectEq(carAgain, metrics.carPixels, 'redraw-idempotent', '同一状态重读两次像素数就变了，渲染本身在抖');

    metrics.bestRunScore = live.score;
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__diag);
    const afterReload = await page.evaluate(() => window.__diag.storage());
    metrics.bestAfterReload = afterReload.best;
    metrics.storageDegraded = !!afterReload.degraded;
    expectEq(afterReload.best, live.score, 'best-persists', '最高分没有写回存储');

    await page.evaluate(() => {
      window.__diag.setPaused(true);
      window.__diag.reset(1);
    });
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

    const playShot = await page.locator('#stage').screenshot();
    shots.push({ name: 'play.png', bytes: playShot.length, sha: sha(playShot) });
    const deadShot = await page.locator('#wrap').screenshot();
    shots.push({ name: 'dead.png', bytes: deadShot.length, sha: sha(deadShot) });
    metrics.shots = shots;
    expect(shots.every(s => s.bytes > 0), 'shots-non-empty', '截图有空壳');
    expect(new Set(shots.map(s => s.sha)).size === shots.length, 'shots-distinct', '几张图居然一模一样，像是截图采在同一帧冻结状态');

    /* 前面把循环冻住了，这里必须显式解冻，并且先自证它真的在跑，
       否则下面那条帧率断言会盯着一个静止的计数器，而报告里只会写「帧率太低」。 */
    await page.evaluate(() => {
      window.__diag.setPaused(false);
      window.__diag.reset(1);
    });
    const running = await page.evaluate(() => window.__diag.running());
    expect(running, 'loop-resumed-before-fps', '循环没有解冻，帧率断言会报一个假的低帧率');
    const f0 = await page.evaluate(() => window.__diag.frames());
    await page.waitForTimeout(1000);
    const f1 = await page.evaluate(() => window.__diag.frames());
    const fps = f1 - f0;
    metrics.fps = fps;
    metrics.fpsFloor = FPS_FLOOR;
    metrics.fpsBaseline = FPS_BASELINE;
    expect(fps >= FPS_FLOOR, 'fps-floor', '帧率太低，像是循环卡住了（循环在跑：' + running + '）');
    expect(FPS_FLOOR <= Math.floor(FPS_BASELINE / 3), 'fps-floor-not-too-tight', '帧率下限太紧，会制造假红');

    fs.mkdirSync('artifacts', { recursive: true });
    fs.writeFileSync('artifacts/menu.png', menu);
    fs.writeFileSync('artifacts/play.png', playShot);
    fs.writeFileSync('artifacts/dead.png', deadShot);
    fs.writeFileSync('artifacts/stage-frozen.png', stageShot);
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
