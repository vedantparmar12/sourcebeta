import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = join(appRoot, ".claude/skills/sourcebeta");
const launcher = join(skillRoot, "scripts/sourcebeta.mjs");
const temporary = await mkdtemp(join(tmpdir(), "sourcebeta skill check-"));
const project = join(temporary, "project with spaces");
const env = { ...process.env };
delete env.SOURCEBETA_HOME;

function run(args = [], options = {}) {
  const result = spawnSync(process.execPath, [options.script ?? launcher, ...args], {
    cwd: project,
    env: { ...env, ...options.env },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

try {
  const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: sourcebeta\r?\n/);
  const description = skill.match(/^description: (.+)$/m)?.[1];
  assert.ok(description && description.length <= 1024);
  assert.match(skill, /\r?\n---\r?\n/);
  assert.ok(skill.split("\n").length < 500);
  assert.ok(!skill.includes("TODO:"));
  assert.ok(skill.includes("${CLAUDE_SKILL_DIR}/scripts/sourcebeta.mjs"));
  assert.ok(skill.includes("$ARGUMENTS"));
  assert.deepEqual((await readdir(skillRoot)).sort(), ["SKILL.md", "scripts"]);
  assert.deepEqual(await readdir(join(skillRoot, "scripts")), ["sourcebeta.mjs"]);
  assert.ok(!(await readFile(launcher, "utf8")).includes("C:/Users/"));
  console.log("ok - portable Claude skill metadata and bundled paths");

  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "notes"));
  await writeFile(join(project, "src/main.ts"), 'import { leaf } from "./helper";\nexport function main() { return leaf(); }\nexport function fallback() { return inferred(); }\n');
  await writeFile(join(project, "src/helper.ts"), 'throw new Error("TARGET_CODE_MUST_NOT_EXECUTE");\nexport function leaf() { return "PRIVATE_SOURCE_BODY"; }\n');
  await writeFile(join(project, "src/other.ts"), "export function inferred() { return 1; }\n");
  await writeFile(join(project, "src/many.ts"), Array.from({ length: 12 }, (_, i) => `export function many${i}() { return ${i}; }`).join("\n"));
  await writeFile(join(project, "notes/Guide.md"), "# Guide\n");
  await writeFile(join(project, "src/service.py"), "class Service:\n    def run(self):\n        def nested():\n            return 1\n        return nested()\n");
  await writeFile(join(project, "src/Main.java"), "class Main {\n  void run() { helper(); }\n  void helper() {}\n}\n");
  await writeFile(join(project, "src/lib.rs"), "fn helper() {}\nfn run() { helper(); }\n");
  await writeFile(join(project, "src/service.go"), "package svc\n\nfunc Run() {}\n");
  await writeFile(join(project, "src/main.c"), "int helper() { return 1; }\nint run() { return helper(); }\n");
  await writeFile(join(project, "src/oversized.ts"), "//" + "x".repeat(1_000_000));
  await writeFile(join(project, "unsupported.txt"), "not a source file");
  for (const directory of ["node_modules", ".git", "dist", ".venv", "__pycache__"]) {
    await mkdir(join(project, directory));
    await writeFile(join(project, directory, "ignored.ts"), "export function ignored() {}\n");
  }

  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: bun sourcebeta\.mjs/);

  const summary = run();
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /Scanned: 10 supported files/);
  assert.match(summary.stdout, /Skipped: 1 file larger than 1 MB/);
  assert.ok(!summary.stdout.includes("App:"));
  assert.ok(!summary.stdout.includes("TARGET_CODE_MUST_NOT_EXECUTE"));
  assert.ok(!summary.stdout.includes("PRIVATE_SOURCE_BODY"));
  console.log("ok - default headless scan skips build output and oversized files without executing source");

  const focused = run([project, "--query", "LEAF"]);
  assert.equal(focused.status, 0, focused.stderr);
  assert.match(focused.stdout, /leaf \[function\] src\/helper\.ts:2/);
  assert.match(focused.stdout, /main \[calls EXTRACTED\]/);
  const inferred = run(["--query", "inferred"]);
  assert.equal(inferred.status, 0, inferred.stderr);
  assert.match(inferred.stdout, /fallback \[calls INFERRED\]/);
  const bounded = run(["--query", "many"]);
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.match(bounded.stdout, /Matches for "many": 8 \(first 8\)/);
  assert.ok(bounded.stdout.length < 6000);
  const absent = run(["--query", "not-present"]);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /Matches for "not-present": 0/);
  const python = run(["--query", "Service.run"]);
  assert.equal(python.status, 0, python.stderr);
  assert.match(python.stdout, /Service\.run \[function\] src\/service\.py:2/);
  assert.match(python.stdout, /Service\.run\.nested \[function\] src\/service\.py:3/);
  const java = run(["--query", "Main.run"]);
  assert.equal(java.status, 0, java.stderr);
  assert.match(java.stdout, /Main\.run \[function\] src\/Main\.java:2/);
  assert.match(java.stdout, /-> Main\.helper \[calls EXTRACTED\]/);
  console.log("ok - focused context reports nested Python symbols, locations, confidence, bounded matches and no-match results");

  for (const args of [["--query"], ["--query", "--open"], ["--unknown"], [project, project], [join(project, "missing")]]) {
    const invalid = run(args);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /^sourcebeta:/);
    assert.ok(!invalid.stderr.includes("\n    at "));
  }
  const emptyRoot = join(temporary, "empty");
  await mkdir(emptyRoot);
  const empty = run([emptyRoot]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /No supported JS, TS, Python, Java, Rust, Go, C\/C\+\+, or Markdown files/);
  console.log("ok - invalid options and missing or empty projects produce concise errors");

  const installed = join(temporary, "personal/.claude/skills/sourcebeta");
  await cp(skillRoot, installed, { recursive: true });
  const script = join(installed, "scripts/sourcebeta.mjs");
  const missingApp = run([], { script });
  assert.equal(missingApp.status, 1);
  assert.match(missingApp.stderr, /Set SOURCEBETA_HOME/);
  const relocated = run(["--query", "leaf"], { script, env: { SOURCEBETA_HOME: appRoot } });
  assert.equal(relocated.status, 0, relocated.stderr);
  assert.match(relocated.stdout, /leaf \[function\] src\/helper\.ts:2/);
  console.log("ok - copied personal skill works from another project with SOURCEBETA_HOME");
  console.log("Sourcebeta skill checks passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
