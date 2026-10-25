import { MAX_FILES, MAX_FILE_BYTES, normalizePath, SKIPPED_DIRECTORIES, SUPPORTED_EXTENSIONS } from "./scan";
import type { SourceFileInput } from "./types";

export interface ProjectScan {
  files: SourceFileInput[];
  truncated: boolean;
  skippedLarge: number;
}

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

export async function pickProjectFromDirectory(): Promise<ProjectScan | null> {
  const picker = (window as unknown as {
    showDirectoryPicker: () => Promise<DirectoryHandleLike>;
  }).showDirectoryPicker;
  const root = await picker();
  const scan: ProjectScan = { files: [], truncated: false, skippedLarge: 0 };

  const walk = async (directory: DirectoryHandleLike, prefix: string) => {
    for await (const entry of directory.values()) {
      if (scan.truncated) return;
      if (entry.kind === "directory") {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await walk(entry as DirectoryHandleLike, `${prefix}${entry.name}/`);
        }
        continue;
      }
      if (!supported(entry.name)) continue;
      const file = await (entry as FileHandleLike).getFile();
      if (file.size > MAX_FILE_BYTES) {
        scan.skippedLarge += 1;
        continue;
      }
      if (scan.files.length >= MAX_FILES) {
        scan.truncated = true;
        return;
      }
      scan.files.push({ path: normalizePath(prefix + entry.name), content: await file.text() });
    }
  };

  await walk(root, "");
  return scan;
}

export async function readProjectFromInput(fileList: FileList): Promise<ProjectScan> {
  const scan: ProjectScan = { files: [], truncated: false, skippedLarge: 0 };
  for (const file of Array.from(fileList)) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = normalizePath(relative).split("/");
    if (parts.some((part) => SKIPPED_DIRECTORIES.has(part))) continue;
    if (!supported(file.name)) continue;
    if (file.size > MAX_FILE_BYTES) {
      scan.skippedLarge += 1;
      continue;
    }
    if (scan.files.length >= MAX_FILES) {
      scan.truncated = true;
      break;
    }
    // Drop the selected root directory name so imports resolve project-relative.
    scan.files.push({ path: parts.slice(1).join("/") || file.name, content: await file.text() });
  }
  return scan;
}
