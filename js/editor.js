// 画布编辑引擎:世界坐标(画布像素) + 视图变换
// item = { id, kind, bitmap, _w, _h, x, y, scale, rot, flipX, flipY, shadow, params, name }
import { addGrain } from "./sticker.js";

let _uid = 1;
const uid = () => "it" + (_uid++) + "_" + Math.random().toString(36).slice(2, 7);

export class Editor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.W = 1920; this.H = 1080;          // 世界尺寸
    this.view = { scale: 0.4, ox: 0, oy: 0 };
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.items = [];                        // 数组尾部 = 最上层
    this.bitmapCache = new Map();           // id -> canvas(供撤销恢复)
    this.selId = null;
    this.bg = { enabled: false, color: "#efe8d6", grain: true };
    this.onChange = null; this.onSelect = null; this.onDblClick = null;

    this._drag = null;
    this._hover = null;
    this._bindPointer();
    this._initHistory();
    this.resize();
  }

  // ---------- 视图 ----------
  resize() {
    const stage = this.canvas.parentElement;
    const cw = Math.max(80, stage.clientWidth - 48);
    const ch = Math.max(60, stage.clientHeight - 48);
    this.canvas.style.width = cw + "px";
    this.canvas.style.height = ch + "px";
    this.canvas.width = Math.round(cw * this.dpr);
    this.canvas.height = Math.round(ch * this.dpr);
    this.fitView();
    this.render();
  }

  fitView() {
    const cw = this.canvas.width / this.dpr, ch = this.canvas.height / this.dpr;
    const s = Math.min(cw / this.W, ch / this.H);
    this.view.scale = s;
    this.view.ox = (cw - this.W * s) / 2;
    this.view.oy = (ch - this.H * s) / 2;
  }

  setZoom(mode) {
    const cw = this.canvas.width / this.dpr, ch = this.canvas.height / this.dpr;
    if (mode === "fit") { this.fitView(); }
    else {
      const s = mode === "100" ? 1 : this.view.scale * (mode === "in" ? 1.25 : 0.8);
      const cx = cw / 2, cy = ch / 2;
      this.view.ox = cx - (cx - this.view.ox) * (s / this.view.scale);
      this.view.oy = cy - (cy - this.view.oy) * (s / this.view.scale);
      this.view.scale = Math.max(0.03, Math.min(10, s));
    }
    this.render();
  }

  toWorld(cssX, cssY) {
    return { x: (cssX - this.view.ox) / this.view.scale, y: (cssY - this.view.oy) / this.view.scale };
  }

  setWorldSize(W, H) {
    this.W = W; this.H = H;
    this.fitView(); this.render(); this._change();
  }

  // ---------- 项目管理 ----------
  add(kind, bitmap, opts = {}) {
    const it = {
      id: uid(), kind, bitmap,
      _w: bitmap.width, _h: bitmap.height,
      x: opts.x ?? this.W / 2, y: opts.y ?? this.H / 2,
      scale: opts.scale ?? 1, rot: opts.rot ?? 0,
      flipX: false, flipY: false, shadow: opts.shadow ?? true,
      params: opts.params || {}, name: opts.name || "",
    };
    // 图片贴纸:默认让高度约为画布 45%
    if (kind === "image" && !opts.scale) {
      it.scale = Math.min(1, (this.H * 0.45) / it._h);
    }
    // 文字贴纸:字号即位图大小,scale=1 但限制不超过画布 70%
    if (kind !== "image" && !opts.scale) {
      it.scale = Math.min(1.6, (this.W * 0.7) / it._w, (this.H * 0.6) / it._h);
    }
    this.bitmapCache.set(it.id, bitmap);
    this.items.push(it);
    this.select(it.id);
    this._change();
    return it;
  }

  updateBitmap(it, bitmap, keepVisualHeight = false) {
    const oldH = it._h;
    it.bitmap = bitmap;
    it._w = bitmap.width; it._h = bitmap.height;
    if (keepVisualHeight && oldH > 0) it.scale *= oldH / it._h;
    this.bitmapCache.set(it.id, bitmap);
    this.render(); this._change();
  }

  getSelected() { return this.items.find(i => i.id === this.selId) || null; }

  select(id) {
    this.selId = id;
    this.render();
    this.onSelect && this.onSelect(this.getSelected());
  }

  remove(id) {
    const i = this.items.findIndex(x => x.id === id);
    if (i >= 0) { this.items.splice(i, 1); if (this.selId === id) this.selId = null; this._change(); this.render(); }
  }

  duplicate(id) {
    const src = this.items.find(x => x.id === id);
    if (!src) return;
    const plain = { ...src, bitmap: null, _bctx: null, src: null };
    const copy = {
      ...structuredClone(plain),
      id: uid(), bitmap: src.bitmap, x: src.x + 18, y: src.y + 18,
    };
    copy.params = structuredClone(src.params);
    if (src.src) Object.defineProperty(copy, "src", { value: src.src, enumerable: false, writable: true });
    this.bitmapCache.set(copy.id, src.bitmap);
    const idx = this.items.indexOf(src);
    this.items.splice(idx + 1, 0, copy);
    this.select(copy.id); this._change(); this.render();
  }

  reorder(id, dir) { // dir: 'up'|'down'|'top'|'bottom'
    const i = this.items.findIndex(x => x.id === id);
    if (i < 0) return;
    const [it] = this.items.splice(i, 1);
    if (dir === "up") this.items.splice(Math.min(i + 1, this.items.length), 0, it);
    else if (dir === "down") this.items.splice(Math.max(i - 1, 0), 0, it);
    else if (dir === "top") this.items.push(it);
    else this.items.unshift(it);
    this._change(); this.render();
  }

  // ---------- 历史记录 ----------
  _snapshot() {
    return JSON.stringify(this.items.map(i => ({ ...i, bitmap: null, _bctx: null })));
  }
  _initHistory() {
    this._hist = [this._snapshot()];
    this._histIdx = 0;
    this._notifyHistory();
  }
  _commit() {
    this._hist.splice(this._histIdx + 1);
    this._hist.push(this._snapshot());
    if (this._hist.length > 50) this._hist.shift();
    this._histIdx = this._hist.length - 1;
    this._notifyHistory();
  }
  _notifyHistory() {
    this.onHistory && this.onHistory(this._histIdx > 0, this._histIdx < this._hist.length - 1);
  }
  _change() { this.onChange && this.onChange(); this._commit(); }
  undo() { if (this._histIdx > 0) { this._histIdx--; this._applyHist(); } }
  redo() { if (this._histIdx < this._hist.length - 1) { this._histIdx++; this._applyHist(); } }
  _applyHist() {
    const data = JSON.parse(this._hist[this._histIdx]);
    this.items = data
      .map(o => ({ ...o, bitmap: this.bitmapCache.get(o.id) || null }))
      .filter(i => i.bitmap);
    if (this.selId && !this.items.find(i => i.id === this.selId)) this.selId = null;
    this.render();
    this.onSelect && this.onSelect(this.getSelected());
  }

  // ---------- 渲染 ----------
  render() {
    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(this.dpr * this.view.scale, 0, 0, this.dpr * this.view.scale, this.dpr * this.view.ox, this.dpr * this.view.oy);

    if (this.bg.enabled) {
      ctx.fillStyle = this.bg.color;
      ctx.fillRect(0, 0, this.W, this.H);
      if (this.bg.grain) addGrain(ctx, 0, 0, this.W, this.H, 0.4);
    }

    for (const it of this.items) this._drawItem(ctx, it, this.view.scale * this.dpr);

    // 选中框(屏幕空间)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const sel = this.getSelected();
    if (sel) this._drawSelection(sel);
  }

  _drawItem(ctx, it, pixelScale) {
    ctx.save();
    if (it.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.36)";
      ctx.shadowBlur = 16 * pixelScale * it.scale;
      ctx.shadowOffsetY = 7 * pixelScale * it.scale;
    }
    ctx.translate(it.x, it.y);
    ctx.rotate(it.rot);
    ctx.scale(it.scale * (it.flipX ? -1 : 1), it.scale * (it.flipY ? -1 : 1));
    ctx.drawImage(it.bitmap, -it._w / 2, -it._h / 2);
    ctx.restore();
  }

  _itemCorners(it) {
    const hw = it._w * it.scale / 2, hh = it._h * it.scale / 2;
    const cos = Math.cos(it.rot), sin = Math.sin(it.rot);
    const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    return pts.map(([x, y]) => ({
      x: it.x + x * cos - y * sin,
      y: it.y + x * sin + y * cos,
    }));
  }

  _drawSelection(it) {
    const ctx = this.ctx;
    const v = this.view;
    const toS = (p) => ({ x: p.x * v.scale + v.ox, y: p.y * v.scale + v.oy });
    const corners = this._itemCorners(it).map(toS);
    ctx.save();
    ctx.strokeStyle = "#d8a24a";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    // 角点(缩放)
    ctx.fillStyle = "#fff8ec";
    for (const c of corners) {
      ctx.beginPath(); ctx.rect(c.x - 5, c.y - 5, 10, 10); ctx.fill(); ctx.stroke();
    }
    // 旋转柄
    const rh = this._rotateHandleScreen(it);
    const topMid = toS({ x: (corners[0].x + corners[1].x) / 2 / v.scale, y: (corners[0].y + corners[1].y) / 2 / v.scale });
    ctx.beginPath(); ctx.moveTo(topMid.x, topMid.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(rh.x, rh.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#d8a24a"; ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  _rotateHandleScreen(it) {
    const v = this.view;
    const corners = this._itemCorners(it);
    const tm = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    // 沿“上方”方向外推
    const dirx = (corners[1].x - corners[0].x), diry = (corners[1].y - corners[0].y);
    const len = Math.hypot(dirx, diry) || 1;
    const nx = dirx / len, ny = diry / len; // 单位向上(局部)
    const dist = 34 / v.scale;
    return { x: (tm.x + nx * dist) * v.scale + v.ox, y: (tm.y + ny * dist) * v.scale + v.oy };
  }

  // ---------- 命中测试 ----------
  _hitItem(wx, wy) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const dx = wx - it.x, dy = wy - it.y;
      const cos = Math.cos(-it.rot), sin = Math.sin(-it.rot);
      let lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
      if (it.flipX) lx = -lx;
      if (it.flipY) ly = -ly;
      const s = it.scale;
      const px = lx / s + it._w / 2, py = ly / s + it._h / 2;
      if (px < 0 || py < 0 || px >= it._w || py >= it._h) continue;
      const bctx = it._bctx || (it._bctx = it.bitmap.getContext("2d", { willReadFrequently: true }));
      try {
        const a = bctx.getImageData(Math.floor(px), Math.floor(py), 1, 1).data[3];
        if (a > 12) return it;
      } catch { return it; }
    }
    return null;
  }

  _hitHandle(cssX, cssY) {
    const sel = this.getSelected();
    if (!sel) return null;
    const v = this.view;
    const corners = this._itemCorners(sel).map(p => ({ x: p.x * v.scale + v.ox, y: p.y * v.scale + v.oy }));
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(corners[i].x - cssX, corners[i].y - cssY) <= 11) return { type: "scale", index: i };
    }
    const rh = this._rotateHandleScreen(sel);
    if (Math.hypot(rh.x - cssX, rh.y - cssY) <= 13) return { type: "rotate" };
    return null;
  }

  // ---------- 指针交互 ----------
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _bindPointer() {
    const cv = this.canvas;
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      const p = this._pos(e);
      const handle = this._hitHandle(p.x, p.y);
      if (handle && e.button === 0) {
        const sel = this.getSelected();
        this._drag = {
          mode: handle.type, item: sel,
          start: { x: sel.x, y: sel.y, scale: sel.scale, rot: sel.rot },
          p0: p, center: { x: sel.x * this.view.scale + this.view.ox, y: sel.y * this.view.scale + this.view.oy },
          ang0: Math.atan2(p.y - (sel.y * this.view.scale + this.view.oy), p.x - (sel.x * this.view.scale + this.view.ox)),
        };
        return;
      }
      const w = this.toWorld(p.x, p.y);
      const hit = this._hitItem(w.x, w.y);
      if (hit && e.button === 0) {
        this.select(hit.id);
        this._drag = { mode: "move", item: hit, start: { x: hit.x, y: hit.y }, p0w: w };
        cv.style.cursor = "grabbing";
      } else if (e.button === 1 || e.button === 0) {
        this._drag = { mode: "pan", ox0: this.view.ox, oy0: this.view.oy, p0: p, moved: false };
        if (e.button === 0 && !hit) { /* 抬起时若未移动则取消选中 */ }
      }
    });

    cv.addEventListener("pointermove", (e) => {
      const p = this._pos(e);
      if (!this._drag) {
        const h = this._hitHandle(p.x, p.y);
        const w = this.toWorld(p.x, p.y);
        const hit = h ? null : this._hitItem(w.x, w.y);
        cv.style.cursor = h ? (h.type === "rotate" ? "grab" : "nwse-resize") : hit ? "grab" : "default";
        return;
      }
      const d = this._drag;
      if (d.mode === "move") {
        const w = this.toWorld(p.x, p.y);
        d.item.x = d.start.x + (w.x - d.p0w.x);
        d.item.y = d.start.y + (w.y - d.p0w.y);
      } else if (d.mode === "scale") {
        const dist0 = Math.hypot(d.p0.x - d.center.x, d.p0.y - d.center.y) || 1;
        const dist1 = Math.hypot(p.x - d.center.x, p.y - d.center.y);
        d.item.scale = Math.max(0.03, Math.min(30, d.start.scale * (dist1 / dist0)));
      } else if (d.mode === "rotate") {
        const ang = Math.atan2(p.y - d.center.y, p.x - d.center.x);
        let r = d.start.rot + (ang - d.ang0);
        if (e.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
        d.item.rot = r;
      } else if (d.mode === "pan") {
        const dx = p.x - d.p0.x, dy = p.y - d.p0.y;
        if (Math.hypot(dx, dy) > 3) d.moved = true;
        this.view.ox = d.ox0 + dx;
        this.view.oy = d.oy0 + dy;
      }
      this.render();
    });

    const finish = (e) => {
      if (!this._drag) return;
      const d = this._drag;
      if (d.mode === "pan" && !d.moved && e.button === 0) {
        this.select(null);
      }
      if (d.mode === "move" || d.mode === "scale" || d.mode === "rotate") {
        this._change(); // 记录历史
      }
      this._drag = null;
      this.canvas.style.cursor = "default";
    };
    cv.addEventListener("pointerup", finish);
    cv.addEventListener("pointercancel", () => { this._drag = null; });

    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = this._pos(e);
      if (e.altKey) {
        // Alt+滚轮:缩放选中贴纸
        const sel = this.getSelected();
        if (sel) {
          sel.scale = Math.max(0.03, Math.min(30, sel.scale * Math.exp(-e.deltaY * 0.0016)));
          this.render(); this._change();
        }
        return;
      }
      // 滚轮:视图缩放(以光标为中心)
      const v = this.view;
      const oldS = v.scale;
      const ns = Math.max(0.03, Math.min(10, oldS * Math.exp(-e.deltaY * 0.0013)));
      v.ox = p.x - (p.x - v.ox) * (ns / oldS);
      v.oy = p.y - (p.y - v.oy) * (ns / oldS);
      v.scale = ns;
      this.render();
    }, { passive: false });

    cv.addEventListener("dblclick", (e) => {
      const p = this._pos(e);
      const w = this.toWorld(p.x, p.y);
      const hit = this._hitItem(w.x, w.y);
      if (hit && this.onDblClick) this.onDblClick(hit);
    });
  }

  // ---------- 导出 ----------
  renderTo(canvas, opts = {}) {
    canvas.width = this.W; canvas.height = this.H;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, this.W, this.H);
    if (opts.forceTransparent) {
      // 透明导出
    } else if (this.bg.enabled) {
      ctx.fillStyle = this.bg.color;
      ctx.fillRect(0, 0, this.W, this.H);
      if (this.bg.grain) addGrain(ctx, 0, 0, this.W, this.H, 0.4);
    }
    for (const it of this.items) this._drawItem(ctx, it, it.scale);
    return canvas;
  }

  exportItemTo(canvas, it, withShadow = true) {
    const pad = withShadow ? Math.round(Math.max(it._w, it._h) * 0.08) : 0;
    canvas.width = Math.round(it._w * it.scale) + pad * 2;
    canvas.height = Math.round(it._h * it.scale) + pad * 2;
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(it.rot);
    const saveS = it.scale;
    if (withShadow) {
      ctx.shadowColor = "rgba(0,0,0,0.36)";
      ctx.shadowBlur = 16 * saveS; ctx.shadowOffsetY = 7 * saveS;
    }
    ctx.scale(it.scale * (it.flipX ? -1 : 1), it.scale * (it.flipY ? -1 : 1));
    ctx.drawImage(it.bitmap, -it._w / 2, -it._h / 2);
    ctx.restore();
    return canvas;
  }
}
