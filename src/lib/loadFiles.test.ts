import { describe, expect, it } from "vitest";
import { readProjectFromInput } from "./loadFiles";
import { MAX_FILES, MAX_FILE_BYTES } from "./scan";

function file(content: string, name: string, relative = name): File {
  const item = new File([content], name);
  Object.defineProperty(item, "webkitRelativePath", { value: relative });
  return item;
}

const fileList = (files: File[]) => files as unknown as FileList;

describe("readProjectFromInput", () => {
  it("skips unsupported, ignored-directory, and oversized files with root-relative paths", async () => {
    const scan = await readProjectFromInput(fileList([
      file("export const a = 1;", "a.ts", "project/a.ts"),
      file("ignored", "readme.txt", "project/readme.txt"),
      file("export const skip = 1;", "skip.ts", "project/node_modules/skip.ts"),
      file("export const cache = 1;", "cache.ts", "project/__pycache__/cache.ts"),
      file("//" + "x".repeat(MAX_FILE_BYTES), "huge.ts", "project/huge.ts"),
      file("def f(): pass", "f.py", "project/pkg/f.py"),
    ]));
    expect(scan.files.map(item => item.path)).toEqual(["a.ts", "pkg/f.py"]);
    expect(scan.skippedLarge).toBe(1);
    expect(scan.truncated).toBe(false);
  });

  it("reports truncation at the file cap instead of silently stopping", async () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, index) => file("", `f${index}.ts`, `project/f${index}.ts`));
    const scan = await readProjectFromInput(fileList(files));
    expect(scan.files).toHaveLength(MAX_FILES);
    expect(scan.truncated).toBe(true);
  });
});
