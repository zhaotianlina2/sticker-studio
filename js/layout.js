// 自动排版:让一组贴纸在画布上摆得有构图美感
// 思路:面积排序 → 主视觉落在黄金视觉点 → 其余按评分(重叠惩罚 + 重心平衡 + 边距)择位 → 交错小角度旋转

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 项目的碰撞半径(外接圆)
function radiusOf(it) {
  return Math.hypot(it._w, it._h) / 2 * it.scale * 0.86;
}

function overlapArea(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  const d = Math.hypot(dx, dy);
  const r = radiusOf(a) + radiusOf(b);
  if (d >= r) return 0;
  // 超出允许贴合量的部分算重叠(允许轻微搭接 8%)
  return (r - d) / (radiusOf(Math.min(radiusOf(a), radiusOf(b)) < 1 ? a : b) * 2 + 1e-6);
}

function scorePlacement(cand, placed, W, H, golden) {
  let s = 0;
  for (const p of placed) s += overlapArea(cand, p) * 26;
  // 加权重心靠近黄金点
  const gx = golden.x - cand.x, gy = golden.y - cand.y;
  s += Math.hypot(gx, gy) / Math.hypot(W, H) * 10;
  // 出界惩罚(以半径计)
  const r = radiusOf(cand);
  const m = r * 0.35;
  if (cand.x - r < m) s += (m - (cand.x - r)) / W * 60;
  if (cand.x + r > W - m) s += ((cand.x + r) - (W - m)) / W * 60;
  if (cand.y - r < m) s += (m - (cand.y - r)) / H * 60;
  if (cand.y + r > H - m) s += ((cand.y + r) - (H - m)) / H * 60;
  return s;
}

function fitGroup(items, W, H, coverage) {
  // 整体缩放,让组占据画布约 coverage 面积
  let area = 0;
  for (const it of items) area += Math.PI * radiusOf(it) ** 2;
  const target = W * H * coverage;
  const k = Math.sqrt(target / Math.max(area, 1));
  const cap = Math.min(2.4, Math.max(0.12, k));
  for (const it of items) {
    it.scale *= cap;
    // 单体过大再单独收敛
    const r = radiusOf(it);
    const maxR = Math.min(W, H) * 0.46;
    if (r > maxR) it.scale *= maxR / r;
  }
}

// 预设一:主次群组(杂志感)
function layoutCluster(items, W, H, rnd) {
  const golden = { x: W * 0.42, y: H * 0.44 };
  const placed = [];
  const [main, ...rest] = items;
  main.x = golden.x + (rnd() - 0.5) * W * 0.03;
  main.y = golden.y + (rnd() - 0.5) * H * 0.03;
  placed.push(main);
  for (let i = 0; i < rest.length; i++) {
    const it = rest[i];
    let best = null, bestS = Infinity;
    const ringR = radiusOf(main) * (0.78 + rnd() * 0.5) + radiusOf(it);
    const a0 = rnd() * Math.PI * 2;
    for (let t = 0; t < 140; t++) {
      const a = a0 + t / 140 * Math.PI * 2 * (1 + rnd() * 0.4);
      const rr = ringR * (0.82 + rnd() * 0.5);
      const cand = { x: main.x + Math.cos(a) * rr, y: main.y + Math.sin(a) * rr * 0.82, scale: it.scale, _w: it._w, _h: it._h };
      const s = scorePlacement(cand, placed, W, H, golden) + rnd() * 1.2;
      if (s < bestS) { bestS = s; best = cand; }
    }
    it.x = best.x; it.y = best.y;
    placed.push(it);
  }
}

// 预设二:底部一排(主持感)
function layoutRow(items, W, H, rnd) {
  const n = items.length;
  const rowH = H * (n <= 3 ? 0.5 : 0.42);
  // 等高化
  for (const it of items) {
    const r = rowH / 2 / Math.max(it._h * it.scale, 1);
    it.scale *= r;
  }
  const totalW = items.reduce((s, it) => s + it._w * it.scale, 0);
  const gap = Math.max(W * 0.02, (W * 0.92 - totalW) / Math.max(n - 1, 1) - (n > 1 ? 0 : 0));
  let widths = items.map(it => it._w * it.scale);
  const span = widths.reduce((a, b) => a + b, 0) + gap * (n - 1);
  let x = W / 2 - span / 2;
  const cy = H * 0.72;
  for (const it of items) {
    const w = it._w * it.scale;
    it.x = x + w / 2 + (rnd() - 0.5) * w * 0.06;
    it.y = cy + (rnd() - 0.5) * H * 0.04;
    x += w + gap;
  }
}

// 预设三:对角线
function layoutDiagonal(items, W, H, rnd) {
  const n = items.length;
  items.forEach((it, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    it.x = W * (0.2 + 0.6 * t) + (rnd() - 0.5) * W * 0.05;
    it.y = H * (0.78 - 0.56 * t) + (rnd() - 0.5) * H * 0.05;
  });
}

// 预设四:散落拼贴
function layoutScatter(items, W, H, rnd) {
  const placed = [];
  const golden = { x: W * 0.5, y: H * 0.48 };
  for (const it of items) {
    let best = null, bestS = Infinity;
    for (let t = 0; t < 220; t++) {
      const cand = { x: W * (0.12 + rnd() * 0.76), y: H * (0.12 + rnd() * 0.76), scale: it.scale, _w: it._w, _h: it._h };
      const s = scorePlacement(cand, placed, W, H, golden) + rnd() * 2.4;
      if (s < bestS) { bestS = s; best = cand; }
    }
    it.x = best.x; it.y = best.y;
    placed.push(it);
  }
}

// 预设五:整齐网格
function layoutGrid(items, W, H, rnd) {
  const n = items.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = W / cols, cellH = H / rows;
  items.forEach((it, i) => {
    const cx = (i % cols) * cellW + cellW / 2;
    const cy = Math.floor(i / cols) * cellH + cellH / 2;
    it.x = cx; it.y = cy;
    const maxR = Math.min(cellW, cellH) * 0.42;
    const r = radiusOf(it);
    if (r > maxR) it.scale *= maxR / r;
  });
}

// 预设六:环绕中心
function layoutRing(items, W, H, rnd) {
  const n = items.length;
  const R = Math.min(W, H) * 0.3;
  const a0 = rnd() * Math.PI * 2;
  items.forEach((it, i) => {
    const a = a0 + (i / n) * Math.PI * 2;
    it.x = W / 2 + Math.cos(a) * R * 1.15;
    it.y = H / 2 + Math.sin(a) * R * 0.85;
    const maxR = Math.min(W, H) * 0.24;
    const r = radiusOf(it);
    if (r > maxR) it.scale *= maxR / r;
  });
}

const PRESETS = {
  cluster: layoutCluster,
  row: layoutRow,
  diagonal: layoutDiagonal,
  scatter: layoutScatter,
  grid: layoutGrid,
  ring: layoutRing,
};

// items: [{_w,_h, x,y,scale}] 会被就地修改 x/y/scale/rot
export function autoLayout(items, W, H, preset, seed = 1) {
  if (!items.length) return;
  const rnd = mulberry32(seed * 7919 + 13);
  const area = (it) => it._w * it._h * it.scale * it.scale;
  // 保存原始顺序,按面积从大到小处理(主视觉优先)
  const order = [...items].sort((a, b) => area(b) - area(a));

  // 先归一 scale 到单位高度,便于统一处理
  for (const it of order) {
    it.scale = 1;
  }
  const PRESETS_FN = PRESETS[preset] || layoutCluster;

  // 统一初始尺寸:按最长边归一到画布短边的 0.4,保留素材间的大小层级
  const baseSize = Math.min(W, H) * 0.4;
  for (const it of order) {
    it.scale = baseSize / Math.max(it._w, it._h);
  }

  PRESETS_FN(order, W, H, rnd);

  // 整体覆盖度收敛
  if (preset !== "grid" && preset !== "ring") {
    fitGroup(order, W, H, preset === "row" ? 0.4 : 0.52);
  }
  // 收边:确保都在画布内(留 4% 边距)
  const margin = Math.min(W, H) * 0.04;
  for (const it of order) {
    const r = radiusOf(it);
    it.x = Math.max(Math.min(it.x, W - margin - r * 0.25), margin + r * 0.25);
    it.y = Math.max(Math.min(it.y, H - margin - r * 0.25), margin + r * 0.25);
  }
  // 交错小角度旋转(度 → 弧度)
  order.forEach((it, i) => {
    const dir = i % 2 === 0 ? 1 : -1;
    it.rot = dir * (2 + rnd() * 5) * Math.PI / 180;
  });
}
