// =============================================================================
// 文件名称：responsibility-evidence.mjs
// 所属模块：infra
// 作用说明：
//   职责审查只读证据包：全脚本+diff，超预算 fail-closed。
//
// 【运行原理速读】
//   walk 源码 inventory → 读文件/hash → git diff → packet digest。
// =============================================================================
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { runCommandFile } from "./command-runner.mjs";
import { hashContent } from "./runtime-store.mjs";
import { assertPathInsideRoot } from "./path-match.mjs";
import { contractPath } from "./responsibility-contract.mjs";

const SOURCE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|cpp|cc|c|h|hpp|rb|php|swift|vue|svelte|sql|sh|ps1)$/i;
const EXCLUDED = new Set([".git", ".wildarrange", "node_modules", "vendor", "dist", "build", "target", ".venv"]);

// Evidence only: no decisions, no writes, no silent truncation.
/**
 * collectResponsibilityEvidence：本模块对外异步 API。
 */
export async function collectResponsibilityEvidence(rootDir, changes, changedPaths, maxChars = 500000) {
  if (!Array.isArray(changedPaths)) throw new Error("changed-path evidence is missing");
  const root = await realpath(rootDir);
  const paths = new Set(changedPaths.map(contractPath));
  for (const change of changes) {
    paths.add(change.script);
    for (const fact of change.facts) {
      if (fact.ownerBefore) paths.add(fact.ownerBefore);
      if (fact.ownerAfter) paths.add(fact.ownerAfter);
    }
  }
  await walk(root, "");
  const files = [];
  let chars = 0;
  for (const name of [...paths].sort()) {
    if (/(^|\/)(?:\.env(?:\.|$)|id_rsa|id_ed25519|credentials(?:\.|$))|\.(?:pem|key|p12|pfx)$/i.test(name)) throw new Error(`sensitive file is not review source: ${name}`);
    const absolute = path.resolve(root, name);
    assertPathInsideRoot(root, absolute, name);
    let content = null;
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`not a regular source file: ${name}`);
      assertPathInsideRoot(root, await realpath(absolute), name);
      if (/\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|mp3|pdf|zip)$/i.test(name)) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(absolute)) hash.update(chunk);
        files.push({ path: name, content: null, binary: true, size: info.size, hash: hash.digest("hex") });
        continue;
      }
      if (info.size > maxChars * 4) throw new Error(`responsibility evidence exceeds budget: ${name}`);
      content = await readFile(absolute, "utf8");
      if (content.includes("\0")) throw new Error(`binary responsibility evidence: ${name}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    chars += content?.length || 0;
    if (chars > maxChars) throw new Error("responsibility evidence exceeds budget; configure a larger review.responsibility.maxEvidenceChars");
    files.push({ path: name, content, hash: hashContent(content === null ? "<deleted>" : content) });
  }
  const diff = await runCommandFile("git", ["diff", "HEAD", "--no-ext-diff", "--", ".", ":!.wildarrange"], root, 30000, { maxOutputChars: maxChars });
  if (diff.outputTruncated?.stdout) throw new Error("responsibility diff is truncated");
  const packet = { changedPaths, files, diff: diff.exitCode === 0 ? diff.stdout : null, diffAvailable: diff.exitCode === 0 };
  if (JSON.stringify(packet).length > maxChars) throw new Error("responsibility packet exceeds budget");
  return { ...packet, digest: hashContent(JSON.stringify(packet)) };

  async function walk(directory, relative) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name) || entry.name.startsWith(".")) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        if (SOURCE.test(name)) throw new Error(`symlink source cannot be audited: ${name}`);
        continue;
      }
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else if (SOURCE.test(name)) paths.add(name);
      if (paths.size > 10000) throw new Error("responsibility source inventory exceeds 10000 files");
    }
  }
}
