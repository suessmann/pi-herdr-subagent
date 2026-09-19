import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_PARALLEL = 4;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_READ_LINES = 400;

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
type Run = (args: string[], signal?: AbortSignal, timeout?: number) => Promise<ExecResult>;

interface RunningAgent {
  name: string;
  tabId: string;
  paneId: string;
  role: AgentConfig;
  promptFile?: string;
  promptDir?: string;
}

interface TaskResult {
  name: string;
  role: string;
  task: string;
  output: string;
}

type DisplayStatus = "launching" | "working" | "collecting" | "waiting" | "paused" | "done" | "error";

interface DisplayAgent {
  name: string;
  role: string;
  task?: string;
  status: DisplayStatus;
  startedAt: number;
  removeOnSettle: boolean;
}

const WIDGET_ID = "herdr-subagents";

function formatElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function parseHerdrJson(text: string): any {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Ignore non-JSON diagnostics and keep looking.
    }
  }
  throw new Error(`Herdr returned no JSON: ${text.trim() || "(empty output)"}`);
}

export function makeShortName(role: string, nonce = Math.random().toString(36).slice(2, 7)): string {
  let base = role
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/[-_]+$/, "");
  if (!base) base = "agent";
  base = base.slice(0, Math.max(1, 31 - nonce.length));
  return `${base}-${nonce}`.slice(0, 32);
}

export function finalAssistantText(sessionPath: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(sessionPath, "utf8");
  } catch {
    return undefined;
  }
  const lines = content.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const entry = JSON.parse(lines[index]);
      if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
      const texts = (entry.message.content ?? [])
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text.trim())
        .filter(Boolean);
      if (texts.length > 0) return texts.join("\n\n");
    } catch {
      // Ignore a partial or malformed line.
    }
  }
  return undefined;
}

function commandError(args: string[], result: ExecResult): Error {
  const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`herdr ${args.join(" ")} failed: ${diagnostic}`);
}

async function checked(run: Run, args: string[], signal?: AbortSignal, timeout?: number): Promise<any> {
  const result = await run(args, signal, timeout);
  if (result.code !== 0) throw commandError(args, result);
  return parseHerdrJson(result.stdout);
}

async function writeSystemPrompt(role: AgentConfig, name: string): Promise<{ dir: string; file: string }> {
  const parentTarget = process.env.HERDR_PANE_ID ?? "the parent Pi session";
  const contract = [
    "# Herdr subagent contract",
    "",
    `You are subagent \`${name}\`, delegated by the parent Pi agent at \`${parentTarget}\`.`,
    "You are not the primary user-facing agent. Complete only the delegated assignment.",
    "Your final assistant message is the result report that the parent agent will collect.",
    "Make that final report self-contained and start it with `SUBAGENT_RESULT:`.",
    "Do not wait for acknowledgement and do not attempt to terminate yourself.",
    "After emitting the report, become idle. The parent agent will read the report and close your Herdr tab.",
  ].join("\n");
  const content = role.systemPrompt.trim() ? `${role.systemPrompt.trim()}\n\n${contract}\n` : `${contract}\n`;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-herdr-subagent-"));
  const file = path.join(dir, "system.md");
  await fs.promises.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

async function removePrompt(agent: RunningAgent): Promise<void> {
  if (agent.promptFile) await fs.promises.rm(agent.promptFile, { force: true }).catch(() => undefined);
  if (agent.promptDir) await fs.promises.rm(agent.promptDir, { recursive: true, force: true }).catch(() => undefined);
}

function findRole(cwd: string, scope: AgentScope, name: string): AgentConfig {
  const roles = discoverAgents(cwd, scope);
  const role = roles.find((candidate) => candidate.name === name);
  if (role) return role;
  throw new Error(`Unknown agent role ${JSON.stringify(name)}. Available: ${roles.map((item) => item.name).join(", ") || "none"}`);
}

async function launchAgent(options: {
  run: Run;
  workspaceId: string;
  cwd: string;
  role: AgentConfig;
  name?: string;
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
}): Promise<RunningAgent> {
  const name = options.name ?? makeShortName(options.role.name);
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Agent name ${JSON.stringify(name)} must match ${NAME_PATTERN}`);
  }

  const created = await checked(
    options.run,
    ["tab", "create", "--workspace", options.workspaceId, "--cwd", options.cwd, "--label", name, "--no-focus"],
    options.signal,
    30_000,
  );
  const tabId = created?.result?.tab?.tab_id;
  const paneId = created?.result?.root_pane?.pane_id;
  if (typeof tabId !== "string" || typeof paneId !== "string") {
    throw new Error("Herdr tab create response did not include tab and root pane IDs");
  }

  const running: RunningAgent = { name, tabId, paneId, role: options.role };
  try {
    const prompt = await writeSystemPrompt(options.role, name);
    running.promptDir = prompt.dir;
    running.promptFile = prompt.file;

    const childArgs: string[] = [];
    const model = options.role.model ?? options.model;
    if (model) childArgs.push("--model", model);
    if (!options.role.model && options.thinking) childArgs.push("--thinking", options.thinking);
    if (options.role.tools?.length) childArgs.push("--tools", options.role.tools.join(","));
    if (running.promptFile) childArgs.push("--append-system-prompt", running.promptFile);

    const startArgs = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000"];
    if (childArgs.length > 0) startArgs.push("--", ...childArgs);
    await checked(options.run, startArgs, options.signal, 70_000);
    // Pi reads --append-system-prompt during startup; it is safe to remove once
    // Herdr has detected the initialized interactive agent.
    await removePrompt(running);
    running.promptFile = undefined;
    running.promptDir = undefined;
    return running;
  } catch (error) {
    await options.run(["tab", "close", tabId], undefined, 15_000).catch(() => undefined);
    await removePrompt(running);
    throw error;
  }
}

async function collectOutput(run: Run, agent: RunningAgent): Promise<string> {
  const info = await checked(run, ["agent", "get", agent.name], undefined, 15_000);
  const session = info?.result?.agent?.agent_session;
  if (session?.kind === "path" && typeof session.value === "string" && path.isAbsolute(session.value)) {
    const output = finalAssistantText(session.value);
    if (output) return output;
  }

  const read = await run(
    ["agent", "read", agent.name, "--source", "recent-unwrapped", "--lines", String(MAX_READ_LINES)],
    undefined,
    30_000,
  );
  if (read.code !== 0) throw commandError(["agent", "read", agent.name], read);
  return read.stdout.trim() || "(agent completed without readable output)";
}

async function closeAgent(run: Run, agent: RunningAgent): Promise<void> {
  // The parent has been paused in this awaited tool call. Once Herdr reports done,
  // close the whole tab, which also terminates the now-idle child agent.
  const result = await run(["tab", "close", agent.tabId], undefined, 15_000);
  await removePrompt(agent);
  if (result.code !== 0) throw commandError(["tab", "close", agent.tabId], result);
}

async function runTask(options: {
  run: Run;
  workspaceId: string;
  cwd: string;
  role: AgentConfig;
  task: string;
  timeoutMs: number;
  model?: string;
  thinking?: string;
  signal?: AbortSignal;
  onState?: (name: string, status: DisplayStatus, removeOnSettle?: boolean) => void;
}): Promise<TaskResult> {
  const name = makeShortName(options.role.name);
  options.onState?.(name, "launching");
  let agent: RunningAgent;
  try {
    agent = await launchAgent({ ...options, name });
  } catch (error) {
    options.onState?.(name, "error", true);
    throw error;
  }
  options.onState?.(name, "working");
  let done = false;
  try {
    const response = await checked(
      options.run,
      [
        "agent",
        "prompt",
        agent.name,
        `Subagent assignment from the parent agent:\n\n${options.task}\n\nReturn the result according to your subagent contract.`,
        "--wait",
        "--until",
        "idle",
        "--until",
        "done",
        "--timeout",
        String(options.timeoutMs),
      ],
      options.signal,
      options.timeoutMs + 10_000,
    );
    const settledStatus = response?.result?.agent?.agent_status;
    if (settledStatus !== "done" && settledStatus !== "idle") {
      throw new Error(`Agent ${agent.name} settled with unexpected status ${String(settledStatus)}`);
    }
    done = true;
    options.onState?.(name, "collecting");
    const output = await collectOutput(options.run, agent);
    await closeAgent(options.run, agent);
    options.onState?.(name, "done", true);
    return { name: agent.name, role: options.role.name, task: options.task, output };
  } catch (error) {
    // Aborted launches are cleaned up. On timeout/block/error, leave the tab open
    // so the user can inspect or resume it with herdr_agent_prompt.
    if (options.signal?.aborted) {
      await options.run(["tab", "close", agent.tabId], undefined, 15_000).catch(() => undefined);
      await removePrompt(agent);
      options.onState?.(name, "paused", true);
    } else if (done) {
      await options.run(["tab", "close", agent.tabId], undefined, 15_000).catch(() => undefined);
      await removePrompt(agent);
      options.onState?.(name, "error", true);
    } else {
      options.onState?.(name, "error", false);
    }
    throw error;
  }
}

const ScopeSchema = StringEnum(["user", "project", "both"] as const, { default: "user" });
const TaskSchema = Type.Object({
  agent: Type.String({ description: "Agent role (for example worker, scout, planner, or reviewer)" }),
  task: Type.String(),
  cwd: Type.Optional(Type.String()),
});

export default function herdrSubagentExtension(pi: ExtensionAPI) {
  const binary = process.env.HERDR_BIN_PATH || "herdr";
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  const run: Run = (args, signal, timeout) => pi.exec(binary, args, { signal, timeout });
  const displayAgents = new Map<string, DisplayAgent>();

  function refreshWidget(ctx: any): void {
    if (ctx.mode !== "tui") return;
    if (displayAgents.size === 0) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }

    ctx.ui.setWidget(WIDGET_ID, (_tui: any, theme: any) => ({
      render(width: number): string[] {
        if (width < 12) return [];
        const innerWidth = width - 2;
        const running = [...displayAgents.values()].filter((item) =>
          ["launching", "working", "collecting"].includes(item.status),
        ).length;
        const suffix = running > 0 ? `${running} running` : `${displayAgents.size} agent${displayAgents.size === 1 ? "" : "s"}`;
        const title = ` Subagents · ${suffix} `;
        const topPlain = `╭─${title}`;
        const top = theme.fg("accent", truncateToWidth(topPlain + "─".repeat(Math.max(0, width - visibleWidth(topPlain) - 1)) + "╮", width, ""));
        const lines = [top];

        for (const item of displayAgents.values()) {
          const icon = item.status === "done" ? "✓" : item.status === "error" ? "!" : item.status === "paused" ? "Ⅱ" : item.status === "waiting" ? "○" : "↻";
          const color = item.status === "done" ? "success" : item.status === "error" ? "error" : item.status === "paused" ? "warning" : item.status === "waiting" ? "muted" : "accent";
          const contentWidth = Math.max(1, innerWidth - 2);
          const left = `${theme.fg(color, icon)} ${theme.fg("text", item.name)} ${theme.fg("muted", `(${item.role})`)}`;
          const right = `${theme.fg(color, item.status)} ${theme.fg("dim", `· ${formatElapsed(item.startedAt)}`)}`;
          const rightWidth = visibleWidth(right);
          const leftWidth = Math.max(1, contentWidth - rightWidth - 1);
          const clippedLeft = truncateToWidth(left, leftWidth, "…");
          const gap = " ".repeat(Math.max(1, contentWidth - visibleWidth(clippedLeft) - rightWidth));
          const row = truncateToWidth(`${clippedLeft}${gap}${right}`, contentWidth, "");
          const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(row)));
          lines.push(`${theme.fg("accent", "│")} ${row}${padding} ${theme.fg("accent", "│")}`);
        }

        lines.push(theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
        return lines;
      },
      invalidate() {},
    }));
  }

  function setDisplayAgent(
    ctx: any,
    name: string,
    role: string,
    status: DisplayStatus,
    options: { task?: string; removeOnSettle?: boolean } = {},
  ): void {
    const previous = displayAgents.get(name);
    displayAgents.set(name, {
      name,
      role,
      task: options.task ?? previous?.task,
      status,
      startedAt: previous?.startedAt ?? Date.now(),
      removeOnSettle: options.removeOnSettle ?? previous?.removeOnSettle ?? false,
    });
    refreshWidget(ctx);
  }

  pi.on("agent_settled", (_event, ctx) => {
    for (const [name, item] of displayAgents) {
      if (item.removeOnSettle) displayAgents.delete(name);
    }
    refreshWidget(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    displayAgents.clear();
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);
  });

  function requireWorkspace(): string {
    if (!workspaceId || process.env.HERDR_ENV !== "1") {
      throw new Error("This extension must run inside a Herdr pane (HERDR_WORKSPACE_ID is missing)");
    }
    return workspaceId;
  }

  pi.registerTool({
    name: "subagent",
    label: "Herdr Subagent",
    description: "Delegate one task or parallel tasks to acknowledged Pi subagents in separate Herdr tabs. Each task uses herdr agent prompt, pauses this tool until the child reports its final result and settles idle/done, returns that report to the parent, and closes the child tab.",
    promptSnippet: "Delegate isolated work to Pi agents running in visible Herdr tabs",
    parameters: Type.Object({
      agent: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
      tasks: Type.Optional(Type.Array(TaskSchema, { maxItems: MAX_PARALLEL })),
      agentScope: Type.Optional(ScopeSchema),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 3_600_000, default: DEFAULT_TIMEOUT_MS })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const hasSingle = Boolean(params.agent && params.task);
      const hasParallel = Boolean(params.tasks?.length);
      if (Number(hasSingle) + Number(hasParallel) !== 1) {
        throw new Error("Provide exactly one mode: agent + task, or tasks");
      }
      const scope: AgentScope = params.agentScope ?? "user";
      const defaults = {
        run,
        workspaceId: requireWorkspace(),
        cwd: ctx.cwd,
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinking: ctx.thinkingLevel,
        signal,
      };

      if (hasSingle && params.agent && params.task) {
        const role = findRole(ctx.cwd, scope, params.agent);
        onUpdate?.({ content: [{ type: "text", text: `Launching ${role.name} in a Herdr tab…` }], details: {} });
        const result = await runTask({
          ...defaults,
          role,
          task: params.task,
          cwd: params.cwd ?? ctx.cwd,
          onState: (name, status, removeOnSettle) =>
            setDisplayAgent(ctx, name, role.name, status, { task: params.task, removeOnSettle }),
        });
        return { content: [{ type: "text", text: result.output }], details: { mode: "single", results: [result] } };
      }

      const tasks = params.tasks ?? [];
      onUpdate?.({ content: [{ type: "text", text: `Launching ${tasks.length} Herdr agents…` }], details: {} });
      const settled = await Promise.allSettled(
        tasks.map((item) =>
          (() => {
            const role = findRole(ctx.cwd, scope, item.agent);
            return runTask({
              ...defaults,
              role,
              task: item.task,
              cwd: item.cwd ?? ctx.cwd,
              onState: (name, status, removeOnSettle) =>
                setDisplayAgent(ctx, name, role.name, status, { task: item.task, removeOnSettle }),
            });
          })(),
        ),
      );
      const failures = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      const results = settled.filter((item): item is PromiseFulfilledResult<TaskResult> => item.status === "fulfilled").map((item) => item.value);
      const sections = results.map((item) => `### ${item.role} (${item.name})\n\n${item.output}`);
      for (const failure of failures) sections.push(`### Failed\n\n${failure.reason instanceof Error ? failure.reason.message : String(failure.reason)}`);
      return {
        content: [{ type: "text", text: `${results.length}/${tasks.length} agents completed\n\n${sections.join("\n\n---\n\n")}` }],
        details: { mode: "parallel", results, failures: failures.length },
      };
    },
    renderCall(args, theme) {
      const label = args.tasks?.length ? `${args.tasks.length} parallel tasks` : `${args.agent ?? "agent"}: ${args.task ?? "…"}`;
      return new Text(theme.fg("toolTitle", theme.bold("herdr subagent ")) + theme.fg("accent", label), 0, 0);
    },
  });

  pi.registerTool({
    name: "herdr_agent_launch",
    label: "Launch Herdr Agent",
    description: "Launch a named Pi agent in a new Herdr tab. The short name must match [a-z][a-z0-9_-]{0,31}. Optionally submit an initial prompt through herdr agent prompt without waiting.",
    parameters: Type.Object({
      name: Type.String(),
      agent: Type.String({ description: "Agent role" }),
      prompt: Type.Optional(Type.String()),
      agentScope: Type.Optional(ScopeSchema),
      cwd: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const role = findRole(ctx.cwd, params.agentScope ?? "user", params.agent);
      setDisplayAgent(ctx, params.name, role.name, "launching", { task: params.prompt });
      let agent: RunningAgent;
      try {
        agent = await launchAgent({
          run,
          workspaceId: requireWorkspace(),
          cwd: params.cwd ?? ctx.cwd,
          role,
          name: params.name,
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          thinking: ctx.thinkingLevel,
          signal,
        });
        if (params.prompt) {
          setDisplayAgent(ctx, params.name, role.name, "working");
          await checked(run, ["agent", "prompt", agent.name, params.prompt], signal, 30_000);
        } else {
          setDisplayAgent(ctx, params.name, role.name, "waiting");
        }
      } catch (error) {
        setDisplayAgent(ctx, params.name, role.name, "error", { removeOnSettle: true });
        throw error;
      }
      return {
        content: [{ type: "text", text: `Launched ${agent.name} (${role.name}) in tab ${agent.tabId}${params.prompt ? " and submitted the prompt" : ""}.` }],
        details: { name: agent.name, tabId: agent.tabId, paneId: agent.paneId, role: role.name },
      };
    },
  });

  pi.registerTool({
    name: "herdr_agent_prompt",
    label: "Prompt Herdr Agent",
    description: "Communicate with a live named subagent using herdr agent prompt. By default wait until Herdr reports idle or done, return its result to the parent, and close its tab.",
    parameters: Type.Object({
      name: Type.String(),
      prompt: Type.String(),
      wait: Type.Optional(Type.Boolean({ default: true })),
      closeOnDone: Type.Optional(Type.Boolean({ default: true })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 3_600_000, default: DEFAULT_TIMEOUT_MS })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireWorkspace();
      const before = await checked(run, ["agent", "get", params.name], signal, 15_000);
      const tabId = before?.result?.agent?.tab_id;
      const paneId = before?.result?.agent?.pane_id;
      if (typeof tabId !== "string" || typeof paneId !== "string") throw new Error("Agent lookup did not return its tab and pane IDs");
      const wait = params.wait ?? true;
      const previousRole = displayAgents.get(params.name)?.role ?? before?.result?.agent?.agent ?? "agent";
      setDisplayAgent(ctx, params.name, previousRole, "working", { task: params.prompt });
      const args = ["agent", "prompt", params.name, params.prompt];
      if (wait) {
        args.push(
          "--wait",
          "--until",
          "idle",
          "--until",
          "done",
          "--timeout",
          String(params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        );
      }
      const response = await checked(run, args, signal, wait ? (params.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 10_000 : 30_000);
      if (!wait) {
        return {
          content: [{ type: "text", text: `Prompt submitted to ${params.name}.` }],
          details: { name: params.name, tabId, paneId, status: "submitted", closed: false },
        };
      }

      const pseudoAgent: RunningAgent = {
        name: params.name,
        tabId,
        paneId,
        role: { name: "external", description: "", systemPrompt: "", source: "bundled", filePath: "" },
      };
      const status = response?.result?.agent?.agent_status ?? "idle";
      setDisplayAgent(ctx, params.name, previousRole, "collecting");
      const output = await collectOutput(run, pseudoAgent);
      // A successful wait is authoritative: the subagent has emitted its report and
      // settled. The parent now owns the result and can terminate the child tab.
      const shouldClose = params.closeOnDone ?? true;
      if (shouldClose) {
        await closeAgent(run, pseudoAgent);
        setDisplayAgent(ctx, params.name, previousRole, "done", { removeOnSettle: true });
      } else {
        setDisplayAgent(ctx, params.name, previousRole, "waiting");
      }
      return {
        content: [{ type: "text", text: output }],
        details: { name: params.name, tabId, paneId, status, closed: shouldClose },
      };
    },
  });

  pi.registerTool({
    name: "herdr_agent_pause",
    label: "Pause Herdr Agent",
    description: "Interrupt a live Herdr agent with ctrl+c. Optionally close its entire tab after interrupting it.",
    parameters: Type.Object({ name: Type.String(), closeTab: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      requireWorkspace();
      const info = await checked(run, ["agent", "get", params.name], signal, 15_000);
      const tabId = info?.result?.agent?.tab_id;
      await checked(run, ["agent", "send-keys", params.name, "ctrl+c"], signal, 15_000);
      const role = displayAgents.get(params.name)?.role ?? info?.result?.agent?.agent ?? "agent";
      if (params.closeTab) {
        if (typeof tabId !== "string") throw new Error("Agent lookup did not return a tab ID");
        await checked(run, ["tab", "close", tabId], undefined, 15_000);
        setDisplayAgent(ctx, params.name, role, "done", { removeOnSettle: true });
      } else {
        setDisplayAgent(ctx, params.name, role, "paused");
      }
      return { content: [{ type: "text", text: `${params.name} interrupted${params.closeTab ? `; tab ${tabId} closed` : ""}.` }], details: { name: params.name, tabId, closed: params.closeTab ?? false } };
    },
  });
}
