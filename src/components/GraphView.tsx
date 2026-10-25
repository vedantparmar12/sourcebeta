import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphAnalytics } from "../lib/analytics";
import { createLayout, fitGraph, hitGraphNode, stepLayout, type LayoutNode } from "../lib/layout";
import type { KnowledgeGraph } from "../lib/types";

const COMMUNITY_COLORS = [
  "#7c6cf0", "#4dabf7", "#38d9a9", "#ffd43b", "#ff8787", "#f783ac",
  "#66d9e8", "#a9e34b", "#ffa94d", "#b197fc", "#63e6be", "#e599f7",
];

interface GraphViewProps {
  graph: KnowledgeGraph;
  analytics: GraphAnalytics;
  visibleIds: Set<string>;
  selected: Set<string>;
  activeId: string | null;
  onSelect: (id: string, additive: boolean) => void;
  onBackground: () => void;
}

export function GraphView({ graph, analytics, visibleIds, selected, activeId, onSelect, onBackground }: GraphViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layout = useMemo(() => createLayout(graph, analytics), [graph, analytics]);
  const latest = useRef({ visibleIds, selected, activeId, onSelect, onBackground });
  const controls = useRef<{ fit: () => void; zoom: (factor: number) => void; redraw: () => void } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tooltip, setTooltip] = useState<{ node: LayoutNode; x: number; y: number } | null>(null);

  useEffect(() => {
    const previous = latest.current.visibleIds;
    const filtered = previous.size !== visibleIds.size || [...visibleIds].some((id) => !previous.has(id));
    latest.current = { visibleIds, selected, activeId, onSelect, onBackground };
    if (filtered) { controls.current?.fit(); setTooltip(null); }
    else controls.current?.redraw();
  }, [visibleIds, selected, activeId, onSelect, onBackground]);

  useEffect(() => {
    const element = canvas.current!;
    const context = element.getContext("2d")!;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let camera = { x: 0, y: 0, scale: 1 };
    let frameId = 0;
    let ticks = 0;
    let autoFit = true;
    const maxTicks = layout.nodes.length > 8000 ? 60 : layout.nodes.length > 4000 ? 90 : 150;
    const repulsionSamples = layout.nodes.length > 8000 ? 6 : 12;
    const settleThreshold = layout.nodes.length > 4000 ? 0.04 : 0.015;
    let hovered: LayoutNode | undefined;
    let drag: { node?: LayoutNode; x: number; y: number; startX: number; startY: number; cameraX: number; cameraY: number; fixed: boolean; moved: boolean; pointerId: number } | null = null;

    const fit = () => {
      camera = fitGraph(layout.nodes.filter((node) => latest.current.visibleIds.has(node.id)), width, height);
      setZoom(camera.scale);
    };
    const paint = () => {
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.fillStyle = "#101217";
      context.fillRect(0, 0, width, height);
      context.translate(camera.x, camera.y);
      context.scale(camera.scale, camera.scale);
      const state = latest.current;
      const highlighted = (id: string) => state.selected.has(id) || state.activeId === id || hovered?.id === id;
      const left = -camera.x / camera.scale;
      const top = -camera.y / camera.scale;
      const right = (width - camera.x) / camera.scale;
      const bottom = (height - camera.y) / camera.scale;

      for (const emphasis of [false, true]) {
        for (const inferred of [false, true]) {
          context.beginPath();
          context.strokeStyle = emphasis ? "#c6c4e1" : inferred ? "#59617555" : "#66708677";
          context.lineWidth = (emphasis ? 1.4 : 0.8) / camera.scale;
          context.setLineDash(inferred ? [5 / camera.scale, 4 / camera.scale] : []);
          for (const { from, to, edge } of layout.edges) {
            if (!state.visibleIds.has(from.id) || !state.visibleIds.has(to.id)) continue;
            if ((highlighted(from.id) || highlighted(to.id)) !== emphasis || (edge.confidence === "INFERRED") !== inferred) continue;
            if (Math.max(from.x, to.x) < left || Math.min(from.x, to.x) > right || Math.max(from.y, to.y) < top || Math.min(from.y, to.y) > bottom) continue;
            if (from === to) {
              context.moveTo(from.x + from.radius, from.y - from.radius);
              context.arc(from.x, from.y - from.radius, from.radius, 0, Math.PI * 1.7);
              continue;
            }
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const distance = Math.hypot(dx, dy);
            if (distance <= from.radius + to.radius + 2) continue;
            const ux = dx / distance;
            const uy = dy / distance;
            const x = to.x - ux * (to.radius + 2);
            const y = to.y - uy * (to.radius + 2);
            context.moveTo(from.x + ux * from.radius, from.y + uy * from.radius);
            context.lineTo(x, y);
            if (camera.scale > 0.45 || emphasis) {
              const size = 5 / camera.scale;
              context.moveTo(x - ux * size - uy * size * 0.45, y - uy * size + ux * size * 0.45);
              context.lineTo(x, y);
              context.lineTo(x - ux * size + uy * size * 0.45, y - uy * size - ux * size * 0.45);
            }
          }
          context.stroke();
        }
      }
      context.setLineDash([]);
      let labels = 0;
      for (const node of layout.nodes) {
        if (!state.visibleIds.has(node.id) || node.x + node.radius < left || node.x - node.radius > right || node.y + node.radius < top || node.y - node.radius > bottom) continue;
        context.beginPath();
        context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        const community = analytics.community.get(node.id);
        context.fillStyle = community === undefined ? "#adb5bd" : COMMUNITY_COLORS[community % COMMUNITY_COLORS.length];
        context.fill();
        const prominent = highlighted(node.id);
        if (prominent) {
          context.strokeStyle = state.activeId === node.id ? "#ffffff" : "#d7cffb";
          context.lineWidth = 2 / camera.scale;
          context.stroke();
        }
        if (prominent || analytics.godNodes.includes(node.id) || (camera.scale > 1.1 && labels < 160)) {
          const text = node.label.length > 70 ? `${node.label.slice(0, 67)}…` : node.label;
          context.font = `${12 / camera.scale}px "Segoe UI", sans-serif`;
          context.textAlign = "center";
          context.lineWidth = 3 / camera.scale;
          context.strokeStyle = "#101217";
          context.strokeText(text, node.x, node.y + node.radius + 16 / camera.scale);
          context.fillStyle = "#e4e4ee";
          context.fillText(text, node.x, node.y + node.radius + 16 / camera.scale);
          labels++;
        }
      }
    };
    const render = () => {
      frameId = 0;
      if (ticks < maxTicks) {
        const motion = stepLayout(layout, Math.max(0.08, 1 - ticks / maxTicks), repulsionSamples);
        ticks++;
        if (ticks > Math.min(50, maxTicks / 2) && motion < settleThreshold) ticks = maxTicks;
        if (autoFit && (ticks % 20 === 0 || ticks === maxTicks)) fit();
      }
      element.dataset.layoutState = ticks < maxTicks ? "running" : "settled";
      paint();
      if (ticks < maxTicks) schedule();
    };
    const schedule = () => { if (!frameId) frameId = requestAnimationFrame(render); };
    const zoomAt = (factor: number, x: number, y: number) => {
      autoFit = false;
      const scale = Math.max(0.01, Math.min(8, camera.scale * factor));
      camera = { scale, x: x - (x - camera.x) * scale / camera.scale, y: y - (y - camera.y) * scale / camera.scale };
      setZoom(scale);
      schedule();
    };
    controls.current = { fit: () => { autoFit = false; fit(); schedule(); }, zoom: (factor) => zoomAt(factor, width / 2, height / 2), redraw: schedule };
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry.contentRect.width;
      const nextHeight = entry.contentRect.height;
      const initial = width === 0 || height === 0;
      camera.x += (nextWidth - width) / 2;
      camera.y += (nextHeight - height) / 2;
      width = nextWidth;
      height = nextHeight;
      pixelRatio = window.devicePixelRatio || 1;
      element.width = Math.round(width * pixelRatio);
      element.height = Math.round(height * pixelRatio);
      if (initial) fit();
      schedule();
    });
    observer.observe(container.current!);
    const position = (event: MouseEvent) => {
      const bounds = element.getBoundingClientRect();
      return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = position(event);
      zoomAt(Math.exp(-event.deltaY * 0.0015), point.x, point.y);
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault(); element.focus(); autoFit = false;
      const point = position(event);
      const node = event.button === 0 ? hitGraphNode(layout.nodes, latest.current.visibleIds, camera, point.x, point.y) : undefined;
      drag = { node, x: point.x, y: point.y, startX: node?.x ?? 0, startY: node?.y ?? 0, cameraX: camera.x, cameraY: camera.y, fixed: node?.fixed ?? false, moved: false, pointerId: event.pointerId };
      element.setPointerCapture(event.pointerId);
      element.style.cursor = node ? "grabbing" : "move";
      setTooltip(null);
    };
    const move = (event: PointerEvent) => {
      const point = position(event);
      if (drag) {
        if (drag.pointerId !== event.pointerId) return;
        const dx = point.x - drag.x;
        const dy = point.y - drag.y;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        if (!drag.moved) return;
        if (drag.node) {
          drag.node.x = drag.startX + dx / camera.scale;
          drag.node.y = drag.startY + dy / camera.scale;
          drag.node.vx = 0; drag.node.vy = 0; drag.node.fixed = true;
        } else { camera.x = drag.cameraX + dx; camera.y = drag.cameraY + dy; }
      } else {
        hovered = hitGraphNode(layout.nodes, latest.current.visibleIds, camera, point.x, point.y);
        element.style.cursor = hovered ? "pointer" : "grab";
        setTooltip(hovered ? { node: hovered, x: Math.max(8, Math.min(width - 245, point.x + 16)), y: Math.max(8, Math.min(height - 80, point.y + 16)) } : null);
      }
      schedule();
    };
    const up = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (event.type === "pointercancel") {
        if (drag.node) { drag.node.x = drag.startX; drag.node.y = drag.startY; drag.node.fixed = drag.fixed; }
        else { camera.x = drag.cameraX; camera.y = drag.cameraY; }
      } else if (!drag.moved) {
        if (drag.node) latest.current.onSelect(drag.node.id, event.ctrlKey || event.metaKey || event.shiftKey);
        else latest.current.onBackground();
      }
      drag = null;
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      element.style.cursor = "grab";
      schedule();
    };
    const leave = () => { if (!drag) { hovered = undefined; setTooltip(null); schedule(); } };
    const key = (event: KeyboardEvent) => {
      if (event.key === "+" || event.key === "=") zoomAt(1.25, width / 2, height / 2);
      else if (event.key === "-") zoomAt(0.8, width / 2, height / 2);
      else if (event.key === "Home" || event.key.toLowerCase() === "f") { autoFit = false; fit(); }
      else if (event.key === "Escape") latest.current.onBackground();
      else if (event.key.startsWith("Arrow")) {
        autoFit = false;
        camera.x += event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0;
        camera.y += event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0;
      } else return;
      event.preventDefault(); schedule();
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("keydown", key);
    return () => {
      cancelAnimationFrame(frameId); observer.disconnect(); controls.current = null;
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("keydown", key);
    };
  }, [layout, analytics]);

  return <div className="graph-view" ref={container}>
    <canvas ref={canvas} aria-label="Sourcebeta code graph" aria-describedby="graph-help" role="application" tabIndex={0}>
      Use the node list and filters to inspect code connections.
    </canvas>
    <div className="graph-navigation">
      <button aria-label="Zoom out graph" onClick={() => controls.current?.zoom(0.8)}>−</button>
      <output aria-label="Graph zoom">{Math.round(zoom * 100)}%</output>
      <button aria-label="Zoom in graph" onClick={() => controls.current?.zoom(1.25)}>+</button>
      <button onClick={() => controls.current?.fit()}>Fit graph</button>
    </div>
    <p id="graph-help" className="graph-help">{visibleIds.size} visible nodes · drag background to pan · F to fit</p>
    {tooltip && <div role="tooltip" className="graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}><strong>{tooltip.node.label}</strong><span>{tooltip.node.kind} · {tooltip.node.file}{tooltip.node.line ? `:${tooltip.node.line}` : ""}</span></div>}
  </div>;
}
