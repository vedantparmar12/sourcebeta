import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import type { FileAnalysis, SymbolInfo } from "./analyzer";

export function analyzePython(path: string, content: string, known: Set<string>): FileAnalysis {
  const result: FileAnalysis = { symbols: [], imports: [], edges: [] };
  const ids = new Set<string>();
  const importedFiles = new Set<string>();
  const lineStarts = [0];
  for (const match of content.matchAll(/\r\n|\r|\n/g)) lineStarts.push(match.index + match[0].length);
  const text = (node: SyntaxNode) => content.slice(node.from, node.to);
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

  const directory = path.split("/").slice(0, -1);
  const roots = [""];
  // Package markers identify import roots without guessing unrelated basenames.
  const packageRoot = [...directory];
  while (packageRoot.length && [".py", ".pyi"].some(ext => known.has(`${packageRoot.join("/")}/__init__${ext}`))) packageRoot.pop();
  if (packageRoot.length < directory.length) roots.push(packageRoot.join("/"));
  const srcIndex = directory.lastIndexOf("src");
  if (srcIndex !== -1) roots.push(directory.slice(0, srcIndex + 1).join("/"));
  roots.push("src");
  const absoluteRoots = [...new Set(roots)];
  const join = (left: string, right: string) => left && right ? `${left}/${right}` : left || right;
  const moduleFile = (base: string) => [base && `${base}.py`, base && `${base}.pyi`, join(base, "__init__.py"), join(base, "__init__.pyi")]
    .find((candidate): candidate is string => !!candidate && known.has(candidate));
  const moduleBases = (specifier: string) => {
    const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
    const modulePath = specifier.slice(dots).replace(/\./g, "/");
    if (!dots) return absoluteRoots.map((root) => join(root, modulePath));
    if (dots - 1 > directory.length) return [];
    return [join(directory.slice(0, directory.length - dots + 1).join("/"), modulePath)];
  };
  const bindImport = (scope: string, alias: string, file: string, name: string) => {
    result.imports.push({ scope, alias, file, name });
    if (importedFiles.has(file)) return;
    importedFiles.add(file);
    result.edges.push({ source: path, target: file, type: "imports", confidence: "EXTRACTED" });
  };
  const readImport = (node: SyntaxNode, scope: string) => {
    const tokens: string[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (["VariableName", ".", "Ellipsis", "*", "from", "import", "as", ","].includes(child.name)) {
        tokens.push(text(child));
      }
    }
    const importIndex = tokens.indexOf("import");
    if (importIndex < 0) return;
    const from = tokens[0] === "from" ? tokens.slice(1, importIndex).join("") : null;
    const groups: string[][] = [[]];
    for (const token of tokens.slice(importIndex + 1)) {
      if (token === ",") groups.push([]);
      else groups[groups.length - 1].push(token);
    }
    for (const group of groups) {
      if (!group.length) continue;
      const asIndex = group.indexOf("as");
      const name = (asIndex < 0 ? group : group.slice(0, asIndex)).join("");
      const alias = asIndex < 0 ? name : group[asIndex + 1];
      if (!name || !alias) continue;
      for (const base of moduleBases(from ?? name)) {
        // A from-import may name a submodule rather than a symbol in its parent.
        const childFile = from !== null && name !== "*" ? moduleFile(join(base, name.replace(/\./g, "/"))) : undefined;
        const file = childFile ?? moduleFile(base);
        if (!file) continue;
        bindImport(scope, alias, file, from === null || childFile ? "*" : name);
        break;
      }
    }
  };

  const dottedName = (node: SyntaxNode | null): string | undefined => {
    if (!node) return undefined;
    if (node.name === "VariableName") return text(node);
    if (node.name === "ParenthesizedExpression") return dottedName(node.firstChild?.nextSibling ?? null);
    if (node.name !== "MemberExpression" || node.firstChild?.nextSibling?.name !== ".") return undefined;
    const receiver = dottedName(node.firstChild);
    const property = node.lastChild;
    return receiver && property?.name === "PropertyName" ? `${receiver}.${text(property)}` : undefined;
  };
  const lambdaName = (node: SyntaxNode) => {
    let value = node;
    while (value.parent?.name === "ParenthesizedExpression") value = value.parent;
    const assignment = value.parent;
    if ((assignment?.name === "AssignStatement" || assignment?.name === "NamedExpression") && value.prevSibling?.name === "AssignOp") {
      // Tuple unpacking and lambdas inside containers do not have one clear name.
      let simple = true;
      for (let target = assignment.firstChild; target && target.from < value.from; target = target.nextSibling) {
        if (!["VariableName", "MemberExpression", "AssignOp", "TypeDef", "Comment"].includes(target.name)) simple = false;
      }
      const assignedName = simple ? dottedName(assignment.firstChild) : undefined;
      if (assignedName) return assignedName.split(".").pop()!;
    }
    const line = lineAt(node.from);
    return `<lambda@${line}:${node.from - lineStarts[line - 1] + 1}>`;
  };
  const parameters = (node: SyntaxNode) => {
    const names: string[] = [];
    let expectingName = true;
    for (let child = node.getChild("ParamList")?.firstChild; child; child = child.nextSibling) {
      if (child.name === ",") expectingName = true;
      else if (child.name === "AssignOp") expectingName = false;
      else if (child.name === "VariableName" && expectingName) {
        names.push(text(child));
        expectingName = false;
      }
    }
    return names;
  };

  const visit = (node: SyntaxNode, owner?: SymbolInfo) => {
    if (node.name === "DecoratedStatement") {
      // Attribute decorator calls to the decorated symbol, not its enclosing function.
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== "Decorator") visit(child, owner);
      }
      return;
    }
    if (["FunctionDefinition", "ClassDefinition", "LambdaExpression"].includes(node.name)) {
      const isLambda = node.name === "LambdaExpression";
      const nameNode = node.getChild("VariableName");
      const line = lineAt(isLambda ? node.from : nameNode?.from ?? node.from);
      const name = isLambda ? lambdaName(node) : nameNode ? text(nameNode) : `<anonymous@${line}>`;
      const qualified = owner ? `${owner.node.label}.${name}` : name;
      const baseId = `${path}#${qualified}`;
      let id = ids.has(baseId) ? `${baseId}@${line}` : baseId;
      // Several assigned lambdas can share a physical line.
      if (ids.has(id)) id += `:${node.from - lineStarts[line - 1] + 1}`;
      ids.add(id);
      let last = node.to - 1;
      while (last > node.from && /\s/.test(content[last])) last--;
      const decorated = node.parent?.name === "DecoratedStatement" ? node.parent : null;
      const info: SymbolInfo = {
        node: {
          id,
          label: qualified,
          kind: node.name === "ClassDefinition" ? "class" : "function",
          file: path,
          line,
          startLine: decorated ? lineAt(decorated.from) : line,
          endLine: lineAt(Math.max(node.from, last)),
        },
        parentId: owner?.node.id ?? path,
        calls: [],
        parameters: node.name === "ClassDefinition" ? [] : parameters(node),
      };
      result.symbols.push(info);
      if (decorated) {
        for (let child = decorated.firstChild; child; child = child.nextSibling) {
          if (child.name === "Decorator") visit(child, info);
        }
      }
      // Nested bodies must not leak calls into their enclosing symbol.
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child, info);
      info.calls = [...new Set(info.calls)];
      return;
    }
    if (node.name === "ImportStatement") readImport(node, owner?.node.id ?? path);
    if (node.name === "CallExpression" && owner) {
      const name = dottedName(node.firstChild);
      if (name) owner.calls.push(name);
    }
    // Lezer uses Decorator + ArgList rather than CallExpression for invoked decorators.
    if (node.name === "Decorator" && node.getChild("ArgList") && owner) {
      owner.calls.push(node.getChildren("VariableName").map(text).join("."));
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, owner);
  };
  visit(parser.parse(content).topNode);
  return result;
}
