import { parser } from "@lezer/cpp";
import type { SyntaxNode } from "@lezer/common";
import type { FileAnalysis, SymbolInfo } from "./analyzer";
import { addImportEdge, symbolFactory, syntaxOf } from "./lezer";

const DECLARATOR_WRAPPERS = new Set(["PointerDeclarator", "ReferenceDeclarator"]);

function joinPath(directory: string, specifier: string): string {
  const parts = directory ? directory.split("/") : [];
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export function analyzeCpp(path: string, content: string, known: Set<string>): FileAnalysis {
  const syntax = syntaxOf(content);
  const result: FileAnalysis = { symbols: [], imports: [], edges: [] };
  const createSymbol = symbolFactory(path, syntax);
  const imported = new Set<string>();
  const top = parser.parse(content).topNode;
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const containers = new Map<string, SymbolInfo>();
  const functions = new Map<string, SymbolInfo>();
  const bodies = new Set<string>();

  const resolveInclude = (specifier: string): string | undefined => {
    const relative = joinPath(directory, specifier);
    if (known.has(relative)) return relative;
    const matches = [...known].filter((file) => file === specifier || file.endsWith(`/${specifier}`)).sort();
    return matches.length === 1 ? matches[0] : undefined;
  };

  const declaratorOf = (node: SyntaxNode): SyntaxNode | null => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "FunctionDeclarator") return child;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (!DECLARATOR_WRAPPERS.has(child.name)) continue;
      const found = declaratorOf(child);
      if (found) return found;
    }
    return null;
  };

  const nameParts = (declarator: SyntaxNode): string[] => {
    const scoped = declarator.getChild("ScopedIdentifier");
    if (scoped) return syntax.text(scoped).replace(/\s+/g, "").split("::").filter(Boolean);
    const nameNode = declarator.getChild("FieldIdentifier") ?? declarator.getChild("Identifier") ?? declarator.getChild("DestructorName");
    return nameNode ? [syntax.text(nameNode)] : [];
  };

  const typeOf = (node: SyntaxNode | null): string | undefined => {
    if (!node) return undefined;
    if (node.name === "TypeIdentifier" || node.name === "PrimitiveType") return syntax.text(node);
    if (node.name === "ScopedIdentifier") return syntax.text(node).replace(/\s+/g, "").split("::").filter(Boolean).join(".");
    if (node.name === "StructSpecifier" || node.name === "ClassSpecifier" || node.name === "EnumSpecifier") {
      return typeOf(node.getChild("TypeIdentifier"));
    }
    return undefined;
  };

  const parameters = (declarator: SyntaxNode): { names: string[]; types: Map<string, string>; signature: string } => {
    const names: string[] = [];
    const types = new Map<string, string>();
    const signature: string[] = [];
    for (const parameter of declarator.getChild("ParameterList")?.getChildren("ParameterDeclaration") ?? []) {
      const type = typeOf(parameter.getChild("TypeIdentifier") ?? parameter.getChild("PrimitiveType")
        ?? parameter.getChild("StructSpecifier") ?? parameter.getChild("ScopedIdentifier"));
      signature.push(type ?? "");
      let nameNode = parameter.getChild("Identifier");
      if (!nameNode) {
        for (const wrapper of DECLARATOR_WRAPPERS) {
          nameNode = parameter.getChild(wrapper)?.getChild("Identifier") ?? null;
          if (nameNode) break;
        }
      }
      if (!nameNode) continue;
      const name = syntax.text(nameNode);
      names.push(name);
      if (type) types.set(name, type);
    }
    return { names, types, signature: signature.join(",") };
  };

  const containerFor = (parts: string[], owner: SymbolInfo | undefined, node: SyntaxNode): { owner?: SymbolInfo; name: string } => {
    const name = parts[parts.length - 1];
    let current = owner;
    let index = 0;
    for (; index < parts.length - 1; index++) {
      const label = current ? `${current.node.label}.${parts[index]}` : parts[index];
      const found = containers.get(label);
      if (!found) break;
      current = found;
    }
    for (; index < parts.length - 1; index++) {
      const proxy = createSymbol({ name: parts[index], kind: "class", owner: current, start: node.from, nameOffset: node.from, end: node.to });
      result.symbols.push(proxy);
      containers.set(proxy.node.label, proxy);
      current = proxy;
    }
    return { owner: current, name };
  };

  const declareFunction = (node: SyntaxNode, declarator: SyntaxNode, owner: SymbolInfo | undefined, inheritedTypes: Map<string, string> | undefined, hasBody: boolean) => {
    const parts = nameParts(declarator);
    if (!parts.length || parts[parts.length - 1].startsWith("operator")) return;
    const target = containerFor(parts, owner, node);
    const { names, types, signature } = parameters(declarator);
    const key = `${target.owner?.node.id ?? path}\0${target.name}(${signature})`;
    let info = functions.get(key);
    if (info && (!hasBody || bodies.has(key))) return;
    if (!info) {
      info = createSymbol({
        name: target.name,
        kind: "function",
        owner: target.owner,
        start: node.from,
        nameOffset: declarator.from,
        end: node.to,
        parameters: names,
      });
      result.symbols.push(info);
      functions.set(key, info);
    } else {
      info.node.startLine = syntax.lineAt(node.from);
      info.node.endLine = syntax.lineAt(Math.max(node.from, node.to - 1));
      info.parameters = names;
    }
    if (!hasBody) return;
    bodies.add(key);
    const scoped = new Map(inheritedTypes);
    for (const [name, type] of types) scoped.set(name, type);
    const body = node.getChild("CompoundStatement");
    if (body) for (let child = body.firstChild; child; child = child.nextSibling) visit(child, info, scoped);
  };

  const localTypes = (node: SyntaxNode, types: Map<string, string>) => {
    const type = typeOf(node.getChild("TypeIdentifier") ?? node.getChild("StructSpecifier"));
    if (!type) return;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "Identifier") types.set(syntax.text(child), type);
      else if (child.name === "InitDeclarator") {
        const name = child.getChild("Identifier");
        if (name) types.set(syntax.text(name), type);
      }
    }
  };

  const visit = (node: SyntaxNode, owner?: SymbolInfo, types?: Map<string, string>) => {
    if (node.name === "PreprocDirective") {
      if (node.getChild("#include")) {
        const literal = node.getChild("String");
        if (literal) {
          const target = resolveInclude(syntax.text(literal).slice(1, -1));
          if (target) {
            result.imports.push({ scope: path, alias: "*", file: target, name: "*" });
            addImportEdge(result, imported, path, target);
          }
        }
      }
      return;
    }
    if (node.name === "NamespaceDefinition") {
      const nameNode = node.getChild("Identifier");
      if (!nameNode) return;
      const name = syntax.text(nameNode);
      const label = owner ? `${owner.node.label}.${name}` : name;
      let info = containers.get(label);
      if (!info) {
        info = createSymbol({ name, kind: "class", owner, start: node.from, nameOffset: nameNode.from, end: node.to, namespace: true });
        result.symbols.push(info);
        containers.set(label, info);
      }
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, types);
      return;
    }
    if (["ClassSpecifier", "StructSpecifier", "UnionSpecifier", "EnumSpecifier"].includes(node.name)) {
      const body = node.getChild("FieldDeclarationList") ?? node.getChild("EnumeratorList");
      const nameNode = node.getChild("TypeIdentifier");
      if (!body) return;
      if (!nameNode) {
        for (let child = body.firstChild; child; child = child.nextSibling) visit(child, owner, types);
        return;
      }
      const info = createSymbol({ name: syntax.text(nameNode), kind: "class", owner, start: node.from, nameOffset: nameNode.from, end: node.to });
      result.symbols.push(info);
      containers.set(info.node.label, info);
      for (let child = body.firstChild; child; child = child.nextSibling) visit(child, info, types);
      return;
    }
    if (node.name === "FunctionDefinition") {
      const declarator = declaratorOf(node);
      if (declarator) declareFunction(node, declarator, owner, types, true);
      return;
    }
    if (node.name === "Declaration" || node.name === "FieldDeclaration") {
      const declarator = declaratorOf(node);
      if (declarator) {
        declareFunction(node, declarator, owner, types, false);
        return;
      }
      if (node.name === "Declaration" && types) localTypes(node, types);
    }
    if (node.name === "LambdaExpression") {
      const parent = node.parent?.name === "InitDeclarator" ? node.parent : null;
      const assigned = parent?.getChild("Identifier");
      const name = assigned ? syntax.text(assigned) : `<lambda@${syntax.lineAt(node.from)}:${node.from - syntax.lineStarts[syntax.lineAt(node.from) - 1] + 1}>`;
      const info = createSymbol({ name, kind: "function", owner, start: node.from, nameOffset: assigned?.from ?? node.from, end: node.to });
      result.symbols.push(info);
      const scoped = new Map(types);
      const declarator = node.getChild("AbstractFunctionDeclarator") ?? node.getChild("FunctionDeclarator");
      if (declarator) {
        const { names, types: parameterTypes } = parameters(declarator);
        info.parameters = names;
        for (const [key, value] of parameterTypes) scoped.set(key, value);
      }
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, scoped);
      return;
    }
    if (node.name === "CallExpression" && owner) {
      const callee = node.firstChild;
      if (callee) {
        if (callee.name === "Identifier") {
          owner.calls.push(syntax.text(callee));
        } else if (callee.name === "ScopedIdentifier") {
          owner.calls.push(syntax.text(callee).replace(/\s+/g, "").split("::").filter(Boolean).join("."));
        } else if (callee.name === "FieldExpression") {
          const receiver = callee.firstChild;
          const member = callee.lastChild;
          if (receiver && member?.name === "FieldIdentifier") {
            if (receiver.name === "this") owner.calls.push(`this.${syntax.text(member)}`);
            else if (receiver.name === "Identifier") {
              const name = syntax.text(receiver);
              owner.calls.push(`${types?.get(name) ?? name}.${syntax.text(member)}`);
            }
          }
        }
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, owner, types);
  };
  visit(top);

  const methodsByOwner = new Map<string, SymbolInfo[]>();
  for (const info of result.symbols) {
    if (info.node.kind !== "function") continue;
    methodsByOwner.set(info.parentId, [...(methodsByOwner.get(info.parentId) ?? []), info]);
  }
  for (const [parentId, methods] of methodsByOwner) {
    if (symbolsKind(parentId) !== "class") continue;
    const siblings = new Set(methods.map((info) => info.node.label.split(".").pop()));
    for (const method of methods) {
      method.calls = [...new Set(method.calls.map((call) => !call.includes(".")
        && siblings.has(call) && !method.parameters.includes(call) ? `this.${call}` : call))];
    }
  }
  for (const info of result.symbols) {
    if (info.node.kind === "function") info.calls = [...new Set(info.calls)];
  }
  return result;

  function symbolsKind(id: string) {
    return result.symbols.find((info) => info.node.id === id)?.node.kind;
  }
}
