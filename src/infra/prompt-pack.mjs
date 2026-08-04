import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgentKey } from "./agent-registry.mjs";
import { DEFAULT_RUNTIME_NAME } from "./runtime-config.mjs";
import {
  STATE_VERSION,
  hashContent,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "./runtime-store.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// This file lives at src/infra/prompt-pack.mjs, two levels below the project root.
export const PROJECT_DIR = path.dirname(path.dirname(MODULE_DIR));
export const DEFAULT_PROMPT_PACK_DIR = path.join(PROJECT_DIR, "packs", DEFAULT_RUNTIME_NAME);

export async function installPromptPack(rootDir, packDir = DEFAULT_PROMPT_PACK_DIR) {
  const manifest = await readJson(path.join(packDir, "manifest.json"));
  const entries = await loadPromptPackEntries(packDir, manifest);
  const registry = {
    version: STATE_VERSION,
    installedAt: nowIso(),
    name: manifest.name,
    description: manifest.description,
    source: manifest.source,
    packDir,
    agents: Object.fromEntries(entries.agents.map((entry) => [entry.name, registryEntry(entry)])),
    skills: Object.fromEntries(entries.skills.map((entry) => [entry.name, registryEntry(entry)])),
    tools: registryEntry(entries.tools),
    routes: entries.routes ? registryEntry(entries.routes) : null,
  };
  await writeJsonAtomic(resolveHelixPath(rootDir, "prompt-pack.json"), registry);
  return registry;
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
  if (!relativePath || relativePath.includes("..") || path.isAbsolute(relativePath)) {
    throw new Error(`invalid ${kind} path for ${name}: ${relativePath}`);
  }
  const content = await readFile(path.join(packDir, relativePath), "utf8");
  return { name, kind, relativePath, content, sha256: hashContent(content) };
}

export async function listPromptPack(rootDir) {
  const registry = await readJson(resolveHelixPath(rootDir, "prompt-pack.json"), null);
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
  const registry = await readJson(resolveHelixPath(rootDir, "prompt-pack.json"), null);
  if (!registry) throw new Error("prompt pack is not installed; run helix init");

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

  const content = await readFile(path.join(registry.packDir, entry.path), "utf8");
  const actualHash = hashContent(content);
  if (actualHash !== entry.sha256) {
    throw new Error(`prompt-pack entry changed after install: ${label}`);
  }
  return content;
}
