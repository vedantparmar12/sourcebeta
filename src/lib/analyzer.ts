import ts from "typescript";
import type { GraphEdge, GraphNode, KnowledgeGraph, SourceFileInput } from "./types";

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const NOTE_EXTENSIONS = [".md", ".markdown"];
export const SUPPORTED_EXTENSIONS = [...CODE_EXTENSIONS, ...NOTE_EXTENSIONS];

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function resolveImport(fromFile: string, specifier: string, known: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const baseParts = fromFile.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") baseParts.pop();
    else baseParts.push(part);
  }
  const base = baseParts.join("/");
  const candidates = [base];
  if (!CODE_EXTENSIONS.includes(extensionOf(base))) {
    for (const ext of CODE_EXTENSIONS) candidates.push(base + ext, `${base}/index${ext}`);
  }
  // A compiled "./store.js" specifier usually points at "./store.ts" in source.
  if (extensionOf(base) === ".js") {
    candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  }
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

interface SymbolInfo {
  node: GraphNode;
  calledNames: string[];
}

export function analyzeProject(files: SourceFileInput[]): KnowledgeGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const known = new Set(files.map((file) => normalizePath(file.path)));
  const symbolsByName = new Map<string, SymbolInfo[]>();
  const noteIdByTitle = new Map<string, string>();
  const pendingLinks: { source: string; title: string }[] = [];
  const pendingCalls: { info: SymbolInfo; imports: Map<string, string>; localSymbols: SymbolInfo[] }[] = [];

  const addSymbol = (info: SymbolInfo) => {
    nodes.push(info.node);
    const list = symbolsByName.get(info.node.label) ?? [];
    list.push(info);
    symbolsByName.set(info.node.label, list);
  };

  for (const input of files) {
    const path = normalizePath(input.path);
    const ext = extensionOf(path);
    if (NOTE_EXTENSIONS.includes(ext)) {
      const id = `note:${path}`;
      const title = basename(path).replace(/\.(md|markdown)$/i, "");
      nodes.push({ id, label: title, kind: "note", file: path });
      noteIdByTitle.set(title.toLowerCase(), id);
      const wikilink = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
      for (const match of input.content.matchAll(wikilink)) {
        pendingLinks.push({ source: id, title: match[1].trim().toLowerCase() });
      }
      continue;
    }
    if (!CODE_EXTENSIONS.includes(ext)) continue;

    nodes.push({ id: path, label: basename(path), kind: "file", file: path });
    const source = ts.createSourceFile(path, input.content, ts.ScriptTarget.Latest, true);
    const imports = new Map<string, string>(); // local name -> imported file
    const localSymbols: SymbolInfo[] = [];

    const recordCallNames = (body: ts.Node, info: SymbolInfo) => {
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          info.calledNames.push(node.expression.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(body);
    };

    const visitTopLevel = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveImport(path, node.moduleSpecifier.text, known);
        if (target) {
          edges.push({ source: path, target, type: "imports", confidence: "EXTRACTED" });
          const clause = node.importClause;
          for (const element of clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings.elements
            : []) {
            imports.set(element.name.text, target);
          }
          if (clause?.name) imports.set(clause.name.text, target);
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveImport(path, node.moduleSpecifier.text, known);
        if (target) edges.push({ source: path, target, type: "imports", confidence: "EXTRACTED" });
      } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        const info: SymbolInfo = {
          node: {
            id: `${path}#${node.name.text}`,
            label: node.name.text,
            kind: ts.isClassDeclaration(node) ? "class" : "function",
            file: path,
            line: source.getLineAndCharacterOfPosition(node.name.getStart(source)).line + 1,
          },
          calledNames: [],
        };
        recordCallNames(node, info);
        localSymbols.push(info);
      } else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
          if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) continue;
          const info: SymbolInfo = {
            node: {
              id: `${path}#${declaration.name.text}`,
              label: declaration.name.text,
              kind: "function",
              file: path,
              line: source.getLineAndCharacterOfPosition(declaration.name.getStart(source)).line + 1,
            },
            calledNames: [],
          };
          recordCallNames(declaration.initializer, info);
          localSymbols.push(info);
        }
      }
    };
    ts.forEachChild(source, visitTopLevel);

    for (const info of localSymbols) {
      addSymbol(info);
      edges.push({ source: path, target: info.node.id, type: "contains", confidence: "EXTRACTED" });
    }

    for (const info of localSymbols) pendingCalls.push({ info, imports, localSymbols });
  }

  // Resolve calls once every file's symbols are registered, so results do not
  // depend on scan order. Same-file and explicitly imported names are EXTRACTED;
  // a name that is merely unique across the project stays INFERRED.
  for (const { info, imports, localSymbols } of pendingCalls) {
    for (const name of new Set(info.calledNames)) {
      const local = localSymbols.find((candidate) => candidate.node.label === name);
      const importedFile = imports.get(name);
      const imported = importedFile
        ? (symbolsByName.get(name) ?? []).find((candidate) => candidate.node.file === importedFile)
        : undefined;
      const candidates = symbolsByName.get(name) ?? [];
      const unique = candidates.length === 1 ? candidates[0] : undefined;
      const target = local ?? imported ?? unique;
      if (!target || target.node.id === info.node.id) continue;
      edges.push({
        source: info.node.id,
        target: target.node.id,
        type: "calls",
        confidence: local || imported ? "EXTRACTED" : "INFERRED",
      });
    }
  }

  for (const link of pendingLinks) {
    const target = noteIdByTitle.get(link.title);
    if (target && target !== link.source) {
      edges.push({ source: link.source, target, type: "links", confidence: "EXTRACTED" });
    }
  }

  return { nodes: [...new Map(nodes.map((node) => [node.id, node])).values()], edges: dedupeEdges(edges) };
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
