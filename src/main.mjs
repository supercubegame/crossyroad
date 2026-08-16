/* 壳：输入、循环、存档、DOM 上的字。游戏规则一条都不在这里,全在纯核心里。

   两条壳层的铁律，各有一条扫描器守着：
   - canvas 不做 devicePixelRatio 缩放（像素等号断言依赖 1:1）
   - 一个字都不画在 canvas 上（文字抗锯齿会污染像素计数） */
import { TUNING, createState, step, snapshot, digest, botInput } from './engine.mjs';
import { PALETTE } from './palette.mjs';
import { canvasSize, render } from './render.mjs';

const FRAME_MS = 1000 / 60;
const BEST_KEY = 'crossyroad.best';
const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right'
};

const canvas = document.getElementById('stage');
const size = canvasSize();
canvas.width = size.w;
canvas.height = size.h;
const ctx = canvas.getContext('2d', { alpha: false });

const elScore = document.getElementById('score');
const elBest = document.getElementById('best');
const elMenu = document.getElementById('menu');
const elDead = document.getElementById('over');
const elDeadWhy = document.getElementById('why');
const elDeadScore = document.getElementById('final');

let state = createState(1);
let phase = 'menu';
let paused = false;
let pending = null;
let rafFrames = 0;
let rafId = 0;
let acc = 0;
let lastTs = 0;
let storageDegraded = false;
let best = readBest();

function readBest() {
  try {
    const raw = window.localStorage.getItem(BEST_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch (err) {
    storageDegraded = true;
    return 0;
  }
}

function writeBest() {
  try {
    window.localStorage.setItem(BEST_KEY, String(best));
  } catch (err) {
    storageDegraded = true;
  }
}

function maybeStoreBest() {
  if (state.score > best) {
    best = state.score;
    writeBest();
  }
}

function randomSeed() {
  return (Math.floor(Math.random() * 4294967296)) >>> 0;
}

function startGame(seed) {
  state = createState(seed === undefined ? randomSeed() : seed >>> 0);
  phase = 'play';
  pending = null;
  acc = 0;
  syncDom();
  draw();
}

function onDeath() {
  phase = 'dead';
  maybeStoreBest();
  syncDom();
}

function reasonText(reason) {
  if (reason === 'car') return '被车撞了';
  if (reason === 'drown') return '掉进水里了';
  if (reason === 'washed') return '被木头冲出去了';
  return '结束了';
}

function syncDom() {
  elScore.textContent = String(state.score);
  elBest.textContent = String(best);
  elMenu.hidden = phase !== 'menu';
  elDead.hidden = phase !== 'dead';
  if (phase === 'dead') {
    elDeadWhy.textContent = reasonText(state.deathReason);
    elDeadScore.textContent = String(state.score);
  }
}

function draw() {
  render(ctx, snapshot(state), phase);
  elScore.textContent = String(state.score);
  elBest.textContent = String(best);
}

function tick() {
  const input = pending;
  pending = null;
  step(state, input);
  maybeStoreBest();
  if (state.status === 'dead' && phase === 'play') onDeath();
}

function loop(ts) {
  rafId = window.requestAnimationFrame(loop);
  rafFrames += 1;
  if (!lastTs) lastTs = ts;
  let dt = ts - lastTs;
  lastTs = ts;
  if (dt > 250) dt = 250;
  if (!paused && phase === 'play') {
    acc += dt;
    while (acc >= FRAME_MS) {
      acc -= FRAME_MS;
      tick();
    }
  }
  draw();
}

function onDir(dir) {
  if (phase === 'menu') {
    startGame();
    return;
  }
  if (phase === 'dead') return;
  pending = dir;
}

window.addEventListener('keydown', function (ev) {
  if (ev.code === 'Space' || ev.code === 'Enter') {
    ev.preventDefault();
    if (phase === 'menu') startGame();
    else if (phase === 'dead') startGame();
    return;
  }
  const dir = KEYMAP[ev.code];
  if (!dir) return;
  ev.preventDefault();
  onDir(dir);
});

document.getElementById('play').addEventListener('click', function () { startGame(); });
document.getElementById('again').addEventListener('click', function () { startGame(); });

let touchX = 0;
let touchY = 0;
canvas.addEventListener('touchstart', function (ev) {
  const t = ev.changedTouches[0];
  touchX = t.clientX;
  touchY = t.clientY;
}, { passive: true });
canvas.addEventListener('touchend', function (ev) {
  const t = ev.changedTouches[0];
  const dx = t.clientX - touchX;
  const dy = t.clientY - touchY;
  if (Math.abs(dx) < 24 && Math.abs(dy) < 24) {
    onDir('up');
    return;
  }
  if (Math.abs(dx) > Math.abs(dy)) onDir(dx > 0 ? 'right' : 'left');
  else onDir(dy > 0 ? 'down' : 'up');
}, { passive: true });

/* 闸门用的只读出口。字段可以加，不能删改。 */
window.__diag = {
  version: 1,
  phase: function () { return phase; },
  snapshot: function () { return snapshot(state); },
  digest: function () { return digest(state); },
  score: function () { return state.score; },
  status: function () { return state.status; },
  frames: function () { return rafFrames; },
  running: function () { return !paused && rafId !== 0; },
  setPaused: function (v) { paused = !!v; return paused; },
  reset: function (seed) { startGame(seed); return snapshot(state).frame; },
  advance: function (n, useBot) {
    for (let i = 0; i < n; i += 1) {
      if (state.status !== 'play') break;
      step(state, useBot ? botInput(state) : null);
      maybeStoreBest();
    }
    if (state.status === 'dead' && phase === 'play') onDeath();
    draw();
    return snapshot(state).frame;
  },
  settle: function () {
    let guard = 0;
    while (state.player.hopT !== 0 && state.status === 'play' && guard < TUNING.hopFrames + 2) {
      step(state, null);
      maybeStoreBest();
      guard += 1;
    }
    if (state.status === 'dead' && phase === 'play') onDeath();
    draw();
    return state.player.hopT;
  },
  press: function (dir) { onDir(dir); return pending; },
  draw: function () { draw(); return true; },
  geometry: function () { return { w: size.w, h: size.h, cell: TUNING.cell, cols: TUNING.cols, viewRows: TUNING.viewRows }; },
  tuning: function () { return Object.assign({}, TUNING); },
  palette: function () { return Object.assign({}, PALETTE); },
  storage: function () { return { degraded: storageDegraded, best: best }; }
};

syncDom();
draw();
rafId = window.requestAnimationFrame(loop);
