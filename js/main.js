// 主流程:导入 → 抠图 → 贴纸化 → 编辑 → 排版 → 导出
import { Editor } from "./editor.js";
import { buildStickerBitmap } from "./sticker.js";
import { buildClipTextBitmap, buildBubbleBitmap } from "./text.js";
import { autoLayout } from "./layout.js";

const $ = (s) => document.querySelector(s);

// ---------- 编辑器 ----------
const editor = new Editor($("#board"));
editor.onChange = rebuildLayers;
editor.onSelect = renderProps;
editor.onDblClick = (it) => { if (it.kind !== "image") $("#prop-text")?.focus(); };

const toastEl = $("#toast");
let toastTimer = null;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), ms);
}

// ---------- 抠图 Worker ----------
const worker = new Worker("js/segment.worker.js", { type: "module" });
let engineReady = false;
let engineError = null;
const queue = [];       // {bitmap, name}
let busy = false;
let doneCount = 0, totalCount = 0;

const badge = $("#engine-badge");
probeVendor();
async function probeVendor() {
  let ok = false;
  try {
    const r = await fetch("vendor/transformers.min.js", { method: "HEAD" });
    ok = r.ok;
  } catch { ok = false; }
  badge.textContent = ok ? "抠图引擎: 本地资源就绪" : "抠图引擎: 首次联网加载";
  badge.className = "badge " + (ok ? "ok" : "warn");
}

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "ready") {
    engineReady = true;
    badge.textContent = "抠图引擎: 就绪" + (m.gpu ? "(GPU 加速)" : "(CPU 模式)");
    badge.className = "badge ok";
  } else if (m.type === "progress") {
    const pct = m.pct ?? 0;
    const overall = totalCount > 1 ? (doneCount + pct / 100) / totalCount : pct / 100;
    setQueue(m.note || "处理中…", Math.round(overall * 100));
  } else if (m.type === "result") {
    onSegmentDone(m);
    } else if (m.type === "error") {
      if (m.uid === undefined || m.uid === null) {
        engineError = m.message;
        badge.textContent = "抠图引擎: 不可用";
        badge.className = "badge bad";
        toast("抠图引擎加载失败:" + m.message, 6000);
        flushQueueRaw();
      } else {
        toast("这张抠图失败,已按原图导入(" + m.message.slice(0, 120) + ")", 5000);
        (window.__workerLogs = window.__workerLogs || []).push("RUN-ERR: " + m.message);
        const job = currentJob;
        currentJob = null; busy = false;
        if (job) addSticker(job.bitmap, defaultParams(job.bitmap.width, job.bitmap.height), job.name);
        pump();
      }
    } else if (m.type === "log") {
      (window.__workerLogs = window.__workerLogs || []).push(m.message);
      console.warn("[worker]", m.message);
    }
};
worker.onerror = (e) => {
  engineError = e.message || "worker error";
  badge.textContent = "抠图引擎: 出错";
  badge.className = "badge bad";
  toast("抠图引擎出错:" + engineError, 6000);
  flushQueueRaw();
};

function setQueue(text, pct) {
  const q = $("#queue");
  if (totalCount === 0 && !busy) { q.classList.add("hidden"); return; }
  q.classList.remove("hidden");
  $("#queue-text").textContent = text;
  $("#queue-bar").style.width = (pct ?? 0) + "%";
}
function hideQueueSoon() {
  if (!busy && totalCount === 0) setTimeout(() => $("#queue").classList.add("hidden"), 400);
}

let currentJob = null;
async function pump() {
  if (busy || queue.length === 0) { hideQueueSoon(); return; }
  const job = queue.shift();
  currentJob = job;
  busy = true;
  // worker 会接管所有权,主线程要保留一份用于合成贴纸
  try {
    const forWorker = await createImageBitmap(job.bitmap);
    worker.postMessage({ type: "run", uid: job.uid, bitmap: forWorker }, [forWorker]);
  } catch (e) {
    toast("导入失败:" + e.message, 4000);
    busy = false; currentJob = null;
    pump();
  }
}

let jobSeq = 1;
function enqueue(bitmap, name) {
  totalCount++;
  queue.push({ bitmap, name, uid: "job" + jobSeq++ });
  setQueue(`排队中(剩余 ${queue.length + (busy ? 1 : 0)} 张)…`, busy ? undefined : 0);
  if (!engineReady && !engineError) {
    badge.textContent = "抠图引擎: 启动中…";
  }
  pump();
}

async function onSegmentDone(m) {
  const job = currentJob;
  currentJob = null; busy = false;
  doneCount++;
  try {
    const mask = new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height);
    const maskC = document.createElement("canvas");
    maskC.width = m.width; maskC.height = m.height;
    maskC.getContext("2d").putImageData(mask, 0, 0);
    // 原图 × 掩码
    const cut = document.createElement("canvas");
    cut.width = m.width; cut.height = m.height;
    const g = cut.getContext("2d");
    g.drawImage(job.bitmap, 0, 0);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(maskC, 0, 0);
    addSticker(cut, defaultParams(m.width, m.height), job.name);
  } catch (err) {
    console.error(err);
    toast("贴纸生成出错:" + err.message, 5000);
  }
  job.bitmap.close?.();
  if (doneCount >= totalCount) { doneCount = 0; totalCount = 0; }
  pump();
}

function flushQueueRaw() {
  // 引擎不可用时,把队列里的图直接当贴纸导入
  while (queue.length) {
    const job = queue.shift();
    addSticker(job.bitmap, defaultParams(job.bitmap.width, job.bitmap.height), job.name);
  }
  busy = false; currentJob = null;
  totalCount = 0; doneCount = 0;
  hideQueueSoon();
}

function defaultParams(w, h) {
  return {
    border: Math.max(10, Math.min(90, Math.round(Math.min(w, h) * 0.05))),
    rough: 0.5, age: 0.55, halftone: 0.45, grain: 0.5,
    srcW: w, srcH: h,
  };
}

// 图片贴纸的原始画布注册表(撤销/复制后重建质感时兜底)
const srcMap = new Map();

function addSticker(srcCanvas, params, name) {
  const bmp = buildStickerBitmap(srcCanvas, params);
  const it = editor.add("image", bmp, {
    params, name: name || "图片贴纸", shadow: true,
  });
  Object.defineProperty(it, "src", { value: srcCanvas, enumerable: false, writable: true });
  srcMap.set(it.id, srcCanvas); // 重建质感时需要原图
  rebuildLayers();
  return it;
}

// ---------- 导入 ----------
$("#btn-import").addEventListener("click", () => openPicker(true));
$("#btn-import-raw").addEventListener("click", () => openPicker(false));
const fileInput = $("#file-input");
function openPicker(autoCut) {
  fileInput.dataset.autoCut = autoCut ? "1" : "";
  fileInput.value = "";
  fileInput.click();
}
fileInput.addEventListener("change", () => {
  importFiles([...fileInput.files], fileInput.dataset.autoCut !== "");
});

async function importFiles(files, autoCut) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    let bmp = await createImageBitmap(f, { imageOrientation: "from-image" }).catch(() => createImageBitmap(f));
    if (bmp.width > 2400 || bmp.height > 2400) {
      const k = 2400 / Math.max(bmp.width, bmp.height);
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      bmp = await createImageBitmap(c);
    }
    if (autoCut) enqueue(bmp, f.name.replace(/\.[^.]+$/, ""));
    else addSticker(bmp, defaultParams(bmp.width, bmp.height), f.name.replace(/\.[^.]+$/, ""));
  }
  $("#empty-hint")?.classList.toggle("hidden", editor.items.length > 0);
}

// 拖放
const stage = $("#stage");
const dropOverlay = $("#drop-overlay");
stage.addEventListener("dragover", (e) => { e.preventDefault(); dropOverlay.classList.add("show"); });
stage.addEventListener("dragleave", () => dropOverlay.classList.remove("show"));
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  dropOverlay.classList.remove("show");
  importFiles([...e.dataTransfer.files], true);
});

// 粘贴
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === "file").map(i => i.getAsFile()).filter(Boolean);
  if (files.length) importFiles(files, true);
});

// ---------- 文字贴纸 ----------
$("#btn-add-cliptext").addEventListener("click", () => {
  const params = { text: "剪报标题", fontPx: 76, paperColor: "#f6f1e1", inkColor: "#181310", rough: 0.6 };
  const bmp = buildClipTextBitmap(params);
  editor.add("cliptext", bmp, { params, name: "剪报字" });
});
$("#btn-add-bubble").addEventListener("click", () => {
  const params = { text: "咋就我来唱了…\n紧张捏…", fontPx: 58, paperColor: "#f4efdf", inkColor: "#14100c", tail: true };
  const bmp = buildBubbleBitmap(params);
  editor.add("bubble", bmp, { params, name: "气泡" });
});

// ---------- 图层面板 ----------
function rebuildLayers() {
  const box = $("#layers");
  box.innerHTML = "";
  $("#empty-hint")?.classList.toggle("hidden", editor.items.length > 0);
  if (!editor.items.length) {
    box.innerHTML = `<div class="layers-empty">还没有贴纸,先从左边导入图片吧</div>`;
    return;
  }
  for (let i = editor.items.length - 1; i >= 0; i--) {
    const it = editor.items[i];
    const row = document.createElement("div");
    row.className = "layer" + (it.id === editor.selId ? " sel" : "");
    const th = document.createElement("canvas");
    th.width = 68; th.height = 68;
    const g = th.getContext("2d");
    const k = 60 / Math.max(it._w, it._h);
    g.drawImage(it.bitmap, (68 - it._w * k) / 2, (68 - it._h * k) / 2, it._w * k, it._h * k);
    row.appendChild(th);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = it.name || (it.kind === "image" ? "图片贴纸" : it.kind === "cliptext" ? "剪报字" : "气泡");
    row.appendChild(name);
    const ops = document.createElement("span");
    ops.className = "ops";
    for (const [label, dir, title] of [["↑", "up", "上移一层"], ["↓", "down", "下移一层"]]) {
      const b = document.createElement("button");
      b.textContent = label; b.title = title;
      b.addEventListener("click", (e) => { e.stopPropagation(); editor.reorder(it.id, dir); });
      ops.appendChild(b);
    }
    row.appendChild(ops);
    row.addEventListener("click", () => editor.select(it.id));
    box.appendChild(row);
  }
}

// ---------- 属性面板 ----------
let propsDebounce = null;
function renderProps(it) {
  const sec = $("#props-sec");
  const box = $("#props");
  if (!it) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  $("#props-title").textContent = it.kind === "image" ? "🖼 贴纸属性" : it.kind === "cliptext" ? "📰 剪报字" : "💬 手写气泡";
  box.innerHTML = "";

  if (it.kind === "image") {
    const p = it.params;
    slider(box, "白边宽度", 0, 90, p.border, (v) => { rebuildImage(it, { border: v }); }, v => v + "px");
    slider(box, "毛边(手撕感)", 0, 100, Math.round(p.rough * 100), (v) => rebuildImage(it, { rough: v / 100 }));
    slider(box, "做旧程度", 0, 100, Math.round(p.age * 100), (v) => rebuildImage(it, { age: v / 100 }));
    slider(box, "网点(印刷感)", 0, 100, Math.round(p.halftone * 100), (v) => rebuildImage(it, { halftone: v / 100 }));
    slider(box, "纸纹颗粒", 0, 100, Math.round(p.grain * 100), (v) => rebuildImage(it, { grain: v / 100 }));
    checkbox(box, "投影", it.shadow, (v) => { it.shadow = v; editor.render(); });
    buttons(box, [
      ["⇋ 左右翻转", () => { it.flipX = !it.flipX; editor.render(); }],
      ["⇅ 上下翻转", () => { it.flipY = !it.flipY; editor.render(); }],
      ["⧉ 复制", () => editor.duplicate(it.id)],
      ["🗑 删除", () => editor.remove(it.id)],
    ]);
  } else if (it.kind === "cliptext") {
    const p = it.params;
    textarea(box, "文字", p.text, (v) => rebuildText(it, { text: v }));
    slider(box, "字号", 24, 220, p.fontPx, (v) => rebuildText(it, { fontPx: v }), v => v + "px");
    color(box, "纸条颜色", p.paperColor, (v) => rebuildText(it, { paperColor: v }));
    color(box, "文字颜色", p.inkColor, (v) => rebuildText(it, { inkColor: v }));
    buttons(box, [
      ["⧉ 复制", () => editor.duplicate(it.id)],
      ["🗑 删除", () => editor.remove(it.id)],
    ]);
  } else {
    const p = it.params;
    textarea(box, "文字(可换行)", p.text, (v) => rebuildText(it, { text: v }));
    slider(box, "字号", 24, 180, p.fontPx, (v) => rebuildText(it, { fontPx: v }), v => v + "px");
    checkbox(box, "带小尾巴", p.tail !== false, (v) => rebuildText(it, { tail: v }));
    color(box, "气泡颜色", p.paperColor, (v) => rebuildText(it, { paperColor: v }));
    color(box, "文字颜色", p.inkColor, (v) => rebuildText(it, { inkColor: v }));
    buttons(box, [
      ["⧉ 复制", () => editor.duplicate(it.id)],
      ["🗑 删除", () => editor.remove(it.id)],
    ]);
  }
}

function slider(box, label, min, max, val, onInput, fmt) {
  const d = document.createElement("div");
  d.className = "prop";
  d.innerHTML = `<label><span>${label}</span><span class="val">${fmt ? fmt(val) : val}</span></label>`;
  const r = document.createElement("input");
  r.type = "range"; r.min = min; r.max = max; r.value = val;
  const valEl = d.querySelector(".val");
  r.addEventListener("input", () => {
    valEl.textContent = fmt ? fmt(+r.value) : r.value;
    onInput(+r.value);
  });
  d.appendChild(r);
  box.appendChild(d);
}
function checkbox(box, label, val, onChange) {
  const l = document.createElement("label");
  l.className = "row";
  l.innerHTML = `<input type="checkbox"> ${label}`;
  const c = l.querySelector("input");
  c.checked = !!val;
  c.addEventListener("change", () => onChange(c.checked));
  box.appendChild(l);
}
function color(box, label, val, onChange) {
  const l = document.createElement("label");
  l.className = "row";
  l.innerHTML = `<span style="flex:1">${label}</span>`;
  const c = document.createElement("input");
  c.type = "color"; c.value = val || "#f6f1e1";
  c.addEventListener("input", () => onChange(c.value));
  l.appendChild(c);
  box.appendChild(l);
}
function textarea(box, label, val, onChange) {
  const d = document.createElement("div");
  d.className = "prop";
  d.innerHTML = `<label><span>${label}</span></label>`;
  const t = document.createElement("textarea");
  t.id = "prop-text";
  t.value = val || "";
  t.addEventListener("input", () => {
    clearTimeout(propsDebounce);
    propsDebounce = setTimeout(() => onChange(t.value), 260);
  });
  d.appendChild(t);
  box.appendChild(d);
}
function buttons(box, defs) {
  const row = document.createElement("div");
  row.className = "btn-row";
  for (const [label, fn] of defs) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", fn);
    row.appendChild(b);
  }
  box.appendChild(row);
}

function rebuildImage(it, patch) {
  Object.assign(it.params, patch);
  const p = it.params;
  const srcC = it.src || srcMap.get(it.id);
  if (!srcC) return;
  const oldW = it._w;
  const newW = p.srcW + p.border * 2;
  it.scale *= oldW / newW; // 保持照片世界尺寸不变
  const bmp = buildStickerBitmap(srcC, p);
  editor.updateBitmap(it, bmp, false);
}
function rebuildText(it, patch) {
  Object.assign(it.params, patch);
  const p = it.params;
  const bmp = it.kind === "cliptext" ? buildClipTextBitmap(p) : buildBubbleBitmap(p);
  editor.updateBitmap(it, bmp, true);
}

// ---------- 自动排版 ----------
let layoutSeed = 1;
$("#btn-layout").addEventListener("click", () => runLayout(false));
$("#btn-layout-reroll").addEventListener("click", () => runLayout(true));
function runLayout(reroll) {
  if (!editor.items.length) { toast("画布上还没有贴纸"); return; }
  if (reroll) layoutSeed++;
  autoLayout(editor.items, editor.W, editor.H, $("#layout-preset").value, layoutSeed);
  editor.render();
  editor._commit();
  toast("已按「" + $("#layout-preset").selectedOptions[0].textContent + "」排列");
}

// ---------- 背景 ----------
$("#bg-enabled").addEventListener("change", (e) => { editor.bg.enabled = e.target.checked; editor.render(); });
$("#bg-color").addEventListener("input", (e) => { editor.bg.color = e.target.value; if (editor.bg.enabled) editor.render(); });
$("#bg-grain").addEventListener("change", (e) => { editor.bg.grain = e.target.checked; if (editor.bg.enabled) editor.render(); });

// ---------- 画布尺寸 ----------
const presetSel = $("#canvas-preset");
presetSel.addEventListener("change", () => {
  const isCustom = presetSel.value === "custom";
  $("#canvas-w").classList.toggle("hidden", !isCustom);
  $("#canvas-h").classList.toggle("hidden", !isCustom);
  $("#canvas-x").classList.toggle("hidden", !isCustom);
  if (!isCustom) {
    const [w, h] = presetSel.value.split("x").map(Number);
    editor.setWorldSize(w, h);
  }
});
for (const id of ["#canvas-w", "#canvas-h"]) {
  $(id).addEventListener("change", () => {
    const w = Math.max(200, Math.min(6000, +$("#canvas-w").value || 1920));
    const h = Math.max(200, Math.min(6000, +$("#canvas-h").value || 1080));
    editor.setWorldSize(w, h);
  });
}

// ---------- 视图 / 历史 ----------
$("#btn-zoom-in").addEventListener("click", () => editor.setZoom("in"));
$("#btn-zoom-out").addEventListener("click", () => editor.setZoom("out"));
$("#btn-zoom-fit").addEventListener("click", () => editor.setZoom("fit"));
$("#btn-zoom-100").addEventListener("click", () => editor.setZoom("100"));
const undoBtn = $("#btn-undo"), redoBtn = $("#btn-redo");
undoBtn.addEventListener("click", () => editor.undo());
redoBtn.addEventListener("click", () => editor.redo());
editor.onHistory = (canUndo, canRedo) => { undoBtn.disabled = !canUndo; redoBtn.disabled = !canRedo; };

// ---------- 导出 ----------
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function download(canvas) {
  canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `贴纸工坊_${stamp()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, "image/png");
}
$("#btn-export").addEventListener("click", () => {
  if (!editor.items.length) { toast("画布是空的,先加点贴纸吧"); return; }
  download(editor.renderTo(document.createElement("canvas")));
  toast("已导出整图 PNG" + (editor.bg.enabled ? "" : "(透明背景)"));
});
$("#btn-copy").addEventListener("click", async () => {
  if (!editor.items.length) { toast("画布是空的"); return; }
  try {
    const c = editor.renderTo(document.createElement("canvas"));
    const blob = await new Promise(r => c.toBlob(r, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("已复制,可直接粘贴到剪映 / PPT / 微信");
  } catch (e) {
    toast("复制失败:" + e.message, 4000);
  }
});
$("#btn-export-item").addEventListener("click", () => {
  const sel = editor.getSelected();
  if (!sel) { toast("先在画布上选中一个贴纸"); return; }
  download(editor.exportItemTo(document.createElement("canvas"), sel, sel.shadow));
  toast("已导出选中贴纸(透明底)");
});

// ---------- 快捷键 ----------
document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
  const sel = editor.getSelected();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    e.shiftKey ? editor.redo() : editor.undo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
    e.preventDefault(); editor.redo();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
    e.preventDefault();
    if (sel) editor.duplicate(sel.id);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (sel) { e.preventDefault(); editor.remove(sel.id); }
  } else if (e.key.startsWith("Arrow") && sel) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") sel.x -= step;
    if (e.key === "ArrowRight") sel.x += step;
    if (e.key === "ArrowUp") sel.y -= step;
    if (e.key === "ArrowDown") sel.y += step;
    editor.render();
  } else if (e.key === "Escape") {
    editor.select(null);
  }
});

// 初始
rebuildLayers();
window.addEventListener("resize", () => editor.resize());

// 测试/自动化钩子(不影响正常使用)
window.__importFiles = importFiles;
window.__editor = editor;
window.__addClipText = () => $("#btn-add-cliptext").click();
window.__addBubble = () => $("#btn-add-bubble").click();
