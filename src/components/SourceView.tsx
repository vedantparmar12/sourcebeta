import { memo, useMemo, useState } from "react";
import type { GraphNode } from "../lib/types";

export const SourceView = memo(function SourceView({ node, source }: { node: GraphNode; source?: string }) {
  const [wholeFile, setWholeFile] = useState(false);
  const isSymbol = node.kind === "function" || node.kind === "class";
  const showWholeFile = !isSymbol || wholeFile;
  const lineStarts = useMemo(() => {
    if (source === undefined) return null;
    const starts = [0];
    // Keep original line endings in the source rather than rebuilding it from lines.
    for (const match of source.matchAll(/\r\n|\r|\n/g)) {
      starts.push(match.index + match[0].length);
    }
    return starts;
  }, [source]);
  const excerpt = useMemo(() => {
    if (source === undefined || !lineStarts) return null;
    const start = showWholeFile ? 1 : Math.min(lineStarts.length, Math.max(1, node.startLine ?? node.line ?? 1));
    const end = showWholeFile ? lineStarts.length : Math.min(lineStarts.length, Math.max(start, node.endLine ?? lineStarts.length));
    return {
      start,
      end,
      code: source.slice(lineStarts[start - 1], lineStarts[end] ?? source.length),
      gutter: Array.from({ length: end - start + 1 }, (_, index) => String(start + index)).join("\n"),
    };
  }, [source, lineStarts, showWholeFile, node.startLine, node.line, node.endLine]);

  return (
    <details className="source-view" open>
      <summary>Source</summary>
      <div className="source-range" role="note" aria-label="Source range">
        {node.file}{excerpt ? `:${excerpt.start}${excerpt.end !== excerpt.start ? `–${excerpt.end}` : ""}` : ""}
      </div>
      {excerpt ? (
        <>
          <div className="source-toolbar">
            <span>{showWholeFile ? "Whole file" : "Symbol"} · {excerpt.end - excerpt.start + 1} lines</span>
            {isSymbol && (
              <button type="button" onClick={() => setWholeFile((value) => !value)}>
                {wholeFile ? "Symbol" : "Whole file"}
              </button>
            )}
          </div>
          <div className="source-code" role="region" aria-label={`Source code for ${node.label}`} tabIndex={0}>
            <pre className="source-gutter" aria-hidden="true">{excerpt.gutter}</pre>
            <pre className="source-text">{excerpt.code}</pre>
          </div>
        </>
      ) : (
        <p className="hint">Source unavailable. This graph does not include source text for this file.</p>
      )}
    </details>
  );
});
