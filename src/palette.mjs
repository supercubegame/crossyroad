/* 只放平色。渐变、描边、半透明会让「这块区域该有多少个某色像素」变成一笔算不清的
   账，而那笔账正是浏览器闸门里承重的等号断言。有一条扫描器守着这件事。

   car / log / player / tree / dead / menu 是**探针色**：浏览器闸门数它们的像素，
   和一个独立光栅器算出来的数做逐个相等。所以这些值必须互不相同（有断言）。 */
export const PALETTE = {
  grass: '#5aa64b',
  grassAlt: '#4f9a41',
  road: '#3b3b46',
  roadAlt: '#34343e',
  river: '#2f6f9e',
  riverAlt: '#2a6693',
  tree: '#2f6b34',
  car: '#e5484d',
  log: '#8a5a2b',
  player: '#f5d90a',
  dead: '#7a1020',
  menu: '#101018'
};

export const PROBE_COLORS = ['car', 'log', 'player', 'tree', 'dead', 'menu'];
