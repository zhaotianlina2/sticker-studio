// 文字贴纸:📰 剪报字(撕报纸条 + 衬线大字) / 💬 手写气泡(歪歪扭扭纸泡 + 楷体)
import { mulberry32, hashStr, addGrain } from "./sticker.js";

const SERIF = '"Times New Roman", "SimSun", "宋体", serif';
const HAND = '"KaiTi", "STKaiti", "楷体", "Microsoft YaHei", sans-serif';

// ---------- 撕纸边路径 ----------
function tornRectPath(ctx, x, y, w, h, amp, rnd) {
  const seg = Math.max(6, Math.round(Math.min(w, h) / 14));
  const pts = [];
  const jitter = () => (rnd() - 0.5) * 2 * amp;
  // 上边
  for (let px = 0; px <= w; px += seg) pts.push([x + px, y + jitter()]);
  pts[pts.length - 1][0] = x + w;
  // 右边
  for (let py = seg; py <= h; py += seg) pts.push([x + w + jitter(), y + py]);
  pts[pts.length - 1][1] = y + h;
  // 下边(倒序)
  for (let px = w - seg; px >= 0; px -= seg) pts.push([x + px, y + h + jitter()]);
  pts[pts.length - 1][0] = x;
  // 左边
  for (let py = h - seg; py > 0; py -= seg) pts.push([x + jitter(), y + py]);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    ctx.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
  }
  ctx.closePath();
}

// ---------- 剪报字 ----------
// opts: { text, fontPx, paperColor, inkColor, rough }
export function buildClipTextBitmap(opts) {
  const text = (opts.text || "双击右侧修改").trim() || " ";
  const fontPx = Math.max(16, Math.round(opts.fontPx || 72));
  const seed = hashStr(text + "|" + fontPx);
  const rnd = mulberry32(seed);

  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `bold ${fontPx}px ${SERIF}`;
  const textW = measure.measureText(text).width;
  const padX = fontPx * 0.55, padY = fontPx * 0.34;
  const tornAmp = Math.max(2.5, fontPx * 0.055) * (0.5 + (opts.rough ?? 0.6));
  const W = Math.ceil(textW + padX * 2 + tornAmp * 2);
  const H = Math.ceil(fontPx * 1.28 + padY * 2 + tornAmp * 2);

  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");

  // 纸条(撕边)
  ctx.save();
  tornRectPath(ctx, tornAmp, tornAmp, W - tornAmp * 2, H - tornAmp * 2, tornAmp, rnd);
  ctx.fillStyle = opts.paperColor || "#f6f1e1";
  ctx.fill();
  ctx.clip();
  // 纸面细横纹(印刷行感)
  ctx.strokeStyle = "rgba(90,70,40,0.05)";
  ctx.lineWidth = 1;
  for (let y = tornAmp; y < H; y += Math.max(5, fontPx * 0.11)) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  addGrain(ctx, W, H, 0.55);
  ctx.restore();

  // 字
  ctx.font = `bold ${fontPx}px ${SERIF}`;
  ctx.fillStyle = opts.inkColor || "#181310";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // 轻微墨色不均
  const jx = (rnd() - 0.5) * fontPx * 0.02, jy = (rnd() - 0.5) * fontPx * 0.03;
  ctx.fillText(text, W / 2 + jx, H / 2 + jy);
  return c;
}

// ---------- 手写气泡 ----------
// opts: { text, fontPx, paperColor, inkColor, tail }
export function buildBubbleBitmap(opts) {
  const text = (opts.text || "双击修改文字…").trim() || " ";
  const fontPx = Math.max(16, Math.round(opts.fontPx || 56));
  const lines = text.split("\n");
  const seed = hashStr(text + "|" + fontPx);
  const rnd = mulberry32(seed);

  const measure = document.createElement("canvas").getContext("2d");
  measure.font = `bold ${fontPx}px ${HAND}`;
  let maxW = 0;
  for (const ln of lines) maxW = Math.max(maxW, measure.measureText(ln).width);
  const padX = fontPx * 0.8, padY = fontPx * 0.55, lineH = fontPx * 1.42;
  const tailH = opts.tail === false ? 0 : fontPx * 0.85;
  const W = Math.ceil(maxW + padX * 2);
  const H = Math.ceil(lines.length * lineH + padY * 2 + tailH);
  const bw = W, bh = H - tailH;

  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");

  // 云朵状歪边泡泡
  const cxm = bw / 2, cym = bh / 2;
  const rx = bw / 2, ry = bh / 2;
  const N = Math.max(14, Math.round((bw + bh) / 40));
  const pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const wob = 1 + (rnd() - 0.5) * 0.09;
    pts.push([cxm + Math.cos(a) * rx * wob, cym + Math.sin(a) * ry * wob]);
  }
  const drawBlob = () => {
    ctx.beginPath();
    ctx.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
    for (let i = 1; i <= N; i++) {
      const p = pts[i % N], q = pts[(i + 1) % N];
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
    }
    ctx.closePath();
  };
  // 尾巴(先画,被泡泡盖住接缝)
  if (tailH > 0) {
    const tx = bw * 0.22, ty = bh - fontPx * 0.12;
    ctx.beginPath();
    ctx.moveTo(tx - fontPx * 0.22, ty);
    ctx.quadraticCurveTo(tx - fontPx * 0.1, bh + tailH * 0.85, tx - fontPx * 0.42, bh + tailH * 0.98);
    ctx.quadraticCurveTo(tx + fontPx * 0.18, bh + tailH * 0.55, tx + fontPx * 0.34, ty);
    ctx.closePath();
    ctx.fillStyle = opts.paperColor || "#f4efdf";
    ctx.fill();
  }
  drawBlob();
  ctx.fillStyle = opts.paperColor || "#f4efdf";
  ctx.fill();
  ctx.save();
  drawBlob(); ctx.clip();
  addGrain(ctx, W, bh, 0.5);
  ctx.restore();

  // 逐字手写感(大小/位置/角度微抖)
  ctx.fillStyle = opts.inkColor || "#14100c";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  lines.forEach((ln, li) => {
    const y = padY + lineH * li + lineH / 2 - (tailH > 0 ? 0 : 0);
    // 逐字排布
    let x = cxm - measure.measureText(ln).width / 2;
    for (const ch of ln) {
      const s = 0.92 + rnd() * 0.16;
      const fs = fontPx * s;
      ctx.save();
      ctx.font = `bold ${fs}px ${HAND}`;
      const cw = measure.measureText ? ctx.measureText(ch).width : fs;
      ctx.translate(x + cw / 2, y + (rnd() - 0.5) * fontPx * 0.08);
      ctx.rotate((rnd() - 0.5) * 0.05);
      ctx.fillText(ch, 0, 0);
      ctx.restore();
      x += cw + fontPx * 0.02;
    }
  });
  return c;
}
