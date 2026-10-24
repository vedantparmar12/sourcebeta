import { normalizePath, SUPPORTED_EXTENSIONS } from "./analyzer";
import type { SourceFileInput } from "./types";

const SKIPPED_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", "out", "target", "vendor", ".venv",
]);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1_000_000;

function supported(path: string): boolean {
  return SUPPORTED_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
}

interface FileSystemEntryLike {
  kind: "file" | "directory";
  name: string;
}

interface DirectoryHandleLike extends FileSystemEntryLike {
  kind: "directory";
  values(): AsyncIterableIterator<DirectoryHandleLike | FileHandleLike>;
}

interface FileHandleLike extends FileSystemEntryLike {
  kind: "file";
  getFile(): Promise<File>;
}

export function supportsDirectoryPicker(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

export async function pickProjectFromDirectory(): Promise<SourceFileInput[] | null> {
  const picker = (window as unknown as {
    showDirectoryPicker: () => Promise<DirectoryHandleLike>;
  }).showDirectoryPicker;
  const root = await picker();
  const files: SourceFileInput[] = [];

  const walk = async (directory: DirectoryHandleLike, prefix: string) => {
    for await (const entry of directory.values()) {
      if (files.length >= MAX_FILES) return;
      if (entry.kind === "directory") {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await walk(entry as DirectoryHandleLike, `${prefix}${entry.name}/`);
        }
        continue;
      }
      if (!supported(entry.name)) continue;
      const file = await (entry as FileHandleLike).getFile();
      if (file.size > MAX_FILE_BYTES) continue;
      files.push({ path: normalizePath(prefix + entry.name), content: await file.text() });
    }
  };

  await walk(root, "");
  return files;
}

export async function readProjectFromInput(fileList: FileList): Promise<SourceFileInput[]> {
  const files: SourceFileInput[] = [];
  for (const file of Array.from(fileList)) {
    if (files.length >= MAX_FILES) break;
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = normalizePath(relative).split("/");
    if (parts.some((part) => SKIPPED_DIRECTORIES.has(part))) continue;
    if (!supported(file.name) || file.size > MAX_FILE_BYTES) continue;
    // Drop the selected root directory name so imports resolve project-relative.
    files.push({ path: parts.slice(1).join("/") || file.name, content: await file.text() });
  }
  return files;
}
