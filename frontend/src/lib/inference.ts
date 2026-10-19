import type * as ortTypes from "onnxruntime-web";

export interface RawMeasureBox {
  measure_number: number;
  system_index: number;
  measure_in_system: number;
  page_number: number;
  box: [number, number, number, number]; // [x1, y1, x2, y2]
  confidence: number;
  bars: number;
}

export interface RenderedPage {
  page_number: number;
  width: number;
  height: number;
  image_url: string;
  canvas: HTMLCanvasElement;
}

const MODEL_INPUT_SIZE = 1024;
const CONF_THRESHOLD = 0.45;
const IOU_THRESHOLD = 0.5;

async function createOrtSession(): Promise<ortTypes.InferenceSession> {
  const ort = await import("onnxruntime-web");

  ort.env.wasm.wasmPaths = "/ort/";
  // Use 1 thread so WASM does not duplicate 1024x1024 memory arenas across CPU cores
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = true;

  const modelUrl =
    process.env.NEXT_PUBLIC_ONNX_MODEL_URL || "/models/best.onnx";

  return await ort.InferenceSession.create(modelUrl, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
    // CRITICAL FOR LINUX RAM: Prevent ONNX from holding a 2GB memory arena
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
}

/**
 * 1. Rasterize a PDF (at 150 DPI) or Image file into HTML5 Canvas pages
 */
export async function rasterizeFileToPages(
  file: File,
  onProgress?: (msg: string) => void
): Promise<RenderedPage[]> {
  const isPdf = file.name.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    onProgress?.("Loading PDF document...");
    const pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

      const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdfDoc = await loadingTask.promise;
    const pages: RenderedPage[] = [];

    const scale = 150 / 72;

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      onProgress?.(`Rasterizing PDF Page ${i} of ${pdfDoc.numPages} (150 DPI)...`);
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d")!;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      page.cleanup();

      pages.push({
        page_number: i,
        width: canvas.width,
        height: canvas.height,
        image_url: canvas.toDataURL("image/jpeg", 0.85),
        canvas,
      });
    }

    await pdfDoc.cleanup();
    await loadingTask.destroy();
    return pages;
  } else {
    onProgress?.("Loading image...");
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    return [
      {
        page_number: 1,
        width: canvas.width,
        height: canvas.height,
        image_url: canvas.toDataURL("image/jpeg", 0.85),
        canvas,
      },
    ];
  }
}

/**
 * 2. YOLOv8 Letterbox Preprocessing (1024x1024, RGB normalized [0,1], NCHW Float32Array)
 */
function preprocessCanvas(sourceCanvas: HTMLCanvasElement) {
  const origW = sourceCanvas.width;
  const origH = sourceCanvas.height;

  const scale = Math.min(MODEL_INPUT_SIZE / origW, MODEL_INPUT_SIZE / origH);
  const newW = Math.round(origW * scale);
  const newH = Math.round(origH * scale);

  const padX = Math.round((MODEL_INPUT_SIZE - newW) / 2);
  const padY = Math.round((MODEL_INPUT_SIZE - newH) / 2);

  const letterboxCanvas = document.createElement("canvas");
  letterboxCanvas.width = MODEL_INPUT_SIZE;
  letterboxCanvas.height = MODEL_INPUT_SIZE;
  const ctx = letterboxCanvas.getContext("2d")!;

  ctx.fillStyle = "rgb(114, 114, 114)";
  ctx.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  ctx.drawImage(sourceCanvas, 0, 0, origW, origH, padX, padY, newW, newH);

  const imgData = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE).data;

  // Free letterbox canvas backing memory immediately
  letterboxCanvas.width = 0;
  letterboxCanvas.height = 0;

  const numPixels = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const float32Data = new Float32Array(3 * numPixels);

  for (let i = 0; i < numPixels; i++) {
    const rgbaIdx = i * 4;
    float32Data[i] = imgData[rgbaIdx] / 255.0;
    float32Data[numPixels + i] = imgData[rgbaIdx + 1] / 255.0;
    float32Data[2 * numPixels + i] = imgData[rgbaIdx + 2] / 255.0;
  }

  return { float32Data, scale, padX, padY, origW, origH };
}

function computeIoU(
  boxA: [number, number, number, number],
  boxB: [number, number, number, number]
): number {
  const xA = Math.max(boxA[0], boxB[0]);
  const yA = Math.max(boxA[1], boxB[1]);
  const xB = Math.min(boxA[2], boxB[2]);
  const yB = Math.min(boxA[3], boxB[3]);

  const interW = Math.max(0, xB - xA);
  const interH = Math.max(0, yB - yA);
  const interArea = interW * interH;
  if (interArea <= 0) return 0;

  const areaA = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]);
  const areaB = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]);
  return interArea / (areaA + areaB - interArea);
}

function postprocessYoloOutput(
  outputData: Float32Array,
  dims: readonly number[],
  scale: number,
  padX: number,
  padY: number,
  origW: number,
  origH: number,
  pageNumber: number
): RawMeasureBox[] {
  const numChannels = dims[1];
  const numAnchors = dims[2];

  const candidates: { box: [number, number, number, number]; confidence: number }[] = [];

  for (let i = 0; i < numAnchors; i++) {
    let maxConf = 0;
    for (let c = 4; c < numChannels; c++) {
      const conf = outputData[c * numAnchors + i];
      if (conf > maxConf) maxConf = conf;
    }

    if (maxConf < CONF_THRESHOLD) continue;

    const cx = outputData[0 * numAnchors + i];
    const cy = outputData[1 * numAnchors + i];
    const w = outputData[2 * numAnchors + i];
    const h = outputData[3 * numAnchors + i];

    const x1 = Math.max(0, Math.min(origW, (cx - w / 2 - padX) / scale));
    const y1 = Math.max(0, Math.min(origH, (cy - h / 2 - padY) / scale));
    const x2 = Math.max(0, Math.min(origW, (cx + w / 2 - padX) / scale));
    const y2 = Math.max(0, Math.min(origH, (cy + h / 2 - padY) / scale));

    if (x2 - x1 > 5 && y2 - y1 > 5) {
      candidates.push({
        box: [
          Number(x1.toFixed(2)),
          Number(y1.toFixed(2)),
          Number(x2.toFixed(2)),
          Number(y2.toFixed(2)),
        ],
        confidence: Number(maxConf.toFixed(4)),
      });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  const kept: RawMeasureBox[] = [];
  const suppressed = new Uint8Array(candidates.length);

  for (let i = 0; i < candidates.length; i++) {
    if (suppressed[i]) continue;
    const curr = candidates[i];

    kept.push({
      measure_number: kept.length + 1,
      system_index: 0,
      measure_in_system: 0,
      page_number: pageNumber,
      box: curr.box,
      confidence: curr.confidence,
      bars: 1,
    });

    for (let j = i + 1; j < candidates.length; j++) {
      if (suppressed[j]) continue;
      if (computeIoU(curr.box, candidates[j].box) > IOU_THRESHOLD) {
        suppressed[j] = 1;
      }
    }
  }

  return kept;
}

/**
 * 5. Main Entrypoint: Runs Inference and Frees 100% of WASM Memory When Done
 */
export async function detectMeasuresInBrowser(
  file: File,
  onProgress?: (msg: string) => void
) {
  const ort = await import("onnxruntime-web");
  const renderedPages = await rasterizeFileToPages(file, onProgress);

  onProgress?.("Loading YOLOv8 ONNX model in browser...");
  const session = await createOrtSession();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const allRawBoxes: RawMeasureBox[] = [];

  try {
    for (let i = 0; i < renderedPages.length; i++) {
      const page = renderedPages[i];
      onProgress?.(
        `Running YOLOv8 Inference on Page ${page.page_number} of ${renderedPages.length}...`
      );

      await new Promise((r) => setTimeout(r, 20));

      const { float32Data, scale, padX, padY, origW, origH } = preprocessCanvas(page.canvas);

      // Free the full-page canvas memory as soon as pixels are extracted
      page.canvas.width = 0;
      page.canvas.height = 0;

      const inputTensor = new ort.Tensor("float32", float32Data, [
        1,
        3,
        MODEL_INPUT_SIZE,
        MODEL_INPUT_SIZE,
      ]);

      const results = await session.run({ [inputName]: inputTensor });
      const outputTensor = results[outputName];

      const pageBoxes = postprocessYoloOutput(
        outputTensor.data as Float32Array,
        outputTensor.dims,
        scale,
        padX,
        padY,
        origW,
        origH,
        page.page_number
      );

      // Explicitly dispose tensors so WASM heap doesn't balloon
      inputTensor.dispose?.();
      outputTensor.dispose?.();

      allRawBoxes.push(...pageBoxes);
    }
  } finally {
    // Release the ONNX session & terminate worker so 0 MB is held during playback
    await session.release();
  }

  return {
    pages: renderedPages.map(({ page_number, width, height, image_url }) => ({
      page_number,
      width,
      height,
      image_url,
    })),
    rawMeasures: allRawBoxes,
  };
}