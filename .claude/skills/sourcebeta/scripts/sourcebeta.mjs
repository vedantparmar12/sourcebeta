import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_APP = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SKIPPED = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out", "target", "vendor", ".venv"]);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1_000_000;

function parseArguments(args) {
  const paths = [];
  let query = "";
  let open = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--open") open = true;
    else if (arg === "--query") {
      query = args[++index] ?? "";
      if (!query.trim() || query.startsWith("--")) throw new Error("--query requires a value");
    } else if (arg === "--help") {
      console.log("Usage: bun sourcebeta.mjs [project-dir] [--query <symbol-or-file>] [--open]");
      console.log("Analyze without opening a browser by default. Use SOURCEBETA_HOME to locate a separate Sourcebeta checkout.");
      process.exit(0);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else paths.push(arg);
  }
  if (paths.length > 1) throw new Error("Pass at most one project directory");
  return { root: resolve(paths[0] ?? "."), query: query.trim().toLowerCase(), open };
}

async function scanProject(root, extensions, normalizePath) {
  const files = [];
  const walk = async (directory) => {
    if (files.length >= MAX_FILES) return;
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) continue;
      const metadata = await stat(fullPath);
      if (metadata.size > MAX_FILE_BYTES) continue;
      files.push({
        path: normalizePath(relative(root, fullPath)),
        content: await readFile(fullPath, "utf8"),
      });
    }
  };
  await walk(root);
  return files;
}

function printSummary(root, graph, analytics, explainNode, query, fileCount) {
  const counts = { file: 0, function: 0, class: 0, note: 0 };
  for (const node of graph.nodes) counts[node.kind] += 1;
  console.log(`Project: ${basename(root)}`);
  console.log(`Scanned: ${fileCount} supported files${fileCount >= MAX_FILES ? " (file cap reached)" : ""}`);
  console.log(`Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges | ${counts.file} files, ${counts.function} functions, ${counts.class} classes, ${counts.note} notes`);
  console.log("Key nodes:");
  for (const id of analytics.godNodes) {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    console.log(`- ${node.label} [${node.kind}] ${node.file} (degree ${analytics.degree.get(id)})`);
  }
  if (!query) return;
  const matches = graph.nodes
    .filter((node) => `${node.label} ${node.file}`.toLowerCase().includes(query))
    .sort((a, b) => (analytics.degree.get(b.id) ?? 0) - (analytics.degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, 8);
  console.log(`Matches for "${query}": ${matches.length}${matches.length === 8 ? " (first 8)" : ""}`);
  for (const node of matches) {
    const location = `${node.file}${node.line ? `:${node.line}` : ""}`;
    console.log(`- ${node.label} [${node.kind}] ${location} (degree ${analytics.degree.get(node.id) ?? 0})`);
    for (const connection of explainNode(graph, node.id).slice(0, 5)) {
      const other = graph.nodes.find((candidate) => candidate.id === connection.other);
      const arrow = connection.direction === "outgoing" ? "->" : "<-";
      console.log(`  ${arrow} ${other?.label ?? connection.other} [${connection.edge.type} ${connection.edge.confidence}]`);
    }
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port");
  const { port } = address;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function runningApp(serverFile, root) {
  try {
    const { port } = JSON.parse(await readFile(serverFile, "utf8"));
    const url = `http://127.0.0.1:${port}`;
    const response = await fetch(`${url}/api/sourcebeta/project`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const project = await response.json();
    return project.root === root ? `${url}/?project=1` : null;
  } catch {
    return null;
  }
}

async function startApp(appRoot, graphFile, serverFile, root) {
  const existing = await runningApp(serverFile, root);
  if (existing) return existing;
  const port = await availablePort();
  const vite = join(appRoot, "node_modules/vite/bin/vite.js");
  await access(vite);
  const child = spawn(process.execPath, [vite, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: appRoot,
    env: { ...process.env, SOURCEBETA_GRAPH: graphFile },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  await writeFile(serverFile, JSON.stringify({ pid: child.pid, port }));
  const url = `http://127.0.0.1:${port}/?project=1`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/sourcebeta/project`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return url;
    } catch {}
    if (child.exitCode !== null) break;
    await delay(100);
  }
  throw new Error(`sourcebeta did not start; check ${appRoot}`);
}

function openBrowser(url) {
  const [command, args] = process.platform === "win32"
    ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

try {
  const options = parseArguments(process.argv.slice(2));
  const appRoot = resolve(process.env.SOURCEBETA_HOME ?? DEFAULT_APP);
  await access(join(appRoot, "src/lib/analyzer.ts")).catch(() => {
    throw new Error("Sourcebeta app not found. Set SOURCEBETA_HOME to the Sourcebeta checkout and run bun install there.");
  });
  const analyzerUrl = pathToFileURL(join(appRoot, "src/lib/analyzer.ts")).href;
  const analyticsUrl = pathToFileURL(join(appRoot, "src/lib/analytics.ts")).href;
  const { analyzeProject, SUPPORTED_EXTENSIONS, normalizePath } = await import(analyzerUrl);
  const { computeAnalytics, explainNode } = await import(analyticsUrl);
  const files = await scanProject(options.root, SUPPORTED_EXTENSIONS, normalizePath);
  if (files.length === 0) throw new Error(`No supported JS, TS, or Markdown files found in ${options.root}`);
  const graph = analyzeProject(files);
  const analytics = computeAnalytics(graph);
  printSummary(options.root, graph, analytics, explainNode, options.query, files.length);
  if (options.open) {
    const id = createHash("sha256").update(`${appRoot}\0${options.root}`).digest("hex").slice(0, 16);
    const graphFile = join(tmpdir(), "sourcebeta", `${id}.json`);
    const serverFile = join(tmpdir(), "sourcebeta", `${id}.server.json`);
    await mkdir(dirname(graphFile), { recursive: true });
    await writeFile(graphFile, JSON.stringify({ name: basename(options.root), root: options.root, graph }));
    const url = await startApp(appRoot, graphFile, serverFile, options.root);
    console.log(`App: ${url}`);
    openBrowser(url);
  }
} catch (error) {
  console.error(`sourcebeta: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
