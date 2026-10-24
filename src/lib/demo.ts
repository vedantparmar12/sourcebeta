import type { SourceFileInput } from "./types";

export const DEMO_FILES: SourceFileInput[] = [
  {
    path: "src/main.ts",
    content: `import { TaskStore } from "./store";
import { renderTasks } from "./view";

export function main() {
  const store = new TaskStore();
  bootstrap(store);
  renderTasks(store.list());
}

export function bootstrap(store: TaskStore) {
  store.add("Map the codebase");
  store.add("Sketch it on the canvas");
}
`,
  },
  {
    path: "src/store.ts",
    content: `import { makeTask } from "./task";

export class TaskStore {
  private tasks: unknown[] = [];

  add(title: string) {
    this.tasks.push(makeTask(title));
  }

  complete(title: string) {
    return this.tasks.length;
  }

  list() {
    return this.tasks;
  }
}

export function summarize(store: TaskStore) {
  return store.list().length;
}
`,
  },
  {
    path: "src/task.ts",
    content: `export function makeTask(title: string) {
  return { title, done: false, id: nextId() };
}

let counter = 0;

export function nextId() {
  counter += 1;
  return counter;
}
`,
  },
  {
    path: "src/view.ts",
    content: `import { summarize } from "./store";

export function renderTasks(tasks: unknown[]) {
  return tasks.map(formatTask).join("\\n");
}

export function formatTask(task: unknown) {
  return String(task);
}
`,
  },
  {
    path: "notes/Welcome.md",
    content: "# Welcome\n\nStart with [[Tasks]] and [[Architecture]].\n",
  },
  {
    path: "notes/Tasks.md",
    content: "# Tasks\n\nThe store is described in [[Architecture]].\n",
  },
  {
    path: "notes/Architecture.md",
    content: "# Architecture\n\nGraph, canvas and code in one place.\n",
  },
];
