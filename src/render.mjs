/* canvas 上只画平色整数矩形，一个字都不写。

   为什么这么苛刻：浏览器闸门里承重的那条断言是「canvas 上每种探针色的像素数
   == 一个独立光栅器从快照算出来的数」，一条等号同时守住三件事,画出来了、
   画对了几个、画面已经追上了状态。描边、渐变、半透明、抗锯齿的文字，任何一样
   都会把这条等号悄悄变成近似。

   所以：分数和提示文字全在 DOM 里，不在 canvas 上。有扫描器守着这两件事。

   这里的几何规则与 scripts/verify-web.mjs 里那个光栅器是**一组耦合参数**：
   两边各写一遍是故意的（独立的尺），改一边必须改另一边。规则写在 AGENTS.md。 */
import { PALETTE } from './palette.mjs';
import { TUNING } from './engine.mjs';

export function canvasSize() {
  return { w: TUNING.cols * TUNING.cell, h: TUNING.viewRows * TUNING.cell };
}

/* 全仓唯一一处 fillRect。取整在这里发生，有一条断言数它只出现一次。 */
function rectPx(ctx, color, x, y, w, h) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function bandColor(row) {
  const odd = row.index % 2 !== 0;
  if (row.type === 'grass') return odd ? PALETTE.grassAlt : PALETTE.grass;
  if (row.type === 'road') return odd ? PALETTE.roadAlt : PALETTE.road;
  return odd ? PALETTE.riverAlt : PALETTE.river;
}

export function render(ctx, snap, phase) {
  const size = canvasSize();
  const cell = TUNING.cell;
  for (let i = 0; i < snap.rows.length; i += 1) {
    const row = snap.rows[i];
    const top = size.h - cell - (row.index * cell - snap.camPx);
    if (top >= size.h || top + cell <= 0) continue;
    rectPx(ctx, bandColor(row), 0, top, size.w, cell);
    if (row.type === 'grass') {
      for (let t = 0; t < row.trees.length; t += 1) {
        rectPx(ctx, PALETTE.tree, row.trees[t] * cell, top, cell, cell);
      }
    } else if (row.type === 'river') {
      for (let e = 0; e < row.entities.length; e += 1) {
        rectPx(ctx, PALETTE.log, (row.entities[e] - row.len / 2) * cell, top + 6, row.len * cell, cell - 12);
      }
    } else {
      for (let e = 0; e < row.entities.length; e += 1) {
        rectPx(ctx, PALETTE.car, (row.entities[e] - row.len / 2) * cell, top + 8, row.len * cell, cell - 16);
      }
    }
  }
  const pTop = size.h - cell - (snap.player.visualRow * cell - snap.camPx);
  rectPx(ctx, PALETTE.player, snap.player.visualX * cell + 8, pTop + 8, cell - 16, cell - 16);
  if (snap.status === 'dead') {
    rectPx(ctx, PALETTE.dead, 0, Math.round(size.h / 2) - 72, size.w, 144);
  }
  if (phase === 'menu') {
    rectPx(ctx, PALETTE.menu, 0, 0, size.w, size.h);
  }
}
