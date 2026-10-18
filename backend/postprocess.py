from dataclasses import dataclass
from typing import List, Dict, Any
import statistics

@dataclass
class BoundingBox:
    x1: float
    y1: float
    x2: float
    y2: float
    confidence: float = 1.0

    @property
    def width(self) -> float:
        return self.x2 - self.x1

    @property
    def height(self) -> float:
        return self.y2 - self.y1

    @property
    def x_center(self) -> float:
        return self.x1 + (self.width / 2.0)

    @property
    def y_center(self) -> float:
        return self.y1 + (self.height / 2.0)

def sort_measures_reading_order(
    raw_boxes: List[BoundingBox],
    page_number: int = 1,
    starting_measure_number: int = 1,
    min_confidence: float = 0.45,
    row_overlap_threshold: float = 0.5
) -> List[Dict[str, Any]]:
    valid_boxes = [
        b for b in raw_boxes 
        if b.confidence >= min_confidence and b.width > 5 and b.height > 5
    ]
    if not valid_boxes:
        return []

    median_height = statistics.median([b.height for b in valid_boxes])
    y_threshold = median_height * row_overlap_threshold
    y_sorted_boxes = sorted(valid_boxes, key=lambda b: b.y_center)

    systems: List[List[BoundingBox]] = []
    current_system: List[BoundingBox] = [y_sorted_boxes[0]]
    current_system_y_mean = y_sorted_boxes[0].y_center

    for box in y_sorted_boxes[1:]:
        if abs(box.y_center - current_system_y_mean) <= y_threshold:
            current_system.append(box)
            current_system_y_mean = statistics.mean([b.y_center for b in current_system])
        else:
            systems.append(current_system)
            current_system = [box]
            current_system_y_mean = box.y_center
    systems.append(current_system)

    ordered_measures: List[Dict[str, Any]] = []
    measure_counter = starting_measure_number

    for sys_idx, system_row in enumerate(systems):
        left_to_right = sorted(system_row, key=lambda b: b.x_center)
        for m_idx, box in enumerate(left_to_right):
            ordered_measures.append({
                "measure_number": measure_counter,
                "system_index": sys_idx,
                "measure_in_system": m_idx,
                "page_number": page_number,
                "box": [round(box.x1, 2), round(box.y1, 2), round(box.x2, 2), round(box.y2, 2)],
                "confidence": round(box.confidence, 4),
                "bars": 1
            })
            measure_counter += 1

    return ordered_measures
