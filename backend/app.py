from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pathlib import Path
import fitz
from ultralytics import YOLO
from postprocess import BoundingBox, sort_measures_reading_order
import io
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

# Automatically locate best.onnx or best.pt inside backend/models/
BASE_DIR = Path(__file__).resolve().parent
ONNX_PATH = BASE_DIR / "models" / "best.onnx"
PT_PATH = BASE_DIR / "models" / "best.pt"

MODEL_PATH = ONNX_PATH if ONNX_PATH.exists() else PT_PATH
model = YOLO(str(MODEL_PATH))


def load_first_page_as_pil(contents: bytes, filename: str) -> Image.Image:
    if filename.lower().endswith(".pdf"):
        doc = fitz.open(stream=contents, filetype="pdf")
        pix = doc[0].get_pixmap(dpi=150)
        return Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    return Image.open(io.BytesIO(contents)).convert("RGB")


@app.post("/api/detect")
async def detect_measures(file: UploadFile = File(...)):
    """Uploads a PDF or PNG/JPG and returns sorted measure coordinates as JSON."""
    contents = await file.read()
    all_pages_measures = []
    global_measure_idx = 1

    if file.filename.lower().endswith(".pdf"):
        doc = fitz.open(stream=contents, filetype="pdf")
        pages = [
            Image.open(io.BytesIO(page.get_pixmap(dpi=150).tobytes("png"))).convert("RGB")
            for page in doc
        ]
    else:
        pages = [Image.open(io.BytesIO(contents)).convert("RGB")]

    for page_idx, img in enumerate(pages):
        results = model.predict(source=img, imgsz=1024, conf=0.45, iou=0.5)

        raw_boxes = [
            BoundingBox(x1=b[0], y1=b[1], x2=b[2], y2=b[3], confidence=conf)
            for b, conf in zip(results[0].boxes.xyxy.tolist(), results[0].boxes.conf.tolist())
        ]

        sorted_page = sort_measures_reading_order(
            raw_boxes,
            page_number=page_idx + 1,
            starting_measure_number=global_measure_idx
        )
        all_pages_measures.extend(sorted_page)
        if sorted_page:
            global_measure_idx = sorted_page[-1]["measure_number"] + 1

    return {
        "status": "success",
        "model_used": MODEL_PATH.name,
        "total_measures": len(all_pages_measures),
        "measures": all_pages_measures
    }


@app.post("/api/visualize")
async def visualize_measures(file: UploadFile = File(...)):
    """Uploads a PDF or image and returns a PNG with sorted #1, #2, #3 measure boxes drawn on it."""
    contents = await file.read()
    pil_img = load_first_page_as_pil(contents, file.filename)

    results = model.predict(source=pil_img, imgsz=1024, conf=0.45, iou=0.5)
    raw_boxes = [
        BoundingBox(x1=b[0], y1=b[1], x2=b[2], y2=b[3], confidence=conf)
        for b, conf in zip(results[0].boxes.xyxy.tolist(), results[0].boxes.conf.tolist())
    ]

    sorted_measures = sort_measures_reading_order(raw_boxes, page_number=1)

    # Convert PIL image to OpenCV format to draw boxes and numbers
    cv_img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)

    for m in sorted_measures:
        x1, y1, x2, y2 = [int(coord) for coord in m["box"]]
        num = m["measure_number"]
        # Green rectangle for the measure
        cv2.rectangle(cv_img, (x1, y1), (x2, y2), (0, 180, 0), 2)
        # Red badge for the sorted measure number (#1, #2, #3...)
        cv2.putText(
            cv_img,
            f"#{num}",
            (x1 + 5, y1 + 22),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (0, 0, 220),
            2
        )

    _, encoded_png = cv2.imencode(".png", cv_img)
    return Response(content=encoded_png.tobytes(), media_type="image/png")
