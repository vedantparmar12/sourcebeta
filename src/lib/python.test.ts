import { describe, expect, it } from "vitest";
import { analyzePython } from "./python";

const path = "pkg/a.py";
const analyze = (content: string, files: string[] = []) => analyzePython(path, content, new Set([path, ...files]));

describe("analyzePython", () => {
  it("extracts decorated async methods, nested classes, and every nested function with source ranges", () => {
    const result = analyze([
      "@registered",
      "class Outer:",
      "    @cached(",
      "        ttl=10",
      "    )",
      "    async def method(self, handler, /, *args, flag=True, **kwargs):",
      "        await handler()",
      "        def inner(value: int = 1):",
      "            return helper(value)",
      "        if flag:",
      "            class Local:",
      "                def run(self):",
      "                    return inner(2)",
      "        return inner(1)",
      "    ",
      "",
    ].join("\n"));
    expect(result.symbols.map(({ node, parentId }) => [node.id, parentId, node.kind, node.line, node.startLine, node.endLine])).toEqual([
      [`${path}#Outer`, path, "class", 2, 1, 14],
      [`${path}#Outer.method`, `${path}#Outer`, "function", 6, 3, 14],
      [`${path}#Outer.method.inner`, `${path}#Outer.method`, "function", 8, 8, 9],
      [`${path}#Outer.method.Local`, `${path}#Outer.method`, "class", 11, 11, 13],
      [`${path}#Outer.method.Local.run`, `${path}#Outer.method.Local`, "function", 12, 12, 13],
    ]);
    expect(result.symbols[1].parameters).toEqual(["self", "handler", "args", "flag", "kwargs"]);
    expect(result.symbols.map(({ calls }) => calls)).toEqual([[], ["cached", "handler", "inner"], ["helper"], [], ["inner"]]);
    expect(result.edges).toEqual([]);
  });

  it("preserves property accessors and their nested definitions with distinct IDs, but unsuffixed labels", () => {
    const result = analyze([
      "class Outer:",
      "    @property",
      "    def value(self):",
      "        def inner(): return read()",
      "        return inner()",
      "    @value.setter",
      "    def value(self, item):",
      "        def inner(): return write(item)",
      "        inner()",
    ].join("\n"));
    expect(result.symbols.map(({ node }) => node.id)).toEqual([
      `${path}#Outer`, `${path}#Outer.value`, `${path}#Outer.value.inner`,
      `${path}#Outer.value@7`, `${path}#Outer.value.inner@8`,
    ]);
    expect(result.symbols[3].node.label).toBe("Outer.value");
    expect(result.symbols[3].node.startLine).toBe(6);
    expect(result.symbols[4].parentId).toBe(`${path}#Outer.value@7`);
    expect(result.symbols[4].node.label).toBe("Outer.value.inner");
  });

  it("discovers duplicate definitions inside conditional and exception bodies", () => {
    const result = analyze([
      "if enabled:",
      "    def choose(): return first()",
      "else:",
      "    def choose(): return second()",
      "try:",
      "    class Option: pass",
      "except Error:",
      "    class Option: pass",
    ].join("\n"));
    expect(result.symbols.map(({ node }) => node.id)).toEqual([
      `${path}#choose`, `${path}#choose@4`, `${path}#Option`, `${path}#Option@8`,
    ]);
    expect(result.symbols.every(({ parentId }) => parentId === path)).toBe(true);
  });

  it("names assigned lambdas and retains anonymous and nested lambdas without leaking calls", () => {
    const result = analyze([
      "named = lambda fn: fn()",
      "annotated: object = (lambda *args, **kwargs: invoke())",
      "class Holder:",
      "    callback = lambda self: self.work()",
      "def enclosing(fn):",
      "    local = lambda value=default: value()",
      "    consume(lambda item: item.run())",
      "    return lambda outer: (lambda inner: target(inner))",
    ].join("\n"));
    expect(result.symbols.map(({ node }) => node.label)).toEqual([
      "named", "annotated", "Holder", "Holder.callback", "enclosing", "enclosing.local",
      "enclosing.<lambda@7:13>", "enclosing.<lambda@8:12>", "enclosing.<lambda@8:12>.<lambda@8:27>",
    ]);
    expect(result.symbols[0].parameters).toEqual(["fn"]);
    expect(result.symbols[1].parameters).toEqual(["args", "kwargs"]);
    expect(result.symbols[3].parentId).toBe(`${path}#Holder`);
    expect(result.symbols[4].calls).toEqual(["consume"]);
    expect(result.symbols[5].parameters).toEqual(["value"]);
    expect(result.symbols[5].calls).toEqual(["value"]);
    expect(result.symbols[7].calls).toEqual([]);
    expect(result.symbols[8].calls).toEqual(["target"]);
    expect(result.symbols[8].parentId).toBe(result.symbols[7].node.id);
  });

  it("distinguishes lambdas on the same line and avoids borrowing container assignment names", () => {
    const result = analyze([
      "one = lambda: a(); one = lambda: b(); one = lambda: c()",
      "slots = [lambda: left(), lambda: right()]",
      "assigned = alias = lambda: shared()",
      "if (predicate := lambda x: x()): pass",
      "obj.callback = lambda: ready()",
    ].join("\n"));
    const ids = result.symbols.map(({ node }) => node.id);
    expect(new Set(ids).size).toBe(8);
    expect(ids.slice(0, 3)).toEqual([`${path}#one`, `${path}#one@1`, `${path}#one@1:45`]);
    expect(result.symbols[3].node.label).toBe("<lambda@2:10>");
    expect(result.symbols[4].node.label).toBe("<lambda@2:26>");
    expect(result.symbols[5].node.label).toBe("assigned");
    expect(result.symbols[6].node.label).toBe("predicate");
    expect(result.symbols[7].node.label).toBe("callback");
  });

  it("collects only parameter names, including positional-only, keyword-only, and variadic names", () => {
    const result = analyze([
      "def run(callback=default_callback, /, value: Factory = fallback, *args, option: Type = Factory(), **kwargs):",
      "    callback()",
      "    value()",
      "    option()",
      "    kwargs.run()",
      "    local = lambda item=fallback, *rest, only=default, **options: item()",
    ].join("\n"));
    expect(result.symbols[0].parameters).toEqual(["callback", "value", "args", "option", "kwargs"]);
    expect(result.symbols[1].parameters).toEqual(["item", "rest", "only", "options"]);
    expect(result.symbols[0].calls).toEqual(["Factory", "callback", "value", "option", "kwargs.run"]);
    expect(result.symbols[1].calls).toEqual(["item"]);
  });

  it("collects dotted receiver calls without inventing names for dynamic receivers", () => {
    const result = analyze([
      "class Worker:",
      "    def run(self, cls, arbitrary):",
      "        helper()",
      "        helper()",
      "        self.work()",
      "        cls.make()",
      "        module.fn()",
      "        pkg.module.fn()",
      "        arbitrary.work()",
      "        factory().work()",
      "        items[0]()",
      "        self['work']()",
      "        (wrapped)()",
    ].join("\n"));
    expect(result.symbols[0].calls).toEqual([]);
    expect(result.symbols[1].calls).toEqual([
      "helper", "self.work", "cls.make", "module.fn", "pkg.module.fn", "arbitrary.work", "factory", "wrapped",
    ]);
  });

  it("isolates nested bodies and discovers lambdas inside decorators and defaults", () => {
    const result = analyze([
      "def outer():",
      "    before()",
      "    @decorate(factory(lambda: decorated_body()))",
      "    def inner(arg=lambda: default_body()):",
      "        inside()",
      "    class Local:",
      "        class_body()",
      "        def method(self): method_body()",
      "    after()",
    ].join("\n"));
    const byLabel = new Map(result.symbols.map((symbol) => [symbol.node.label, symbol]));
    expect(byLabel.get("outer")?.calls).toEqual(["before", "after"]);
    expect(byLabel.get("outer.inner")?.calls).toEqual(["decorate", "factory", "inside"]);
    expect(byLabel.get("outer.Local")?.calls).toEqual(["class_body"]);
    expect(byLabel.get("outer.Local.method")?.calls).toEqual(["method_body"]);
    expect(result.symbols.filter(({ node }) => node.label.includes("<lambda@")).map(({ calls }) => calls)).toEqual([
      ["decorated_body"], ["default_body"],
    ]);
  });

  it("keeps accurate ranges with CRLF, multiline signatures, blank lines, and no final newline", () => {
    const result = analyze([
      "@first",
      "@second()",
      "async def run(",
      "    callback,",
      "):",
      "    callback()",
      "",
      "",
      "def final(): pass",
    ].join("\r\n"));
    expect(result.symbols.map(({ node }) => [node.line, node.startLine, node.endLine])).toEqual([[3, 1, 6], [9, 9, 9]]);
  });

  it("ignores definitions and calls in comments and strings", () => {
    const result = analyze('# def fake(): phantom()\ntext = "class Fake: pass"\ndef real():\n    """def also_fake(): not_a_call()"""\n    return "helper()"\n');
    expect(result.symbols.map(({ node }) => node.label)).toEqual(["real"]);
    expect(result.symbols[0].calls).toEqual([]);
    expect(analyze("")).toEqual({ symbols: [], imports: [], edges: [] });
  });

  it("resolves multiline relative imports, aliases, submodules, parent packages, and lexical scopes", () => {
    const file = "pkg/feature/main.py";
    const result = analyzePython(file, [
      "from .helpers import (",
      "    helper as renamed, # a comment between imported names",
      "    other,",
      ")",
      "from .x import y as child",
      "from . import worker",
      "from ..shared import tool",
      "def outer():",
      "    from .helpers import local as call_local",
      "    def inner():",
      "        import localmod as lm",
    ].join("\n"), new Set([
      file, "pkg/feature/helpers.py", "pkg/feature/x.py", "pkg/feature/x/y.py",
      "pkg/feature/worker/__init__.py", "pkg/shared/__init__.py", "localmod.py",
    ]));
    expect(result.imports).toEqual([
      { scope: file, alias: "renamed", file: "pkg/feature/helpers.py", name: "helper" },
      { scope: file, alias: "other", file: "pkg/feature/helpers.py", name: "other" },
      { scope: file, alias: "child", file: "pkg/feature/x/y.py", name: "*" },
      { scope: file, alias: "worker", file: "pkg/feature/worker/__init__.py", name: "*" },
      { scope: file, alias: "tool", file: "pkg/shared/__init__.py", name: "tool" },
      { scope: `${file}#outer`, alias: "call_local", file: "pkg/feature/helpers.py", name: "local" },
      { scope: `${file}#outer.inner`, alias: "lm", file: "localmod.py", name: "*" },
    ]);
    expect(result.edges).toEqual([
      "pkg/feature/helpers.py", "pkg/feature/x/y.py", "pkg/feature/worker/__init__.py", "pkg/shared/__init__.py", "localmod.py",
    ].map((target) => ({ source: file, target, type: "imports", confidence: "EXTRACTED" })));
  });

  it("resolves modules and package initializers, retaining namespace bindings and wildcard imports", () => {
    const result = analyze([
      "import helpers as local, pkg.tools as tools",
      "import pkg.tools",
      "import pkg",
      "from pkg import tools as submodule, exported",
      "from pkg import *",
    ].join("\n"), ["helpers.py", "pkg/__init__.py", "pkg/tools.py"]);
    expect(result.imports).toEqual([
      { scope: path, alias: "local", file: "helpers.py", name: "*" },
      { scope: path, alias: "tools", file: "pkg/tools.py", name: "*" },
      { scope: path, alias: "pkg.tools", file: "pkg/tools.py", name: "*" },
      { scope: path, alias: "pkg", file: "pkg/__init__.py", name: "*" },
      { scope: path, alias: "submodule", file: "pkg/tools.py", name: "*" },
      { scope: path, alias: "exported", file: "pkg/__init__.py", name: "exported" },
      { scope: path, alias: "*", file: "pkg/__init__.py", name: "*" },
    ]);
    expect(result.edges).toHaveLength(3);
  });

  it("prefers imported child modules or packages over symbols in the parent module", () => {
    const result = analyze("from .x import y, z, value\n", ["pkg/x.py", "pkg/x/y.py", "pkg/x/z/__init__.py"]);
    expect(result.imports.map(({ alias, file, name }) => [alias, file, name])).toEqual([
      ["y", "pkg/x/y.py", "*"], ["z", "pkg/x/z/__init__.py", "*"], ["value", "pkg/x.py", "value"],
    ]);
  });

  it("supports continued import lines and three-dot relative imports", () => {
    const file = "pkg/sub/deeper/main.py";
    const result = analyzePython(file, "from ...helpers import first as f, \\\n    second as s\n", new Set(["pkg/helpers.py"]));
    expect(result.imports).toEqual([
      { scope: file, alias: "f", file: "pkg/helpers.py", name: "first" },
      { scope: file, alias: "s", file: "pkg/helpers.py", name: "second" },
    ]);
    expect(result.edges).toHaveLength(1);
  });

  it("resolves relative imports from package initializers without falling back to unrelated roots", () => {
    const result = analyzePython("pkg/__init__.py", "from .child import thing\nfrom .missing import other\nfrom ...child import impossible\n", new Set(["pkg/child.py", "missing.py", "child.py"]));
    expect(result.imports).toEqual([{ scope: "pkg/__init__.py", alias: "thing", file: "pkg/child.py", name: "thing" }]);
  });

  it("supports root src layouts and package-marker-derived import roots", () => {
    const src = analyzePython("tests/test_main.py", "from pkg import service\nimport pkg.tools as tools\nimport util\n", new Set([
      "src/pkg/__init__.py", "src/pkg/service.py", "src/pkg/tools/__init__.py", "src/util.py",
    ]));
    expect(src.imports.map(({ file }) => file)).toEqual(["src/pkg/service.py", "src/pkg/tools/__init__.py", "src/util.py"]);
    const packaged = analyzePython("project/pkg/sub/main.py", "import pkg.service as service\n", new Set([
      "project/pkg/__init__.py", "project/pkg/sub/__init__.py", "project/pkg/service.py",
    ]));
    expect(packaged.imports[0]).toEqual({ scope: "project/pkg/sub/main.py", alias: "service", file: "project/pkg/service.py", name: "*" });
    const nestedSrc = analyzePython("project/src/pkg/main.py", "import pkg.service as service\n", new Set(["project/src/pkg/service.py"]));
    expect(nestedSrc.imports[0]?.file).toBe("project/src/pkg/service.py");
  });

  it("resolves stub modules and stub package initializers", () => {
    const result = analyze("from .types import Item\nfrom .stubs import Service\n", ["pkg/types.pyi", "pkg/stubs/__init__.pyi"]);
    expect(result.imports.map(({ file, name }) => [file, name])).toEqual([
      ["pkg/types.pyi", "Item"], ["pkg/stubs/__init__.pyi", "Service"],
    ]);
    const definitions = analyzePython("pkg/types.pyi", "class Item:\n    def get(self) -> str: ...\n", new Set());
    expect(definitions.symbols.map(({ node }) => node.label)).toEqual(["Item", "Item.get"]);
  });

  it("does not guess external packages or arbitrary same-basename files", () => {
    const result = analyze([
      "import os, requests as network",
      "from numpy import array",
      "from missing import helper",
      "import helper",
      "from .unknown import work",
    ].join("\n"), ["unrelated/os.py", "vendor/requests/__init__.py", "pkg/helper.py", "other/unknown.py"]);
    expect(result.imports).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});
