from postprocess import BoundingBox, sort_measures_reading_order

def test_sorting_reading_order():
    mock_boxes = [
        BoundingBox(x1=500, y1=102, x2=700, y2=182, confidence=0.92),
        BoundingBox(x1=100, y1=300, x2=350, y2=380, confidence=0.88),
        BoundingBox(x1=100, y1=105, x2=300, y2=185, confidence=0.95),
        BoundingBox(x1=300, y1=100, x2=500, y2=180, confidence=0.91),
        BoundingBox(x1=350, y1=298, x2=600, y2=378, confidence=0.94),
    ]
    sorted_boxes = sort_measures_reading_order(mock_boxes)
    assert len(sorted_boxes) == 5
    assert [m["measure_number"] for m in sorted_boxes] == [1, 2, 3, 4, 5]
    assert sorted_boxes[0]["system_index"] == 0
    assert sorted_boxes[3]["system_index"] == 1

def test_empty_input():
    assert sort_measures_reading_order([]) == []
