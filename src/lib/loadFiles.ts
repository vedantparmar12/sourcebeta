import { MAX_FILES, MAX_FILE_BYTES, normalizePath, SKIPPED_DIRECTORIES, SUPPORTED_EXTENSIONS } from "./scan";
import type { SourceFileInput } from "./types";

export interface ProjectScan {
  files: SourceFileInput[];
  truncated: boolean;
  skippedLarge: number;
  skippedUnreadable: number;
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

export type ProjectDirectoryHandle = DirectoryHandleLike;

interface FileHandleLike extends FileSystemEntryLike {
  kind: "file";
  getFile(): Promise<File>;
}

export function supportsDirectoryPicker(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

export async function pickProjectDirectory(): Promise<ProjectDirectoryHandle> {
  const picker = (window as unknown as {
    showDirectoryPicker: () => Promise<ProjectDirectoryHandle>;
  }).showDirectoryPicker;
  return picker();
}

export async function scanProjectDirectory(root: ProjectDirectoryHandle, signal?: AbortSignal): Promise<ProjectScan> {
  const scan: ProjectScan = { files: [], truncated: false, skippedLarge: 0, skippedUnreadable: 0 };

  const walk = async (directory: DirectoryHandleLike, prefix: string) => {
    for await (const entry of directory.values()) {
      signal?.throwIfAborted();
      if (scan.truncated) return;
      if (entry.kind === "directory") {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          try {
            await walk(entry as DirectoryHandleLike, `${prefix}${entry.name}/`);
          } catch (cause) {
            if ((cause as Error).name === "AbortError") throw cause;
            scan.skippedUnreadable += 1;
          }
        }
        continue;
      }
      if (!supported(entry.name)) continue;
      try {
        const file = await (entry as FileHandleLike).getFile();
        signal?.throwIfAborted();
        if (file.size > MAX_FILE_BYTES) {
          scan.skippedLarge += 1;
          continue;
        }
        if (scan.files.length >= MAX_FILES) {
          scan.truncated = true;
          return;
        }
        scan.files.push({ path: normalizePath(prefix + entry.name), content: await file.text() });
      } catch (cause) {
        if ((cause as Error).name === "AbortError") throw cause;
        scan.skippedUnreadable += 1;
      }
    }
  };

  await walk(root, "");
  signal?.throwIfAborted();
  return scan;
}

export async function pickProjectFromDirectory(signal?: AbortSignal): Promise<ProjectScan> {
  return scanProjectDirectory(await pickProjectDirectory(), signal);
}

export async function readProjectFromInput(fileList: FileList, signal?: AbortSignal): Promise<ProjectScan> {
  const scan: ProjectScan = { files: [], truncated: false, skippedLarge: 0, skippedUnreadable: 0 };
  for (const file of Array.from(fileList)) {
    signal?.throwIfAborted();
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
    try {
      // Drop the selected root directory name so imports resolve project-relative.
      scan.files.push({ path: parts.slice(1).join("/") || file.name, content: await file.text() });
    } catch (cause) {
      if ((cause as Error).name === "AbortError") throw cause;
      scan.skippedUnreadable += 1;
    }
  }
  signal?.throwIfAborted();
  return scan;
}
