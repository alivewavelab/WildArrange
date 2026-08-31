import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM_EXECUTABLE = process.platform === "win32" ? process.execPath : "npm";
const NPM_ARGS_PREFIX = process.platform === "win32"
  ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
  : [];
const RESTRICTED_PROMPTS = [
  "doc/plans/claude-fable-5-system-prompt.md",
  "doc/plans/claude-fable-5-system-prompt-zh.md",
];
const ALLOWED_PLAN_FILES = new Set([
  "doc/plans/2026-08-04-beginner-handbook.html",
]);

async function withPackedPackage(callback) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "wildarrange-pack-test-"));
  const cacheDir = path.join(tempRoot, "cache");
  const packDir = path.join(tempRoot, "pack");
  await mkdir(packDir, { recursive: true });

  try {
    const output = execFileSync(
      NPM_EXECUTABLE,
      [...NPM_ARGS_PREFIX, "pack", "--json", "--pack-destination", packDir, "--cache", cacheDir],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    const manifests = JSON.parse(output);
    assert.equal(manifests.length, 1, "npm pack should create exactly one package");
    const manifest = manifests[0];
    const tarballPath = path.join(packDir, manifest.filename);
    return await callback({ cacheDir, manifest, tarballPath, tempRoot });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function stripMarkdownCode(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

function collectRelativeLinks(markdown) {
  const links = [];
  const source = stripMarkdownCode(markdown);
  const inlineLink = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of source.matchAll(inlineLink)) {
    let target = match[1];
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    if (
      !target ||
      target.startsWith("#") ||
      target.startsWith("/") ||
      target.startsWith("//") ||
      /^[a-z][a-z\d+.-]*:/i.test(target)
    ) {
      continue;
    }
    try {
      target = decodeURIComponent(target);
    } catch {
      // Keep the literal target so the missing-link assertion reports it.
    }
    target = target.split("#", 1)[0].split("?", 1)[0];
    if (target) links.push(target);
  }
  return links;
}

test("npm package excludes plans, restricted prompts, and runtime state", async () => {
  await withPackedPackage(async ({ manifest }) => {
    const packedPaths = manifest.files.map((file) => file.path);

    assert.ok(packedPaths.length > 0, "npm pack returned an empty file list");
    const publishedPlanFiles = packedPaths.filter((file) => file.startsWith("doc/plans/"));
    assert.deepEqual(
      publishedPlanFiles,
      [...ALLOWED_PLAN_FILES],
      "published package may contain only the explicitly allowlisted beginner handbook from doc/plans",
    );
    for (const restrictedPath of RESTRICTED_PROMPTS) {
      assert.equal(
        packedPaths.includes(restrictedPath),
        false,
        `published package contains restricted prompt: ${restrictedPath}`,
      );
    }
    for (const forbiddenRoot of [".external/", ".helix/", ".tmp/"]) {
      assert.equal(
        packedPaths.some((file) => file.startsWith(forbiddenRoot)),
        false,
        `published package contains forbidden runtime path: ${forbiddenRoot}`,
      );
    }
    for (const [pattern, label] of [
      [/packs\/wildarrange-linear\/skills\/lcx-/, "retired LCX skills"],
      [/packs\/wildarrange-linear\/skills\/wa-/, "retired WA stage skills"],
      [/(^|\/)\.workflow(\/|$)/, "retired .workflow runtime content"],
    ]) {
      assert.equal(
        packedPaths.some((file) => pattern.test(file)),
        false,
        `published package contains ${label}`,
      );
    }
  });
});

test("relative links in published Markdown resolve inside the package", async () => {
  await withPackedPackage(async ({ manifest }) => {
    const packedPaths = new Set(manifest.files.map((file) => file.path));
    const markdownPaths = [...packedPaths].filter((file) => file.endsWith(".md"));
    const missing = [];

    for (const markdownPath of markdownPaths) {
      const markdown = readFileSync(path.join(REPO_ROOT, markdownPath), "utf8");
      for (const target of collectRelativeLinks(markdown)) {
        const resolved = path.posix.normalize(
          path.posix.join(path.posix.dirname(markdownPath), target),
        );
        const targetExists =
          !resolved.startsWith("../") &&
          (packedPaths.has(resolved) ||
            [...packedPaths].some((file) => file.startsWith(`${resolved.replace(/\/$/, "")}/`)));
        if (!targetExists) missing.push(`${markdownPath} -> ${target}`);
      }
    }

    assert.deepEqual(missing, [], `published Markdown has missing relative links:\n${missing.join("\n")}`);
  });
});

test("packed package installs offline and public CLI completes a minimal smoke run", async () => {
  await withPackedPackage(async ({ cacheDir, tarballPath, tempRoot }) => {
    const installDir = path.join(tempRoot, "install");
    await mkdir(installDir, { recursive: true });
    await writeFile(
      path.join(installDir, "package.json"),
      `${JSON.stringify({ name: "wildarrange-package-smoke", private: true }, null, 2)}\n`,
      "utf8",
    );
    execFileSync(
      NPM_EXECUTABLE,
      [
        ...NPM_ARGS_PREFIX,
        "install",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        "--cache",
        cacheDir,
        tarballPath,
      ],
      { cwd: installDir, encoding: "utf8" },
    );

    const publicShim = path.join(installDir, "node_modules", ".bin", process.platform === "win32" ? "wildarrange.cmd" : "wildarrange");
    assert.equal(existsSync(publicShim), true, "npm install must create the public wildarrange bin shim");
    const installedCli = path.join(installDir, "node_modules", "@alivewavelab", "wildarrange", "bin", "helix.mjs");
    const help = execFileSync(process.execPath, [installedCli, "--help"], { cwd: installDir, encoding: "utf8" });
    assert.match(help, /WildArrange linear runtime/);

    const initialized = JSON.parse(
      execFileSync(process.execPath, [installedCli, "init"], { cwd: installDir, encoding: "utf8" }),
    );
    assert.equal(initialized.ok, true);
    const status = JSON.parse(
      execFileSync(process.execPath, [installedCli, "status"], { cwd: installDir, encoding: "utf8" }),
    );
    assert.equal(status.work?.status, "idle");
    assert.equal(status.total, 0);
  });
});
