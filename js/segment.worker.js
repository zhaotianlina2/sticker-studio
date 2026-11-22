// 抠图引擎 Worker:RMBG-1.4 (ONNX, transformers.js)
// 引擎加载顺序:本地 vendor → jsDelivr → npmmirror → unpkg
// 模型策略:WebGPU(fp32,快)优先 → CPU 量化(q8,兼容)回退
// 模型来源:本地 vendor/models → hf-mirror.com → huggingface.co

let T = null;        // transformers.js 模块
let model = null;    // 已加载模型
let usingGPU = false;

const JS_SOURCES = [
  { js: "/vendor/transformers.min.js", wasm: "/vendor/ort/" },
  { js: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3/dist/transformers.min.js", wasm: null },
  { js: "https://registry.npmmirror.com/@huggingface/transformers/3.3.3/files/dist/transformers.min.js", wasm: null },
  { js: "https://unpkg.com/@huggingface/transformers@3.3.3/dist/transformers.min.js", wasm: null },
];

const MODEL_LOCAL = "/models/rmbg/model";
const MODEL_ID = "briaai/RMBG-1.4";
const REMOTE_HOSTS = ["https://hf-mirror.com", "https://huggingface.co"];

function post(msg, transfer) { self.postMessage(msg, transfer || []); }
function progress(stage, pct, note) { post({ type: "progress", stage, pct, note }); }

async function loadLibrary() {
  const errors = [];
  for (const s of JS_SOURCES) {
    try {
      progress("engine", 4, "加载推理引擎…");
      const mod = await import(/* @vite-ignore */ s.js);
      if (!mod || !mod.AutoModel) throw new Error("模块不完整");
      T = mod;
      T.env.allowLocalModels = true;
      T.env.allowRemoteModels = true;
      T.env.backends.onnx.wasm.numThreads = Math.min(4, (self.navigator && self.navigator.hardwareConcurrency) || 1);
      T.env.backends.onnx.wasm.proxy = false;
      if (s.wasm) T.env.backends.onnx.wasm.wasmPaths = s.wasm;
      progress("engine", 10, "推理引擎就绪");
      return;
    } catch (e) {
      errors.push(`${s.js}: ${e.message}`);
    }
  }
  throw new Error("无法加载推理引擎(本地与 CDN 均失败):\n" + errors.join("\n"));
}

// 预热推理,验证执行器真的能用(RMBG-1.4 固定 1024×1024 输入)
async function warmup() {
  const S = 1024;
  const data = new Float32Array(3 * S * S).fill(-0.5);
  const out = await runModel(new T.Tensor("float32", data, [1, 3, S, S]));
  if (!out || !out.data || out.data.length === 0) throw new Error("模型输出异常");
}

// 按 ONNX 会话要求的输入名喂张量(transformers.js v3 需要显式对象)
async function runModel(tensor) {
  let name = "input";
  try {
    const s = await (model.sessions?.model ?? model.session);
    if (s && s.inputNames && s.inputNames.length) name = s.inputNames[0];
  } catch { /* 用默认名 */ }
  const out = await model({ [name]: tensor });
  return out.output ?? out.logits ?? Object.values(out)[0];
}

async function tryLoadModel(source, plan) {
  const opts = {
    config: { model_type: "custom" },
    dtype: plan.dtype,
    device: plan.device,
    progress_callback: (p) => {
      if (p && p.status === "progress" && p.total) {
        const pct = 12 + (p.loaded / p.total) * 74;
        progress("model", pct, `下载模型(${plan.label}) ${(p.loaded / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(0)}MB,仅首次`);
      } else if (p && p.status === "done") {
        progress("model", 88, "模型就绪,正在初始化…");
      }
    },
  };
  if (source === "local") {
    model = await T.AutoModel.from_pretrained(MODEL_LOCAL, opts);
  } else {
    T.env.remoteHost = source;
    T.env.remotePathTemplate = "{model}/resolve/main/";
    model = await T.AutoModel.from_pretrained(MODEL_ID, opts);
  }
  // GPU 路径预热校验(CPU 太慢,跳过预热;失败会在首图时报错并降级导入)
  if (plan.device === "webgpu") await warmup();
}

async function loadModel() {
  const hasGPU = !!(self.navigator && self.navigator.gpu);
  const plans = hasGPU
    ? [{ device: "webgpu", dtype: "fp32", label: "GPU" }, { device: "wasm", dtype: "q8", label: "CPU" }]
    : [{ device: "wasm", dtype: "q8", label: "CPU" }];
  const sources = ["local", ...REMOTE_HOSTS];
  const errors = [];
  for (const source of sources) {
    for (const plan of plans) {
      // 远端下载 176MB 的 fp32 只在 GPU 可用时才尝试
      try {
        const srcLabel = source === "local" ? "本地" : source.replace("https://", "");
        progress("model", 12, `${srcLabel} · ${plan.label === "GPU" ? "GPU 模式" : "CPU 模式"}…`);
        await tryLoadModel(source, plan);
        usingGPU = plan.device === "webgpu";
        progress("model", 92, usingGPU ? "GPU 抠图引擎就绪" : "CPU 抠图引擎就绪");
        post({ type: "ready", gpu: usingGPU, source: source === "local" ? "local" : srcLabel2(source) });
        return;
      } catch (e) {
        errors.push(`[${source}/${plan.device}] ${e.message}`);
        post({ type: "log", message: `模型加载失败 ${source}/${plan.device}: ${e.message}` });
        model = null;
      }
    }
  }
  throw new Error("抠图模型加载失败(所有方式均不可达):\n" + errors.slice(-3).join("\n"));
}

function srcLabel2(source) { return source.replace("https://", ""); }

// 推理:输入 ImageBitmap,输出全尺寸 alpha 掩码
async function segment(bitmap, uid) {
  const w = bitmap.width, h = bitmap.height;
  const S = 1024;
  const inC = new OffscreenCanvas(S, S);
  const inG = inC.getContext("2d", { willReadFrequently: true });
  inG.drawImage(bitmap, 0, 0, S, S);
  const idata = inG.getImageData(0, 0, S, S).data;
  const arr = new Float32Array(3 * S * S);
  const plane = S * S;
  for (let i = 0, p = 0; i < idata.length; i += 4, p++) {
    arr[p] = idata[i] / 255 - 0.5;
    arr[plane + p] = idata[i + 1] / 255 - 0.5;
    arr[2 * plane + p] = idata[i + 2] / 255 - 0.5;
  }
  const input = new T.Tensor("float32", arr, [1, 3, S, S]);

  progress("run", 94, usingGPU ? "GPU 正在抠图…" : "正在抠图(CPU,约需 1-3 分钟)…");
  await new Promise(r => setTimeout(r, 30));
  const tensor = await runModel(input);
  const td = tensor.data;

  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < td.length; i++) { const v = td[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const range = mx - mn || 1;
  const maskC = new OffscreenCanvas(S, S);
  const mG = maskC.getContext("2d", { willReadFrequently: true });
  const mImg = mG.createImageData(S, S);
  for (let i = 0, p = 0; i < td.length; i++, p += 4) {
    let a = ((td[i] - mn) / range) * 255;
    if (a < 24) a = 0; else if (a > 232) a = 255;
    mImg.data[p] = mImg.data[p + 1] = mImg.data[p + 2] = 255;
    mImg.data[p + 3] = a;
  }
  mG.putImageData(mImg, 0, 0);

  const upC = new OffscreenCanvas(w, h);
  const uG = upC.getContext("2d", { willReadFrequently: true });
  uG.imageSmoothingEnabled = true;
  uG.drawImage(maskC, 0, 0, w, h);
  const final = uG.getImageData(0, 0, w, h);
  bitmap.close?.();
  progress("run", 100, "完成");
  post({ type: "result", uid, width: w, height: h, rgba: final.data.buffer }, [final.data.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "init" || msg.type === "run") {
      if (!model) {
        await loadLibrary();
        await loadModel();
      }
      if (msg.type === "init") return;
      await segment(msg.bitmap, msg.uid);
    }
  } catch (err) {
    post({ type: "error", uid: msg.uid, message: String(err && err.message || err) });
  }
};
