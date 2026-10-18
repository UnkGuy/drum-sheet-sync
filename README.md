# Drum Sheet Sync

Interactive drum notation sync engine combining computer vision measure detection (YOLOv8/ONNX) and a sample-accurate Web Audio metronome.

## Architecture
- Detection: YOLOv8 OMR trained on 1024x1024 sheet music rasters.
- Post-processing: 1D row clustering to order measures top-to-bottom, left-to-right.
- Backend API: FastAPI servicing ONNX runtime inference.
- Frontend: Next.js and HTML5 Canvas overlay.

## Running Tests
    PYTHONPATH=backend pytest backend/tests/
