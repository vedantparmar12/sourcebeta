import { describe, expect, it } from "vitest";
import type { BoardElement } from "./canvas";
import { changedProjectFiles, createBoardReport, matchesQuery, refreshBoardSources } from "./productivity";

const card: BoardElement = {
  id: "card", kind: "card", x: 0, y: 0, width: 220, height: 90,
  stroke: "#000", fill: "#fff", strokeWidth: 1, text: "old\nfunction",
  source: { nodeId: "a", file: "old.ts", line: 1 },
};

describe("productivity helpers", () => {
  it("compares added, removed, changed, and unchanged files", () => {
    const changed = changedProjectFiles(
      [{ path: "same.ts", content: "same" }, { path: "edit.ts", content: "new" }, { path: "new.ts", content: "new" }],
      [{ path: "same.ts", content: "same" }, { path: "edit.ts", content: "old" }, { path: "removed.ts", content: "old" }],
    );
    expect([...changed].sort()).toEqual(["edit.ts", "new.ts", "removed.ts"]);
  });

  it("supports tokenized substring and fuzzy search", () => {
    expect(matchesQuery("SourceView", "src/components/SourceView.tsx", "source view")).toBe(true);
    expect(matchesQuery("SourceView", "src/components/SourceView.tsx", "srcv")).toBe(true);
    expect(matchesQuery("SourceView", "src/components/SourceView.tsx", "missing")).toBe(false);
    expect(matchesQuery("module-1234", "src/module-1234.ts", "module-9999")).toBe(false);
  });

  it("refreshes linked cards and marks unavailable sources", () => {
    const graph = { nodes: [{ id: "a", label: "renamed", kind: "function" as const, file: "new.ts", line: 8 }], edges: [] };
    expect(refreshBoardSources([card], graph)[0]).toMatchObject({ text: "renamed\nfunction", source: { nodeId: "a", file: "new.ts", line: 8 } });
    const missing = refreshBoardSources([card], { nodes: [], edges: [] });
    expect(missing[0].text).toContain("source unavailable");
    expect(refreshBoardSources(missing, { nodes: [], edges: [] })[0].text).toBe(missing[0].text);
  });

  it("creates a self-contained report and escapes markup in board data", () => {
    const report = createBoardReport("Architecture", [{ ...card, comment: "</script><script>alert(1)</script>" }]);
    expect(report).toContain("<!doctype html>");
    expect(report).not.toContain("</script><script>alert(1)</script>");
    expect(report).toContain("\\u003c/script\\u003e");
  });
});
