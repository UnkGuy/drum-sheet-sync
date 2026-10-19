"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { get, set } from "idb-keyval";
import {
  Play,
  Pause,
  RotateCcw,
  Upload,
  Volume2,
  VolumeX,
  Repeat,
  Plus,
  Minus,
  Timer,
  ScrollText,
  Music,
  Scissors,
  Trash2,
  Combine,
  PenTool,
  Save,
  FolderOpen,
  X,
  Check,
} from "lucide-react";

interface Measure {
  measure_number: number;
  system_index: number;
  measure_in_system: number;
  page_number: number;
  box: [number, number, number, number]; // [x1, y1, x2, y2]
  confidence: number;
  bars: number;
}

interface PageData {
  page_number: number;
  width: number;
  height: number;
  image_url: string;
}

interface SavedChart {
  id: string;
  title: string;
  bpm: number;
  beatsPerBar: number;
  updatedAt: string;
  pages: PageData[];
  measures: Measure[];
}

const STORAGE_KEY = "drumsync_saved_charts_v1";

/**
 * Client-side port of our 1D Row-Clustering Reading-Order Sorter.
 * Automatically re-numbers #1, #2, #3... whenever the user draws, splits, merges, or deletes boxes.
 */
function resortMeasuresReadingOrder(allMeasures: Measure[]): Measure[] {
  if (allMeasures.length === 0) return [];

  const pageNumbers = Array.from(new Set(allMeasures.map((m) => m.page_number))).sort(
    (a, b) => a - b
  );

  const finalSorted: Measure[] = [];
  let globalCounter = 1;

  for (const pageNum of pageNumbers) {
    const pageBoxes = allMeasures.filter((m) => m.page_number === pageNum);
    if (pageBoxes.length === 0) continue;

    const heights = pageBoxes.map((m) => m.box[3] - m.box[1]).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] || 60;
    const yThreshold = medianHeight * 0.5;

    const ySorted = [...pageBoxes].sort((a, b) => {
      const ycA = (a.box[1] + a.box[3]) / 2;
      const ycB = (b.box[1] + b.box[3]) / 2;
      return ycA - ycB;
    });

    const systems: Measure[][] = [];
    let currentSystem: Measure[] = [ySorted[0]];
    let currentSystemYMean = (ySorted[0].box[1] + ySorted[0].box[3]) / 2;

    for (let i = 1; i < ySorted.length; i++) {
      const box = ySorted[i];
      const yc = (box.box[1] + box.box[3]) / 2;
      if (Math.abs(yc - currentSystemYMean) <= yThreshold) {
        currentSystem.push(box);
        currentSystemYMean =
          currentSystem.reduce((acc, item) => acc + (item.box[1] + item.box[3]) / 2, 0) /
          currentSystem.length;
      } else {
        systems.push(currentSystem);
        currentSystem = [box];
        currentSystemYMean = yc;
      }
    }
    systems.push(currentSystem);

    systems.forEach((sysRow, sysIdx) => {
      const leftToRight = [...sysRow].sort((a, b) => {
        const xcA = (a.box[0] + a.box[2]) / 2;
        const xcB = (b.box[0] + b.box[2]) / 2;
        return xcA - xcB;
      });

      leftToRight.forEach((m, mIdx) => {
        finalSorted.push({
          ...m,
          measure_number: globalCounter++,
          system_index: sysIdx,
          measure_in_system: mIdx,
          page_number: pageNum,
        });
      });
    });
  }

  return finalSorted;
}

export default function DrumSightReader() {
  const [pages, setPages] = useState<PageData[]>([]);
  const [measures, setMeasures] = useState<Measure[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fileName, setFileName] = useState<string>("");

  // Playback & Practice Controls
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState<number>(100);
  const [beatsPerBar, setBeatsPerBar] = useState<number>(4);
  const [metronomeOn, setMetronomeOn] = useState<boolean>(true);
  const [countInOn, setCountInOn] = useState<boolean>(true);
  const [autoScrollOn, setAutoScrollOn] = useState<boolean>(true);

  // Active & Selection State
  const [activeMeasureIdx, setActiveMeasureIdx] = useState<number>(0);
  const [selectedMeasureIdx, setSelectedMeasureIdx] = useState<number | null>(null);
  const [measureProgress, setMeasureProgress] = useState<number>(0);
  const [currentBeatInBar, setCurrentBeatInBar] = useState<number>(1);
  const [currentBarInMulti, setCurrentBarInMulti] = useState<number>(1);
  const [countInBeat, setCountInBeat] = useState<number | null>(null);

  // Interactive Box Editor State (Draw & Resize)
  const [isDrawMode, setIsDrawMode] = useState<boolean>(false);
  const [drawingState, setDrawingState] = useState<{
    pageNumber: number;
    startX: number;
    startY: number;
    currX: number;
    currY: number;
  } | null>(null);
  const [resizingState, setResizingState] = useState<{
    measureIdx: number;
    edge: "left" | "right";
  } | null>(null);

  // Saved Charts Library (IndexedDB)
  const [savedCharts, setSavedCharts] = useState<SavedChart[]>([]);
  const [isLibraryOpen, setIsLibraryOpen] = useState<boolean>(false);
  const [saveSuccessToast, setSaveSuccessToast] = useState<boolean>(false);

  // Loop Range
  const [loopStartIdx, setLoopStartIdx] = useState<number | null>(null);
  const [loopEndIdx, setLoopEndIdx] = useState<number | null>(null);

  // Audio & Animation Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const accumulatedBeatsRef = useRef<number>(0);
  const lastClickedBeatRef = useRef<number>(-1);
  const lastScrolledSystemRef = useRef<string>("");
  const measureRefs = useRef<{ [key: number]: SVGGElement | null }>({});

  // Load saved charts list on mount
  useEffect(() => {
    get<SavedChart[]>(STORAGE_KEY).then((list) => {
      if (list) setSavedCharts(list);
    });
  }, []);

  // Synthesize crisp woodblock metronome click via Web Audio API
  const playMetronomeClick = useCallback(
    (isDownbeat: boolean, isCountIn = false) => {
      if (!metronomeOn) return;
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "triangle";
      const freq = isCountIn ? 1000 : isDownbeat ? 1200 : 800;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.045);

      gain.gain.setValueAtTime(0.4, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.045);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.05);
    },
    [metronomeOn]
  );

  // Handle PDF / Image Upload to FastAPI Backend
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setIsPlaying(false);
    setFileName(file.name.replace(/\.[^/.]+$/, ""));

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("http://127.0.0.1:8000/api/detect", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (data.status === "success") {
        setPages(data.pages);
        setMeasures(data.measures);
        setActiveMeasureIdx(0);
        setSelectedMeasureIdx(0);
        setMeasureProgress(0);
        setLoopStartIdx(null);
        setLoopEndIdx(null);
      }
    } catch (err) {
      alert("Could not connect to FastAPI backend on port 8000. Make sure uvicorn is running!");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  // Save current chart + edits to browser IndexedDB
  const saveChartToLibrary = async () => {
    if (pages.length === 0 || measures.length === 0) return;
    const title = fileName.trim() || `Drum Chart (${new Date().toLocaleDateString()})`;
    const newChart: SavedChart = {
      id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      title,
      bpm,
      beatsPerBar,
      updatedAt: new Date().toLocaleString(),
      pages,
      measures,
    };

    const existing = (await get<SavedChart[]>(STORAGE_KEY)) || [];
    const filtered = existing.filter((c) => c.id !== newChart.id);
    const updated = [newChart, ...filtered];

    await set(STORAGE_KEY, updated);
    setSavedCharts(updated);
    setSaveSuccessToast(true);
    setTimeout(() => setSaveSuccessToast(false), 2500);
  };

  const loadChartFromLibrary = (chart: SavedChart) => {
    setIsPlaying(false);
    setFileName(chart.title);
    setBpm(chart.bpm);
    setBeatsPerBar(chart.beatsPerBar);
    setPages(chart.pages);
    setMeasures(chart.measures);
    setActiveMeasureIdx(0);
    setSelectedMeasureIdx(0);
    setMeasureProgress(0);
    setLoopStartIdx(null);
    setLoopEndIdx(null);
    setIsLibraryOpen(false);
  };

  const deleteChartFromLibrary = async (id: string) => {
    const updated = savedCharts.filter((c) => c.id !== id);
    await set(STORAGE_KEY, updated);
    setSavedCharts(updated);
  };

  // Auto-scroll when the active system row changes
  useEffect(() => {
    if (!autoScrollOn || !isPlaying || measures.length === 0) return;
    const currentMeasure = measures[activeMeasureIdx];
    if (!currentMeasure) return;

    const systemKey = `${currentMeasure.page_number}-${currentMeasure.system_index}`;
    if (systemKey !== lastScrolledSystemRef.current) {
      lastScrolledSystemRef.current = systemKey;
      const el = measureRefs.current[currentMeasure.measure_number];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [activeMeasureIdx, autoScrollOn, isPlaying, measures]);

  // Main Sight-Reading Animation & Audio Clock Loop
  useEffect(() => {
    if (!isPlaying || measures.length === 0) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    lastFrameTimeRef.current = performance.now();

    const tick = (now: number) => {
      const dtSeconds = (now - lastFrameTimeRef.current) / 1000;
      lastFrameTimeRef.current = now;

      const beatsPerSecond = bpm / 60;
      accumulatedBeatsRef.current += dtSeconds * beatsPerSecond;

      const totalBeatsElapsed = accumulatedBeatsRef.current;
      const wholeBeatIndex = Math.floor(totalBeatsElapsed);

      if (totalBeatsElapsed < 0) {
        const countBeat = beatsPerBar + wholeBeatIndex + 1;
        setCountInBeat(countBeat);
        if (wholeBeatIndex !== lastClickedBeatRef.current) {
          lastClickedBeatRef.current = wholeBeatIndex;
          playMetronomeClick(countBeat === 1, true);
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      setCountInBeat(null);

      const startIdx = loopStartIdx !== null ? loopStartIdx : 0;
      const endIdx = loopEndIdx !== null ? loopEndIdx : measures.length - 1;

      let rangeTotalBeats = 0;
      for (let i = startIdx; i <= endIdx; i++) {
        rangeTotalBeats += (measures[i]?.bars || 1) * beatsPerBar;
      }

      let beatInLoop = totalBeatsElapsed;
      if (beatInLoop >= rangeTotalBeats) {
        if (loopStartIdx !== null || loopEndIdx !== null) {
          accumulatedBeatsRef.current = totalBeatsElapsed % rangeTotalBeats;
          beatInLoop = accumulatedBeatsRef.current;
          lastClickedBeatRef.current = -1;
        } else {
          setIsPlaying(false);
          setMeasureProgress(0);
          return;
        }
      }

      let runningBeats = 0;
      let foundIdx = startIdx;
      let beatInsideMeasure = 0;
      let measureTotalBeats = beatsPerBar;

      for (let i = startIdx; i <= endIdx; i++) {
        const mBeats = (measures[i]?.bars || 1) * beatsPerBar;
        if (beatInLoop < runningBeats + mBeats) {
          foundIdx = i;
          beatInsideMeasure = beatInLoop - runningBeats;
          measureTotalBeats = mBeats;
          break;
        }
        runningBeats += mBeats;
      }

      setActiveMeasureIdx(foundIdx);
      setMeasureProgress(beatInsideMeasure / measureTotalBeats);

      const beatInt = Math.floor(beatInsideMeasure);
      const beatInSingleBar = (beatInt % beatsPerBar) + 1;
      const barInMulti = Math.floor(beatInt / beatsPerBar) + 1;

      setCurrentBeatInBar(beatInSingleBar);
      setCurrentBarInMulti(barInMulti);

      if (wholeBeatIndex !== lastClickedBeatRef.current) {
        lastClickedBeatRef.current = wholeBeatIndex;
        playMetronomeClick(beatInSingleBar === 1, false);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, bpm, beatsPerBar, measures, loopStartIdx, loopEndIdx, playMetronomeClick]);

  // Start / Pause Handler
  const togglePlay = useCallback(() => {
    if (measures.length === 0) return;
    if (!isPlaying) {
      const startIdx = loopStartIdx !== null ? loopStartIdx : 0;
      let offsetBeats = 0;
      for (let i = startIdx; i < activeMeasureIdx; i++) {
        offsetBeats += (measures[i]?.bars || 1) * beatsPerBar;
      }
      accumulatedBeatsRef.current = countInOn ? -beatsPerBar : offsetBeats;
      lastClickedBeatRef.current = -999;
      lastScrolledSystemRef.current = "";
      setIsPlaying(true);
    } else {
      setIsPlaying(false);
      setCountInBeat(null);
    }
  }, [measures, isPlaying, loopStartIdx, activeMeasureIdx, beatsPerBar, countInOn]);

  const resetPlayback = () => {
    setIsPlaying(false);
    setCountInBeat(null);
    const startIdx = loopStartIdx !== null ? loopStartIdx : 0;
    setActiveMeasureIdx(startIdx);
    setMeasureProgress(0);
    setCurrentBeatInBar(1);
    setCurrentBarInMulti(1);
  };

  // Box Editing Actions: Bar Multiplier, Split, Merge, Delete
  const updateMeasureBars = (idx: number, delta: number) => {
    setMeasures((prev) =>
      prev.map((m, i) => (i === idx ? { ...m, bars: Math.max(1, m.bars + delta) } : m))
    );
  };

  const deleteSelectedMeasure = useCallback(() => {
    if (selectedMeasureIdx === null) return;
    setMeasures((prev) => {
      const filtered = prev.filter((_, i) => i !== selectedMeasureIdx);
      return resortMeasuresReadingOrder(filtered);
    });
    setSelectedMeasureIdx((prev) => (prev !== null && prev > 0 ? prev - 1 : 0));
    setActiveMeasureIdx(0);
  }, [selectedMeasureIdx]);

  const splitSelectedMeasure = () => {
    if (selectedMeasureIdx === null) return;
    const target = measures[selectedMeasureIdx];
    if (!target) return;

    const [x1, y1, x2, y2] = target.box;
    const midX = Math.round((x1 + x2) / 2);
    if (midX - x1 < 15) return; // Prevent splitting tiny boxes

    const leftBox: Measure = {
      ...target,
      box: [x1, y1, midX - 2, y2],
      bars: 1,
    };
    const rightBox: Measure = {
      ...target,
      box: [midX + 2, y1, x2, y2],
      bars: 1,
    };

    const updated = [...measures];
    updated.splice(selectedMeasureIdx, 1, leftBox, rightBox);
    setMeasures(resortMeasuresReadingOrder(updated));
  };

  const mergeWithNextMeasure = () => {
    if (selectedMeasureIdx === null || selectedMeasureIdx >= measures.length - 1) return;
    const curr = measures[selectedMeasureIdx];
    const next = measures[selectedMeasureIdx + 1];

    if (curr.page_number !== next.page_number || curr.system_index !== next.system_index) {
      alert("You can only merge two adjacent measures on the same staff row!");
      return;
    }

    const mergedBox: Measure = {
      ...curr,
      box: [
        Math.min(curr.box[0], next.box[0]),
        Math.min(curr.box[1], next.box[1]),
        Math.max(curr.box[2], next.box[2]),
        Math.max(curr.box[3], next.box[3]),
      ],
      bars: curr.bars + next.bars - 1,
    };

    const updated = [...measures];
    updated.splice(selectedMeasureIdx, 2, mergedBox);
    setMeasures(resortMeasuresReadingOrder(updated));
  };

  // Keyboard Shortcuts: Spacebar (Play/Pause) & Delete/Backspace (Delete Selected Box)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if ((e.code === "Delete" || e.code === "Backspace") && selectedMeasureIdx !== null && !isPlaying) {
        e.preventDefault();
        deleteSelectedMeasure();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlay, deleteSelectedMeasure, selectedMeasureIdx, isPlaying]);

  // Convert Mouse Position on responsive SVG into exact image pixel coordinates
  const getSvgCoords = (
    e: React.MouseEvent<SVGSVGElement>,
    pageWidth: number,
    pageHeight: number
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scaleX = pageWidth / rect.width;
    const scaleY = pageHeight / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

  const handleSvgMouseDown = (
    e: React.MouseEvent<SVGSVGElement>,
    page: PageData
  ) => {
    if (!isDrawMode) return;
    const { x, y } = getSvgCoords(e, page.width, page.height);
    setDrawingState({
      pageNumber: page.page_number,
      startX: x,
      startY: y,
      currX: x,
      currY: y,
    });
  };

  const handleSvgMouseMove = (
    e: React.MouseEvent<SVGSVGElement>,
    page: PageData
  ) => {
    if (drawingState && drawingState.pageNumber === page.page_number) {
      const { x, y } = getSvgCoords(e, page.width, page.height);
      setDrawingState((prev) => (prev ? { ...prev, currX: x, currY: y } : null));
    } else if (resizingState !== null) {
      const { x } = getSvgCoords(e, page.width, page.height);
      setMeasures((prev) =>
        prev.map((m, idx) => {
          if (idx !== resizingState.measureIdx) return m;
          const [x1, y1, x2, y2] = m.box;
          if (resizingState.edge === "left" && x < x2 - 15) {
            return { ...m, box: [x, y1, x2, y2] };
          }
          if (resizingState.edge === "right" && x > x1 + 15) {
            return { ...m, box: [x1, y1, x, y2] };
          }
          return m;
        })
      );
    }
  };

  const handleSvgMouseUp = () => {
    if (drawingState) {
      const x1 = Math.min(drawingState.startX, drawingState.currX);
      const y1 = Math.min(drawingState.startY, drawingState.currY);
      const x2 = Math.max(drawingState.startX, drawingState.currX);
      const y2 = Math.max(drawingState.startY, drawingState.currY);

      if (x2 - x1 > 20 && y2 - y1 > 15) {
        const newMeasure: Measure = {
          measure_number: measures.length + 1,
          system_index: 0,
          measure_in_system: 0,
          page_number: drawingState.pageNumber,
          box: [x1, y1, x2, y2],
          confidence: 1.0,
          bars: 1,
        };
        const updated = resortMeasuresReadingOrder([...measures, newMeasure]);
        setMeasures(updated);
      }
      setDrawingState(null);
      setIsDrawMode(false);
    }
    if (resizingState) {
      setMeasures((prev) => resortMeasuresReadingOrder(prev));
      setResizingState(null);
    }
  };

  const selectedMeasure = selectedMeasureIdx !== null ? measures[selectedMeasureIdx] : null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Top Studio Transport Bar */}
      <header className="sticky top-0 z-30 bg-zinc-900/95 backdrop-blur border-b border-zinc-800 px-6 py-3 shadow-lg">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          {/* Brand, Upload & Library */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 font-bold text-lg text-emerald-400 mr-1">
              <Music className="w-6 h-6" />
              <span>DrumSync</span>
            </div>

            <label className="cursor-pointer inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 py-1.5 rounded-lg text-xs font-semibold border border-zinc-700 transition">
              <Upload className="w-3.5 h-3.5 text-emerald-400" />
              <span>Upload PDF</span>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>

            <button
              onClick={() => setIsLibraryOpen(true)}
              className="inline-flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3 py-1.5 rounded-lg text-xs font-semibold border border-zinc-700 transition"
            >
              <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
              <span>My Library ({savedCharts.length})</span>
            </button>

            {pages.length > 0 && (
              <div className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder="Chart Title..."
                  className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs font-medium w-36 focus:outline-none focus:border-emerald-500"
                />
                <button
                  onClick={saveChartToLibrary}
                  className="inline-flex items-center gap-1.5 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 px-3 py-1.5 rounded-lg text-xs font-semibold transition"
                  title="Save Chart & Box Edits to Browser Library"
                >
                  {saveSuccessToast ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                  <span>{saveSuccessToast ? "Saved!" : "Save"}</span>
                </button>
              </div>
            )}
          </div>

          {/* Transport Controls */}
          <div className="flex items-center gap-2.5">
            <button
              onClick={togglePlay}
              disabled={measures.length === 0}
              className={`flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm transition ${
                isPlaying
                  ? "bg-amber-500 hover:bg-amber-400 text-zinc-950"
                  : "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 disabled:opacity-40"
              }`}
              title="Shortcut: Spacebar"
            >
              {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
              <span>{isPlaying ? "Pause" : "Play"}</span>
            </button>

            <button
              onClick={resetPlayback}
              disabled={measures.length === 0}
              className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 disabled:opacity-40"
              title="Reset to Start"
            >
              <RotateCcw className="w-4 h-4" />
            </button>

            {measures.length > 0 && (
              <div className="bg-zinc-950 border border-zinc-800 px-3 py-1.5 rounded-lg text-xs font-mono flex items-center gap-2.5">
                <span>
                  Bar:{" "}
                  <strong className="text-emerald-400">
                    #{measures[activeMeasureIdx]?.measure_number || 1}
                  </strong>
                  /{measures.length}
                </span>
                <span className="text-zinc-700">|</span>
                <span>
                  Beat: <strong className="text-amber-400">{currentBeatInBar}</strong>/{beatsPerBar}
                </span>
              </div>
            )}
          </div>

          {/* Tempo (BPM), Time Signature, & Toggles */}
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 px-2.5 py-1 rounded-lg">
              <span className="text-xs text-zinc-400 font-medium">BPM</span>
              <input
                type="range"
                min={40}
                max={240}
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
                className="w-20 accent-emerald-500 cursor-pointer"
              />
              <input
                type="number"
                min={40}
                max={240}
                value={bpm}
                onChange={(e) => setBpm(Math.max(40, Math.min(240, Number(e.target.value))))}
                className="w-12 bg-zinc-900 text-center text-xs font-bold text-emerald-400 rounded border border-zinc-700 py-0.5"
              />
            </div>

            <select
              value={beatsPerBar}
              onChange={(e) => setBeatsPerBar(Number(e.target.value))}
              className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs font-semibold"
            >
              <option value={4}>4/4</option>
              <option value={3}>3/4</option>
              <option value={6}>6/8</option>
              <option value={5}>5/4</option>
              <option value={7}>7/8</option>
            </select>

            <button
              onClick={() => setMetronomeOn(!metronomeOn)}
              className={`p-2 rounded-lg border text-xs font-medium flex items-center gap-1 transition ${
                metronomeOn
                  ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                  : "bg-zinc-800 border-zinc-700 text-zinc-400"
              }`}
              title="Toggle Metronome Click"
            >
              {metronomeOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>

            <button
              onClick={() => setCountInOn(!countInOn)}
              className={`p-2 rounded-lg border text-xs font-medium flex items-center gap-1 transition ${
                countInOn
                  ? "bg-amber-500/15 border-amber-500/50 text-amber-300"
                  : "bg-zinc-800 border-zinc-700 text-zinc-400"
              }`}
              title="4-Beat Stick Count-In"
            >
              <Timer className="w-4 h-4" />
            </button>

            <button
              onClick={() => setAutoScrollOn(!autoScrollOn)}
              className={`p-2 rounded-lg border text-xs font-medium flex items-center gap-1 transition ${
                autoScrollOn
                  ? "bg-sky-500/15 border-sky-500/50 text-sky-300"
                  : "bg-zinc-800 border-zinc-700 text-zinc-400"
              }`}
              title="Hands-Free Auto-Scroll"
            >
              <ScrollText className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Interactive Measure Box Editor & Loop Toolbar */}
        {pages.length > 0 && (
          <div className="max-w-7xl mx-auto mt-2.5 pt-2.5 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
            {/* Left: Box Geometry Tools (Draw, Split, Merge, Delete, Bar Multiplier) */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setIsDrawMode(!isDrawMode)}
                className={`px-2.5 py-1 rounded font-semibold flex items-center gap-1.5 border transition ${
                  isDrawMode
                    ? "bg-emerald-500 text-zinc-950 border-emerald-400"
                    : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-zinc-700"
                }`}
                title="Click and drag on the sheet music to draw a missing measure box"
              >
                <PenTool className="w-3.5 h-3.5" />
                <span>{isDrawMode ? "Drag on Sheet to Draw Box..." : "+ Draw Missing Box"}</span>
              </button>

              {selectedMeasure && (
                <>
                  <span className="text-zinc-600">|</span>
                  <span className="text-zinc-400">
                    Bar <strong className="text-white">#{selectedMeasure.measure_number}</strong>{" "}
                    (Row {selectedMeasure.system_index + 1}):
                  </span>

                  {/* Split Box in Half */}
                  <button
                    onClick={splitSelectedMeasure}
                    className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 flex items-center gap-1 text-zinc-200"
                    title="Slice this box vertically into 2 separate measures"
                  >
                    <Scissors className="w-3.5 h-3.5 text-sky-400" />
                    <span>Split in 2</span>
                  </button>

                  {/* Merge with Next Box */}
                  <button
                    onClick={mergeWithNextMeasure}
                    className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 flex items-center gap-1 text-zinc-200"
                    title="Merge this box with the next measure on the same row"
                  >
                    <Combine className="w-3.5 h-3.5 text-purple-400" />
                    <span>Merge Next</span>
                  </button>

                  {/* Delete Box */}
                  <button
                    onClick={deleteSelectedMeasure}
                    className="px-2.5 py-1 rounded bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 flex items-center gap-1 text-red-300"
                    title="Delete selected box (Shortcut: Delete / Backspace)"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete</span>
                  </button>

                  {/* Multi-Bar Rest Multiplier */}
                  <div className="flex items-center gap-1.5 bg-zinc-950 px-2.5 py-1 rounded border border-zinc-800 ml-1">
                    <span className="text-zinc-400">Rest/Repeat Multiplier:</span>
                    <button
                      onClick={() => updateMeasureBars(selectedMeasureIdx!, -1)}
                      className="p-0.5 hover:bg-zinc-800 rounded text-zinc-300"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                    <span className="font-bold text-emerald-400 px-1">
                      {selectedMeasure.bars} {selectedMeasure.bars === 1 ? "Bar" : "Bars"}
                    </span>
                    <button
                      onClick={() => updateMeasureBars(selectedMeasureIdx!, 1)}
                      className="p-0.5 hover:bg-zinc-800 rounded text-zinc-300"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Right: Section Loop Controls */}
            {selectedMeasure && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setLoopStartIdx(selectedMeasureIdx)}
                  className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700"
                >
                  Loop Start (#{loopStartIdx !== null ? measures[loopStartIdx]?.measure_number : "—"})
                </button>
                <button
                  onClick={() => setLoopEndIdx(selectedMeasureIdx)}
                  className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700"
                >
                  Loop End (#{loopEndIdx !== null ? measures[loopEndIdx]?.measure_number : "—"})
                </button>
                {(loopStartIdx !== null || loopEndIdx !== null) && (
                  <button
                    onClick={() => {
                      setLoopStartIdx(null);
                      setLoopEndIdx(null);
                    }}
                    className="px-2.5 py-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1"
                  >
                    <Repeat className="w-3 h-3" /> Clear Loop
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </header>

      {/* Saved Charts Library Modal */}
      {isLibraryOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
              <div className="flex items-center gap-2 font-bold text-base">
                <FolderOpen className="w-5 h-5 text-amber-400" />
                <span>Saved Drum Charts Library</span>
              </div>
              <button
                onClick={() => setIsLibraryOpen(false)}
                className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="my-4 max-h-80 overflow-y-auto space-y-2.5">
              {savedCharts.length === 0 ? (
                <p className="text-zinc-500 text-sm text-center py-8">
                  No saved charts yet. Upload a drum PDF, tweak any boxes or rest multipliers, and click{" "}
                  <strong className="text-emerald-400">Save</strong>!
                </p>
              ) : (
                savedCharts.map((chart) => (
                  <div
                    key={chart.id}
                    className="flex items-center justify-between bg-zinc-950 border border-zinc-800 p-3.5 rounded-xl hover:border-zinc-700 transition"
                  >
                    <div>
                      <p className="font-bold text-sm text-white">{chart.title}</p>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        {chart.measures.length} Measures • {chart.bpm} BPM ({chart.beatsPerBar}/4) • Saved{" "}
                        {chart.updatedAt}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => loadChartFromLibrary(chart)}
                        className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-bold text-xs rounded-lg transition"
                      >
                        Load
                      </button>
                      <button
                        onClick={() => deleteChartFromLibrary(chart.id)}
                        className="p-1.5 hover:bg-red-500/20 text-zinc-400 hover:text-red-400 rounded-lg transition"
                        title="Delete Saved Chart"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Giant 4-Beat Count-In Overlay */}
      {countInBeat !== null && (
        <div className="fixed inset-0 z-40 pointer-events-none flex items-center justify-center bg-black/40 backdrop-blur-xs">
          <div className="bg-zinc-900 border-2 border-amber-400 rounded-2xl px-12 py-8 text-center shadow-2xl">
            <p className="text-xs uppercase tracking-widest text-amber-300 mb-2">Stick Count-In</p>
            <p className="text-7xl font-black text-white">{countInBeat}</p>
          </div>
        </div>
      )}

      {/* Main Sheet Music Viewport */}
      <main className="flex-1 max-w-5xl w-full mx-auto p-6">
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-32 text-zinc-400 gap-3">
            <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm font-medium">Running YOLOv8 Measure Detection & Reading-Order Sort...</p>
          </div>
        )}

        {!isLoading && pages.length === 0 && (
          <div className="border-2 border-dashed border-zinc-800 rounded-2xl p-16 text-center my-12 bg-zinc-900/40">
            <Music className="w-12 h-12 text-emerald-400 mx-auto mb-4 opacity-80" />
            <h2 className="text-xl font-bold mb-2">Upload a Drum Sheet PDF or Load from Library</h2>
            <p className="text-zinc-400 text-sm max-w-md mx-auto mb-6">
              Your local YOLOv8 ONNX model detects every measure, sorts them in musical reading order, and lets you split, merge, draw, and save charts for instant daily practice.
            </p>
            <div className="flex items-center justify-center gap-4">
              <label className="cursor-pointer inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-zinc-950 px-6 py-3 rounded-xl font-bold text-sm transition">
                <Upload className="w-4 h-4" />
                <span>Select Drum Sheet (.PDF / .PNG)</span>
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
              {savedCharts.length > 0 && (
                <button
                  onClick={() => setIsLibraryOpen(true)}
                  className="inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-6 py-3 rounded-xl font-bold text-sm border border-zinc-700 transition"
                >
                  <FolderOpen className="w-4 h-4 text-amber-400" />
                  <span>Open Saved Library ({savedCharts.length})</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Rendered Pages with Interactive SVG Measure Editor Overlay */}
        <div className="space-y-8">
          {pages.map((page) => {
            const pageMeasures = measures.filter((m) => m.page_number === page.page_number);

            return (
              <div
                key={page.page_number}
                className="relative rounded-xl overflow-hidden shadow-2xl border border-zinc-800 bg-white"
              >
                <img
                  src={page.image_url}
                  alt={`Page ${page.page_number}`}
                  className="w-full h-auto block select-none"
                />

                <svg
                  viewBox={`0 0 ${page.width} ${page.height}`}
                  onMouseDown={(e) => handleSvgMouseDown(e, page)}
                  onMouseMove={(e) => handleSvgMouseMove(e, page)}
                  onMouseUp={handleSvgMouseUp}
                  className={`absolute inset-0 w-full h-full ${
                    isDrawMode ? "cursor-crosshair" : ""
                  }`}
                >
                  {pageMeasures.map((m) => {
                    const globalIdx = measures.findIndex(
                      (item) => item.measure_number === m.measure_number
                    );
                    const isActive = globalIdx === activeMeasureIdx;
                    const isSelected = globalIdx === selectedMeasureIdx;
                    const isInLoop =
                      loopStartIdx !== null &&
                      loopEndIdx !== null &&
                      globalIdx >= loopStartIdx &&
                      globalIdx <= loopEndIdx;

                    const [x1, y1, x2, y2] = m.box;
                    const padY = 14;
                    const boxY = Math.max(0, y1 - padY);
                    const boxH = y2 - y1 + padY * 2;
                    const boxW = x2 - x1;
                    const playheadX = x1 + boxW * measureProgress;

                    return (
                      <g
                        key={m.measure_number}
                        ref={(el) => {
                          measureRefs.current[m.measure_number] = el;
                        }}
                        onClick={(e) => {
                          if (isDrawMode) return;
                          e.stopPropagation();
                          setSelectedMeasureIdx(globalIdx);
                          setActiveMeasureIdx(globalIdx);
                          setMeasureProgress(0);
                          accumulatedBeatsRef.current = 0;
                        }}
                        className="cursor-pointer"
                      >
                        {/* Main Measure Bounding Box */}
                        <rect
                          x={x1}
                          y={boxY}
                          width={boxW}
                          height={boxH}
                          rx={4}
                          fill={
                            isActive
                              ? "rgba(16, 185, 129, 0.24)"
                              : isSelected
                              ? "rgba(245, 158, 11, 0.14)"
                              : isInLoop
                              ? "rgba(245, 158, 11, 0.10)"
                              : "rgba(59, 130, 246, 0.04)"
                          }
                          stroke={
                            isActive
                              ? "#10b981"
                              : isSelected
                              ? "#f59e0b"
                              : isInLoop
                              ? "#f59e0b"
                              : "rgba(16, 185, 129, 0.35)"
                          }
                          strokeWidth={isActive ? 3.5 : isSelected ? 2.5 : 1.5}
                          className="transition-colors hover:fill-emerald-500/15"
                        />

                        {/* Left & Right Drag-Resize Handles when Selected */}
                        {isSelected && !isPlaying && (
                          <>
                            <rect
                              x={x1 - 5}
                              y={boxY + boxH / 2 - 14}
                              width={10}
                              height={28}
                              rx={3}
                              fill="#f59e0b"
                              className="cursor-ew-resize"
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setResizingState({ measureIdx: globalIdx, edge: "left" });
                              }}
                            />
                            <rect
                              x={x2 - 5}
                              y={boxY + boxH / 2 - 14}
                              width={10}
                              height={28}
                              rx={3}
                              fill="#f59e0b"
                              className="cursor-ew-resize"
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setResizingState({ measureIdx: globalIdx, edge: "right" });
                              }}
                            />
                          </>
                        )}

                        {/* Measure Number Badge (#1, #2...) */}
                        <rect
                          x={x1}
                          y={Math.max(0, boxY - 18)}
                          width={m.bars > 1 ? 68 : 34}
                          height={18}
                          rx={3}
                          fill={isActive ? "#10b981" : isSelected ? "#f59e0b" : "#18181b"}
                        />
                        <text
                          x={x1 + 5}
                          y={Math.max(13, boxY - 5)}
                          fill={isActive || isSelected ? "#09090b" : "#e4e4e7"}
                          fontSize="11"
                          fontWeight="bold"
                          fontFamily="monospace"
                        >
                          #{m.measure_number}
                          {m.bars > 1 ? ` (${m.bars}x)` : ""}
                        </text>

                        {/* Sweeping Vertical Beat Playhead Line */}
                        {isActive && (
                          <line
                            x1={playheadX}
                            y1={boxY}
                            x2={playheadX}
                            y2={boxY + boxH}
                            stroke="#059669"
                            strokeWidth={4}
                          />
                        )}

                        {/* Live Multi-Bar Rest / Repeat Countdown Overlay */}
                        {isActive && m.bars > 1 && (
                          <g>
                            <rect
                              x={x1 + boxW / 2 - 55}
                              y={boxY + boxH / 2 - 14}
                              width={110}
                              height={28}
                              rx={6}
                              fill="#09090b"
                              opacity={0.9}
                            />
                            <text
                              x={x1 + boxW / 2}
                              y={boxY + boxH / 2 + 5}
                              textAnchor="middle"
                              fill="#fbbf24"
                              fontSize="13"
                              fontWeight="bold"
                              fontFamily="monospace"
                            >
                              BAR {currentBarInMulti} OF {m.bars}
                            </text>
                          </g>
                        )}
                      </g>
                    );
                  })}

                  {/* Active Drag-to-Draw Preview Box */}
                  {drawingState && drawingState.pageNumber === page.page_number && (
                    <rect
                      x={Math.min(drawingState.startX, drawingState.currX)}
                      y={Math.min(drawingState.startY, drawingState.currY)}
                      width={Math.abs(drawingState.currX - drawingState.startX)}
                      height={Math.abs(drawingState.currY - drawingState.startY)}
                      fill="rgba(16, 185, 129, 0.25)"
                      stroke="#10b981"
                      strokeWidth={2.5}
                      strokeDasharray="6 4"
                    />
                  )}
                </svg>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
