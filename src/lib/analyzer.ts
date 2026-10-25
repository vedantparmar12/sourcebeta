import ts from "typescript";
import { analyzePython } from "./python";
import { analyzeJava } from "./java";
import { analyzeRust } from "./rust";
import { analyzeGo } from "./go";
import { analyzeCpp } from "./cpp";
import { C_EXTENSIONS, CODE_EXTENSIONS, GO_EXTENSIONS, JAVA_EXTENSIONS, NOTE_EXTENSIONS, normalizePath, PYTHON_EXTENSIONS, RUST_EXTENSIONS, SUPPORTED_EXTENSIONS } from "./scan";
import type { GraphEdge, GraphNode, KnowledgeGraph, SourceFileInput } from "./types";

export interface SymbolInfo {
  node: GraphNode;
  parentId: string;
  calls: string[];
  parameters: string[];
  namespace?: boolean;
}

export interface ImportBinding {
  scope: string;
  alias: string;
  file: string;
  name: string;
  parent?: string;
}

export interface FileAnalysis {
  symbols: SymbolInfo[];
  imports: ImportBinding[];
  edges: GraphEdge[];
  defaultExport?: string;
  namespace?: string;
  returns?: { name: string; type: string }[];
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

function relativePath(fromFile: string, specifier: string): string {
  const parts = fromFile.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolveImport(fromFile: string, specifier: string, known: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = relativePath(fromFile, specifier);
  const candidates = [base];
  if (!CODE_EXTENSIONS.includes(extensionOf(base))) {
    for (const ext of CODE_EXTENSIONS) candidates.push(base + ext, `${base}/index${ext}`);
  }
  if (extensionOf(base) === ".js") candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"));
  return candidates.find(candidate => known.has(candidate)) ?? null;
}

function analyzeTypescript(path: string, content: string, known: Set<string>): FileAnalysis {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const result: FileAnalysis = { symbols: [], imports: [], edges: [] };
  const symbols = new Map<string, SymbolInfo>();
  const implementations = new Set<string>();
  const lineAt = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;
  const addImport = (specifier: string) => {
    const target = resolveImport(path, specifier, known);
    if (target) result.edges.push({ source: path, target, type: "imports", confidence: "EXTRACTED" });
    return target;
  };
  const visit = (syntax: ts.Node, owner?: SymbolInfo) => {
    if (ts.isImportDeclaration(syntax) && ts.isStringLiteral(syntax.moduleSpecifier)) {
      const target = addImport(syntax.moduleSpecifier.text);
      if (target) {
        const clause = syntax.importClause;
        if (clause?.name) result.imports.push({ scope: path, alias: clause.name.text, file: target, name: "default" });
        if (clause?.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            result.imports.push({ scope: path, alias: clause.namedBindings.name.text, file: target, name: "*" });
          } else for (const element of clause.namedBindings.elements) {
            result.imports.push({ scope: path, alias: element.name.text, file: target, name: (element.propertyName ?? element.name).text });
          }
        }
      }
    }
    if (ts.isExportDeclaration(syntax) && syntax.moduleSpecifier && ts.isStringLiteral(syntax.moduleSpecifier)) addImport(syntax.moduleSpecifier.text);
    if (ts.isCallExpression(syntax) || ts.isNewExpression(syntax)) {
      const name = syntax.expression.getText(source).replace(/\?\./g, ".");
      if (/^[\w$]+(?:\.[\w$]+)*$/.test(name)) owner?.calls.push(name);
      if (ts.isCallExpression(syntax) && (syntax.expression.kind === ts.SyntaxKind.ImportKeyword || name === "require") && syntax.arguments[0] && ts.isStringLiteralLike(syntax.arguments[0])) {
        addImport(syntax.arguments[0].text);
      }
    }
    const isClass = ts.isClassDeclaration(syntax) || ts.isClassExpression(syntax);
    const isFunction = ts.isFunctionDeclaration(syntax) || ts.isFunctionExpression(syntax) || ts.isArrowFunction(syntax) || ts.isMethodDeclaration(syntax) || ts.isConstructorDeclaration(syntax) || ts.isGetAccessorDeclaration(syntax) || ts.isSetAccessorDeclaration(syntax);
    if (isClass || isFunction) {
      let assigned: ts.Node = syntax;
      while (ts.isCallExpression(assigned.parent) && assigned.parent.arguments[0] === assigned || ts.isParenthesizedExpression(assigned.parent)) assigned = assigned.parent;
      const parent = assigned.parent;
      let name = "name" in syntax && syntax.name ? syntax.name.getText(source).replace(/^['"]|['"]$/g, "") : "";
      if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === assigned) name = parent.name.getText(source);
      if (ts.isConstructorDeclaration(syntax)) name = "constructor";
      if (ts.isGetAccessorDeclaration(syntax)) name = `get ${name}`;
      if (ts.isSetAccessorDeclaration(syntax)) name = `set ${name}`;
      const start = syntax.getStart(source);
      const position = source.getLineAndCharacterOfPosition(start);
      if (!name) name = `<${isClass ? "class" : "anonymous"}@${position.line + 1}:${position.character + 1}>`;
      const parentId = owner?.node.id ?? path;
      const qualified = owner ? `${owner.node.id.slice(path.length + 1)}.${name}` : name;
      const baseId = `${path}#${qualified}`;
      const hasBody = isClass || ("body" in syntax && !!syntax.body);
      const id = symbols.has(baseId) && implementations.has(baseId) ? `${baseId}@${position.line + 1}:${position.character + 1}` : baseId;
      const previous = symbols.get(id);
      const info: SymbolInfo = {
        node: { id, label: qualified, kind: isClass ? "class" : "function", file: path,
          line: lineAt("name" in syntax && syntax.name ? syntax.name.getStart(source) : start),
          startLine: previous?.node.startLine ?? lineAt(start), endLine: lineAt(Math.max(start, syntax.end - 1)) },
        parentId, calls: [], parameters: [],
      };
      if (isFunction) {
        for (const parameter of syntax.parameters) {
          const collect = (node: ts.Node) => { if (ts.isIdentifier(node)) info.parameters.push(node.text); else ts.forEachChild(node, collect); };
          collect(parameter.name);
        }
      }
      symbols.set(id, info);
      if (hasBody) implementations.add(id);
      if (ts.canHaveModifiers(syntax) && ts.getModifiers(syntax)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) result.defaultExport = id;
      ts.forEachChild(syntax, child => visit(child, info));
      return;
    }
    ts.forEachChild(syntax, child => visit(child, owner));
  };
  visit(source);
  result.symbols = [...symbols.values()];
  return result;
}

export function analyzeProject(files: SourceFileInput[]): KnowledgeGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const sources: Record<string, string> = Object.create(null);
  const inputs = files
    .map(file => ({ ...file, path: normalizePath(file.path) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const known = new Set(inputs.map(file => file.path));
  const symbols = new Map<string, SymbolInfo>();
  const byScope = new Map<string, SymbolInfo[]>();
  const byName = new Map<string, SymbolInfo[]>();
  const imports = new Map<string, ImportBinding[]>();
  const defaults = new Map<string, string>();
  const namespaces = new Map<string, string[]>();
  const fileNamespace = new Map<string, string>();
  const returnTypes = new Map<string, string>();
  const warnings: string[] = [];
  const noteIdByTitle = new Map<string, string>();
  const pendingLinks: { source: string; title: string }[] = [];

  for (const input of inputs) {
    const path = input.path;
    const ext = extensionOf(path);
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;
    sources[path] = input.content;
    const endLine = input.content.split("\n").length;
    if (NOTE_EXTENSIONS.includes(ext)) {
      const id = `note:${path}`;
      const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "");
      nodes.push({ id, label: title, kind: "note", file: path, line: 1, startLine: 1, endLine });
      noteIdByTitle.set(title.toLowerCase(), id);
      for (const match of input.content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) pendingLinks.push({ source: id, title: match[1].trim().toLowerCase() });
      for (const match of input.content.matchAll(/\[[^\]\n]+\]\(([^\s)#]+)(?:#[^\s)]*)?\)/g)) {
        const target = relativePath(path, match[1]);
        if (known.has(target) && NOTE_EXTENSIONS.includes(extensionOf(target))) edges.push({ source: id, target: `note:${target}`, type: "links", confidence: "EXTRACTED" });
      }
      continue;
    }
    nodes.push({ id: path, label: path.slice(path.lastIndexOf("/") + 1), kind: "file", file: path, line: 1, startLine: 1, endLine });
    let result: FileAnalysis;
    try {
      result = PYTHON_EXTENSIONS.includes(ext) ? analyzePython(path, input.content, known)
        : JAVA_EXTENSIONS.includes(ext) ? analyzeJava(path, input.content, known)
          : RUST_EXTENSIONS.includes(ext) ? analyzeRust(path, input.content, known)
            : GO_EXTENSIONS.includes(ext) ? analyzeGo(path, input.content, known)
              : C_EXTENSIONS.includes(ext) ? analyzeCpp(path, input.content, known)
                : analyzeTypescript(path, input.content, known);
    } catch {
      warnings.push(path);
      continue;
    }
    edges.push(...result.edges);
    for (const binding of result.imports) {
      const key = `${binding.scope}\0${binding.alias}`;
      imports.set(key, [...(imports.get(key) ?? []), binding]);
    }
    if (result.namespace) {
      fileNamespace.set(path, result.namespace);
      namespaces.set(result.namespace, [...(namespaces.get(result.namespace) ?? []), path]);
      for (const entry of result.returns ?? []) {
        const key = `${result.namespace}\0${entry.name}`;
        if (!returnTypes.has(key)) returnTypes.set(key, entry.type);
      }
    }
    if (result.defaultExport) defaults.set(path, result.defaultExport);
    for (const symbol of result.symbols) {
      symbols.set(symbol.node.id, symbol);
      nodes.push(symbol.node);
      edges.push({ source: symbol.parentId, target: symbol.node.id, type: "contains", confidence: "EXTRACTED" });
      const name = symbol.node.label.split(".").pop()!;
      const key = `${symbol.parentId}\0${name}`;
      byScope.set(key, [...(byScope.get(key) ?? []), symbol]);
      if (symbol.parentId === path) byName.set(name, [...(byName.get(name) ?? []), symbol]);
    }
  }

  const one = (candidates?: SymbolInfo[]) => candidates?.length === 1 ? candidates[0] : undefined;
  const descend = (start: SymbolInfo | undefined, names: string[]) => {
    let target = start;
    for (const name of names) {
      target = target?.node.kind === "class" ? one(byScope.get(`${target.node.id}\0${name}`)) : undefined;
    }
    return target;
  };
  const resolvePath = (scope: string, parts: string[]) => descend(one(byScope.get(`${scope}\0${parts[0]}`)), parts.slice(1));
  const resolveBinding = (binding: ImportBinding, parts: string[]) => {
    const names = [...parts];
    let target: SymbolInfo | undefined = binding.parent ? one(byScope.get(`${binding.file}\0${binding.parent}`)) : undefined;
    if (binding.parent && !target) return undefined;
    const name = binding.name === "*" ? names.shift() : binding.name;
    if (name === "default") target = symbols.get(defaults.get(binding.file) ?? "");
    else if (name) target = target ? descend(target, [name]) : one(byScope.get(`${binding.file}\0${name}`));
    return descend(target, names);
  };
  for (const info of symbols.values()) {
    const resolvedCalls = new Set<string>();
    for (let call of info.calls) {
      if (call.startsWith("@")) {
        const parts = call.split(".");
        const type = returnTypes.get(`${fileNamespace.get(info.node.file) ?? ""}\0${parts[0].slice(1)}`);
        if (!type) continue;
        call = [type, ...parts.slice(1)].join(".");
      }
      resolvedCalls.add(call);
    }
    for (const call of resolvedCalls) {
      const parts = call.split(".");
      let scope: string | undefined = info.node.id;
      let target: SymbolInfo | undefined;
      let blocked = false;
      if (["self", "cls", "this"].includes(parts[0]) && parts.length === 2) {
        let parent: SymbolInfo | undefined = info;
        while (parent && parent.node.kind !== "class") parent = symbols.get(parent.parentId);
        target = parent ? one(byScope.get(`${parent.node.id}\0${parts[1]}`)) : undefined;
      } else {
        while (scope && !target) {
          const current = symbols.get(scope);
          if (current?.parameters.includes(parts[0])) { blocked = true; break; }
          if (current?.node.kind !== "class" || current.namespace) target = resolvePath(scope, parts);
          let bindings: ImportBinding[] | undefined;
          let prefixLength = parts.length;
          for (; prefixLength > 0; prefixLength--) {
            bindings = imports.get(`${scope}\0${parts.slice(0, prefixLength).join(".")}`);
            if (bindings) break;
          }
          if (!target && bindings) {
            for (const binding of bindings) {
              target = resolveBinding(binding, parts.slice(prefixLength));
              if (target) break;
            }
            blocked = !target;
            break;
          }
          if (!target) {
            for (const binding of imports.get(`${scope}\0*`) ?? []) {
              target = resolveBinding(binding, parts);
              if (target) break;
            }
          }
          scope = current?.parentId;
        }
      }
      let confidence: GraphEdge["confidence"] = "EXTRACTED";
      if (!target && !blocked) {
        const namespace = fileNamespace.get(info.node.file);
        if (namespace) {
          let ambiguous = false;
          for (const file of namespaces.get(namespace) ?? []) {
            const candidate = resolvePath(file, parts);
            if (!candidate) continue;
            if (target && target !== candidate) { ambiguous = true; break; }
            target = candidate;
          }
          if (ambiguous) target = undefined;
        }
      }
      if (!target && !blocked && parts.length === 1) {
        target = one(byName.get(call));
        confidence = "INFERRED";
      }
      if (target && target.node.id !== info.node.id) edges.push({ source: info.node.id, target: target.node.id, type: "calls", confidence });
    }
  }
  for (const link of pendingLinks) {
    const target = noteIdByTitle.get(link.title);
    if (target && target !== link.source) edges.push({ source: link.source, target, type: "links", confidence: "EXTRACTED" });
  }
  const uniqueEdges = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    if (!uniqueEdges.has(key) || edge.confidence === "EXTRACTED") uniqueEdges.set(key, edge);
  }
  return {
    nodes: [...new Map(nodes.map(node => [node.id, node])).values()],
    edges: [...uniqueEdges.values()],
    sources,
    ...(warnings.length ? { warnings } : {}),
  };
}
