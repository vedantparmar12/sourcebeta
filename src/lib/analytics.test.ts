import { describe, expect, it } from "vitest";
import { analyzeProject } from "./analyzer";
import { computeAnalytics, explainNode, impactSet, neighborhood, shortestPath } from "./analytics";
import { DEMO_FILES } from "./demo";
import type { KnowledgeGraph } from "./types";

const chain: KnowledgeGraph = {
  nodes: [
    { id: "a", label: "a", kind: "file", file: "a" },
    { id: "b", label: "b", kind: "file", file: "b" },
    { id: "c", label: "c", kind: "file", file: "c" },
  ],
  edges: [
    { source: "a", target: "b", type: "imports", confidence: "EXTRACTED" },
    { source: "b", target: "c", type: "imports", confidence: "EXTRACTED" },
  ],
};

describe("analytics", () => {
  it("computes degree and PageRank importance", () => {
    const analytics = computeAnalytics(chain);
    expect(analytics.degree.get("b")).toBe(2);
    expect(analytics.rank.get("c")!).toBeGreaterThan(analytics.rank.get("b")!);
    expect(analytics.rank.get("b")!).toBeGreaterThan(analytics.rank.get("a")!);
    expect(analytics.godNodes.slice(0, 3)).toEqual(["c", "b", "a"]);
    expect(analytics.cycle.size).toBe(0);
  });

  it("finds dependency cycles with an iterative strongly connected components pass", () => {
    const cyclic: KnowledgeGraph = {
      nodes: "abcdef".split("").map((id) => ({ id, label: id, file: id, kind: "file" })),
      edges: [
        { source: "a", target: "b", type: "imports", confidence: "EXTRACTED" },
        { source: "b", target: "c", type: "imports", confidence: "EXTRACTED" },
        { source: "c", target: "a", type: "imports", confidence: "EXTRACTED" },
        { source: "d", target: "e", type: "imports", confidence: "EXTRACTED" },
        { source: "e", target: "d", type: "imports", confidence: "EXTRACTED" },
        { source: "f", target: "f", type: "contains", confidence: "EXTRACTED" },
      ],
    };
    const analytics = computeAnalytics(cyclic);
    expect([...analytics.cycle.entries()].sort()).toEqual([
      ["a", 3], ["b", 3], ["c", 3], ["d", 2], ["e", 2],
    ]);
  });

  it("does not let contains edges or self loops create cycles", () => {
    const analytics = computeAnalytics({
      nodes: chain.nodes,
      edges: [
        { source: "a", target: "b", type: "contains", confidence: "EXTRACTED" },
        { source: "b", target: "a", type: "contains", confidence: "EXTRACTED" },
        { source: "c", target: "c", type: "imports", confidence: "EXTRACTED" },
      ],
    });
    expect(analytics.cycle.size).toBe(0);
  });

  it("finds shortest paths through the smaller frontier and ignores longer detours", () => {
    const graph: KnowledgeGraph = {
      nodes: "abcdefgh".split("").map((id) => ({ id, label: id, file: id, kind: "file" })),
      edges: [
        ["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"],
        ["a", "f"], ["f", "g"], ["g", "e"],
        ["b", "g"], ["h", "h"],
      ].map(([source, target]) => ({ source, target, type: "imports" as const, confidence: "EXTRACTED" as const })),
    };
    const path = shortestPath(graph, "a", "e");
    expect(path).toHaveLength(4);
    expect(path).toEqual(["a", "b", "g", "e"]);
    expect(shortestPath(graph, "a", "h")).toBeNull();
  });

  it("handles long chains and rings without recursion limits", () => {
    const size = 6000;
    const ids = Array.from({ length: size }, (_, index) => `n${index}`);
    const nodes = ids.map((id) => ({ id, label: id, file: id, kind: "file" as const }));
    const chainEdges = ids.slice(1).map((id, index) => ({ source: ids[index], target: id, type: "imports" as const, confidence: "EXTRACTED" as const }));
    const line = computeAnalytics({ nodes, edges: chainEdges });
    expect(line.cycle.size).toBe(0);
    expect(shortestPath({ nodes, edges: chainEdges }, "n0", `n${size - 1}`)).toHaveLength(size);

    const ringEdges = [...chainEdges, { source: ids[size - 1], target: ids[0], type: "imports" as const, confidence: "EXTRACTED" as const }];
    const ring = computeAnalytics({ nodes, edges: ringEdges });
    expect(ring.cycle.size).toBe(size);
    expect(ring.cycle.get("n0")).toBe(size);
  });

  it("finds neighborhoods in both directions", () => {
    expect([...neighborhood(chain, ["b"], 1)].sort()).toEqual(["a", "b", "c"]);
    expect([...neighborhood(chain, ["a"], 1)].sort()).toEqual(["a", "b"]);
    expect([...neighborhood(chain, ["a"], 2)].sort()).toEqual(["a", "b", "c"]);
  });

  it("finds direct and transitive dependents for impact analysis", () => {
    expect([...impactSet(chain, ["c"])].sort()).toEqual(["a", "b", "c"]);
    expect([...impactSet(chain, ["b"])].sort()).toEqual(["a", "b"]);
    expect([...impactSet(chain, ["a"])].sort()).toEqual(["a"]);
  });

  it("finds shortest paths and reports disconnected nodes", () => {
    expect(shortestPath(chain, "a", "c")).toEqual(["a", "b", "c"]);
    expect(shortestPath(chain, "a", "a")).toEqual(["a"]);
    expect(shortestPath(chain, "a", "missing")).toBeNull();
  });

  it("separates the demo project into communities", () => {
    const graph = analyzeProject(DEMO_FILES);
    const analytics = computeAnalytics(graph);
    expect(analytics.community.size).toBeGreaterThan(0);
    const welcome = analytics.community.get("note:notes/Welcome.md");
    expect(welcome).toBeDefined();
    expect(analytics.community.get("note:notes/Tasks.md")).toBe(welcome);
  });

  it("clusters dense groups deterministically across input order and weak bridges", () => {
    const nodes: KnowledgeGraph["nodes"] = "abcdefgh".split("").map((id) => ({ id, label: id, file: id, kind: "file" }));
    const edges: KnowledgeGraph["edges"] = [];
    for (const group of ["abcd", "efgh"]) {
      for (let from = 0; from < group.length; from++) {
        for (let to = from + 1; to < group.length; to++) edges.push({ source: group[from], target: group[to], type: "imports", confidence: "EXTRACTED" });
      }
    }
    edges.push({ source: "d", target: "e", type: "imports", confidence: "EXTRACTED" });
    const result = computeAnalytics({ nodes, edges });
    const reversed = computeAnalytics({ nodes: [...nodes].reverse(), edges: [...edges].reverse() });
    expect(result.community).toEqual(reversed.community);
    expect(result.community.get("a")).toBe(result.community.get("d"));
    expect(result.community.get("e")).toBe(result.community.get("h"));
    expect(result.community.get("a")).not.toBe(result.community.get("e"));
  });

  it("handles empty and isolated nodes without merging contains or duplicate edges", () => {
    expect(computeAnalytics({ nodes: [], edges: [] }).community.size).toBe(0);
    const isolated = computeAnalytics({ nodes: chain.nodes, edges: [] });
    expect(new Set(isolated.community.values()).size).toBe(3);
    const base = { nodes: chain.nodes, edges: [chain.edges[0]] };
    const repeated = computeAnalytics({ ...base, edges: [
      chain.edges[0], chain.edges[0], { ...chain.edges[0], source: "b", target: "a" },
      { ...chain.edges[0], source: "a", target: "a" }, { ...chain.edges[1], type: "contains" },
    ] });
    expect(repeated.community).toEqual(computeAnalytics(base).community);
    expect(repeated.degree.get("a")).toBe(5);
    expect(repeated.community.get("a")).not.toBe(repeated.community.get("c"));
  });

  it("explains a node with directions and confidence", () => {
    const graph = analyzeProject(DEMO_FILES);
    const connections = explainNode(graph, "src/store.ts#TaskStore");
    expect(connections.some((connection) => connection.direction === "incoming" && connection.edge.type === "contains")).toBe(true);
    expect(connections.every((connection) => connection.edge.source === "src/store.ts#TaskStore" || connection.edge.target === "src/store.ts#TaskStore")).toBe(true);
  });
});
