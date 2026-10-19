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

// Singleton ONNX session so the 43MB model only loads once per browser tab
let sessionPromise: Promise<ortTypes.InferenceSession> | null = null;

async function getOrtSession(): Promise<ortTypes.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import("onnxruntime-web");

      // Serve WASM files from /public/ort/ and run inference in a background Web Worker
      ort.env.wasm.wasmPaths = "/ort/";
      ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
      ort.env.wasm.proxy = true; // Offloads session.run() to a Web Worker automatically

      const modelUrl =
        process.env.NEXT_PUBLIC_ONNX_MODEL_URL || "/models/best.onnx";

      return await ort.InferenceSession.create(modelUrl, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
    })();
  }
  return sessionPromise;
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
    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages: RenderedPage[] = [];

    // 150 DPI scale factor (PDF standard point unit is 72 DPI)
    const scale = 150 / 72;

    for (let i = 1; i <= pdfDoc.numPages; i++) {
      onProgress?.(`Rasterizing PDF Page ${i} of ${pdfDoc.numPages} (150 DPI)...`);
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d")!;

      // Fill white background before rendering PDF strokes
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport, canvas }).promise;

      pages.push({
        page_number: i,
        width: canvas.width,
        height: canvas.height,
        image_url: canvas.toDataURL("image/png"),
        canvas,
      });
    }
    return pages;
  } else {
    // Standard PNG / JPG upload
    onProgress?.("Loading image...");
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);

    return [
      {
        page_number: 1,
        width: canvas.width,
        height: canvas.height,
        image_url: canvas.toDataURL("image/png"),
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

  const padX = (MODEL_INPUT_SIZE - newW) / 2;
  const padY = (MODEL_INPUT_SIZE - newH) / 2;

  const letterboxCanvas = document.createElement("canvas");
  letterboxCanvas.width = MODEL_INPUT_SIZE;
  letterboxCanvas.height = MODEL_INPUT_SIZE;
  const ctx = letterboxCanvas.getContext("2d")!;

  // Ultralytics standard gray letterbox padding: rgb(114, 114, 114)
  ctx.fillStyle = "rgb(114, 114, 114)";
  ctx.fillRect(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  ctx.drawImage(
    sourceCanvas,
    0,
    0,
    origW,
    origH,
    Math.round(padX),
    Math.round(padY),
    newW,
    newH
  );

  const imgData = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE).data;
  const numPixels = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
  const float32Data = new Float32Array(3 * numPixels);

  // Convert interleaved RGBA [H, W, 4] to planar RGB [1, 3, H, W] normalized to 0.0 - 1.0
  for (let i = 0; i < numPixels; i++) {
    const rgbaIdx = i * 4;
    float32Data[i] = imgData[rgbaIdx] / 255.0; // R
    float32Data[numPixels + i] = imgData[rgbaIdx + 1] / 255.0; // G
    float32Data[2 * numPixels + i] = imgData[rgbaIdx + 2] / 255.0; // B
  }

  return { float32Data, scale, padX: Math.round(padX), padY: Math.round(padY), origW, origH };
}

/**
 * 3. Compute Intersection-over-Union (IoU) for Non-Maximum Suppression
 */
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

/**
 * 4. Decode YOLOv8 Output Tensor [1, 5, 21504] & Run Greedy NMS
 */
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
  // dims is typically [1, 5, 21504] where 5 = [cx, cy, w, h, conf]
  const numChannels = dims[1];
  const numAnchors = dims[2];

  const candidates: { box: [number, number, number, number]; confidence: number }[] = [];

  for (let i = 0; i < numAnchors; i++) {
    // Find max class confidence across channels 4..numChannels-1
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

    // Map from 1024x1024 letterbox coordinates back to original page pixel coordinates
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

  // Sort descending by confidence for NMS
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
 * 5. Main Entrypoint: End-to-End Browser Detection Pipeline
 */
export async function detectMeasuresInBrowser(
  file: File,
  onProgress?: (msg: string) => void
) {
  const ort = await import("onnxruntime-web");
  const renderedPages = await rasterizeFileToPages(file, onProgress);

  onProgress?.("Loading YOLOv8 ONNX model in browser...");
  const session = await getOrtSession();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const allRawBoxes: RawMeasureBox[] = [];

  for (let i = 0; i < renderedPages.length; i++) {
    const page = renderedPages[i];
    onProgress?.(
      `Running YOLOv8 Inference on Page ${page.page_number} of ${renderedPages.length}...`
    );

    // Yield to browser event loop so loading status text updates smoothly
    await new Promise((r) => setTimeout(r, 15));

    const { float32Data, scale, padX, padY, origW, origH } = preprocessCanvas(page.canvas);

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

    allRawBoxes.push(...pageBoxes);
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