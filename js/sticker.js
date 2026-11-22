// 贴纸质感生成:白边、手撕毛边、做旧调色、半调网点、纸张颗粒
// 所有函数纯客户端,输入输出都是 canvas

// ---------- 确定性随机(保证重生成时边缘形状稳定) ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------- 纸张颗粒纹理(单例) ----------
let grainCanvas = null;
function getGrain() {
  if (grainCanvas) return grainCanvas;
  grainCanvas = document.createElement("canvas");
  grainCanvas.width = grainCanvas.height = 160;
  const g = grainCanvas.getContext("2d");
  const img = g.createImageData(160, 160);
  const rnd = mulberry32(1234);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 118 + rnd() * 74; // 中灰为主,深浅起伏
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return grainCanvas;
}

export function addGrain(ctx, w, h, strength = 0.5) {
  if (strength <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = 0.16 * strength;
  const pat = ctx.createPattern(getGrain(), "repeat");
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.07 * strength;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ---------- 平滑噪声图(用于毛边抖动) ----------
function smoothNoiseMap(w, h, cell, seed) {
  const c = document.createElement("canvas");
  const gw = Math.max(2, Math.ceil(w / cell));
  const gh = Math.max(2, Math.ceil(h / cell));
  c.width = gw; c.height = gh;
  const g = c.getContext("2d");
  const img = g.createImageData(gw, gh);
  const rnd = mulberry32(seed);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rnd() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // 放大到目标尺寸即得到平滑噪声
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const o = out.getContext("2d");
  o.imageSmoothingEnabled = true;
  o.drawImage(c, 0, 0, w, h);
  return o.getImageData(0, 0, w, h).data;
}

// ---------- 从源图提取轮廓(白色剪影,保留羽化 alpha) ----------
function makeSilhouette(src) {
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  const g = c.getContext("2d");
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

// ---------- 膨胀轮廓 = 白边形状(模糊 + 噪声阈值,得到手撕感) ----------
function dilateSilhouette(src, radius, rough, seed) {
  const w = src.width, h = src.height;
  const rnd = mulberry32(seed);
  const base = radius * 0.55 + 1;
  // 多次不同模糊/偏移叠加,取最大 alpha → 不规则扩张
  const acc = document.createElement("canvas");
  acc.width = w; acc.height = h;
  const g = acc.getContext("2d");
  const passes = rough > 0.02 ? 4 : 2;
  for (let i = 0; i < passes; i++) {
    const j = rough * (i === 0 ? 0 : 1);
    const r = Math.max(0.5, base * (1 - j * 0.55) + (i > 0 ? rnd() * rough * 5 : 0));
    const dx = (rnd() - 0.5) * 2 * rough * 4;
    const dy = (rnd() - 0.5) * 2 * rough * 4;
    g.save();
    g.filter = `blur(${r}px)`;
    g.translate(dx, dy);
    g.drawImage(src, 0, 0);
    g.restore();
  }
  // 阈值化:每像素阈值受平滑噪声调制 → 咬合状毛边
  const noise = rough > 0.02 ? smoothNoiseMap(w, h, 14, seed ^ 0x9e37) : null;
  const data = g.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const t = noise ? 122 + (noise[i] / 255 - 0.5) * rough * 130 : 122;
    const a = px[i + 3];
    // 软阈值,保留一点抗锯齿
    px[i] = px[i + 1] = px[i + 2] = 255;
    px[i + 3] = Math.max(0, Math.min(255, (a - t) * 10));
  }
  g.putImageData(data, 0, 0);
  return acc;
}

// ---------- 构建复古白边贴纸 ----------
// src: canvas(已抠好图或不抠图直接用)
// params: { border:px, rough:0-1, age:0-1, halftone:0-1, grain:0-1 }
export function buildStickerBitmap(src, params, seed = 7) {
  const { border: B, rough, age, halftone: ht, grain } = params;
  const W = src.width + B * 2;
  const H = src.height + B * 2;
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d");

  if (B > 0) {
    const sil = makeSilhouette(src);
    const dil = dilateSilhouette(sil, B, rough, seed);
    // 白边底色(微暖的纸白)
    ctx.drawImage(dil, B, B);
    ctx.globalCompositeOperation = "source-in";
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#f7f2e4");
    grad.addColorStop(1, "#efe8d5");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  } else {
    // 无白边:直接铺满底形(保持原 alpha)
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  }

  // 做旧照片
  const f = age > 0.01
    ? `sepia(${(0.34 * age).toFixed(3)}) saturate(${(1 - 0.28 * age).toFixed(3)}) contrast(${(1 + 0.16 * age).toFixed(3)}) brightness(${(1 - 0.05 * age).toFixed(3)})`
    : "none";
  ctx.filter = f;
  ctx.drawImage(src, B, B);
  ctx.filter = "none";

  // 做旧泛黄覆盖
  if (age > 0.01) {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = `rgba(226,196,138,${0.14 * age})`;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // 半调网点(只作用于照片区域)
  if (ht > 0.01) {
    const reg = ctx.getImageData(B, B, src.width, src.height);
    ctx.save();
    ctx.fillStyle = `rgba(30,24,18,1)`;
    const cell = Math.max(4, Math.round(Math.min(src.width, src.height) / 150));
    const rnd = mulberry32(seed ^ 0x51ed);
    for (let yy = 0; yy < src.height; yy += cell) {
      for (let xx = 0; xx < src.width; xx += cell) {
        let lum = 0, n = 0;
        for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
          const sx = Math.min(src.width - 1, Math.floor(xx + cell * ox));
          const sy = Math.min(src.height - 1, Math.floor(yy + cell * oy));
          const i = (sy * src.width + sx) * 4;
          lum += (reg.data[i] * 0.299 + reg.data[i + 1] * 0.587 + reg.data[i + 2] * 0.114) / 255;
          n++;
        }
        lum /= n;
        const dark = 1 - lum;
        if (dark < 0.1) continue;
        const r = Math.pow(dark, 1.2) * cell * 0.6 * ht;
        if (r < 0.3) continue;
        ctx.globalAlpha = 0.42;
        ctx.beginPath();
        ctx.arc(B + xx + cell / 2 + (rnd() - 0.5), B + yy + cell / 2 + (rnd() - 0.5), r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // 纸纹颗粒(整个贴纸)
  addGrain(ctx, W, H, grain);
  return out;
}

// 给画布整图导出时加纸纹
export { addGrain as grain };
export { hashStr };
