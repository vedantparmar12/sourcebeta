import { parser } from "@lezer/go";
import type { SyntaxNode } from "@lezer/common";
import type { FileAnalysis, SymbolInfo } from "./analyzer";
import { addImportEdge, symbolFactory, syntaxOf } from "./lezer";

const GO_LAYOUT = new WeakMap<Set<string>, Map<string, string[]>>();

function goLayout(known: Set<string>) {
  const cached = GO_LAYOUT.get(known);
  if (cached) return cached;
  const files = new Map<string, string[]>();
  for (const file of known) {
    if (!file.toLowerCase().endsWith(".go")) continue;
    const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    files.set(directory, [...(files.get(directory) ?? []), file]);
  }
  for (const list of files.values()) list.sort();
  GO_LAYOUT.set(known, files);
  return files;
}

function joinPath(directory: string, specifier: string): string {
  const parts = directory ? directory.split("/") : [];
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function analyzeGo(path: string, content: string, known: Set<string>): FileAnalysis {
  const syntax = syntaxOf(content);
  const result: FileAnalysis = { symbols: [], imports: [], edges: [] };
  const createSymbol = symbolFactory(path, syntax);
  const imported = new Set<string>();
  const top = parser.parse(content).topNode;
  const packageNode = top.getChild("PackageClause")?.getChild("DefName");
  const packageName = packageNode ? syntax.text(packageNode) : "";
  if (packageName) result.namespace = packageName;
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const files = goLayout(known);
  const directories = [...files.keys()].sort();

  const packageFor = (specifier: string): string[] | undefined => {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return files.get(joinPath(directory, specifier));
    }
    const parts = specifier.split("/").filter(Boolean);
    for (let length = parts.length; length > 0; length--) {
      const suffix = parts.slice(-length).join("/");
      const matches = directories.filter((candidate) => candidate === suffix || candidate.endsWith(`/${suffix}`));
      if (matches.length === 1) return files.get(matches[0]);
      if (matches.length > 1) return undefined;
    }
    return undefined;
  };

  const typeOf = (node: SyntaxNode | null, returns: Map<string, string>): string | undefined => {
    if (!node) return undefined;
    if (node.name === "TypeName") return syntax.text(node).replace(/\[.*$/s, "");
    if (node.name === "PointerType" || node.name === "GenericType" || node.name === "VariadicType") {
      return typeOf(node.getChild("TypeName"), returns);
    }
    if (node.name === "TypedLiteral") return typeOf(node.getChild("TypeName"), returns);
    if (node.name === "UnaryExp") {
      const literal = node.getChild("TypedLiteral");
      if (literal) return typeOf(literal, returns);
    }
    if (node.name === "CallExpr") {
      const callee = node.firstChild;
      if (callee?.name === "VariableName") return returns.get(syntax.text(callee)) ?? `@${syntax.text(callee)}`;
    }
    return undefined;
  };

  const parameters = (node: SyntaxNode | null): { names: string[]; types: Map<string, string> } => {
    const names: string[] = [];
    const types = new Map<string, string>();
    if (!node) return { names, types };
    for (const parameter of node.getChildren("Parameter")) {
      const type = typeOf(parameter.getChild("TypeName") ?? parameter.getChild("PointerType") ?? parameter.getChild("GenericType"), new Map())
        ?? typeOf(parameter.getChild("VariadicType"), new Map());
      for (const name of parameter.getChildren("DefName")) {
        names.push(syntax.text(name));
        if (type) types.set(syntax.text(name), type);
      }
    }
    return { names, types };
  };

  const returns = new Map<string, string>();
  for (const declaration of top.getChildren("FunctionDecl")) {
    const name = declaration.getChild("DefName");
    if (!name) continue;
    const parameterList = declaration.getChild("Parameters");
    let type: string | undefined;
    for (let child = parameterList?.nextSibling; child && child.name !== "Block"; child = child.nextSibling) {
      if (child.name === "ParameterList") type = typeOf(child.getChild("Parameter")?.getChild("TypeName") ?? null, returns);
      else type = typeOf(child, returns);
      if (type) break;
    }
    if (type) returns.set(syntax.text(name), type);
  }

  for (const declaration of top.getChildren("ImportDecl")) {
    for (const spec of declaration.getChildren("ImportSpec")) {
      const literal = spec.getChild("String");
      if (!literal) continue;
      const specifier = syntax.text(literal).slice(1, -1);
      const targetFiles = packageFor(specifier);
      if (!targetFiles || targetFiles.length === 0) continue;
      const aliasNode = spec.getChild("DefName");
      const rawAlias = aliasNode ? syntax.text(aliasNode) : "";
      if (rawAlias === "_") {
        addImportEdge(result, imported, path, targetFiles[0]);
        continue;
      }
      const alias = rawAlias === "." ? "*" : rawAlias || specifier.split("/").filter(Boolean).pop() || "";
      if (!alias) {
        addImportEdge(result, imported, path, targetFiles[0]);
        continue;
      }
      for (const file of targetFiles) result.imports.push({ scope: path, alias, file, name: "*" });
      addImportEdge(result, imported, path, targetFiles[0]);
    }
  }

  const classByType = new Map<string, SymbolInfo>();
  const typeSymbols = new Map<number, SymbolInfo>();
  for (const declaration of top.getChildren("TypeDecl")) {
    for (const spec of declaration.getChildren("TypeSpec")) {
      const nameNode = spec.getChild("DefName");
      if (!nameNode) continue;
      const info = createSymbol({ name: syntax.text(nameNode), kind: "class", start: spec.from, nameOffset: nameNode.from, end: spec.to });
      result.symbols.push(info);
      classByType.set(syntax.text(nameNode), info);
      typeSymbols.set(spec.from, info);
    }
  }

  const visit = (node: SyntaxNode, owner?: SymbolInfo, types?: Map<string, string>) => {
    if (node.name === "TypeDecl") {
      for (const spec of node.getChildren("TypeSpec")) {
        const nameNode = spec.getChild("DefName");
        if (!nameNode) continue;
        const info = typeSymbols.get(spec.from) ?? createSymbol({ name: syntax.text(nameNode), kind: "class", owner, start: spec.from, nameOffset: nameNode.from, end: spec.to });
        if (!typeSymbols.has(spec.from)) {
          result.symbols.push(info);
          typeSymbols.set(spec.from, info);
        }
        for (let child = spec.firstChild; child; child = child.nextSibling) visit(child, info, types);
      }
      return;
    }
    if (node.name === "MethodElem") {
      const nameNode = node.getChild("FieldName");
      if (!nameNode || !owner) return;
      const { names } = parameters(node.getChild("Parameters"));
      const info = createSymbol({ name: syntax.text(nameNode), kind: "function", owner, start: node.from, nameOffset: nameNode.from, end: node.to, parameters: names });
      result.symbols.push(info);
      return;
    }
    if (node.name === "FunctionDecl") {
      const nameNode = node.getChild("DefName");
      if (!nameNode) return;
      const { names, types: parameterTypes } = parameters(node.getChild("Parameters"));
      const info = createSymbol({ name: syntax.text(nameNode), kind: "function", start: node.from, nameOffset: nameNode.from, end: node.to, parameters: names });
      result.symbols.push(info);
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, new Map(parameterTypes));
      return;
    }
    if (node.name === "MethodDecl") {
      const lists = node.getChildren("Parameters");
      const receiver = parameters(lists[0] ?? null);
      const nameNode = node.getChild("FieldName");
      if (!nameNode) return;
      const receiverType = [...receiver.types.values()][0];
      const { names, types: parameterTypes } = parameters(lists[1] ?? null);
      const types = new Map(receiver.types);
      for (const [name, type] of parameterTypes) types.set(name, type);
      let classOwner = receiverType ? classByType.get(receiverType) : undefined;
      if (receiverType && !classOwner) {
        classOwner = createSymbol({ name: receiverType, kind: "class", start: node.from, nameOffset: nameNode.from, end: node.to });
        result.symbols.push(classOwner);
        classByType.set(receiverType, classOwner);
      }
      const info = createSymbol({ name: syntax.text(nameNode), kind: "function", owner: classOwner, start: node.from, nameOffset: nameNode.from, end: node.to, parameters: names });
      result.symbols.push(info);
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, types);
      return;
    }
    if (node.name === "FunctionLiteral") {
      const parent = node.parent;
      const assigned = parent && (parent.name === "VarDecl" || parent.name === "ShortVarDecl") ? parent.getChild("DefName") : null;
      const name = assigned ? syntax.text(assigned) : `<func@${syntax.lineAt(node.from)}:${node.from - syntax.lineStarts[syntax.lineAt(node.from) - 1] + 1}>`;
      const { names, types: parameterTypes } = parameters(node.getChild("Parameters"));
      const info = createSymbol({ name, kind: "function", owner, start: node.from, nameOffset: assigned?.from ?? node.from, end: node.to, parameters: names });
      result.symbols.push(info);
      const scoped = new Map(types);
      for (const [key, value] of parameterTypes) scoped.set(key, value);
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, scoped);
      return;
    }
    if (node.name === "VarDecl" && types) {
      const spec = node.getChild("VarSpec");
      if (spec) {
        const nameNode = spec.getChild("DefName");
        const type = typeOf(spec.getChild("TypeName") ?? spec.getChild("PointerType") ?? spec.getChild("GenericType"), returns);
        if (nameNode && type) types.set(syntax.text(nameNode), type);
      } else {
        const names = node.getChildren("DefName");
        let type: string | undefined;
        for (let child = node.lastChild; child; child = child.prevSibling) {
          if (child.name === "DefName" || child.name === ":=" || child.name === "=") continue;
          type = typeOf(child, returns);
          if (type) break;
        }
        if (type) for (const name of names) types.set(syntax.text(name), type);
      }
    }
    if (node.name === "CallExpr" && owner) {
      const callee = node.firstChild;
      if (callee) {
        if (callee.name === "VariableName") {
          owner.calls.push(syntax.text(callee));
        } else if (callee.name === "SelectorExpr") {
          const receiver = callee.firstChild;
          const field = callee.lastChild;
          if (receiver?.name === "VariableName" && field?.name === "FieldName") {
            const name = syntax.text(receiver);
            owner.calls.push(`${types?.get(name) ?? name}.${syntax.text(field)}`);
          }
        }
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, owner, types);
  };
  visit(top);

  for (const info of result.symbols) {
    if (info.node.kind === "function") info.calls = [...new Set(info.calls)];
  }
  result.returns = [...returns].map(([name, type]) => ({ name, type }));
  return result;
}
