import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { alignLeft, alignTop, arrowPoints, distributeHorizontally, elementBounds, readCloudLibrary, sceneBounds, snapToGrid, validateBoardJSON, type Artwork, type BoardElement, type BoardKind, type Point } from "../lib/canvas";

type Tool = "select" | "hand" | "rectangle" | "ellipse" | "diamond" | "arrow" | "pen" | "text" | "container";
const TOOLS: { name: string; tool: Tool; key: string; icon: string }[] = [
  { name: "Select", tool: "select", key: "V", icon: "↖" }, { name: "Pan", tool: "hand", key: "H", icon: "✥" },
  { name: "Rectangle", tool: "rectangle", key: "R", icon: "▭" }, { name: "Ellipse", tool: "ellipse", key: "O", icon: "○" },
  { name: "Diamond", tool: "diamond", key: "D", icon: "◇" }, { name: "Arrow", tool: "arrow", key: "A", icon: "↗" },
  { name: "Freehand", tool: "pen", key: "P", icon: "∿" }, { name: "Text", tool: "text", key: "T", icon: "T" },
  { name: "Container", tool: "container", key: "C", icon: "☐" },
];

const BoardShape = memo(function Shape({ element, elements }: { element: BoardElement; elements: BoardElement[] }) {
  const { kind, x, y, width, height, stroke, fill, strokeWidth } = element;
  const paint = { stroke, fill, strokeWidth, strokeDasharray: element.dashed ? "6 4" : undefined };
  const text = (centered: boolean) => (element.text ?? "").split("\n").map((line, index, lines) => (
    <text key={index} x={centered ? x + width / 2 : x} y={centered ? y + height / 2 + (index - (lines.length - 1) / 2) * 22 : y + (index + 1) * (element.fontSize ?? 20) * 1.2}
      fill={kind === "card" ? "#e9ecf2" : stroke} fontSize={element.fontSize ?? 20} fontFamily="Segoe UI, sans-serif" textAnchor={centered ? "middle" : "start"} dominantBaseline={centered ? "central" : "auto"}>{line}</text>
  ));
  let shape;
  if (kind === "arrow") {
    const [from, to] = arrowPoints(element, elements);
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const size = 9 + strokeWidth;
    const tip = `${to.x - size * Math.cos(angle - 0.45)},${to.y - size * Math.sin(angle - 0.45)} ${to.x},${to.y} ${to.x - size * Math.cos(angle + 0.45)},${to.y - size * Math.sin(angle + 0.45)}`;
    shape = <>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="transparent" strokeWidth={Math.max(14, strokeWidth)} />
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} {...paint} /><polyline points={tip} fill="none" stroke={stroke} strokeWidth={strokeWidth} />
      {element.text && <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 8} textAnchor="middle" fontSize="12" fill={stroke} paintOrder="stroke" stroke="#ffffff" strokeWidth="4">{element.text}</text>}
    </>;
  } else if (kind === "symbol" && element.artwork) {
    shape = <g transform={`translate(${x} ${y}) scale(${width / element.artwork.width} ${height / element.artwork.height})`}>
      {element.artwork.elements.map((child) => <BoardShape key={child.id} element={child} elements={element.artwork!.elements} />)}
    </g>;
  } else if (kind === "pen") {
    shape = <polyline points={element.points?.map((point) => `${x + point.x},${y + point.y}`).join(" ")} {...paint} strokeLinecap="round" strokeLinejoin="round" />;
  } else if (kind === "ellipse") {
    shape = <ellipse cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} {...paint} />;
  } else if (kind === "diamond") {
    shape = <polygon points={`${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}`} {...paint} />;
  } else if (kind === "text") {
    shape = text(false);
  } else if (kind === "container") {
    shape = <><rect x={x} y={y} width={width} height={height} rx={6} {...paint} strokeDasharray="8 4" />
      {element.text && <text x={x + 8} y={y + 18} fontSize={14} fill="#2c3040" fontFamily="Segoe UI, sans-serif" textAnchor="start">{element.text}</text>}</>;
  } else {
    shape = <><rect x={x} y={y} width={width} height={height} rx={kind === "card" ? 12 : 3} {...paint} />{element.text && text(true)}</>;
  }
  return <g opacity={element.opacity ?? 1} transform={element.angle ? `rotate(${element.angle * 180 / Math.PI} ${x + width / 2} ${y + height / 2})` : undefined}>{shape}</g>;
});

interface CanvasViewProps {
  elements: BoardElement[];
  onChange: (elements: BoardElement[]) => void;
  fitKey: number;
  onOpenSource?: (source: { nodeId: string; file: string; line?: number }) => void;
}
interface Drag {
  mode: "pan" | "move" | "draw" | "resize" | "marquee";
  start: Point;
  screen: Point;
  before: BoardElement[];
  ids: Set<string>;
  draft?: BoardElement;
  camera: { x: number; y: number; zoom: number };
  moved: boolean;
}

export function CanvasView({ elements, onChange, fitKey, onOpenSource }: CanvasViewProps) {
  const svg = useRef<SVGSVGElement>(null);
  const current = useRef(elements);
  useEffect(() => { current.current = elements; }, [elements]);
  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState(new Set<string>());
  const [stroke, setStroke] = useState("#b8abff");
  const [fill, setFill] = useState("#252338");
  const [filled, setFilled] = useState(true);
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [camera, setCamera] = useState({ x: 80, y: 60, zoom: 1 });
  const [grid, setGrid] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<Artwork[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [past, setPast] = useState<BoardElement[][]>([]);
  const [future, setFuture] = useState<BoardElement[][]>([]);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [exportError, setExportError] = useState("");
  const [clipboard, setClipboard] = useState<BoardElement[]>([]);
  const [presenting, setPresenting] = useState(false);
  const [commentingId, setCommentingId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [importError, setImportError] = useState("");
  const drag = useRef<Drag | null>(null);
  const lastTap = useRef<{ id: string; time: number } | null>(null);
  const space = useRef(false);
  const gridSize = 24;

  const change = (next: BoardElement[]) => { current.current = next; onChange(next); };
  const record = (before: BoardElement[]) => { setPast((items) => [...items.slice(-49), before]); setFuture([]); };
  const commit = (next: BoardElement[]) => { record(current.current); change(next); };
  const fit = () => {
    const bounds = sceneBounds(current.current);
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const zoom = Math.max(0.1, Math.min(1.5, (box.width - 140) / Math.max(bounds.width, 1), (box.height - 140) / Math.max(bounds.height, 1)));
    setCamera({ x: box.width / 2 - (bounds.x + bounds.width / 2) * zoom, y: box.height / 2 - (bounds.y + bounds.height / 2) * zoom, zoom });
  };
  useEffect(() => { fit(); }, [fitKey]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/libraries/cloud.excalidrawlib", { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Cloud library could not be loaded."); return response.json(); })
      .then((data) => setLibrary(readCloudLibrary(data)))
      .catch((error: Error) => { if (error.name !== "AbortError") setLibraryError(error.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const element = svg.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      setCamera((value) => {
        const zoom = Math.max(0.1, Math.min(5, value.zoom * Math.exp(-event.deltaY * 0.0015)));
        return { zoom, x: x - (x - value.x) * zoom / value.zoom, y: y - (y - value.y) * zoom / value.zoom };
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const undo = () => {
    if (!past.length) return;
    const before = current.current;
    setFuture((items) => [...items, before]);
    change(past[past.length - 1]); setPast(past.slice(0, -1)); setSelected(new Set());
  };
  const redo = () => {
    if (!future.length) return;
    const before = current.current;
    setPast((items) => [...items, before]);
    change(future[future.length - 1]); setFuture(future.slice(0, -1)); setSelected(new Set());
  };
  const remove = () => {
    if (!selected.size) return;
    commit(elements.filter((element) => !selected.has(element.id)).map((element) => {
      if (element.kind !== "arrow" || (!selected.has(element.startId ?? "") && !selected.has(element.endId ?? ""))) return element;
      const [from, to] = arrowPoints(element, elements);
      return { ...element, x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y, points: undefined,
        startId: selected.has(element.startId ?? "") ? undefined : element.startId, endId: selected.has(element.endId ?? "") ? undefined : element.endId };
    }));
    setSelected(new Set());
  };
  const duplicate = () => {
    if (!selected.size) return;
    const ids = new Map([...selected].map((id) => [id, crypto.randomUUID()]));
    const copies = elements.filter((element) => selected.has(element.id)).map((element) => {
      const [from, to] = element.kind === "arrow" ? arrowPoints(element, elements) : [{ x: element.x, y: element.y }, { x: 0, y: 0 }];
      return { ...element, id: ids.get(element.id)!, x: from.x + 24, y: from.y + 24,
        ...(element.kind === "arrow" ? { width: to.x - from.x, height: to.y - from.y, points: undefined } : {}),
        startId: ids.get(element.startId ?? ""), endId: ids.get(element.endId ?? "") };
    });
    commit([...elements, ...copies]); setSelected(new Set(copies.map((element) => element.id)));
  };
  const style = (patch: Partial<BoardElement>) => {
    if (selected.size) commit(elements.map((element) => selected.has(element.id) ? { ...element, ...patch } : element));
  };
  const pointer = (event: ReactPointerEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left - camera.x) / camera.zoom, y: (event.clientY - rect.top - camera.y) / camera.zoom };
  };
  const targetAt = (point: Point) => [...current.current].reverse().find((element) => {
    if (element.kind === "arrow" || element.kind === "pen") return false;
    const box = elementBounds(element);
    return point.x >= box.x && point.y >= box.y && point.x <= box.x + box.width && point.y <= box.y + box.height;
  });
  const down = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault(); svg.current!.focus(); svg.current!.setPointerCapture(event.pointerId);
    const start = pointer(event);
    const target = (event.target as Element).closest("[data-element-id]")?.getAttribute("data-element-id") ?? (tool === "select" ? targetAt(start)?.id : undefined);
    const resize = (event.target as Element).getAttribute("data-resize-id");
    const state: Drag = { mode: "marquee", start, screen: { x: event.clientX, y: event.clientY }, before: current.current, ids: selected, camera, moved: false };
    if (tool === "hand" || event.button === 1 || space.current) state.mode = "pan";
    else if (resize) { state.mode = "resize"; state.ids = new Set([resize]); }
    else if (tool === "select") {
      if (target) {
        const ids = event.shiftKey || event.ctrlKey || event.metaKey ? new Set(selected) : selected.has(target) ? new Set(selected) : new Set<string>();
        if ((event.shiftKey || event.ctrlKey || event.metaKey) && ids.has(target)) ids.delete(target); else ids.add(target);
        setSelected(ids); state.ids = ids; state.mode = "move";
      } else if (!event.shiftKey) { setSelected(new Set()); state.ids = new Set(); }
    } else {
      const element: BoardElement = {
        id: crypto.randomUUID(), kind: tool as BoardKind, x: start.x, y: start.y, width: 0, height: 0,
        stroke, fill: tool === "pen" || tool === "arrow" || !filled ? "none" : fill, strokeWidth,
        ...(tool === "pen" || tool === "arrow" ? { points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] } : {}),
        ...(tool === "arrow" ? { startId: targetAt(start)?.id } : {}),
      };
      if (tool === "text") {
        element.width = 180; element.height = 30; element.text = "Note"; element.fontSize = 20;
        commit([...current.current, element]); setSelected(new Set([element.id])); setEditing({ id: element.id, text: "Note" }); setTool("select");
        return;
      }
      state.mode = "draw"; state.draft = element;
      change([...current.current, element]); setSelected(new Set([element.id]));
    }
    drag.current = state;
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (!state) return;
    const point = pointer(event);
    const dx = point.x - state.start.x;
    const dy = point.y - state.start.y;
    if (Math.hypot(event.clientX - state.screen.x, event.clientY - state.screen.y) > 3) state.moved = true;
    if (state.mode === "pan") {
      setCamera({ ...state.camera, x: state.camera.x + event.clientX - state.screen.x, y: state.camera.y + event.clientY - state.screen.y });
    } else if (state.mode === "move") {
      const movingIds = new Set(state.ids);
      for (const element of state.before) {
        if (!state.ids.has(element.id) || !element.groupId) continue;
        for (const other of state.before) if (other.groupId === element.groupId) movingIds.add(other.id);
      }
      change(state.before.map((element) => {
        if (!movingIds.has(element.id)) return element;
        const [from, to] = element.kind === "arrow" ? arrowPoints(element, state.before) : [{ x: element.x, y: element.y }, { x: 0, y: 0 }];
        const movedX = from.x + dx;
        const movedY = from.y + dy;
        return { ...element, x: snapEnabled ? snapToGrid(movedX, gridSize) : movedX, y: snapEnabled ? snapToGrid(movedY, gridSize) : movedY,
          ...(element.kind === "arrow" ? { width: to.x - from.x, height: to.y - from.y, points: undefined,
            startId: movingIds.has(element.startId ?? "") ? element.startId : undefined, endId: movingIds.has(element.endId ?? "") ? element.endId : undefined } : {}) };
      }));
    } else if (state.mode === "resize") {
      change(state.before.map((element) => {
        if (!state.ids.has(element.id)) return element;
        const width = Math.max(12, element.width + dx);
        return { ...element, width, height: event.shiftKey ? width * element.height / element.width : Math.max(12, element.height + dy) };
      }));
    } else if (state.mode === "draw") {
      const element = state.draft!;
      let next: BoardElement;
      if (element.kind === "pen") {
        const previous = current.current.find((item) => item.id === element.id)!;
        const points = [...previous.points!, { x: dx, y: dy }];
        next = { ...element, points, width: dx, height: dy };
      } else if (element.kind === "arrow") {
        const endId = targetAt(point)?.id;
        next = { ...element, width: dx, height: dy, points: [{ x: 0, y: 0 }, { x: dx, y: dy }], endId: endId === element.startId ? undefined : endId };
      } else {
        const rawWidth = event.shiftKey ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.abs(dx);
        const rawHeight = event.shiftKey ? rawWidth : Math.abs(dy);
        const width = snapEnabled ? snapToGrid(rawWidth, gridSize) : rawWidth;
        const height = snapEnabled ? snapToGrid(rawHeight, gridSize) : rawHeight;
        const rawX = dx < 0 ? state.start.x - rawWidth : state.start.x;
        const rawY = dy < 0 ? state.start.y - rawHeight : state.start.y;
        next = { ...element, x: snapEnabled ? snapToGrid(rawX, gridSize) : rawX, y: snapEnabled ? snapToGrid(rawY, gridSize) : rawY, width, height };
      }
      change([...state.before, next]);
    } else {
      setMarquee({ x: Math.min(state.start.x, point.x), y: Math.min(state.start.y, point.y), width: Math.abs(dx), height: Math.abs(dy) });
    }
  };
  const up = (event: ReactPointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (!state) return;
    if (event.type === "pointercancel") change(state.before);
    else if (state.mode === "marquee" && marquee) {
      const ids = new Set(state.ids);
      for (const element of current.current) {
        const box = elementBounds(element, current.current);
        if (box.x >= marquee.x && box.y >= marquee.y && box.x + box.width <= marquee.x + marquee.width && box.y + box.height <= marquee.y + marquee.height) ids.add(element.id);
      }
      setSelected(ids);
    } else if (["draw", "move", "resize"].includes(state.mode)) {
      if (state.moved) record(state.before); else change(state.before);
      if (state.mode === "draw") { setTool("select"); if (!state.moved) setSelected(new Set()); }
    }
    drag.current = null; setMarquee(null);
    if (svg.current!.hasPointerCapture(event.pointerId)) svg.current!.releasePointerCapture(event.pointerId);
    const clickedId = event.type !== "pointercancel" && state.mode === "move" && !state.moved && state.ids.size === 1 ? [...state.ids][0] : undefined;
    if (clickedId && lastTap.current?.id === clickedId && event.timeStamp - lastTap.current.time < 400) {
      lastTap.current = null;
      const element = current.current.find((item) => item.id === clickedId);
      if (element?.source && onOpenSource) onOpenSource(element.source);
      else if (element?.text !== undefined) setEditing({ id: element.id, text: element.text });
    } else lastTap.current = clickedId ? { id: clickedId, time: event.timeStamp } : null;
  };
  const addSymbol = (artwork: Artwork) => {
    const rect = svg.current!.getBoundingClientRect();
    const width = 180;
    const height = width * artwork.height / artwork.width;
    const element: BoardElement = { id: crypto.randomUUID(), kind: "symbol", x: (rect.width / 2 - camera.x) / camera.zoom - width / 2,
      y: (rect.height / 2 - camera.y) / camera.zoom - height / 2, width, height, artwork, stroke, fill: "none", strokeWidth };
    commit([...elements, element]); setSelected(new Set([element.id])); setTool("select"); svg.current?.focus();
  };
  const finishText = () => {
    if (!editing) return;
    const lines = editing.text.split("\n");
    commit(current.current.map((element) => element.id === editing.id ? { ...element, text: editing.text,
      ...(element.kind === "text" ? { width: Math.max(20, ...lines.map((line) => line.length * 12)), height: Math.max(28, lines.length * 25) } : {}) } : element));
    setEditing(null);
  };
  const exportBoard = async (format: "svg" | "png") => {
    setExportError("");
    const bounds = sceneBounds(elements);
    const width = Math.ceil(Math.max(1, bounds.width) + 80);
    const height = Math.ceil(Math.max(1, bounds.height) + 80);
    const root = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    root.setAttribute("width", String(width)); root.setAttribute("height", String(height));
    root.setAttribute("viewBox", `${bounds.x - 40} ${bounds.y - 40} ${width} ${height}`);
    const background = document.createElementNS(root.namespaceURI, "rect");
    for (const [key, value] of Object.entries({ x: bounds.x - 40, y: bounds.y - 40, width, height, fill: "#ffffff" })) background.setAttribute(key, String(value));
    root.append(background, svg.current!.querySelector(".board-content")!.cloneNode(true));
    let blob = new Blob([new XMLSerializer().serializeToString(root)], { type: "image/svg+xml" });
    if (format === "png") {
      const url = URL.createObjectURL(blob);
      try {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement("canvas");
        const scale = Math.min(2, 4096 / Math.max(width, height));
        canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
        canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
        blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("PNG export failed."))));
      } catch (error) { setExportError((error as Error).message); return; }
      finally { URL.revokeObjectURL(url); }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `sourcebeta-board.${format}`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const zoomBy = (factor: number) => {
    const rect = svg.current!.getBoundingClientRect();
    setCamera((value) => { const zoom = Math.max(0.1, Math.min(5, value.zoom * factor)); return { zoom, x: rect.width / 2 - (rect.width / 2 - value.x) * zoom / value.zoom, y: rect.height / 2 - (rect.height / 2 - value.y) * zoom / value.zoom }; });
  };

  const copySelection = () => {
    if (!selected.size) return;
    setClipboard(elements.filter((e) => selected.has(e.id)));
  };
  const pasteClipboard = () => {
    if (!clipboard.length) return;
    const ids = new Map(clipboard.map((e) => [e.id, crypto.randomUUID()]));
    const groups = new Map(clipboard.filter((e) => e.groupId).map((e) => [e.groupId, crypto.randomUUID()]));
    const copies = clipboard.map((e) => ({
      ...e, id: ids.get(e.id)!, x: e.x + 24, y: e.y + 24,
      startId: ids.get(e.startId ?? ""),
      endId: ids.get(e.endId ?? ""),
      groupId: e.groupId ? groups.get(e.groupId) : undefined,
    }));
    commit([...elements, ...copies]);
    setSelected(new Set(copies.map((e) => e.id)));
  };
  const groupSelection = () => {
    if (selected.size < 2) return;
    const groupId = crypto.randomUUID();
    commit(elements.map((e) => selected.has(e.id) ? { ...e, groupId } : e));
  };
  const ungroupSelection = () => {
    if (!selected.size) return;
    commit(elements.map((e) => selected.has(e.id) && e.groupId ? { ...e, groupId: undefined } : e));
  };
  const alignSelectedLeft = () => {
    const sel = elements.filter((e) => selected.has(e.id));
    if (sel.length < 2) return;
    const aligned = alignLeft(sel);
    const map = new Map(aligned.map((e) => [e.id, e]));
    commit(elements.map((e) => map.get(e.id) ?? e));
  };
  const alignSelectedTop = () => {
    const sel = elements.filter((e) => selected.has(e.id));
    if (sel.length < 2) return;
    const aligned = alignTop(sel);
    const map = new Map(aligned.map((e) => [e.id, e]));
    commit(elements.map((e) => map.get(e.id) ?? e));
  };
  const distributeSelectedHorizontally = () => {
    const sel = elements.filter((e) => selected.has(e.id));
    if (sel.length < 3) return;
    const distributed = distributeHorizontally(sel);
    const map = new Map(distributed.map((e) => [e.id, e]));
    commit(elements.map((e) => map.get(e.id) ?? e));
  };
  const togglePresentation = () => {
    if (!document.fullscreenElement) {
      svg.current?.parentElement?.requestFullscreen?.().then(() => setPresenting(true)).catch(() => {});
    } else {
      document.exitFullscreen?.().then(() => setPresenting(false)).catch(() => {});
    }
  };
  useEffect(() => {
    const handler = () => { if (!document.fullscreenElement) setPresenting(false); };
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);
  const exportJSON = () => {
    setExportError("");
    try {
      const json = JSON.stringify(elements, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = "sourcebeta-board.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setExportError((error as Error).message); }
  };
  const importJSON = (file: File) => {
    setImportError("");
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string);
        const validated = validateBoardJSON(data);
        commit(validated);
        setSelected(new Set());
      } catch (error) { setImportError((error as Error).message); }
    };
    reader.readAsText(file);
  };
  const saveComment = (id: string) => {
    commit(elements.map((e) => e.id === id ? { ...e, comment: commentText || undefined } : e));
    setCommentingId(null);
    setCommentText("");
  };

  return <div className="canvas-host" onKeyDown={(event) => {
    if ((event.target as HTMLElement).matches("input, textarea, select")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") { event.preventDefault(); duplicate(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(new Set(elements.map((element) => element.id))); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") { event.preventDefault(); copySelection(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") { event.preventDefault(); pasteClipboard(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g" && event.shiftKey) { event.preventDefault(); ungroupSelection(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") { event.preventDefault(); groupSelection(); }
    else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); remove(); }
    else if (event.code === "Space") { event.preventDefault(); space.current = true; }
    else if (event.key === "Escape") { if (presenting) togglePresentation(); else { setSelected(new Set()); setTool("select"); } }
    else if (!event.ctrlKey && !event.metaKey && !event.altKey) { const next = TOOLS.find((item) => item.key.toLowerCase() === event.key.toLowerCase()); if (next) setTool(next.tool); }
  }} onKeyUp={(event) => { if (event.code === "Space") space.current = false; }} onBlur={() => { space.current = false; }}>
    <div className="board-tools" role="toolbar" aria-label="Drawing tools">
      <span className="board-badge">SOURCEBETA BOARD</span>
      {TOOLS.map((item) => <button key={item.tool} aria-label={item.name} title={`${item.name} (${item.key})`} aria-pressed={tool === item.tool} onClick={() => setTool(item.tool)}><span>{item.icon}</span><small>{item.key}</small></button>)}
      <span className="tool-divider" />
      <button onClick={undo} disabled={!past.length} title="Undo (Ctrl/⌘ Z)">Undo</button>
      <button onClick={redo} disabled={!future.length}>Redo</button>
      <button aria-pressed={libraryOpen} onClick={() => setLibraryOpen(!libraryOpen)}>Cloud library</button>
      <button onClick={() => void exportBoard("svg")}>Export SVG</button>
      <button onClick={() => void exportBoard("png")}>Export PNG</button>
      <button onClick={exportJSON}>Export JSON</button>
      <label title="Import board JSON" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#4a4e5a", fontSize: 13 }}>
        Import <input type="file" accept=".json,application/json" aria-label="Import board JSON" onChange={(event) => { const file = event.target.files?.[0]; if (file) importJSON(file); event.target.value = ""; }} style={{ maxWidth: 140 }} />
      </label>
    </div>
    <div className="board-properties">
      <label>Stroke <input aria-label="Stroke color" type="color" value={stroke} onChange={(event) => { setStroke(event.target.value); style({ stroke: event.target.value }); }} /></label>
      <label><input type="checkbox" checked={filled} onChange={(event) => { setFilled(event.target.checked); style({ fill: event.target.checked ? fill : "none" }); }} /> Fill</label>
      <input aria-label="Fill color" type="color" value={fill} onChange={(event) => { setFill(event.target.value); if (filled) style({ fill: event.target.value }); }} />
      <label>Width <select aria-label="Stroke width" value={strokeWidth} onChange={(event) => { const value = Number(event.target.value); setStrokeWidth(value); style({ strokeWidth: value }); }}><option>1</option><option>2</option><option>4</option><option>8</option></select></label>
      <button disabled={!selected.size} onClick={duplicate}>Duplicate</button><button disabled={!selected.size} onClick={remove}>Delete</button>
      <label><input type="checkbox" checked={grid} onChange={(event) => setGrid(event.target.checked)} /> Grid</label>
      <label><input type="checkbox" checked={snapEnabled} onChange={(event) => setSnapEnabled(event.target.checked)} /> Snap</label>
      <span className="tool-divider" />
      <button disabled={selected.size < 2} onClick={alignSelectedLeft} title="Align left">Align ←</button>
      <button disabled={selected.size < 2} onClick={alignSelectedTop} title="Align top">Align ↑</button>
      <button disabled={selected.size < 3} onClick={distributeSelectedHorizontally} title="Distribute horizontally">Distribute ↔</button>
      <span className="tool-divider" />
      <button disabled={selected.size < 2} onClick={groupSelection} title="Group (Ctrl/⌘ G)">Group</button>
      <button disabled={!selected.size} onClick={ungroupSelection} title="Ungroup (Ctrl/⌘⇧ G)">Ungroup</button>
      <span className="tool-divider" />
      <button onClick={togglePresentation} title={presenting ? "Exit presentation" : "Present (fullscreen)"}>{presenting ? "Exit Present" : "Present"}</button>
      <span className="hint">{elements.length} objects · {selected.size} selected{clipboard.length ? ` · ${clipboard.length} copied` : ""}</span>
    </div>
    {exportError && <div role="alert" className="error">{exportError}</div>}
    {importError && <div role="alert" className="error">{importError}</div>}
    <div className="board-body">
      <div className="board-viewport">
        <svg ref={svg} className={`board-surface tool-${tool}`} aria-label="Sourcebeta drawing canvas" role="application" tabIndex={0}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <defs><pattern id="board-dots" patternUnits="userSpaceOnUse" width={24 * camera.zoom} height={24 * camera.zoom} x={camera.x} y={camera.y}><circle cx="1" cy="1" r="1" fill="#343745" /></pattern></defs>
          <rect width="100%" height="100%" fill={grid ? "url(#board-dots)" : "#ffffff"} />
          <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.zoom})`} data-camera="true">
            <g className="board-content">{elements.map((element) => <g key={element.id} data-element-id={element.id} data-kind={element.kind}><BoardShape element={element} elements={elements} /></g>)}</g>
            {elements.filter((element) => selected.has(element.id)).map((element) => {
              const box = elementBounds(element, elements);
              return <g key={element.id} className="board-selection"><rect x={box.x - 5} y={box.y - 5} width={box.width + 10} height={box.height + 10} fill="none" stroke="#b8abff" strokeWidth={1 / camera.zoom} strokeDasharray={`${4 / camera.zoom} ${3 / camera.zoom}`} pointerEvents="none" />
                {element.kind !== "arrow" && element.kind !== "pen" && <rect data-resize-id={element.id} x={element.x + element.width - 4 / camera.zoom} y={element.y + element.height - 4 / camera.zoom} width={8 / camera.zoom} height={8 / camera.zoom} fill="#e4deff" stroke="#6555c4" strokeWidth={1 / camera.zoom} style={{ cursor: "nwse-resize" }} />}</g>;
            })}
            {marquee && <rect {...marquee} fill="#8b7ff022" stroke="#b8abff" strokeWidth={1 / camera.zoom} pointerEvents="none" />}
          </g>
        </svg>
        {elements.length === 0 && <div className="board-welcome"><strong>Your ideas, connected.</strong><span>Draw a shape, bring in code nodes, or choose a cloud symbol.</span></div>}
        <div className="board-navigation"><button aria-label="Zoom out canvas" onClick={() => zoomBy(0.8)}>−</button><output>{Math.round(camera.zoom * 100)}%</output><button aria-label="Zoom in canvas" onClick={() => zoomBy(1.25)}>+</button><button onClick={fit}>Fit board</button></div>
        <span className="board-help">Drag to draw · Shift for proportions · Space + drag to pan</span>
        {editing && <div className="board-text-editor"><label>Edit text<textarea aria-label="Edit text" autoFocus value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); finishText(); } }} /></label><button onClick={finishText}>Apply text</button><button onClick={() => setEditing(null)}>Cancel</button></div>}
        {commentingId && <div className="board-text-editor" style={{ position: "absolute", bottom: 40, right: 12, zIndex: 10 }}><label>Comment<textarea aria-label="Edit comment" autoFocus value={commentText} onChange={(event) => setCommentText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setCommentingId(null); setCommentText(""); } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); saveComment(commentingId); } }} placeholder="Add a comment…" /></label><button onClick={() => saveComment(commentingId)}>Save</button><button onClick={() => { setCommentingId(null); setCommentText(""); }}>Cancel</button></div>}
        {presenting && <button onClick={togglePresentation} style={{ position: "absolute", top: 12, right: 12, zIndex: 20, background: "#232738", color: "#e9ecf2", border: "1px solid #4a4e5a", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 14 }} aria-label="Exit presentation mode">Exit Presentation ✕</button>}
        {selected.size > 0 && <div style={{ position: "absolute", bottom: 8, left: 12, zIndex: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[...selected].map((id) => {
            const element = elements.find((e) => e.id === id);
            if (!element) return null;
            return <button key={id} onClick={() => { setCommentingId(id); setCommentText(element.comment ?? ""); }} style={{ background: element.comment ? "#b8abff" : "#2c3040", color: element.comment ? "#1a1c24" : "#9ca3af", border: "1px solid #4a4e5a", borderRadius: 4, padding: "2px 8px", fontSize: 12, cursor: "pointer" }} title={element.comment || "Add comment"}>{element.comment ? `Comment: ${element.comment.slice(0, 20)}` : "Add comment"}</button>;
          })}
        </div>}
      </div>
      {libraryOpen && <aside className="board-library"><div className="library-heading"><h2>Cloud library</h2><button aria-label="Close library" onClick={() => setLibraryOpen(false)}>×</button></div><p className="hint">Your imported artwork, drawn by Sourcebeta.</p>
        {libraryError ? <p role="alert">{libraryError}</p> : library.length === 0 ? <p>Loading symbols…</p> : <div className="cloud-grid">{library.map((artwork) => <button key={artwork.name} aria-label={artwork.name} title={`Insert ${artwork.name.toLowerCase()}`} onClick={() => addSymbol(artwork)}><svg viewBox={`-8 -8 ${artwork.width + 16} ${artwork.height + 16}`} aria-hidden="true">{artwork.elements.map((element) => <BoardShape key={element.id} element={element} elements={artwork.elements} />)}</svg></button>)}</div>}
      </aside>}
    </div>
  </div>;
}
