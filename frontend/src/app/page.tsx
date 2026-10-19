"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
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

  // Active State
  const [activeMeasureIdx, setActiveMeasureIdx] = useState<number>(0);
  const [selectedMeasureIdx, setSelectedMeasureIdx] = useState<number | null>(null);
  const [measureProgress, setMeasureProgress] = useState<number>(0); // 0.0 to 1.0
  const [currentBeatInBar, setCurrentBeatInBar] = useState<number>(1);
  const [currentBarInMulti, setCurrentBarInMulti] = useState<number>(1);
  const [countInBeat, setCountInBeat] = useState<number | null>(null);

  // Loop Range (indices)
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

  // Synthesize crisp woodblock metronome click via Web Audio API
  const playMetronomeClick = useCallback((isDownbeat: boolean, isCountIn = false) => {
    if (!metronomeOn) return;
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === "suspended") ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // Higher pitch for beat 1, medium for count-in, lower for beats 2-4
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
  }, [metronomeOn]);

  // Handle PDF / Image Upload to FastAPI Backend
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setIsPlaying(false);
    setFileName(file.name);

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

      // Handle 4-beat Count-In (negative beats: -4, -3, -2, -1)
      if (totalBeatsElapsed < 0) {
        const countBeat = beatsPerBar + wholeBeatIndex + 1; // 1, 2, 3, 4
        setCountInBeat(countBeat);
        if (wholeBeatIndex !== lastClickedBeatRef.current) {
          lastClickedBeatRef.current = wholeBeatIndex;
          playMetronomeClick(countBeat === 1, true);
        }
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      setCountInBeat(null);

      // Determine which measure we are currently inside
      const startIdx = loopStartIdx !== null ? loopStartIdx : 0;
      const endIdx = loopEndIdx !== null ? loopEndIdx : measures.length - 1;

      // Calculate total beats in the active range
      let rangeTotalBeats = 0;
      for (let i = startIdx; i <= endIdx; i++) {
        rangeTotalBeats += (measures[i]?.bars || 1) * beatsPerBar;
      }

      // Loop back or stop at the end
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

      // Find exact measure and progress within that measure
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

      // Trigger Metronome Click on each new beat boundary
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
  const togglePlay = () => {
    if (measures.length === 0) return;
    if (!isPlaying) {
      // Calculate starting beat offset from currently active measure
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
  };

  const resetPlayback = () => {
    setIsPlaying(false);
    setCountInBeat(null);
    const startIdx = loopStartIdx !== null ? loopStartIdx : 0;
    setActiveMeasureIdx(startIdx);
    setMeasureProgress(0);
    setCurrentBeatInBar(1);
    setCurrentBarInMulti(1);
  };

  // Update Bar Multiplier (e.g., for "Rest 11 Bars")
  const updateMeasureBars = (idx: number, delta: number) => {
    setMeasures((prev) =>
      prev.map((m, i) => (i === idx ? { ...m, bars: Math.max(1, m.bars + delta) } : m))
    );
  };

  const selectedMeasure = selectedMeasureIdx !== null ? measures[selectedMeasureIdx] : null;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Top Studio Transport Bar */}
      <header className="sticky top-0 z-30 bg-zinc-900/95 backdrop-blur border-b border-zinc-800 px-6 py-3 shadow-lg">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
          {/* Brand & Upload */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 font-bold text-lg text-emerald-400">
              <Music className="w-6 h-6" />
              <span>DrumSync OMR</span>
            </div>

            <label className="cursor-pointer inline-flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-3.5 py-1.5 rounded-lg text-sm font-medium border border-zinc-700 transition">
              <Upload className="w-4 h-4 text-emerald-400" />
              <span>{fileName ? "Change Sheet" : "Upload Drum PDF"}</span>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={handleFileUpload}
                className="hidden"
              />
            </label>
          </div>

          {/* Transport Controls */}
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              disabled={measures.length === 0}
              className={`flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm transition ${
                isPlaying
                  ? "bg-amber-500 hover:bg-amber-400 text-zinc-950"
                  : "bg-emerald-500 hover:bg-emerald-400 text-zinc-950 disabled:opacity-40"
              }`}
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

            {/* Live Beat & Measure Status Pill */}
            {measures.length > 0 && (
              <div className="bg-zinc-950 border border-zinc-800 px-3.5 py-1.5 rounded-lg text-xs font-mono flex items-center gap-3">
                <span>
                  Measure:{" "}
                  <strong className="text-emerald-400">
                    #{measures[activeMeasureIdx]?.measure_number || 1}
                  </strong>{" "}
                  / {measures.length}
                </span>
                <span className="text-zinc-600">|</span>
                <span>
                  Beat: <strong className="text-amber-400">{currentBeatInBar}</strong>/{beatsPerBar}
                </span>
              </div>
            )}
          </div>

          {/* Tempo (BPM), Time Signature, & Practice Toggles */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 px-3 py-1.5 rounded-lg">
              <span className="text-xs text-zinc-400 font-medium">BPM</span>
              <input
                type="range"
                min={40}
                max={240}
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
                className="w-24 accent-emerald-500 cursor-pointer"
              />
              <input
                type="number"
                min={40}
                max={240}
                value={bpm}
                onChange={(e) => setBpm(Math.max(40, Math.min(240, Number(e.target.value))))}
                className="w-14 bg-zinc-900 text-center text-sm font-bold text-emerald-400 rounded border border-zinc-700 py-0.5"
              />
            </div>

            {/* Time Signature */}
            <select
              value={beatsPerBar}
              onChange={(e) => setBeatsPerBar(Number(e.target.value))}
              className="bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs font-semibold"
              title="Time Signature"
            >
              <option value={4}>4/4 Time</option>
              <option value={3}>3/4 Time</option>
              <option value={6}>6/8 Time</option>
              <option value={5}>5/4 Time</option>
              <option value={7}>7/8 Time</option>
            </select>

            {/* Metronome Sound Toggle */}
            <button
              onClick={() => setMetronomeOn(!metronomeOn)}
              className={`p-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition ${
                metronomeOn
                  ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
                  : "bg-zinc-800 border-zinc-700 text-zinc-400"
              }`}
              title="Toggle Metronome Click"
            >
              {metronomeOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
              <span className="hidden sm:inline">Click</span>
            </button>

            {/* 4-Beat Count-In Toggle */}
            <button
              onClick={() => setCountInOn(!countInOn)}
              className={`p-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition ${
                countInOn
                  ? "bg-amber-500/15 border-amber-500/50 text-amber-300"
                  : "bg-zinc-800 border-zinc-700 text-zinc-400"
              }`}
              title="4-Beat Stick Count-In before Play"
            >
              <Timer className="w-4 h-4" />
              <span className="hidden sm:inline">Count-In</span>
            </button>

            {/* Auto-Scroll Toggle */}
            <button
              onClick={() => setAutoScrollOn(!autoScrollOn)}
              className={`p-2 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition ${
                autoScrollOn
                  ? "bg-sky-500/15 border-sky-500/50 text-sky-300"
                  : "bg-zinc-800 border-zinc-700 text-zinc-400"
              }`}
              title="Hands-Free Auto-Scroll"
            >
              <ScrollText className="w-4 h-4" />
              <span className="hidden sm:inline">Auto-Scroll</span>
            </button>
          </div>
        </div>

        {/* Selected Measure Inspector Bar (Edit Multi-Bar Rests & Loops) */}
        {selectedMeasure && (
          <div className="max-w-7xl mx-auto mt-2.5 pt-2.5 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-4">
              <span className="text-zinc-400">
                Selected:{" "}
                <strong className="text-white">Measure #{selectedMeasure.measure_number}</strong>{" "}
                (Row {selectedMeasure.system_index + 1})
              </span>

              {/* Bar Multiplier for Multi-Measure Rests / Repeats */}
              <div className="flex items-center gap-2 bg-zinc-950 px-2.5 py-1 rounded border border-zinc-800">
                <span className="text-zinc-400">Bar Multiplier (for Rests/Repeats):</span>
                <button
                  onClick={() => updateMeasureBars(selectedMeasureIdx!, -1)}
                  className="p-1 hover:bg-zinc-800 rounded text-zinc-300"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <span className="font-bold text-emerald-400 px-1.5">
                  {selectedMeasure.bars} {selectedMeasure.bars === 1 ? "Bar" : "Bars"}
                </span>
                <button
                  onClick={() => updateMeasureBars(selectedMeasureIdx!, 1)}
                  className="p-1 hover:bg-zinc-800 rounded text-zinc-300"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Section Loop Controls */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setLoopStartIdx(selectedMeasureIdx)}
                className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700"
              >
                Set Loop Start (#{loopStartIdx !== null ? measures[loopStartIdx]?.measure_number : "—"})
              </button>
              <button
                onClick={() => setLoopEndIdx(selectedMeasureIdx)}
                className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700"
              >
                Set Loop End (#{loopEndIdx !== null ? measures[loopEndIdx]?.measure_number : "—"})
              </button>
              {(loopStartIdx !== null || loopEndIdx !== null) && (
                <button
                  onClick={() => {
                    setLoopStartIdx(null);
                    setLoopEndIdx(null);
                  }}
                  className="px-2.5 py-1 rounded bg-red-500/20 text-red-300 border border-red-500/40 flex items-center gap-1"
                >
                  <Repeat className="w-3 h-3" /> Clear Loop
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      {/* Giant Count-In Overlay */}
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
            <h2 className="text-xl font-bold mb-2">Upload a Drum Sheet PDF or Image to Start Sight-Reading</h2>
            <p className="text-zinc-400 text-sm max-w-md mx-auto mb-6">
              Your local YOLOv8 ONNX model will automatically detect every measure, sort them in musical reading order, and lock them to the metronome.
            </p>
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
          </div>
        )}

        {/* Rendered Pages with Responsive SVG Measure Overlay */}
        <div className="space-y-8">
          {pages.map((page) => {
            const pageMeasures = measures.filter((m) => m.page_number === page.page_number);

            return (
              <div
                key={page.page_number}
                className="relative rounded-xl overflow-hidden shadow-2xl border border-zinc-800 bg-white"
              >
                {/* Rasterized Sheet Music Image */}
                <img
                  src={page.image_url}
                  alt={`Page ${page.page_number}`}
                  className="w-full h-auto block select-none"
                />

                {/* 1:1 Coordinate-Matched SVG Overlay */}
                <svg
                  viewBox={`0 0 ${page.width} ${page.height}`}
                  className="absolute inset-0 w-full h-full"
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
                    // Add 14px top/bottom visual headroom so cymbal stems are covered cleanly
                    const padY = 14;
                    const boxY = Math.max(0, y1 - padY);
                    const boxH = y2 - y1 + padY * 2;
                    const boxW = x2 - x1;

                    // Sweeping playhead X position inside the active measure
                    const playheadX = x1 + boxW * measureProgress;

                    return (
                      <g
                        key={m.measure_number}
                        ref={(el) => {
                          measureRefs.current[m.measure_number] = el;
                        }}
                        onClick={() => {
                          setSelectedMeasureIdx(globalIdx);
                          setActiveMeasureIdx(globalIdx);
                          setMeasureProgress(0);
                          accumulatedBeatsRef.current = 0;
                        }}
                        className="cursor-pointer group"
                      >
                        {/* Measure Bounding Box */}
                        <rect
                          x={x1}
                          y={boxY}
                          width={boxW}
                          height={boxH}
                          rx={4}
                          fill={
                            isActive
                              ? "rgba(16, 185, 129, 0.24)"
                              : isInLoop
                              ? "rgba(245, 158, 11, 0.15)"
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

                        {/* Measure Number Tag (#1, #2...) */}
                        <rect
                          x={x1}
                          y={ Math.max(0, boxY - 18) }
                          width={m.bars > 1 ? 68 : 32}
                          height={18}
                          rx={3}
                          fill={isActive ? "#10b981" : "#18181b"}
                        />
                        <text
                          x={x1 + 5}
                          y={Math.max(13, boxY - 5)}
                          fill={isActive ? "#09090b" : "#a1a1aa"}
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
                </svg>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
