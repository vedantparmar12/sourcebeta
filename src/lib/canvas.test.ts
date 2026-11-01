import cloudSource from "../../public/libraries/cloud.excalidrawlib?raw";
import { describe, expect, it } from "vitest";
import { alignLeft, alignTop, arrowPoints, distributeHorizontally, elementBounds, groupBounds, readCloudLibrary, sceneBounds, selectionToElements, snapToGrid, validateBoardJSON, type BoardElement } from "./canvas";
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
    expect(artwork.elements[0].stroke).toBe("#343745");
  });

  it("preserves source metadata on generated cards", () => {
    const elements = selectionToElements(graph, ["src/a.ts", "note:n.md"]);
    const cards = elements.filter((e) => e.kind === "card");
    expect(cards).toHaveLength(2);
    const fileCard = cards.find((c) => c.source?.nodeId === "src/a.ts");
    const noteCard = cards.find((c) => c.source?.nodeId === "note:n.md");
    expect(fileCard?.source).toEqual({ nodeId: "src/a.ts", file: "src/a.ts" });
    expect(noteCard?.source).toEqual({ nodeId: "note:n.md", file: "n.md" });
  });

  it("preserves source line when present on graph nodes", () => {
    const graphWithLine: KnowledgeGraph = {
      nodes: [{ id: "fn", label: "fn", kind: "function", file: "src/a.ts", line: 42 }],
      edges: [],
    };
    const elements = selectionToElements(graphWithLine, ["fn"]);
    expect(elements[0].source).toEqual({ nodeId: "fn", file: "src/a.ts", line: 42 });
  });

  it("aligns elements left and top", () => {
    const els: BoardElement[] = [
      { ...box, id: "a", x: 50, y: 30 },
      { ...box, id: "b", x: 10, y: 80 },
      { ...box, id: "c", x: 100, y: 10 },
    ];
    expect(alignLeft(els).map((e) => e.x)).toEqual([10, 10, 10]);
    expect(alignTop(els).map((e) => e.y)).toEqual([10, 10, 10]);
    expect(alignLeft([els[0]]).map((e) => e.x)).toEqual([50]);
  });

  it("distributes elements horizontally with equal gaps", () => {
    const els: BoardElement[] = [
      { ...box, id: "a", x: 0, width: 20 },
      { ...box, id: "b", x: 100, width: 20 },
      { ...box, id: "c", x: 300, width: 20 },
    ];
    const result = distributeHorizontally(els);
    expect(result[0].x).toBe(0);
    expect(result[2].x).toBe(300);
    const gap1 = result[1].x - (result[0].x + result[0].width);
    const gap2 = result[2].x - (result[1].x + result[1].width);
    expect(gap1).toBeCloseTo(gap2);
  });

  it("snaps values to grid", () => {
    expect(snapToGrid(25, 24)).toBe(24);
    expect(snapToGrid(35, 24)).toBe(24);
    expect(snapToGrid(36, 24)).toBe(48);
    expect(snapToGrid(0, 24)).toBe(0);
    expect(snapToGrid(-10, 24)).toBeCloseTo(0);
  });

  it("computes group bounds", () => {
    const els: BoardElement[] = [
      { ...box, id: "a", x: 10, y: 20, width: 50, height: 30 },
      { ...box, id: "b", x: 100, y: 5, width: 40, height: 60 },
    ];
    const bounds = groupBounds(els);
    expect(bounds).toEqual({ x: 10, y: 5, width: 130, height: 60 });
    expect(groupBounds([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("validates correct board JSON", () => {
    const data = [{ id: "e1", kind: "rectangle", x: 0, y: 0, width: 100, height: 50, stroke: "#000", fill: "none", strokeWidth: 2 }];
    const result = validateBoardJSON(data);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("e1");
    expect(result[0].kind).toBe("rectangle");
  });

  it("validates board JSON with optional fields", () => {
    const data = [{
      id: "e1", kind: "card", x: 0, y: 0, width: 100, height: 50,
      stroke: "#000", fill: "#fff", strokeWidth: 2,
      text: "hello", fontSize: 16, groupId: "g1", comment: "a note",
      source: { nodeId: "n1", file: "f.ts", line: 10 },
    }];
    const result = validateBoardJSON(data);
    expect(result[0].text).toBe("hello");
    expect(result[0].groupId).toBe("g1");
    expect(result[0].comment).toBe("a note");
    expect(result[0].source).toEqual({ nodeId: "n1", file: "f.ts", line: 10 });
  });

  it("round-trips bundled artwork through editable board JSON", () => {
    const symbol = { ...box, kind: "symbol", artwork: { name: "Cloud", width: 100, height: 60, elements: [{ ...box, id: "child" }] } };
    expect(validateBoardJSON(JSON.parse(JSON.stringify([symbol])))[0].artwork).toEqual(symbol.artwork);
  });

  it("rejects invalid board JSON", () => {
    expect(() => validateBoardJSON("not an array")).toThrow("must be an array");
    expect(() => validateBoardJSON([{}])).toThrow("missing required field");
    expect(() => validateBoardJSON([{ id: 123, kind: "rectangle", x: 0, y: 0, width: 10, height: 10, stroke: "#000", fill: "none", strokeWidth: 1 }])).toThrow("id must be a string");
    expect(() => validateBoardJSON([{ id: "e1", kind: "invalid", x: 0, y: 0, width: 10, height: 10, stroke: "#000", fill: "none", strokeWidth: 1 }])).toThrow("invalid kind");
    expect(() => validateBoardJSON([{ id: "e1", kind: "rectangle", x: "bad", y: 0, width: 10, height: 10, stroke: "#000", fill: "none", strokeWidth: 1 }])).toThrow("must be a finite number");
    expect(() => validateBoardJSON([{ id: "e1", kind: "rectangle", x: 0, y: 0, width: 10, height: 10, stroke: "url(evil)", fill: "none", strokeWidth: 1 }])).toThrow("must be a valid color");
  });
});
