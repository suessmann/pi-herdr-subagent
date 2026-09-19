import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "bundled" | "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
};

function parseToolList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(fs.readFileSync(filePath, "utf8"));
      if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
      agents.push({
        name: frontmatter.name,
        description: frontmatter.description,
        tools: parseToolList(frontmatter.tools),
        model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
        systemPrompt: body,
        source,
        filePath,
      });
    } catch {
      // One malformed definition must not hide the other agents.
    }
  }
  return agents;
}

function findProjectAgentsDir(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentConfig[] {
  const bundledDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../agents");
  const userDir = path.join(getAgentDir(), "agents");
  const projectDir = findProjectAgentsDir(cwd);
  const byName = new Map<string, AgentConfig>();

  for (const agent of loadAgentsFromDir(bundledDir, "bundled")) byName.set(agent.name, agent);
  if (scope !== "project") {
    for (const agent of loadAgentsFromDir(userDir, "user")) byName.set(agent.name, agent);
  }
  if (scope !== "user" && projectDir) {
    for (const agent of loadAgentsFromDir(projectDir, "project")) byName.set(agent.name, agent);
  }
  return [...byName.values()];
}
