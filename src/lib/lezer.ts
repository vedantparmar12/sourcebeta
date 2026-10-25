import type { SyntaxNode } from "@lezer/common";
import type { FileAnalysis, SymbolInfo } from "./analyzer";
import type { NodeKind } from "./types";

export interface Syntax {
  content: string;
  lineStarts: number[];
  text(node: SyntaxNode): string;
  lineAt(offset: number): number;
}

export function syntaxOf(content: string): Syntax {
  const lineStarts = [0];
  for (const match of content.matchAll(/\r\n|\r|\n/g)) lineStarts.push(match.index + match[0].length);
  const lineAt = (offset: number) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle;
    }
    return low + 1;
  };
  return { content, lineStarts, lineAt, text: (node) => content.slice(node.from, node.to) };
}

export interface SymbolSpec {
  name: string;
  kind: Extract<NodeKind, "class" | "function">;
  owner?: SymbolInfo;
  start: number;
  nameOffset: number;
  end: number;
  parameters?: string[];
  namespace?: boolean;
}

export function symbolFactory(path: string, syntax: Syntax) {
  const ids = new Set<string>();
  return (spec: SymbolSpec): SymbolInfo => {
    const qualified = spec.owner ? `${spec.owner.node.label}.${spec.name}` : spec.name;
    const line = syntax.lineAt(spec.nameOffset);
    const baseId = `${path}#${qualified}`;
    let id = ids.has(baseId) ? `${baseId}@${line}` : baseId;
    if (ids.has(id)) id += `:${spec.nameOffset - syntax.lineStarts[line - 1] + 1}`;
    ids.add(id);
    let last = spec.end - 1;
    while (last > spec.start && /\s/.test(syntax.content[last])) last--;
    return {
      node: {
        id,
        label: qualified,
        kind: spec.kind,
        file: path,
        line,
        startLine: syntax.lineAt(spec.start),
        endLine: syntax.lineAt(Math.max(spec.start, last)),
      },
      parentId: spec.owner?.node.id ?? path,
      calls: [],
      parameters: spec.parameters ?? [],
      ...(spec.namespace ? { namespace: true } : {}),
    };
  };
}

export function addImportEdge(result: FileAnalysis, imported: Set<string>, source: string, target: string) {
  if (imported.has(target)) return;
  imported.add(target);
  result.edges.push({ source, target, type: "imports", confidence: "EXTRACTED" });
}
