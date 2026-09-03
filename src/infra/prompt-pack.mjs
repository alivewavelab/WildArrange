import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgentKey } from "./agent-registry.mjs";
import { DEFAULT_RUNTIME_NAME } from "./runtime-config.mjs";
import {
  STATE_VERSION,
  createWorkId,
  hashContent,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "./runtime-store.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// This file lives at src/infra/prompt-pack.mjs, two levels below the project root.
export const PROJECT_DIR = path.dirname(path.dirname(MODULE_DIR));
export const DEFAULT_PROMPT_PACK_DIR = path.join(PROJECT_DIR, "packs", DEFAULT_RUNTIME_NAME);

export async function installPromptPack(rootDir, packDir = DEFAULT_PROMPT_PACK_DIR) {
  const canonicalPackDir = await realpath(packDir);
  const manifest = await readJson(path.join(canonicalPackDir, "manifest.json"));
  const entries = await loadPromptPackEntries(canonicalPackDir, manifest);
  await materializePromptPack(rootDir, entries);
  const registry = {
    version: STATE_VERSION,
    installedAt: nowIso(),
    ...registryIdentity(manifest, entries, canonicalPackDir),
  };
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "prompt-pack.json"), registry);
  return registry;
}

export async function isPromptPackCurrent(rootDir, packDir = DEFAULT_PROMPT_PACK_DIR) {
  try {
    const canonicalPackDir = await realpath(packDir);
    const manifest = await readJson(path.join(canonicalPackDir, "manifest.json"));
    const entries = await loadPromptPackEntries(canonicalPackDir, manifest);
    const current = await readJson(resolveWildArrangePath(rootDir, "prompt-pack.json"), null);
    if (!current) return false;
    const expectedIdentity = registryIdentity(manifest, entries, canonicalPackDir);
    if (JSON.stringify(registryIdentityFromRegistry(current)) !== JSON.stringify(expectedIdentity)) return false;

    const installedRoot = await resolveTrustedInstalledRoot(rootDir, "prompt pack idempotency check");
    for (const entry of materializedEntries(entries)) {
      const installedPath = await resolvePackEntryPath(installedRoot, entry.relativePath, `${entry.kind} ${entry.name}`);
      const content = await readFile(installedPath, "utf8");
      if (content.length !== entry.content.length || hashContent(content) !== entry.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function registryIdentity(manifest, entries, canonicalPackDir) {
  return {
    name: manifest.name,
    description: manifest.description,
    source: manifest.source,
    // Diagnostics only. Runtime readers always use the fixed materialized root
    // under .wildarrange and never derive a read root from registry JSON.
    sourcePackDir: canonicalPackDir,
    agents: Object.fromEntries(entries.agents.map((entry) => [entry.name, registryEntry(entry)])),
    skills: Object.fromEntries(entries.skills.map((entry) => [entry.name, registryEntry(entry)])),
    tools: registryEntry(entries.tools),
    routes: entries.routes ? registryEntry(entries.routes) : null,
  };
}

function registryIdentityFromRegistry(registry) {
  return {
    name: registry.name,
    description: registry.description,
    source: registry.source,
    sourcePackDir: registry.sourcePackDir,
    agents: registry.agents || {},
    skills: registry.skills || {},
    tools: registry.tools || null,
    routes: registry.routes || null,
  };
}

function materializedEntries(entries) {
  return [
    ...entries.agents,
    ...entries.skills,
    entries.tools,
    ...(entries.routes ? [entries.routes] : []),
  ];
}

function registryEntry(entry) {
  return {
    path: entry.relativePath,
    bytes: entry.content.length,
    sha256: hashContent(entry.content),
  };
}

export async function loadPromptPackEntries(packDir = DEFAULT_PROMPT_PACK_DIR, manifest = null) {
  const packManifest = manifest || await readJson(path.join(packDir, "manifest.json"));
  const agents = [];
  for (const [name, relativePath] of Object.entries(packManifest.agents || {})) {
    agents.push(await loadPackTextEntry(packDir, name, relativePath, "agent"));
  }
  const skills = [];
  for (const [name, relativePath] of Object.entries(packManifest.skills || {})) {
    skills.push(await loadPackTextEntry(packDir, name, relativePath, "skill"));
  }
  const tools = await loadPackTextEntry(packDir, "tools", packManifest.tools, "tools");
  const routes = packManifest.routes ? await loadPackTextEntry(packDir, "routes", packManifest.routes, "routes") : null;
  return { manifest: packManifest, agents, skills, tools, routes };
}

async function loadPackTextEntry(packDir, name, relativePath, kind) {
  const filePath = await resolvePackEntryPath(packDir, relativePath, `${kind} ${name}`);
  const content = await readFile(filePath, "utf8");
  return { name, kind, relativePath, content, sha256: hashContent(content) };
}

export async function listPromptPack(rootDir) {
  const registry = await readJson(resolveWildArrangePath(rootDir, "prompt-pack.json"), null);
  if (!registry) return null;
  return {
    name: registry.name,
    description: registry.description,
    agents: Object.keys(registry.agents || {}),
    skills: Object.keys(registry.skills || {}),
    tools: registry.tools ? "tools/tool-contract.json" : null,
    routes: registry.routes ? "routes.json" : null,
  };
}

export async function renderPromptPackEntry(rootDir, selector) {
  const registry = await readJson(resolveWildArrangePath(rootDir, "prompt-pack.json"), null);
  if (!registry) throw new Error("prompt pack is not installed; run wildarrange init");

  let entry;
  let label;
  if (selector.agent) {
    const agent = normalizeAgentKey(selector.agent);
    entry = registry.agents?.[agent];
    label = `agent ${agent || selector.agent}`;
  } else if (selector.skill) {
    entry = registry.skills?.[selector.skill];
    label = `skill ${selector.skill}`;
  } else if (selector.tools) {
    entry = registry.tools;
    label = "tools";
  } else if (selector.routes) {
    entry = registry.routes;
    label = "routes";
  } else {
    throw new Error("choose --agent <name>, --skill <name>, --tools, or --routes");
  }
  if (!entry) throw new Error(`unknown prompt-pack entry: ${label}`);

  const installedRoot = await resolveTrustedInstalledRoot(rootDir, label);
  const filePath = await resolvePackEntryPath(installedRoot, entry.path, label);
  const content = await readFile(filePath, "utf8");
  const actualHash = hashContent(content);
  if (actualHash !== entry.sha256) {
    throw new Error(`prompt-pack entry changed after install: ${label}`);
  }
  return content;
}

async function materializePromptPack(rootDir, entries) {
  const runtimeRoot = resolveWildArrangePath(rootDir);
  const runtimeStat = await lstat(runtimeRoot).catch(() => null);
  if (!runtimeStat?.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error("runtime .wildarrange root must be a real directory before installing a prompt pack");
  }
  const packParent = resolveWildArrangePath(rootDir, "prompt-pack");
  await mkdir(packParent, { recursive: true });
  const realRuntimeRoot = await realpath(runtimeRoot);
  const realPackParent = await realpath(packParent);
  if (!isInsideRoot(realRuntimeRoot, realPackParent)) {
    throw new Error("runtime prompt-pack directory escapes .wildarrange root");
  }

  const stagingRoot = path.join(realPackParent, `staging-${createWorkId("pack")}`);
  const installedRoot = path.join(realPackParent, "installed");
  await mkdir(stagingRoot, { recursive: true });
  try {
    const materialized = materializedEntries(entries);
    const written = new Map();
    for (const entry of materialized) {
      const previous = written.get(entry.relativePath);
      if (previous !== undefined && previous !== entry.content) {
        throw new Error(`prompt-pack entries collide at ${entry.relativePath}`);
      }
      written.set(entry.relativePath, entry.content);
    }
    for (const [relativePath, content] of written) {
      const filePath = path.join(stagingRoot, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
    }
    await rm(installedRoot, { recursive: true, force: true });
    await rename(stagingRoot, installedRoot);
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return installedRoot;
}

async function resolveTrustedInstalledRoot(rootDir, label) {
  const runtimeRoot = resolveWildArrangePath(rootDir);
  const installedRoot = resolveWildArrangePath(rootDir, "prompt-pack", "installed");
  const [runtimeStat, installedStat] = await Promise.all([
    lstat(runtimeRoot).catch(() => null),
    lstat(installedRoot).catch(() => null),
  ]);
  if (!runtimeStat?.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error(`runtime .wildarrange root is not trusted for ${label}`);
  }
  if (!installedStat?.isDirectory() || installedStat.isSymbolicLink()) {
    throw new Error(`installed prompt-pack root is not trusted for ${label}`);
  }
  const [realRuntimeRoot, realInstalledRoot] = await Promise.all([
    realpath(runtimeRoot),
    realpath(installedRoot),
  ]);
  if (!isInsideRoot(realRuntimeRoot, realInstalledRoot)) {
    throw new Error(`installed prompt-pack root escapes .wildarrange for ${label}`);
  }
  return realInstalledRoot;
}

async function resolvePackEntryPath(packDir, relativePath, label) {
  if (typeof packDir !== "string" || packDir.length === 0) {
    throw new Error(`invalid prompt-pack root for ${label}`);
  }
  if (!isSafeRelativePath(relativePath)) {
    throw new Error(`invalid prompt-pack entry path for ${label}: ${relativePath}`);
  }
  const realPackRoot = await realpath(packDir).catch(() => null);
  if (!realPackRoot) throw new Error(`prompt-pack root is unavailable for ${label}`);
  const candidate = await realpath(path.join(realPackRoot, relativePath)).catch(() => null);
  if (!candidate || !isInsideRoot(realPackRoot, candidate)) {
    throw new Error(`prompt-pack entry escapes installed pack root: ${label}`);
  }
  return candidate;
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) return false;
  const segments = value.replaceAll("\\", "/").split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isInsideRoot(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
