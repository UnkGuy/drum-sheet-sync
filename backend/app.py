from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pathlib import Path
import fitz
from ultralytics import YOLO
from postprocess import BoundingBox, sort_measures_reading_order
import io
import base64
import cv2
import numpy as np
from PIL import Image

app = FastAPI(title="Drum Sheet Music OMR Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).resolve().parent
ONNX_PATH = BASE_DIR / "models" / "best.onnx"
PT_PATH = BASE_DIR / "models" / "best.pt"

MODEL_PATH = ONNX_PATH if ONNX_PATH.exists() else PT_PATH
model = YOLO(str(MODEL_PATH))


@app.post("/api/detect")
async def detect_measures(file: UploadFile = File(...)):
    """Uploads a PDF or image and returns page images + sorted measure coordinates."""
    contents = await file.read()
    all_pages_measures = []
    pages_data = []
    global_measure_idx = 1

    if file.filename.lower().endswith(".pdf"):
        doc = fitz.open(stream=contents, filetype="pdf")
        pil_pages = [
            Image.open(io.BytesIO(page.get_pixmap(dpi=150).tobytes("png"))).convert("RGB")
            for page in doc
        ]
    else:
        pil_pages = [Image.open(io.BytesIO(contents)).convert("RGB")]

    for page_idx, img in enumerate(pil_pages):
        page_num = page_idx + 1
        results = model.predict(source=img, imgsz=1024, conf=0.45, iou=0.5)

        raw_boxes = [
            BoundingBox(x1=b[0], y1=b[1], x2=b[2], y2=b[3], confidence=conf)
            for b, conf in zip(results[0].boxes.xyxy.tolist(), results[0].boxes.conf.tolist())
        ]

        sorted_page = sort_measures_reading_order(
            raw_boxes,
            page_number=page_num,
            starting_measure_number=global_measure_idx
        )
        all_pages_measures.extend(sorted_page)
        if sorted_page:
            global_measure_idx = sorted_page[-1]["measure_number"] + 1

        # Encode page image as base64 PNG so frontend coordinates match 100%
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        b64_img = base64.b64encode(buf.getvalue()).decode("utf-8")

        pages_data.append({
            "page_number": page_num,
            "width": img.width,
            "height": img.height,
            "image_url": f"data:image/png;base64,{b64_img}"
        })

    return {
        "status": "success",
        "model_used": MODEL_PATH.name,
        "total_measures": len(all_pages_measures),
        "pages": pages_data,
        "measures": all_pages_measures
    }
