import { describe, expect, it } from "vitest";
import { computeAnalytics } from "./analytics";
import { createLayout, fitGraph, hitGraphNode, stepLayout } from "./layout";
import type { KnowledgeGraph } from "./types";

const graph: KnowledgeGraph = {
  nodes: ["a", "b", "c"].map((id) => ({ id, label: id, file: id, kind: "file" })),
  edges: [{ source: "a", target: "b", type: "imports", confidence: "EXTRACTED" }],
};
const make = () => createLayout(graph, computeAnalytics(graph));

describe("native graph layout", () => {
  it("seeds deterministic coordinates without mutating source nodes", () => {
    const first = make();
    const second = make();
    expect(first).toEqual(second);
    stepLayout(first, 1);
    expect(first.nodes).not.toEqual(second.nodes);
    expect(graph.nodes[0]).not.toHaveProperty("x");
    expect(first.edges[0].from).toBe(first.nodes.find((node) => node.id === "a"));
  });

  it("handles empty and isolated graphs", () => {
    const empty = createLayout({ nodes: [], edges: [] }, computeAnalytics({ nodes: [], edges: [] }));
    expect(stepLayout(empty, 1)).toBe(0);
    expect(fitGraph([], 800, 600)).toEqual({ x: 400, y: 300, scale: 1 });
    const isolated = createLayout({ ...graph, edges: [] }, computeAnalytics({ ...graph, edges: [] }));
    expect(new Set(isolated.nodes.map((node) => `${node.x},${node.y}`)).size).toBe(3);
  });

  it("honors pinned nodes and never exceeds bounded per-tick motion", () => {
    const layout = make();
    const pinned = layout.nodes[0];
    pinned.fixed = true;
    const origin = { x: pinned.x, y: pinned.y };
    for (let tick = 0; tick < 150; tick++) {
      const before = layout.nodes.map((node) => ({ x: node.x, y: node.y }));
      const motion = stepLayout(layout, Math.max(0.08, 1 - tick / 150));
      expect(Number.isFinite(motion)).toBe(true);
      layout.nodes.forEach((node, index) => {
        expect(Math.abs(node.x - before[index].x)).toBeLessThanOrEqual(8.000001);
        expect(Math.abs(node.y - before[index].y)).toBeLessThanOrEqual(8.000001);
      });
    }
    expect({ x: pinned.x, y: pinned.y }).toEqual(origin);
  });

  it("fits visible bounds inside the viewport", () => {
    const layout = make();
    const camera = fitGraph(layout.nodes, 900, 700);
    for (const node of layout.nodes) {
      const x = node.x * camera.scale + camera.x;
      const y = node.y * camera.scale + camera.y;
      expect(x).toBeGreaterThan(40);
      expect(x).toBeLessThan(860);
      expect(y).toBeGreaterThan(40);
      expect(y).toBeLessThan(660);
    }
    expect(Object.values(fitGraph(layout.nodes, 0, 0)).every(Number.isFinite)).toBe(true);
  });

  it("hit-tests in screen coordinates and ignores hidden nodes", () => {
    const layout = make();
    const node = layout.nodes[0];
    const camera = { x: 80, y: -30, scale: 2 };
    expect(hitGraphNode(layout.nodes, new Set([node.id]), camera, node.x * 2 + 80, node.y * 2 - 30)).toBe(node);
    expect(hitGraphNode(layout.nodes, new Set(), camera, node.x * 2 + 80, node.y * 2 - 30)).toBeUndefined();
    expect(hitGraphNode(layout.nodes, new Set([node.id]), camera, -1000, -1000)).toBeUndefined();
  });

  it("steps a 6000-node collapsed graph without unbounded pair comparisons", () => {
    const large: KnowledgeGraph = {
      nodes: Array.from({ length: 6000 }, (_, index) => ({ id: `node-${index}`, label: String(index), kind: "file", file: `src/${index}.ts` })),
      edges: [],
    };
    const layout = createLayout(large, computeAnalytics(large));
    for (const node of layout.nodes) { node.x = 0; node.y = 0; }
    for (let tick = 0; tick < 3; tick++) expect(Number.isFinite(stepLayout(layout, 1))).toBe(true);
    expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(new Set(layout.nodes.map((node) => `${node.x},${node.y}`)).size).toBeGreaterThan(5000);
  });
});
