export const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
export const PYTHON_EXTENSIONS = [".py", ".pyi"];
export const JAVA_EXTENSIONS = [".java"];
export const RUST_EXTENSIONS = [".rs"];
export const GO_EXTENSIONS = [".go"];
export const C_EXTENSIONS = [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"];
export const NOTE_EXTENSIONS = [".md", ".markdown"];
export const SUPPORTED_EXTENSIONS = [
  ...CODE_EXTENSIONS,
  ...PYTHON_EXTENSIONS,
  ...JAVA_EXTENSIONS,
  ...RUST_EXTENSIONS,
  ...GO_EXTENSIONS,
  ...C_EXTENSIONS,
  ...NOTE_EXTENSIONS,
];

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export const SKIPPED_DIRECTORIES = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "coverage", ".next", "out", "target",
  "vendor", ".venv", "venv", "env", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".tox", ".cache", ".gradle", ".idea", ".vscode",
]);

export const MAX_FILES = 2000;
export const MAX_FILE_BYTES = 1_000_000;
