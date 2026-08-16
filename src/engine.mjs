/* 纯核心：不读文件、不碰 DOM、不发网络、不用系统时间、不用未播种的随机。
   有一条扫描器守着这件事（先剥注释，并且先自证剥完还剩真东西）。

   两条刻意的设计：

   1. **车和木头的位置是 frame 的解析函数**，不靠逐帧累加。所以「第 900 帧长什么
      样」不取决于某一行是第几次被生成出来的,机器人预测未来也因此是 O(1)。
      玩家在木头上的漂移是全局唯一的累加量。
   2. **这个文件不许 import 任何东西。** 变异体是把这份源码改一个 TUNING 字段之后
      从 data: URL 直接 import 进来的，而 data: URL 解析不了相对路径。有一条断言
      守着,它一旦被违反，三个变异体会静默变成「加载失败」。 */

export const TUNING = {
  cols: 9,
  viewRows: 13,
  cell: 48,
  followRows: 3,
  hopFrames: 6,
  playerHalf: 0.34,
  carLen: 1.5,
  carHalf: 0.75,
  carMinGap: 1,
  logLenMin: 2,
  logLenMax: 3,
  safeRows: 3,
  treeChance: 0.3,
  maxTreesPerRow: 3,
  roadWeight: 4,
  riverWeight: 2,
  grassWeight: 4,
  edgeMargin: 2
};

export const CAR_SPEEDS = [0.035, 0.05, 0.065, 0.08];
export const LOG_SPEEDS = [0.02, 0.03, 0.04];
export const ROW_TYPES = ['grass', 'road', 'river'];

function hash32(a, b) {
  let h = (2166136261 ^ (a >>> 0)) >>> 0;
  h = Math.imul(h ^ (b >>> 0), 16777619) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 16777619) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function frac(seed, row, salt) {
  const mixed = Math.imul(row + 1, 2654435761) >>> 0;
  return hash32(hash32(seed, mixed), salt) / 4294967296;
}

function rawType(seed, index) {
  if (index < TUNING.safeRows) return 'grass';
  const total = TUNING.grassWeight + TUNING.roadWeight + TUNING.riverWeight;
  if (total <= 0) return 'grass';
  const pick = frac(seed, index, 1) * total;
  if (pick < TUNING.grassWeight) return 'grass';
  if (pick < TUNING.grassWeight + TUNING.roadWeight) return 'road';
  return 'river';
}

/* 不许连着两条河：连河能过，但会把机器人和新手一起困死在水上。
   只回看一行，而且回看的是 rawType,不递归，所以第 1000 行和第 3 行一样便宜。 */
export function rowType(seed, index) {
  const t = rawType(seed, index);
  if (t === 'river' && index >= 1 && rawType(seed, index - 1) === 'river') return 'grass';
  return t;
}

export function makeRow(seed, index) {
  const type = rowType(seed, index);
  const row = { index: index, type: type, dir: 0, speed: 0, count: 0, len: 0, phase: 0, trees: [] };
  if (type === 'grass') {
    if (index >= TUNING.safeRows) {
      for (let c = 0; c < TUNING.cols; c += 1) {
        if (frac(seed, index, 10 + c) < TUNING.treeChance) row.trees.push(c);
      }
      while (row.trees.length > TUNING.maxTreesPerRow) row.trees.pop();
    }
    return row;
  }
  row.dir = frac(seed, index, 2) < 0.5 ? -1 : 1;
  row.count = 2 + Math.floor(frac(seed, index, 4) * 2);
  row.phase = frac(seed, index, 5);
  if (type === 'road') {
    row.speed = CAR_SPEEDS[Math.floor(frac(seed, index, 3) * CAR_SPEEDS.length)];
    row.len = TUNING.carLen;
  } else {
    row.speed = LOG_SPEEDS[Math.floor(frac(seed, index, 3) * LOG_SPEEDS.length)];
    const span = TUNING.logLenMax - TUNING.logLenMin + 1;
    row.len = TUNING.logLenMin + Math.floor(frac(seed, index, 6) * span);
  }
  return row;
}

/* 一整圈的跨度。同一行里所有实体共享速度，所以间距恒等于 span/count,
   「车永远不会互相重叠」因此是构造保证的，不是靠逐帧检查碰运气。
   span 与 carMinGap 是一组耦合参数：改 carLen 或 count 上限必须重算间距。 */
export function rowSpan(row) {
  return TUNING.cols + row.len + TUNING.edgeMargin;
}

export function entitiesAt(row, frame) {
  const out = [];
  if (!row || row.type === 'grass' || row.count <= 0) return out;
  const span = rowSpan(row);
  const start = -(row.len / 2) - TUNING.edgeMargin / 2;
  const gap = span / row.count;
  const travel = row.speed * frame * row.dir;
  for (let i = 0; i < row.count; i += 1) {
    let x = row.phase * span + i * gap + travel;
    x = ((x - start) % span + span) % span + start;
    out.push(x);
  }
  return out;
}

export function createState(seed) {
  const startX = Math.floor(TUNING.cols / 2);
  return {
    seed: (seed === undefined ? 1 : seed) >>> 0,
    frame: 0,
    status: 'play',
    deathReason: null,
    score: 0,
    rows: new Map(),
    player: { x: startX, row: 0, hopT: 0, fromX: startX, fromRow: 0, toX: startX, toRow: 0 }
  };
}

export function rowAt(state, index) {
  let row = state.rows.get(index);
  if (!row) {
    row = makeRow(state.seed, index);
    state.rows.set(index, row);
  }
  return row;
}

export function visualX(player) {
  if (player.hopT === 0) return player.x;
  return player.fromX + (player.toX - player.fromX) * (player.hopT / TUNING.hopFrames);
}

export function visualRow(player) {
  if (player.hopT === 0) return player.row;
  return player.fromRow + (player.toRow - player.fromRow) * (player.hopT / TUNING.hopFrames);
}

export function hasTree(state, rowIndex, col) {
  const row = rowAt(state, rowIndex);
  return row.type === 'grass' && row.trees.indexOf(col) >= 0;
}

function die(state, reason) {
  state.status = 'dead';
  state.deathReason = reason;
  return state;
}

function tryHop(state, input) {
  const p = state.player;
  let tx = p.x;
  let tr = p.row;
  if (input === 'up') tr += 1;
  else if (input === 'down') tr -= 1;
  else if (input === 'left') tx -= 1;
  else if (input === 'right') tx += 1;
  else return false;
  if (tr < 0) return false;
  const target = rowAt(state, tr);
  const snapX = target.type === 'river' ? tx : Math.round(tx);
  if (snapX < 0 || snapX > TUNING.cols - 1) return false;
  if (hasTree(state, tr, Math.round(snapX))) return false;
  p.fromX = p.x;
  p.fromRow = p.row;
  p.toX = snapX;
  p.toRow = tr;
  p.hopT = 1;
  return true;
}

export function step(state, input) {
  if (state.status !== 'play') return state;
  state.frame += 1;
  const p = state.player;
  if (p.hopT === 0) {
    if (input) tryHop(state, input);
  } else {
    p.hopT += 1;
    if (p.hopT >= TUNING.hopFrames) {
      p.x = p.toX;
      p.row = p.toRow;
      p.hopT = 0;
    }
  }
  const evalRow = p.hopT === 0 ? p.row : p.toRow;
  const row = rowAt(state, evalRow);
  if (p.hopT === 0 && row.type === 'river') {
    const logs = entitiesAt(row, state.frame);
    let carrier;
    for (let i = 0; i < logs.length; i += 1) {
      if (Math.abs(p.x - logs[i]) <= row.len / 2) carrier = logs[i];
    }
    if (carrier === undefined) return die(state, 'drown');
    p.x += row.speed * row.dir;
    if (p.x < -0.5 || p.x > TUNING.cols - 0.5) return die(state, 'washed');
  }
  if (row.type === 'road') {
    const vx = visualX(p);
    const cars = entitiesAt(row, state.frame);
    for (let i = 0; i < cars.length; i += 1) {
      if (Math.abs(cars[i] - vx) < TUNING.carHalf + TUNING.playerHalf) return die(state, 'car');
    }
  }
  if (p.hopT === 0 && p.row > state.score) state.score = p.row;
  return state;
}

/* 只读诊断出口。字段可以增加，不能删改：闸门认这些名字，一次重构就能把它弄哑。
   浏览器闸门里有一条派生断言,它扫自己源码里用到的 snap.<字段>，逐个要求这里有。 */
export function snapshot(state) {
  const p = state.player;
  const camRow = Math.max(0, visualRow(p) - TUNING.followRows);
  const camPx = Math.round(camRow * TUNING.cell);
  const bottomRow = Math.floor(camPx / TUNING.cell);
  const rows = [];
  for (let i = bottomRow; i <= bottomRow + TUNING.viewRows; i += 1) {
    const row = rowAt(state, i);
    rows.push({
      index: i,
      type: row.type,
      len: row.len,
      trees: row.trees.slice(),
      entities: entitiesAt(row, state.frame)
    });
  }
  return {
    frame: state.frame,
    status: state.status,
    deathReason: state.deathReason,
    score: state.score,
    cols: TUNING.cols,
    cell: TUNING.cell,
    viewRows: TUNING.viewRows,
    camPx: camPx,
    bottomRow: bottomRow,
    player: {
      x: p.x,
      row: p.row,
      hopT: p.hopT,
      visualX: visualX(p),
      visualRow: visualRow(p)
    },
    rows: rows
  };
}

export function digest(state) {
  const snap = snapshot(state);
  const fix = function (n) { return Number(n).toFixed(4); };
  const parts = [snap.frame, snap.status, String(snap.deathReason), snap.score,
    fix(snap.player.x), snap.player.row, snap.player.hopT, snap.camPx, snap.bottomRow];
  for (let i = 0; i < snap.rows.length; i += 1) {
    const r = snap.rows[i];
    parts.push(r.index, r.type, r.len, r.trees.join('.'), r.entities.map(fix).join(','));
  }
  const text = parts.join('|');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/* 落地安全判定。机器人和闸门都用它。安全窗口长度与 hopFrames 是一组耦合参数：
   过河的判定必须在**落地那一帧**脚下有木头，而不是「现在」有。 */
export function safeToLand(state, rowIndex, col) {
  if (rowIndex < 0) return false;
  if (col < 0 || col > TUNING.cols - 1) return false;
  const row = rowAt(state, rowIndex);
  const settle = TUNING.hopFrames + 12;
  if (row.type === 'grass') return row.trees.indexOf(col) < 0;
  if (row.type === 'road') {
    const reach = TUNING.carHalf + TUNING.playerHalf + 0.15;
    for (let f = state.frame + 1; f <= state.frame + settle; f += 1) {
      const cars = entitiesAt(row, f);
      for (let i = 0; i < cars.length; i += 1) {
        if (Math.abs(cars[i] - col) < reach) return false;
      }
    }
    return true;
  }
  const landFrame = state.frame + TUNING.hopFrames - 1;
  const logs = entitiesAt(row, landFrame);
  let onBoard = false;
  for (let i = 0; i < logs.length; i += 1) {
    if (Math.abs(col - logs[i]) <= row.len / 2 - 0.2) onBoard = true;
  }
  if (!onBoard) return false;
  let x = col;
  for (let f = 0; f < settle; f += 1) {
    x += row.speed * row.dir;
    if (x < 0 || x > TUNING.cols - 1) return false;
  }
  return true;
}

export function botInput(state) {
  const p = state.player;
  if (state.status !== 'play' || p.hopT !== 0) return null;
  const col = Math.round(p.x);
  if (safeToLand(state, p.row + 1, col)) return 'up';
  const ahead = rowAt(state, p.row + 1);
  if (ahead.type === 'grass' && ahead.trees.indexOf(col) >= 0) {
    for (let d = 1; d <= 2; d += 1) {
      const sides = [-1, 1];
      for (let s = 0; s < sides.length; s += 1) {
        const c = col + sides[s] * d;
        if (c < 0 || c > TUNING.cols - 1) continue;
        if (ahead.trees.indexOf(c) >= 0) continue;
        if (safeToLand(state, p.row, col + sides[s])) return sides[s] < 0 ? 'left' : 'right';
      }
    }
  }
  const here = rowAt(state, p.row);
  if (here.type !== 'grass') {
    const escapes = [[col - 1, p.row, 'left'], [col + 1, p.row, 'right'], [col, p.row - 1, 'down']];
    for (let i = 0; i < escapes.length; i += 1) {
      if (safeToLand(state, escapes[i][1], escapes[i][0])) return escapes[i][2];
    }
  }
  return null;
}

export function run(seed, frames, policy) {
  const pick = policy === undefined ? botInput : policy;
  const state = createState(seed);
  let steps = 0;
  for (let i = 0; i < frames; i += 1) {
    if (state.status !== 'play') break;
    step(state, pick ? pick(state) : null);
    steps += 1;
  }
  return { state: state, steps: steps, digest: digest(state), score: state.score };
}
