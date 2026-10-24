import { describe, expect, it } from "vitest";
import { analyzeProject } from "./analyzer";
import { DEMO_FILES } from "./demo";

describe("analyzeProject", () => {
  it("resolves relative imports between files", () => {
    const graph = analyzeProject([
      { path: "src/a.ts", content: `import { b } from "./b"; export const a = () => b();` },
      { path: "src/b.ts", content: `export function b() { return 1; }` },
    ]);
    expect(graph.edges).toContainEqual({ source: "src/a.ts", target: "src/b.ts", type: "imports", confidence: "EXTRACTED" });
  });

  it("resolves index files and .js specifiers pointing at TypeScript source", () => {
    const graph = analyzeProject([
      { path: "a.ts", content: `import "./lib/index.js";` },
      { path: "lib/index.ts", content: `export const x = 1;` },
    ]);
    expect(graph.edges.some((edge) => edge.type === "imports" && edge.target === "lib/index.ts")).toBe(true);
  });

  it("extracts functions, classes and arrow functions with contains edges", () => {
    const graph = analyzeProject(DEMO_FILES);
    const store = graph.nodes.find((node) => node.id === "src/store.ts#TaskStore");
    expect(store?.kind).toBe("class");
    expect(graph.edges).toContainEqual({ source: "src/store.ts", target: "src/store.ts#TaskStore", type: "contains", confidence: "EXTRACTED" });
    expect(graph.nodes.some((node) => node.id === "src/view.ts#formatTask" && node.kind === "function")).toBe(true);
  });

  it("marks imported cross-file calls EXTRACTED regardless of file order", () => {
    const graph = analyzeProject([
      { path: "z.ts", content: `export function helper() { return 1; }` },
      { path: "a.ts", content: `import { helper } from "./z"; export function run() { return helper(); }` },
    ]);
    expect(graph.edges).toContainEqual({ source: "a.ts#run", target: "z.ts#helper", type: "calls", confidence: "EXTRACTED" });
  });

  it("marks unique-name resolution without an import INFERRED", () => {
    const graph = analyzeProject([
      { path: "a.ts", content: `export function run() { return helper(); }` },
      { path: "b.ts", content: `export function helper() { return 1; }` },
    ]);
    expect(graph.edges).toContainEqual({ source: "a.ts#run", target: "b.ts#helper", type: "calls", confidence: "INFERRED" });
  });

  it("does not create self-call edges", () => {
    const graph = analyzeProject([{ path: "a.ts", content: `export function run() { return run(); }` }]);
    expect(graph.edges.some((edge) => edge.type === "calls")).toBe(false);
  });

  it("links markdown notes through wikilinks by title", () => {
    const graph = analyzeProject(DEMO_FILES);
    expect(graph.edges).toContainEqual({ source: "note:notes/Welcome.md", target: "note:notes/Tasks.md", type: "links", confidence: "EXTRACTED" });
    expect(graph.edges.some((edge) => edge.type === "links" && edge.source === "note:notes/Architecture.md")).toBe(false);
  });

  it("deduplicates repeated edges", () => {
    const graph = analyzeProject([
      { path: "a.ts", content: `import { b } from "./b";\nimport { b as c } from "./b";` },
      { path: "b.ts", content: `export const b = () => 1;` },
    ]);
    expect(graph.edges.filter((edge) => edge.type === "imports")).toHaveLength(1);
  });

  it("deduplicates function overload declarations", () => {
    const graph = analyzeProject([{
      path: "a.ts",
      content: `export function run(value: string): string;\nexport function run(value: number): number;\nexport function run(value: unknown) { return value; }`,
    }]);
    expect(graph.nodes.filter((node) => node.id === "a.ts#run")).toHaveLength(1);
  });
});
