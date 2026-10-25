import { parser } from "@lezer/java";
import type { SyntaxNode } from "@lezer/common";
import type { FileAnalysis, SymbolInfo } from "./analyzer";
import { addImportEdge, symbolFactory, syntaxOf } from "./lezer";

const JAVA_ROOTS = new WeakMap<Set<string>, { roots: string[]; classes: Map<string, string[]> }>();
const ROOT_MARKERS = [["src", "main", "java"], ["src", "test", "java"], ["src", "main", "kotlin"], ["src", "test", "kotlin"], ["src"]];

function javaLayout(known: Set<string>) {
  const cached = JAVA_ROOTS.get(known);
  if (cached) return cached;
  const roots = new Set([""]);
  const classes = new Map<string, string[]>();
  for (const file of known) {
    if (!file.toLowerCase().endsWith(".java")) continue;
    const slash = file.lastIndexOf("/");
    const directory = slash === -1 ? "" : file.slice(0, slash);
    classes.set(directory, [...(classes.get(directory) ?? []), file]);
    const parts = directory ? directory.split("/") : [];
    for (const marker of ROOT_MARKERS) {
      for (let start = 0; start + marker.length <= parts.length; start++) {
        if (!marker.every((part, offset) => parts[start + offset] === part)) continue;
        roots.add(parts.slice(0, start + marker.length).join("/"));
        break;
      }
    }
  }
  for (const files of classes.values()) files.sort();
  const layout = { roots: [...roots].sort(), classes };
  JAVA_ROOTS.set(known, layout);
  return layout;
}

function baseType(node: SyntaxNode, syntax: ReturnType<typeof syntaxOf>): string | undefined {
  const value = syntax.text(node).trim();
  if (!value) return undefined;
  return value.replace(/<.*$/s, "").replace(/\[\]/g, "").split(".").pop();
}

export function analyzeJava(path: string, content: string, known: Set<string>): FileAnalysis {
  const syntax = syntaxOf(content);
  const result: FileAnalysis = { symbols: [], imports: [], edges: [] };
  const createSymbol = symbolFactory(path, syntax);
  const imported = new Set<string>();
  const top = parser.parse(content).topNode;
  const packageNode = top.getChild("PackageDeclaration")?.getChild("ScopedIdentifier");
  const packageName = packageNode ? syntax.text(packageNode) : "";
  if (packageName) result.namespace = packageName;

  const layout = javaLayout(known);
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const packagePath = packageName ? packageName.replace(/\./g, "/") : "";
  const roots = new Set(layout.roots);
  if (packagePath) {
    if (directory === packagePath) roots.add("");
    else if (directory.endsWith(`/${packagePath}`)) roots.add(directory.slice(0, -packagePath.length - 1));
  }
  const resolveClass = (dotted: string) => {
    const base = dotted.replace(/\./g, "/");
    for (const root of roots) {
      const candidate = root ? `${root}/${base}.java` : `${base}.java`;
      if (known.has(candidate)) return candidate;
    }
    return undefined;
  };
  const packageClasses = (value: string) => {
    const classes: string[] = [];
    for (const root of roots) {
      const dir = root ? `${root}/${value}` : value;
      classes.push(...(layout.classes.get(dir) ?? []));
    }
    return classes;
  };
  const bind = (scope: string, alias: string, file: string, name: string, parent?: string) => {
    result.imports.push({ scope, alias, file, name, ...(parent ? { parent } : {}) });
    addImportEdge(result, imported, path, file);
  };

  for (const declaration of top.getChildren("ImportDeclaration")) {
    let value = syntax.text(declaration).replace(/^import\s+/, "").replace(/;$/, "").trim();
    const isStatic = value.startsWith("static ");
    if (isStatic) value = value.slice("static ".length).trim();
    const wildcard = value.endsWith(".*");
    if (wildcard) value = value.slice(0, -2);
    const parts = value.split(".");
    if (!parts.length) continue;
    if (!isStatic) {
      if (wildcard) {
        for (const file of packageClasses(value)) {
          const name = file.slice(file.lastIndexOf("/") + 1, -".java".length);
          bind(path, name, file, name);
        }
        continue;
      }
      let file = resolveClass(value);
      let parent: string | undefined;
      let name = parts[parts.length - 1];
      if (!file && parts.length >= 3) {
        const outer = parts[parts.length - 2];
        file = resolveClass(parts.slice(0, -1).join("."));
        if (file) parent = outer;
      }
      if (file) bind(path, name, file, name, parent);
      continue;
    }
    if (wildcard) {
      const file = resolveClass(value);
      if (file) bind(path, "*", file, "*", parts[parts.length - 1]);
      continue;
    }
    if (parts.length < 2) continue;
    const member = parts[parts.length - 1];
    const classDotted = parts.slice(0, -1).join(".");
    const file = resolveClass(classDotted);
    if (file) bind(path, member, file, member, parts[parts.length - 2]);
  }

  const fieldTypes = (classNode: SyntaxNode): Map<string, string> => {
    const types = new Map<string, string>();
    const body = classNode.getChild("ClassBody") ?? classNode.getChild("InterfaceBody") ?? classNode.getChild("EnumBody") ?? classNode.getChild("RecordBody");
    for (const field of body?.getChildren("FieldDeclaration") ?? []) {
      const typeNode = field.getChild("TypeName") ?? field.getChild("PrimitiveType");
      const type = typeNode ? baseType(typeNode, syntax) : undefined;
      if (!type) continue;
      for (const declarator of field.getChildren("VariableDeclarator")) {
        const nameNode = declarator.getChild("Definition");
        if (nameNode) types.set(syntax.text(nameNode), type);
      }
    }
    return types;
  };
  const parameterTypes = (node: SyntaxNode, into: Map<string, string>) => {
    const names: string[] = [];
    const parameters = node.getChild("FormalParameters");
    for (const parameter of parameters?.getChildren("FormalParameter") ?? []) {
      const typeNode = parameter.getChild("TypeName") ?? parameter.getChild("PrimitiveType");
      const nameNode = parameter.getChild("Definition");
      if (!nameNode) continue;
      const name = syntax.text(nameNode);
      names.push(name);
      const type = typeNode ? baseType(typeNode, syntax) : undefined;
      if (type) into.set(name, type);
    }
    return names;
  };
  const receiverName = (node: SyntaxNode, types: Map<string, string>): string | undefined => {
    if (node.name === "ObjectCreationExpression") {
      const typeNode = node.getChild("TypeName");
      return typeNode ? baseType(typeNode, syntax) : undefined;
    }
    if (node.name === "Identifier") {
      const name = syntax.text(node);
      if (name === "this" || name === "super") return name;
      return types.get(name) ?? name;
    }
    if (node.name === "FieldAccess") {
      const value = syntax.text(node).replace(/\s+/g, "");
      if (value.startsWith("this.")) {
        const field = value.slice("this.".length);
        const type = types.get(field);
        if (type) return type;
      }
      return value;
    }
    return undefined;
  };
  const callName = (node: SyntaxNode, types: Map<string, string>): string | undefined => {
    const methodNode = node.getChild("MethodName");
    if (!methodNode) return undefined;
    const method = syntax.text(methodNode).trim();
    let receiver: SyntaxNode | null = null;
    for (let child = node.firstChild; child && child.from !== methodNode.from; child = child.nextSibling) {
      if (child.name !== ".") receiver = child;
    }
    if (!receiver) return method;
    const name = receiverName(receiver, types);
    return name ? `${name}.${method}` : undefined;
  };

  const localTypes = (node: SyntaxNode, types: Map<string, string>) => {
    const typeNode = node.getChild("TypeName") ?? node.getChild("PrimitiveType");
    let type = typeNode ? baseType(typeNode, syntax) : undefined;
    for (const declarator of node.getChildren("VariableDeclarator")) {
      const nameNode = declarator.getChild("Definition");
      if (!nameNode) continue;
      if (!type) {
        const created = declarator.getChild("ObjectCreationExpression")?.getChild("TypeName");
        type = created ? baseType(created, syntax) : undefined;
      }
      if (type) types.set(syntax.text(nameNode), type);
    }
  };

  const visit = (node: SyntaxNode, owner?: SymbolInfo, inheritedTypes?: Map<string, string>) => {
    if (["ClassDeclaration", "InterfaceDeclaration", "EnumDeclaration", "RecordDeclaration", "AnnotationTypeDeclaration"].includes(node.name)) {
      const nameNode = node.getChild("Definition");
      if (!nameNode) return;
      const info = createSymbol({
        name: syntax.text(nameNode),
        kind: "class",
        owner,
        start: node.from,
        nameOffset: nameNode.from,
        end: node.to,
      });
      result.symbols.push(info);
      const types = new Map(inheritedTypes);
      for (const [name, type] of fieldTypes(node)) types.set(name, type);
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, types);
      return;
    }
    if (node.name === "MethodDeclaration" || node.name === "ConstructorDeclaration") {
      const nameNode = node.getChild("Definition");
      const name = node.name === "ConstructorDeclaration" ? "constructor" : nameNode ? syntax.text(nameNode) : "";
      if (!name) return;
      const types = new Map(inheritedTypes);
      const parameters = parameterTypes(node, types);
      const info = createSymbol({
        name,
        kind: "function",
        owner,
        start: node.from,
        nameOffset: nameNode?.from ?? node.from,
        end: node.to,
        parameters,
      });
      result.symbols.push(info);
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, types);
      return;
    }
    if (node.name === "LambdaExpression") {
      const parent = node.parent?.name === "VariableDeclarator" ? node.parent : undefined;
      const assigned = parent?.getChild("Definition");
      const name = assigned ? syntax.text(assigned) : `<lambda@${syntax.lineAt(node.from)}:${node.from - syntax.lineStarts[syntax.lineAt(node.from) - 1] + 1}>`;
      const types = new Map(inheritedTypes);
      const parameters: string[] = [];
      const formal = node.getChild("FormalParameters");
      if (formal) {
        for (const parameter of formal.getChildren("FormalParameter")) {
          const parameterName = parameter.getChild("Definition");
          if (!parameterName) continue;
          parameters.push(syntax.text(parameterName));
          const typeNode = parameter.getChild("TypeName") ?? parameter.getChild("PrimitiveType");
          const type = typeNode ? baseType(typeNode, syntax) : undefined;
          if (type) types.set(syntax.text(parameterName), type);
        }
      } else {
        for (const parameter of node.getChildren("Definition")) parameters.push(syntax.text(parameter));
      }
      const info = createSymbol({ name, kind: "function", owner, start: node.from, nameOffset: assigned?.from ?? node.from, end: node.to, parameters });
      result.symbols.push(info);
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info, types);
      return;
    }
    if (node.name === "MethodInvocation" && owner) {
      const name = callName(node, inheritedTypes ?? new Map());
      if (name) owner.calls.push(name);
    }
    if (node.name === "ObjectCreationExpression" && owner) {
      const typeNode = node.getChild("TypeName");
      const type = typeNode ? baseType(typeNode, syntax) : undefined;
      if (type) owner.calls.push(type);
    }
    if (node.name === "LocalVariableDeclaration" && inheritedTypes) localTypes(node, inheritedTypes);
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, owner, inheritedTypes);
  };
  visit(top);

  const functionsByOwner = new Map<string, SymbolInfo[]>();
  for (const info of result.symbols) {
    if (info.node.kind !== "function") continue;
    functionsByOwner.set(info.parentId, [...(functionsByOwner.get(info.parentId) ?? []), info]);
  }
  for (const methods of functionsByOwner.values()) {
    const siblings = new Set(methods.map((info) => info.node.label.split(".").pop()));
    for (const method of methods) {
      method.calls = [...new Set(method.calls.map((call) => !call.includes(".")
        && siblings.has(call) && !method.parameters.includes(call) ? `this.${call}` : call))];
    }
  }
  return result;
}
