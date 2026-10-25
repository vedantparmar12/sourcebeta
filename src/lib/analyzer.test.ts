import { describe, expect, it, vi } from "vitest";
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
    expect(graph.nodes.find(node => node.id === "a.ts#run")).toMatchObject({ line: 3, startLine: 1, endLine: 3 });
  });

  it("discovers methods, nested functions, callbacks and wrapped functions with source ranges", () => {
    const content = `class Service {
  constructor() {}
  run() {
    function inner() { return helper(); }
    return inner();
  }
  done = () => 1;
}
const View = memo(() => helper());
function helper() { return 1; }
[1].map(value => value + 1);`;
    const graph = analyzeProject([{ path: "a.ts", content }]);
    for (const name of ["Service", "Service.constructor", "Service.run", "Service.run.inner", "Service.done", "View", "helper"]) {
      expect(graph.nodes.some(node => node.id === `a.ts#${name}`)).toBe(true);
    }
    expect(graph.nodes.some(node => node.label.startsWith("<anonymous@11:"))).toBe(true);
    expect(graph.nodes.find(node => node.id === "a.ts#Service.run")).toMatchObject({ line: 3, startLine: 3, endLine: 6 });
    expect(graph.sources?.["a.ts"]).toBe(content);
    expect(graph.edges).toContainEqual({ source: "a.ts#Service.run", target: "a.ts#Service.run.inner", type: "contains", confidence: "EXTRACTED" });
    expect(graph.edges).toContainEqual({ source: "a.ts#Service.run.inner", target: "a.ts#helper", type: "calls", confidence: "EXTRACTED" });
    expect(graph.edges.some(edge => edge.source === "a.ts#Service.run" && edge.target === "a.ts#helper" && edge.type === "calls")).toBe(false);
  });

  it("resolves lexical scopes and does not resolve calls through shadowed parameters", () => {
    const graph = analyzeProject([{ path: "a.ts", content: `function helper() {}
function outer() { function helper() {} return helper(); }
function run(helper) { return helper(); }
class Service { a() { return this.b(); } b() {} }` }]);
    expect(graph.edges).toContainEqual({ source: "a.ts#outer", target: "a.ts#outer.helper", type: "calls", confidence: "EXTRACTED" });
    expect(graph.edges).toContainEqual({ source: "a.ts#Service.a", target: "a.ts#Service.b", type: "calls", confidence: "EXTRACTED" });
    expect(graph.edges.some(edge => edge.source === "a.ts#run" && edge.type === "calls")).toBe(false);
  });

  it("resolves renamed, default and namespace imports", () => {
    const graph = analyzeProject([
      { path: "a.ts", content: `import renamed, { helper as alias } from './b'; import * as module from './b'; function run() { renamed(); alias(); module.helper(); }` },
      { path: "b.ts", content: `export default function original() {} export function helper() {}` },
    ]);
    for (const name of ["original", "helper"]) expect(graph.edges).toContainEqual({ source: "a.ts#run", target: `b.ts#${name}`, type: "calls", confidence: "EXTRACTED" });
  });

  it("preserves getters, setters, anonymous exports and dynamic import edges", () => {
    const graph = analyzeProject([
      { path: "a.ts", content: `class A { get value() { return 1; } set value(v) {} } export default () => import('./b');` },
      { path: "b.ts", content: `export const x = 1;` },
    ]);
    expect(graph.nodes.filter(node => node.kind === "function")).toHaveLength(3);
    expect(graph.edges).toContainEqual({ source: "a.ts", target: "b.ts", type: "imports", confidence: "EXTRACTED" });
  });

  it("resolves dotted Python imports, imported classes and lexical method calls", () => {
    const graph = analyzeProject([
      { path: "main.py", content: "import pkg.tools\nfrom pkg.tools import Service as Worker\ndef run():\n    pkg.tools.helper()\n    pkg.tools.Service.work()\n    Worker.work()\n" },
      { path: "pkg/tools.py", content: "def helper(): pass\nclass Service:\n    def work(self):\n        def nested(): return helper()\n        self.finish()\n        return nested()\n    def finish(self): pass\n" },
    ]);
    for (const name of ["helper", "Service.work"]) expect(graph.edges).toContainEqual({ source: "main.py#run", target: `pkg/tools.py#${name}`, type: "calls", confidence: "EXTRACTED" });
    expect(graph.edges).toContainEqual({ source: "pkg/tools.py#Service.work", target: "pkg/tools.py#Service.finish", type: "calls", confidence: "EXTRACTED" });
    expect(graph.edges).toContainEqual({ source: "pkg/tools.py#Service.work", target: "pkg/tools.py#Service.work.nested", type: "calls", confidence: "EXTRACTED" });
    expect(graph.edges.some(edge => edge.source === "pkg/tools.py#Service.work" && edge.target === "pkg/tools.py#helper")).toBe(false);
  });

  it("does not infer bare calls to unrelated methods or nested definitions", () => {
    const graph = analyzeProject([
      { path: "a.py", content: "def run():\n    set()\n    hidden()\n" },
      { path: "b.py", content: "class Cookies:\n    def set(self): pass\ndef outer():\n    def hidden(): pass\n" },
    ]);
    expect(graph.edges.filter(edge => edge.type === "calls")).toEqual([]);
  });

  it("produces identical graph output regardless of input order", () => {
    const forward = analyzeProject(DEMO_FILES);
    const reverse = analyzeProject([...DEMO_FILES].reverse());
    expect(reverse.nodes).toEqual(forward.nodes);
    expect(reverse.edges).toEqual(forward.edges);
    expect(Object.entries(reverse.sources ?? {})).toEqual(Object.entries(forward.sources ?? {}));
  });

  it("keeps references valid for empty and malformed source", () => {
    const inputs = [
      { path: "broken.ts", content: "function broken( { const = ; class { foo( }" },
      { path: "broken.py", content: "def broken(:\n    ???\nclass :\n" },
      { path: "empty.ts", content: "" },
      { path: "binary.ts", content: "const value = \"\u0000\";\n" },
    ];
    expect(() => analyzeProject(inputs)).not.toThrow();
    const graph = analyzeProject(inputs);
    const ids = new Set(graph.nodes.map(node => node.id));
    expect(ids.size).toBe(graph.nodes.length);
    expect(new Set(graph.edges.map(edge => `${edge.source}|${edge.target}|${edge.type}`)).size).toBe(graph.edges.length);
    for (const edge of graph.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
    for (const node of graph.nodes) {
      expect(node.startLine).toBeGreaterThanOrEqual(1);
      expect(node.endLine).toBeGreaterThanOrEqual(node.startLine ?? 1);
      expect(node.line ?? 1).toBeGreaterThanOrEqual(node.startLine ?? 1);
      expect(node.line ?? 1).toBeLessThanOrEqual(node.endLine ?? 1);
    }
  });

  it("connects local Markdown links and retains complete note source", () => {
    const content = "# Notes\n\n[Design](./design.md#overview)\n<script>literal</script>\n";
    const graph = analyzeProject([{ path: "notes/README.md", content }, { path: "notes/design.md", content: "# Design\n" }]);
    expect(graph.edges).toContainEqual({ source: "note:notes/README.md", target: "note:notes/design.md", type: "links", confidence: "EXTRACTED" });
    expect(graph.sources?.["notes/README.md"]).toBe(content);
    expect(graph.nodes.find(node => node.id === "note:notes/README.md")).toMatchObject({ startLine: 1, endLine: 5 });
  });

  it("keeps valid files and reports a file whose language analyzer fails", async () => {
    vi.doMock("./java", () => ({ analyzeJava: () => { throw new Error("Parser failure"); } }));
    vi.resetModules();
    try {
      const { analyzeProject: analyzeWithFailure } = await import("./analyzer");
      const graph = analyzeWithFailure([
        { path: "a.java", content: "class Broken {}" },
        { path: "valid.ts", content: "export function valid() { return 1; }" },
      ]);
      expect(graph.warnings).toEqual(["a.java"]);
      expect(graph.nodes.some(node => node.id === "a.java" && node.kind === "file")).toBe(true);
      expect(graph.nodes.some(node => node.id === "valid.ts#valid" && node.kind === "function")).toBe(true);
      expect(graph.edges).toContainEqual({ source: "valid.ts", target: "valid.ts#valid", type: "contains", confidence: "EXTRACTED" });
    } finally {
      vi.doUnmock("./java");
      vi.resetModules();
    }
  });
});
