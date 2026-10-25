import { parser } from "@lezer/rust";
import type { SyntaxNode } from "@lezer/common";
import type { FileAnalysis, SymbolInfo } from "./analyzer";
import { addImportEdge, symbolFactory, syntaxOf } from "./lezer";

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function typeName(node: SyntaxNode | null, syntax: ReturnType<typeof syntaxOf>): string | undefined {
  if (!node) return undefined;
  if (node.name === "TypeIdentifier" || node.name === "BoundIdentifier" || node.name === "Identifier") return syntax.text(node);
  if (node.name === "GenericType") return typeName(node.getChild("TypeIdentifier"), syntax);
  return undefined;
}

export function analyzeRust(path: string, content: string, known: Set<string>): FileAnalysis {
  const syntax = syntaxOf(content);
  const result: FileAnalysis = { symbols: [], imports: [], edges: [] };
  const createSymbol = symbolFactory(path, syntax);
  const imported = new Set<string>();
  const top = parser.parse(content).topNode;
  const segments = path.split("/");
  const file = segments[segments.length - 1];
  const directory = segments.slice(0, -1).join("/");
  const srcIndex = segments.lastIndexOf("src");
  const root = srcIndex === -1 ? directory : segments.slice(0, srcIndex + 1).join("/");
  const fileName = file.replace(/\.rs$/, "");
  const crateRoot = fileName === "lib" || fileName === "main" || fileName === "mod"
    || directory.endsWith("/bin") || directory === "bin" || directory === "tests" || directory.endsWith("/tests");
  const moduleDir = crateRoot ? directory : (directory ? `${directory}/${fileName}` : fileName);
  const moduleFile = (base: string): string | undefined => {
    if (!base) return undefined;
    return [`${base}.rs`, `${base}/mod.rs`].find((candidate) => known.has(candidate));
  };
  const rootModuleFile = [root ? `${root}/lib.rs` : "lib.rs", root ? `${root}/main.rs` : "main.rs"]
    .find((candidate) => known.has(candidate));
  const resolveModule = (parts: string[]): string | undefined => {
    if (!parts.length || parts[0] === "") return undefined;
    let base = root;
    let index = 0;
    while (parts[index] === "super") {
      base = base.slice(0, Math.max(0, base.lastIndexOf("/")));
      index++;
    }
    if (parts[index] === "crate") {
      index++;
      base = root;
    } else if (parts[index] === "self") {
      index++;
      base = moduleDir;
    }
    const rest = parts.slice(index);
    if (!rest.length) return base === root ? rootModuleFile : undefined;
    const joined = base ? `${base}/${rest.join("/")}` : rest.join("/");
    return moduleFile(joined);
  };
  const bind = (scope: string, alias: string, target: string, name: string) => {
    result.imports.push({ scope, alias, file: target, name });
    addImportEdge(result, imported, path, target);
  };

  const parseUse = (node: SyntaxNode, scope: string) => {
    const raw = syntax.text(node).replace(/^use\s+/, "").replace(/;$/, "").trim();
    if (!raw) return;
    const parse = (expression: string, prefix: string[] = []) => {
      let value = expression.trim();
      if (!value) return;
      if (value.startsWith("{") && value.endsWith("}")) {
        for (const item of splitTopLevel(value.slice(1, -1))) parse(item, prefix);
        return;
      }
      const brace = value.indexOf("{");
      if (brace !== -1 && value.endsWith("}")) {
        const head = value.slice(0, brace).replace(/::$/, "").trim();
        const headParts = head ? head.split("::").map((part) => part.trim()).filter(Boolean) : [];
        for (const item of splitTopLevel(value.slice(brace + 1, -1))) parse(item, [...prefix, ...headParts]);
        return;
      }
      const aliasMatch = value.match(/^(.*?)\s+as\s+(\w+)$/);
      const pathValue = (aliasMatch ? aliasMatch[1] : value).trim();
      if (pathValue.startsWith("::")) return;
      let parts = pathValue.split("::").map((part) => part.trim()).filter(Boolean);
      if (!parts.length) return;
      const wildcard = parts[parts.length - 1] === "*";
      if (wildcard) parts = parts.slice(0, -1);
      if (!parts.length) return;
      if (parts[parts.length - 1] === "self") {
        const moduleParts = [...prefix, ...parts.slice(0, -1)];
        const target = resolveModule(moduleParts);
        if (!target) return;
        const name = moduleParts[moduleParts.length - 1] ?? "self";
        bind(scope, aliasMatch?.[2] ?? name, target, "*");
        return;
      }
      const full = [...prefix, ...parts];
      if (wildcard) {
        const target = resolveModule(full);
        if (target) bind(scope, "*", target, "*");
        return;
      }
      const name = full[full.length - 1];
      const child = resolveModule(full);
      if (child) {
        bind(scope, aliasMatch?.[2] ?? name, child, "*");
        return;
      }
      const target = resolveModule(full.slice(0, -1));
      if (target) bind(scope, aliasMatch?.[2] ?? name, target, name);
    };
    parse(raw);
  };

  const parameters = (node: SyntaxNode): string[] => {
    const names: string[] = [];
    for (let child = node.getChild("ParamList")?.firstChild; child; child = child.nextSibling) {
      if (child.name === "SelfParameter") names.push("self");
      else if (child.name === "Parameter") {
        const name = child.getChild("BoundIdentifier");
        if (name) names.push(syntax.text(name));
      }
    }
    return names;
  };
  const findType = (node: SyntaxNode): string | undefined => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "TypeIdentifier" || child.name === "GenericType") {
        const found = typeName(child, syntax);
        if (found) return found;
      }
      const nested = findType(child);
      if (nested) return nested;
    }
    return undefined;
  };
  const parameterTypes = (node: SyntaxNode, types: Map<string, string>) => {
    for (let child = node.getChild("ParamList")?.firstChild; child; child = child.nextSibling) {
      if (child.name !== "Parameter") continue;
      const name = child.getChild("BoundIdentifier");
      if (!name) continue;
      const type = findType(child);
      if (type) types.set(syntax.text(name), type);
    }
  };

  const classByLabel = new Map<string, SymbolInfo>();

  const visit = (node: SyntaxNode, owner?: SymbolInfo, currentClass?: SymbolInfo, inheritedTypes?: Map<string, string>) => {
    if (node.name === "AttributeItem") {
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, owner, currentClass, inheritedTypes);
      return;
    }
    if (node.name === "UseDeclaration") {
      parseUse(node, owner?.node.id ?? path);
      return;
    }
    if (node.name === "ModItem") {
      const nameNode = node.getChild("BoundIdentifier");
      if (!nameNode) return;
      const name = syntax.text(nameNode);
      const declaration = node.getChild("DeclarationList");
      if (declaration) {
        const info = createSymbol({ name, kind: "class", owner, start: node.from, nameOffset: nameNode.from, end: node.to, namespace: true });
        result.symbols.push(info);
        classByLabel.set(info.node.label, info);
        for (let child = declaration.firstChild; child; child = child.nextSibling) visit(child, info, info, inheritedTypes);
        return;
      }
      const target = moduleFile(moduleDir ? `${moduleDir}/${name}` : name);
      if (target) bind(owner?.node.id ?? path, name, target, "*");
      return;
    }
    if (node.name === "StructItem" || node.name === "EnumItem" || node.name === "TraitItem") {
      const nameNode = node.getChild("TypeIdentifier");
      if (!nameNode) return;
      const info = createSymbol({ name: syntax.text(nameNode), kind: "class", owner, start: node.from, nameOffset: nameNode.from, end: node.to });
      result.symbols.push(info);
      classByLabel.set(info.node.label, info);
      if (node.name === "TraitItem") {
        for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, info, inheritedTypes);
      }
      return;
    }
    if (node.name === "ImplItem") {
      let target: SyntaxNode | null = null;
      let afterFor = false;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "for") afterFor = true;
        const candidate = child.name === "TypeIdentifier" ? child
          : child.name === "GenericType" ? child.getChild("TypeIdentifier")
            : null;
        if (!candidate) continue;
        if (afterFor) {
          target = candidate;
          break;
        }
        if (!target) target = candidate;
      }
      if (!target) return;
      const name = syntax.text(target);
      const label = owner ? `${owner.node.label}.${name}` : name;
      let info = classByLabel.get(label);
      if (!info) {
        info = createSymbol({ name, kind: "class", owner, start: node.from, nameOffset: target.from, end: node.to });
        result.symbols.push(info);
        classByLabel.set(label, info);
      }
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, info, inheritedTypes);
      return;
    }
    if (node.name === "FunctionItem") {
      const nameNode = node.getChild("BoundIdentifier");
      if (!nameNode) return;
      const types = new Map<string, string>();
      const names = parameters(node);
      parameterTypes(node, types);
      const info = createSymbol({
        name: syntax.text(nameNode),
        kind: "function",
        owner,
        start: node.from,
        nameOffset: nameNode.from,
        end: node.to,
        parameters: names,
      });
      result.symbols.push(info);
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, currentClass, types);
      return;
    }
    if (node.name === "ClosureExpression") {
      const assigned = node.parent?.name === "LetDeclaration" ? node.parent.getChild("BoundIdentifier") : null;
      const name = assigned ? syntax.text(assigned) : `<closure@${syntax.lineAt(node.from)}:${node.from - syntax.lineStarts[syntax.lineAt(node.from) - 1] + 1}>`;
      const types = new Map(inheritedTypes);
      const names: string[] = [];
      for (let child = node.getChild("ParamList")?.firstChild; child; child = child.nextSibling) {
        if (child.name !== "Parameter") continue;
        const parameter = child.getChild("BoundIdentifier");
        if (!parameter) continue;
        names.push(syntax.text(parameter));
        const type = findType(child);
        if (type) types.set(syntax.text(parameter), type);
      }
      const info = createSymbol({ name, kind: "function", owner, start: node.from, nameOffset: assigned?.from ?? node.from, end: node.to, parameters: names });
      result.symbols.push(info);
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, currentClass, types);
      return;
    }
    if (node.name === "LetDeclaration" && inheritedTypes) {
      const nameNode = node.getChild("BoundIdentifier");
      if (nameNode) {
        const type = node.getChild("TypeIdentifier") ?? node.getChild("GenericType");
        let resolved = typeName(type, syntax);
        if (!resolved) {
          const value = node.getChild("StructExpression")?.getChild("TypeIdentifier");
          resolved = value ? syntax.text(value) : undefined;
        }
        if (!resolved) {
          const call = node.getChild("CallExpression")?.firstChild;
          if (call?.name === "ScopedIdentifier") {
            const first = call.getChild("ScopeIdentifier");
            if (first) resolved = syntax.text(first);
          }
        }
        if (resolved) inheritedTypes.set(syntax.text(nameNode), resolved);
      }
    }
    if (node.name === "CallExpression" && owner) {
      const callee = node.firstChild;
      if (callee) {
        if (callee.name === "Identifier") {
          owner.calls.push(syntax.text(callee));
        } else if (callee.name === "FieldExpression") {
          const receiver = callee.firstChild;
          const member = callee.lastChild;
          if (receiver && member?.name === "FieldIdentifier") {
            let name: string | undefined;
            if (receiver.name === "Identifier") {
              const receiverName = syntax.text(receiver);
              name = receiverName === "self" ? `self.${syntax.text(member)}` : `${inheritedTypes?.get(receiverName) ?? receiverName}.${syntax.text(member)}`;
            } else {
              name = `${syntax.text(callee).replace(/\s+/g, "")}`;
            }
            if (name) owner.calls.push(name);
          }
        } else if (callee.name === "ScopedIdentifier") {
          const raw = syntax.text(callee).split("::").map((part) => part.trim()).filter((part) => part && !part.startsWith("<"));
          if (raw.length) {
            if (raw[0] === "Self" && currentClass) {
              owner.calls.push(`${currentClass.node.label}.${raw.slice(1).join(".")}`);
            } else if (raw.length > 1) {
              let bound = false;
              for (let split = raw.length - 1; split > 0; split--) {
                const target = resolveModule(raw.slice(0, split));
                if (!target) continue;
                const alias = raw[split - 1];
                bind(owner.node.id, alias, target, "*");
                owner.calls.push(`${alias}.${raw.slice(split).join(".")}`);
                bound = true;
                break;
              }
              if (!bound) owner.calls.push(raw.join("."));
            } else {
              owner.calls.push(raw[0]);
            }
          }
        }
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, owner, currentClass, inheritedTypes);
  };
  visit(top);

  for (const info of result.symbols) {
    if (info.node.kind === "function") info.calls = [...new Set(info.calls)];
  }
  return result;
}
