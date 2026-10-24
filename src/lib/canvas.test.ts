import cloudSource from "../../public/libraries/cloud.excalidrawlib?raw";
import { describe, expect, it } from "vitest";
import { arrowPoints, elementBounds, readCloudLibrary, sceneBounds, selectionToElements, type BoardElement } from "./canvas";
import type { KnowledgeGraph } from "./types";

const graph: KnowledgeGraph = {
  nodes: [
    { id: "src/a.ts", label: "a.ts", kind: "file", file: "src/a.ts" },
    { id: "src/b.ts", label: "b.ts", kind: "file", file: "src/b.ts" },
    { id: "note:n.md", label: "n", kind: "note", file: "n.md" },
  ],
  edges: [{ source: "src/a.ts", target: "src/b.ts", type: "imports", confidence: "EXTRACTED" }],
};
const box: BoardElement = { id: "box", kind: "rectangle", x: 10, y: 20, width: 100, height: 60, stroke: "#fff", fill: "none", strokeWidth: 2 };

describe("Sourcebeta canvas", () => {
  it("creates labeled cards and binds internal arrows to unique IDs", () => {
    const elements = selectionToElements(graph, ["src/a.ts", "src/b.ts"]);
    const cards = elements.filter((element) => element.kind === "card");
    const arrows = elements.filter((element) => element.kind === "arrow");
    expect(cards).toHaveLength(2);
    expect(cards[0].text).toContain("a.ts");
    expect(arrows).toHaveLength(1);
    expect(arrows[0].startId).toBe(cards[0].id);
    expect(arrows[0].endId).toBe(cards[1].id);
    expect(arrows[0].text).toBe("imports");
    expect(selectionToElements(graph, ["src/a.ts"])[0].id).not.toBe(cards[0].id);
  });

  it("supports iterators and offsets without including outside edges", () => {
    const elements = selectionToElements(graph, new Set(["src/a.ts"]).values(), 500);
    expect(elements).toHaveLength(1);
    expect(elements[0].y).toBe(500);
    expect(selectionToElements(graph, [])).toEqual([]);
  });

  it("draws inferred connections dashed and skips contains/self connections", () => {
    const elements = selectionToElements({ ...graph, edges: [
      { ...graph.edges[0], confidence: "INFERRED" },
      { ...graph.edges[0], type: "contains" },
      { ...graph.edges[0], target: "src/a.ts" },
    ] }, ["src/a.ts", "src/b.ts"]);
    expect(elements.filter((element) => element.kind === "arrow")).toHaveLength(1);
    expect(elements[0].dashed).toBe(true);
  });

  it("keeps arrow endpoints at card boundaries after dragging", () => {
    const elements = selectionToElements(graph, ["src/a.ts", "src/b.ts"]);
    const arrow = elements[0];
    const first = elements[1];
    const second = elements[2];
    expect(arrowPoints(arrow, elements)).toEqual([{ x: 220, y: 45 }, { x: 310, y: 45 }]);
    const moved = elements.map((element) => element.id === second.id ? { ...element, y: 250 } : element);
    const [from, to] = arrowPoints(arrow, moved);
    expect(from.y).toBeGreaterThan(first.y);
    expect(to.y).toBeGreaterThan(second.y + 200);
    expect(Number.isFinite(to.x)).toBe(true);
  });

  it("clips connectors to ellipse and diamond boundaries", () => {
    for (const kind of ["ellipse", "diamond"] as const) {
      const shape = { ...box, kind };
      const arrow: BoardElement = { ...box, id: "arrow", kind: "arrow", x: 60, y: 50, width: 300, height: 300, startId: shape.id };
      const [start] = arrowPoints(arrow, [shape, arrow]);
      const nx = (start.x - 60) / 50;
      const ny = (start.y - 50) / 30;
      expect(kind === "ellipse" ? nx * nx + ny * ny : Math.abs(nx) + Math.abs(ny)).toBeCloseTo(1);
    }
  });

  it("measures reverse paths and rotated artwork without clipping", () => {
    expect(elementBounds({ ...box, kind: "pen", points: [{ x: -40, y: 10 }, { x: 50, y: -30 }] })).toEqual({ x: -30, y: -10, width: 90, height: 40 });
    const rotated = elementBounds({ ...box, angle: Math.PI / 2 });
    expect(rotated.width).toBeCloseTo(60);
    expect(rotated.height).toBeCloseTo(100);
    expect(sceneBounds([box, { ...box, x: 200 }])).toEqual({ x: 10, y: 20, width: 290, height: 60 });
    expect(sceneBounds([]).width).toBeGreaterThan(0);
  });

  it("reads all 19 Cloud symbols as native drawing data", () => {
    const data = JSON.parse(cloudSource);
    const library = readCloudLibrary(data);
    expect(library).toHaveLength(19);
    for (const item of library) {
      expect(item.elements.length).toBeGreaterThan(0);
      expect(item.width).toBeGreaterThan(0);
      const bounds = sceneBounds(item.elements);
      expect(bounds.x).toBeCloseTo(0);
      expect(bounds.y).toBeCloseTo(0);
      expect(bounds.width).toBeCloseTo(item.width);
    }
  });

  it("rejects malformed library data and disallows URL paints", () => {
    expect(() => readCloudLibrary({})).toThrow();
    expect(() => readCloudLibrary({ library: [null] })).toThrow();
    const [artwork] = readCloudLibrary({ library: [[{ type: "rectangle", width: 20, height: 20, strokeColor: "url(https://example.invalid)" }]] });
    expect(artwork.elements[0].stroke).toBe("#e9ecf2");
  });
});
