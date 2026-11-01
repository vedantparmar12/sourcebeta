import type { KnowledgeGraph } from "./types";

export type Point = { x: number; y: number };
export type BoardKind = "rectangle" | "ellipse" | "diamond" | "text" | "pen" | "arrow" | "card" | "symbol" | "container";
export interface BoardElement {
  id: string;
  kind: BoardKind;
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
  fill: string;
  strokeWidth: number;
  text?: string;
  fontSize?: number;
  angle?: number;
  opacity?: number;
  points?: Point[];
  startId?: string;
  endId?: string;
  dashed?: boolean;
  artwork?: Artwork;
  source?: { nodeId: string; file: string; line?: number };
  groupId?: string;
  comment?: string;
}
export interface Artwork {
  name: string;
  width: number;
  height: number;
  elements: BoardElement[];
}
export interface Bounds extends Point { width: number; height: number }

export function arrowPoints(element: BoardElement, elements: BoardElement[]): Point[] {
  const points = element.points ?? [{ x: 0, y: 0 }, { x: element.width, y: element.height }];
  const start = { x: element.x + points[0].x, y: element.y + points[0].y };
  const last = points[points.length - 1];
  const end = { x: element.x + last.x, y: element.y + last.y };
  const from = elements.find((item) => item.id === element.startId);
  const to = elements.find((item) => item.id === element.endId);
  const fromCenter = from ? { x: from.x + from.width / 2, y: from.y + from.height / 2 } : start;
  const toCenter = to ? { x: to.x + to.width / 2, y: to.y + to.height / 2 } : end;
  const boundary = (box: BoardElement, center: Point, target: Point) => {
    const dx = target.x - center.x;
    const dy = target.y - center.y;
    const nx = Math.abs(dx) / (box.width / 2 || 1);
    const ny = Math.abs(dy) / (box.height / 2 || 1);
    const distance = box.kind === "ellipse" ? Math.hypot(nx, ny) : box.kind === "diamond" ? nx + ny : Math.max(nx, ny);
    const scale = 1 / Math.max(distance, 1);
    return { x: center.x + dx * scale, y: center.y + dy * scale };
  };
  return [from ? boundary(from, fromCenter, toCenter) : start, to ? boundary(to, toCenter, fromCenter) : end];
}

export function elementBounds(element: BoardElement, elements: BoardElement[] = []): Bounds {
  const rawPoints = element.kind === "arrow" ? arrowPoints(element, elements)
    : element.points?.map((point) => ({ x: element.x + point.x, y: element.y + point.y }));
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  const rotation = element.angle ?? 0;
  const points = rawPoints?.map((point) => ({
    x: cx + (point.x - cx) * Math.cos(rotation) - (point.y - cy) * Math.sin(rotation),
    y: cy + (point.x - cx) * Math.sin(rotation) + (point.y - cy) * Math.cos(rotation),
  }));
  if (points?.length) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  const angle = element.angle ?? 0;
  const width = Math.abs(element.width * Math.cos(angle)) + Math.abs(element.height * Math.sin(angle));
  const height = Math.abs(element.width * Math.sin(angle)) + Math.abs(element.height * Math.cos(angle));
  return { x: element.x + (element.width - width) / 2, y: element.y + (element.height - height) / 2, width, height };
}

export function sceneBounds(elements: BoardElement[]): Bounds {
  if (elements.length === 0) return { x: 0, y: 0, width: 800, height: 500 };
  const bounds = elements.map((element) => elementBounds(element, elements));
  const x = Math.min(...bounds.map((box) => box.x));
  const y = Math.min(...bounds.map((box) => box.y));
  return {
    x, y,
    width: Math.max(...bounds.map((box) => box.x + box.width)) - x,
    height: Math.max(...bounds.map((box) => box.y + box.height)) - y,
  };
}

export function selectionToElements(graph: KnowledgeGraph, ids: Iterable<string>, offsetY = 0): BoardElement[] {
  const wanted = new Set(ids);
  const selected = graph.nodes.filter((node) => wanted.has(node.id));
  const columns = Math.max(1, Math.ceil(Math.sqrt(selected.length)));
  const cards = selected.map((node, index): BoardElement => ({
    id: crypto.randomUUID(), kind: "card", x: (index % columns) * 310, y: offsetY + Math.floor(index / columns) * 160,
    width: 220, height: 90, stroke: node.kind === "note" ? "#e7ba63" : "#8b7ff0", fill: "#232738", strokeWidth: 2,
    text: `${node.label}\n${node.kind}`, fontSize: 16,
    source: { nodeId: node.id, file: node.file, ...(node.line != null ? { line: node.line } : {}) },
  }));
  const byId = new Map(selected.map((node, index) => [node.id, cards[index]]));
  const arrows: BoardElement[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (edge.type === "contains" || !from || !to || from === to) continue;
    arrows.push({
      id: crypto.randomUUID(), kind: "arrow", x: from.x + 110, y: from.y + 45,
      width: to.x - from.x, height: to.y - from.y, stroke: "#a8b4cf", fill: "none", strokeWidth: 1.5,
      startId: from.id, endId: to.id, text: edge.type, dashed: edge.confidence === "INFERRED",
    });
  }
  return [...arrows, ...cards];
}

export function readCloudLibrary(data: unknown): Artwork[] {
  if (!data || typeof data !== "object" || !("library" in data) || !Array.isArray(data.library)) {
    throw new Error("The Cloud library does not contain symbol groups.");
  }
  const number = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const color = (value: unknown, fallback: string) => typeof value === "string" && /^(#[\da-f]{3,8}|[a-z]+)$/i.test(value) ? value : fallback;
  return data.library.map((group: unknown, index: number) => {
    if (!Array.isArray(group)) throw new Error("Invalid Cloud symbol group.");
    const elements: BoardElement[] = group.filter((item) => item && !item.isDeleted).map((item, part) => {
      const kinds: Record<string, BoardKind> = { rectangle: "rectangle", ellipse: "ellipse", diamond: "diamond", text: "text", line: "pen", draw: "pen", freedraw: "pen", arrow: "arrow" };
      const kind = kinds[item.type];
      if (!kind) throw new Error(`Unsupported Cloud shape: ${String(item.type)}`);
      const points: Point[] | undefined = Array.isArray(item.points) ? item.points.map((point: unknown) => {
        if (!Array.isArray(point)) throw new Error("Invalid Cloud path.");
        return { x: number(point[0]), y: number(point[1]) };
      }) : undefined;
      const minX = points?.length ? Math.min(...points.map((point) => point.x)) : 0;
      const minY = points?.length ? Math.min(...points.map((point) => point.y)) : 0;
      return {
        id: `cloud-${index}-${part}`, kind, x: number(item.x) + minX, y: number(item.y) + minY,
        width: points?.length ? Math.max(...points.map((point) => point.x)) - minX : number(item.width),
        height: points?.length ? Math.max(...points.map((point) => point.y)) - minY : number(item.height),
        stroke: color(item.strokeColor, "#343745"), fill: color(item.backgroundColor, "none"),
        strokeWidth: number(item.strokeWidth, 1), angle: number(item.angle), opacity: number(item.opacity, 100) / 100,
        text: typeof item.text === "string" ? item.text : undefined, fontSize: number(item.fontSize, 20),
        points: points?.map((point) => ({ x: point.x - minX, y: point.y - minY })),
      };
    });
    const bounds = sceneBounds(elements);
    return {
      name: `Cloud symbol ${index + 1}`, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height),
      elements: elements.map((element) => ({ ...element, x: element.x - bounds.x, y: element.y - bounds.y })),
    };
  });
}

export function alignLeft(elements: BoardElement[]): BoardElement[] {
  if (elements.length < 2) return elements;
  const minX = Math.min(...elements.map((e) => e.x));
  return elements.map((e) => ({ ...e, x: minX }));
}

export function alignTop(elements: BoardElement[]): BoardElement[] {
  if (elements.length < 2) return elements;
  const minY = Math.min(...elements.map((e) => e.y));
  return elements.map((e) => ({ ...e, y: minY }));
}

export function distributeHorizontally(elements: BoardElement[]): BoardElement[] {
  if (elements.length < 3) return elements;
  const sorted = [...elements].sort((a, b) => a.x - b.x);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const totalWidth = sorted.reduce((sum, e) => sum + e.width, 0);
  const availableSpace = last.x + last.width - first.x - totalWidth;
  const gap = availableSpace / (sorted.length - 1);
  let currentX = first.x;
  return sorted.map((e, i) => {
    if (i === 0) return e;
    const prev = sorted[i - 1];
    currentX = currentX + prev.width + gap;
    return { ...e, x: currentX };
  });
}

export function snapToGrid(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}

export function groupBounds(elements: BoardElement[]): Bounds {
  if (elements.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const bounds = elements.map((e) => elementBounds(e));
  const x = Math.min(...bounds.map((b) => b.x));
  const y = Math.min(...bounds.map((b) => b.y));
  return {
    x, y,
    width: Math.max(...bounds.map((b) => b.x + b.width)) - x,
    height: Math.max(...bounds.map((b) => b.y + b.height)) - y,
  };
}

export function validateBoardJSON(data: unknown): BoardElement[] {
  if (!Array.isArray(data)) throw new Error("Board data must be an array of elements.");
  return data.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Element ${index} is not an object.`);
    const required = ["id", "kind", "x", "y", "width", "height", "stroke", "fill", "strokeWidth"];
    for (const key of required) {
      if (!(key in item)) throw new Error(`Element ${index} missing required field: ${key}`);
    }
    if (typeof item.id !== "string") throw new Error(`Element ${index} id must be a string.`);
    const validKinds = ["rectangle", "ellipse", "diamond", "text", "pen", "arrow", "card", "symbol", "container"];
    if (!validKinds.includes(item.kind)) throw new Error(`Element ${index} has invalid kind: ${item.kind}`);
    const number = (value: unknown, field: string): number => {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Element ${index} ${field} must be a finite number.`);
      return value;
    };
    const color = (value: unknown, field: string): string => {
      if (typeof value !== "string" || !/^(#[\da-f]{3,8}|[a-z]+|none)$/i.test(value)) throw new Error(`Element ${index} ${field} must be a valid color.`);
      return value;
    };
    return {
      id: item.id,
      kind: item.kind as BoardKind,
      x: number(item.x, "x"),
      y: number(item.y, "y"),
      width: number(item.width, "width"),
      height: number(item.height, "height"),
      stroke: color(item.stroke, "stroke"),
      fill: color(item.fill, "fill"),
      strokeWidth: number(item.strokeWidth, "strokeWidth"),
      ...(item.text != null ? { text: String(item.text) } : {}),
      ...(item.fontSize != null ? { fontSize: number(item.fontSize, "fontSize") } : {}),
      ...(item.angle != null ? { angle: number(item.angle, "angle") } : {}),
      ...(item.opacity != null ? { opacity: number(item.opacity, "opacity") } : {}),
      ...(item.dashed != null ? { dashed: Boolean(item.dashed) } : {}),
      ...(item.startId != null ? { startId: String(item.startId) } : {}),
      ...(item.endId != null ? { endId: String(item.endId) } : {}),
      ...(item.groupId != null ? { groupId: String(item.groupId) } : {}),
      ...(item.comment != null ? { comment: String(item.comment) } : {}),
      ...(Array.isArray(item.points) ? {
        points: item.points.map((p: unknown, pi: number) => {
          if (!p || typeof p !== "object") throw new Error(`Element ${index} point ${pi} is invalid.`);
          return { x: number((p as Record<string, unknown>).x, `point ${pi}.x`), y: number((p as Record<string, unknown>).y, `point ${pi}.y`) };
        }),
      } : {}),
      ...(item.source && typeof item.source === "object" ? {
        source: {
          nodeId: String((item.source as Record<string, unknown>).nodeId ?? ""),
          file: String((item.source as Record<string, unknown>).file ?? ""),
          ...((item.source as Record<string, unknown>).line != null ? { line: number((item.source as Record<string, unknown>).line, "source.line") } : {}),
        },
      } : {}),
      ...(item.artwork && typeof item.artwork === "object" ? {
        artwork: {
          name: String((item.artwork as Record<string, unknown>).name ?? "Artwork"),
          width: number((item.artwork as Record<string, unknown>).width, "artwork.width"),
          height: number((item.artwork as Record<string, unknown>).height, "artwork.height"),
          elements: validateBoardJSON((item.artwork as Record<string, unknown>).elements),
        },
      } : {}),
    };
  });
}
