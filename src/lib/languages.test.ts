import { describe, expect, it } from "vitest";
import { analyzeProject } from "./analyzer";
import type { KnowledgeGraph } from "./types";

function project(files: Record<string, string>): KnowledgeGraph {
  return analyzeProject(Object.entries(files).map(([path, content]) => ({ path, content })));
}

function calls(graph: KnowledgeGraph, source: string) {
  return graph.edges.filter((edge) => edge.type === "calls" && edge.source === source);
}

function targets(graph: KnowledgeGraph, source: string) {
  return calls(graph, source).map((edge) => edge.target);
}

describe("Java analysis", () => {
  it("extracts classes, lambdas, sibling calls and typed receivers", () => {
    const graph = project({
      "A.java": `class A {
  Worker field = new Worker();
  Runnable task = () -> helper();
  void run(Worker param) {
    Worker local = new Worker();
    var inferred = new Worker();
    local.work();
    param.work();
    this.field.work();
    helper();
  }
  void helper() {}
}
`,
    });
    const ids = graph.nodes.map((node) => node.id);
    expect(ids).toContain("A.java#A");
    expect(ids).toContain("A.java#A.run");
    expect(ids).toContain("A.java#A.helper");
    expect(ids).toContain("A.java#A.task");
    expect(targets(graph, "A.java#A.run")).toContain("A.java#A.helper");
    expect(targets(graph, "A.java#A.task")).toContain("A.java#A.helper");
    expect(calls(graph, "A.java#A.run").every((edge) => edge.confidence === "EXTRACTED")).toBe(true);
  });

  it("resolves same-package types and static imports", () => {
    const graph = project({
      "src/main/java/com/app/Worker.java": "package com.app;\npublic class Worker {\n  public void work() {}\n}\n",
      "src/main/java/com/app/Util.java": "package com.app;\npublic class Util {\n  public static void helper() {}\n}\n",
      "src/main/java/com/app/Main.java": `package com.app;
import static com.app.Util.helper;
class Main {
  void run() {
    Worker worker = new Worker();
    worker.work();
    helper();
  }
}
`,
    });
    expect(targets(graph, "src/main/java/com/app/Main.java#Main.run")).toEqual([
      "src/main/java/com/app/Worker.java#Worker",
      "src/main/java/com/app/Worker.java#Worker.work",
      "src/main/java/com/app/Util.java#Util.helper",
    ]);
    expect(calls(graph, "src/main/java/com/app/Main.java#Main.run").every((edge) => edge.confidence === "EXTRACTED")).toBe(true);
  });

  it("resolves explicit and wildcard imports", () => {
    const graph = project({
      "src/main/java/com/app/Worker.java": "package com.app;\npublic class Worker {\n  public void work() {}\n}\n",
      "src/main/java/com/app/Main.java": "package com.app;\nimport com.app.Worker;\nclass Main {\n  void run(Worker worker) {\n    worker.work();\n  }\n}\n",
      "src/main/java/com/app/Other.java": "package com.app;\nimport com.app.*;\nclass Other {\n  void run(Worker worker) {\n    worker.work();\n  }\n}\n",
    });
    expect(targets(graph, "src/main/java/com/app/Main.java#Main.run")).toContain("src/main/java/com/app/Worker.java#Worker.work");
    expect(targets(graph, "src/main/java/com/app/Other.java#Other.run")).toContain("src/main/java/com/app/Worker.java#Worker.work");
    expect(graph.edges).toContainEqual({ source: "src/main/java/com/app/Main.java", target: "src/main/java/com/app/Worker.java", type: "imports", confidence: "EXTRACTED" });
  });
});

describe("Rust analysis", () => {
  it("resolves impl methods, Self calls and closures", () => {
    const graph = project({
      "src/lib.rs": `pub struct Service<T> { value: T }
impl<T> Service<T> {
    pub fn new(value: T) -> Self { Self { value } }
    pub fn run(&self) {
        self.new(1);
        Service::<T>::new(2);
        let callback = |x: i32| helper(x);
    }
}
fn helper(x: i32) -> i32 { x }
`,
    });
    const ids = graph.nodes.map((node) => node.id);
    expect(ids).toContain("src/lib.rs#Service");
    expect(ids).toContain("src/lib.rs#Service.new");
    expect(ids).toContain("src/lib.rs#Service.run");
    expect(targets(graph, "src/lib.rs#Service.run")).toContain("src/lib.rs#Service.new");
    expect(targets(graph, "src/lib.rs#Service.run.callback")).toContain("src/lib.rs#helper");
  });

  it("resolves mod declarations and crate-qualified calls across files", () => {
    const graph = project({
      "src/lib.rs": "mod worker;\n\nfn main() {\n    worker::run();\n}\n\nfn helper() {}\n",
      "src/worker.rs": "pub fn run() {\n    crate::helper();\n}\n",
    });
    expect(targets(graph, "src/lib.rs#main")).toContain("src/worker.rs#run");
    expect(targets(graph, "src/worker.rs#run")).toContain("src/lib.rs#helper");
    expect(graph.edges).toContainEqual({ source: "src/lib.rs", target: "src/worker.rs", type: "imports", confidence: "EXTRACTED" });
  });

  it("resolves use trees and aliases", () => {
    const graph = project({
      "src/lib.rs": "mod worker;\nuse crate::worker::{run as start, helper};\n\nfn main() {\n    start();\n    helper();\n}\n",
      "src/worker.rs": "pub fn run() {}\npub fn helper() {}\n",
    });
    expect(targets(graph, "src/lib.rs#main")).toEqual(["src/worker.rs#run", "src/worker.rs#helper"]);
  });
});

describe("Go analysis", () => {
  it("owns methods by receiver type and infers constructor results", () => {
    const graph = project({
      "svc/service.go": `package svc

type Service struct{}

func (s *Service) Run() {
}

func NewService() *Service {
	return &Service{}
}

func Start() {
	made := NewService()
	made.Run()
	helper()
}

func helper() {
}
`,
    });
    expect(graph.nodes.map((node) => node.id)).toContain("svc/service.go#Service.Run");
    expect(targets(graph, "svc/service.go#Start")).toEqual([
      "svc/service.go#NewService",
      "svc/service.go#Service.Run",
      "svc/service.go#helper",
    ]);
  });

  it("resolves same-package calls across files as extracted", () => {
    const graph = project({
      "svc/service.go": "package svc\n\nfunc helper() {}\n",
      "svc/other.go": "package svc\n\nfunc Other() {\n\thelper()\n}\n",
    });
    expect(calls(graph, "svc/other.go#Other")).toEqual([
      { source: "svc/other.go#Other", target: "svc/service.go#helper", type: "calls", confidence: "EXTRACTED" },
    ]);
  });

  it("infers constructor returns across files in the same package", () => {
    const graph = project({
      "svc/service.go": "package svc\n\ntype Service struct{}\n\nfunc (s *Service) Run() {}\n\nfunc NewService() *Service { return &Service{} }\n",
      "svc/start.go": "package svc\n\nfunc Start() {\n\tservice := NewService()\n\tservice.Run()\n}\n",
    });
    expect(calls(graph, "svc/start.go#Start")).toContainEqual({
      source: "svc/start.go#Start", target: "svc/service.go#Service.Run", type: "calls", confidence: "EXTRACTED",
    });
  });

  it("resolves package imports and dot imports", () => {
    const files = {
      "helpers/helpers.go": "package helpers\n\nfunc Helper() {}\n",
      "app/main.go": "package app\n\nimport \"example.com/app/helpers\"\n\nfunc main() {\n\thelpers.Helper()\n}\n",
      "app/dot.go": "package app\n\nimport . \"example.com/app/helpers\"\n\nfunc dot() {\n\tHelper()\n}\n",
    };
    const graph = project(files);
    expect(targets(graph, "app/main.go#main")).toContain("helpers/helpers.go#Helper");
    expect(targets(graph, "app/dot.go#dot")).toContain("helpers/helpers.go#Helper");
    expect(graph.edges).toContainEqual({ source: "app/main.go", target: "helpers/helpers.go", type: "imports", confidence: "EXTRACTED" });
  });
});

describe("C and C++ analysis", () => {
  it("merges C prototypes with definitions and follows includes", () => {
    const graph = project({
      "main.c": `#include <stdio.h>
#include "helpers.h"
#define MAX 10
struct Point { int x; int y; };
static int helper(int value);
int run(struct Point *point) {
  helper(point->x);
  shared(1);
  return 0;
}
static int helper(int value) { return value + MAX; }
`,
      "helpers.h": "int shared(int value);\n",
    });
    const helpers = graph.nodes.filter((node) => node.id.startsWith("main.c#helper"));
    expect(helpers).toHaveLength(1);
    expect(helpers[0].startLine).toBe(11);
    expect(graph.nodes.map((node) => node.id)).toContain("main.c#Point");
    expect(targets(graph, "main.c#run")).toEqual(["main.c#helper", "helpers.h#shared"]);
    expect(graph.edges).toContainEqual({ source: "main.c", target: "helpers.h", type: "imports", confidence: "EXTRACTED" });
  });

  it("merges out-of-line methods and resolves lambdas and typed receivers", () => {
    const graph = project({
      "main.cpp": `class Worker {
public:
  void work();
  int value;
};

void Worker::work() {
  helper();
}

Worker make() {
  return Worker();
}

void helper() {}

int main() {
  Worker worker = make();
  worker.work();
  auto callback = [](int x) { return helper(); };
  callback(1);
}
`,
    });
    const methods = graph.nodes.filter((node) => node.id.startsWith("main.cpp#Worker.work"));
    expect(methods).toHaveLength(1);
    expect(methods[0].startLine).toBe(7);
    expect(targets(graph, "main.cpp#main")).toEqual([
      "main.cpp#make",
      "main.cpp#Worker.work",
      "main.cpp#main.callback",
    ]);
    expect(targets(graph, "main.cpp#Worker.work")).toContain("main.cpp#helper");
    expect(targets(graph, "main.cpp#main.callback")).toContain("main.cpp#helper");
  });

  it("resolves namespace members and qualified calls", () => {
    const graph = project({
      "app.cpp": `namespace app {
void helper() {}
class Worker {
public:
  void work() { helper(); }
};
int run() {
  Worker worker;
  worker.work();
  return 0;
}
}
int main() { app::run(1); }
`,
    });
    expect(targets(graph, "app.cpp#main")).toContain("app.cpp#app.run");
    expect(targets(graph, "app.cpp#app.run")).toContain("app.cpp#app.Worker.work");
    expect(targets(graph, "app.cpp#app.Worker.work")).toContain("app.cpp#app.helper");
  });
});

describe("multi-language robustness", () => {
  it("handles malformed sources deterministically", () => {
    const files = {
      "broken.java": "class { void run( {",
      "broken.rs": "fn ( impl ",
      "broken.go": "func ( package",
      "broken.c": "int main( {",
      "broken.cpp": "namespace { class",
      "valid.ts": "export function ok() { return 1; }\n",
    };
    const first = project(files);
    const second = project(files);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.nodes.map((node) => node.id)).toContain("valid.ts#ok");
  });
});
