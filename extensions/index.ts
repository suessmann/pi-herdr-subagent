import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { type AgentLocation, createBackend, parseLastJson, type SubagentBackend } from "./backends.ts";

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_PARALLEL = 4;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_READ_LINES = 400;

interface RunningAgent extends AgentLocation {
  name: string;
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

function requireParentSummary(report: string): string {
  return [
    "The subagent has finished and its Herdr tab has been closed.",
    "",
    report,
    "",
    "REQUIRED NEXT STEP: Summarize the subagent's findings for the user in your own words. Highlight the answer, material findings, changes, and caveats as applicable. Do not end the turn with only this tool result.",
  ].join("\n");
}

export function parseHerdrJson(text: string): any {
  return parseLastJson(text);
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

async function writeSystemPrompt(role: AgentConfig, name: string, parentTarget: string): Promise<{ dir: string; file: string }> {
  const contract = [
    "# Herdr subagent contract",
    "",
    `You are subagent \`${name}\`, delegated by the parent Pi agent at \`${parentTarget}\`.`,
    "You are not the primary user-facing agent. Complete only the delegated assignment.",
    "Messages from the parent may arrive wrapped in `<hc from=\"...\">` tags; treat them as the parent's instructions.",
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

async function removePrompt(agent: { promptFile?: string; promptDir?: string }): Promise<void> {
  if (agent.promptFile) await fs.promises.rm(agent.promptFile, { force: true }).catch(() => undefined);
  if (agent.promptDir) await fs.promises.rm(agent.promptDir, { recursive: true, force: true }).catch(() => undefined);
}

function findRole(cwd: string, scope: AgentScope, name: string): AgentConfig {
  const roles = discoverAgents(cwd, scope);
  const role = roles.find((candidate) => candidate.name === name);
  if (role) return role;
  throw new Error(`Unknown agent role ${JSON.stringify(name)}. Available: ${roles.map((item) => item.name).join(", ") || "none"}`);
}

function externalRole(name: string): AgentConfig {
  return { name, description: "", systemPrompt: "", source: "bundled", filePath: "" };
}

async function launchAgent(options: {
  backend: SubagentBackend;
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

  const prompt = await writeSystemPrompt(options.role, name, options.backend.parentTarget());
  try {
    const piArgs: string[] = [];
    const model = options.role.model ?? options.model;
    if (model) piArgs.push("--model", model);
    const thinking = options.role.thinking ?? (!options.role.model ? options.thinking : undefined);
    if (thinking) piArgs.push("--thinking", thinking);
    if (options.role.tools?.length) piArgs.push("--tools", options.role.tools.join(","));
    piArgs.push("--append-system-prompt", prompt.file);

    const location = await options.backend.start({ name, cwd: options.cwd, piArgs, signal: options.signal });
    return { ...location, name, role: options.role };
  } finally {
    // Pi reads --append-system-prompt during startup; start() returns only once
    // the child is initialized (or has been cleaned up after a failure).
    await removePrompt({ promptFile: prompt.file, promptDir: prompt.dir });
  }
}

async function collectOutput(backend: SubagentBackend, agent: RunningAgent): Promise<string> {
  const sessionPath = await backend.sessionPath(agent.name);
  if (sessionPath) {
    const output = finalAssistantText(sessionPath);
    if (output) return output;
  }
  const screen = await backend.readScreen(agent.name, MAX_READ_LINES);
  return screen.trim() || "(agent completed without readable output)";
}

async function closeAgent(backend: SubagentBackend, agent: RunningAgent): Promise<void> {
  // The parent has been paused in this awaited tool call. Once the child settles,
  // close it, which also terminates the now-idle child agent.
  try {
    await backend.close(agent.name, agent);
  } finally {
    await removePrompt(agent);
  }
}

async function runTask(options: {
  backend: SubagentBackend;
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
    const settledStatus = await options.backend.prompt(
      agent.name,
      `Subagent assignment from the parent agent:\n\n${options.task}\n\nReturn the result according to your subagent contract.`,
      { wait: true, timeoutMs: options.timeoutMs, signal: options.signal },
    );
    if (settledStatus !== "done" && settledStatus !== "idle") {
      throw new Error(`Agent ${agent.name} settled with unexpected status ${String(settledStatus)}`);
    }
    done = true;
    options.onState?.(name, "collecting");
    const output = await collectOutput(options.backend, agent);
    await closeAgent(options.backend, agent);
    options.onState?.(name, "done", true);
    return { name: agent.name, role: options.role.name, task: options.task, output };
  } catch (error) {
    // Aborted launches are cleaned up. On timeout/block/error, leave the tab open
    // so the user can inspect or resume it with herdr_agent_prompt.
    if (options.signal?.aborted) {
      await closeAgent(options.backend, agent).catch(() => undefined);
      options.onState?.(name, "paused", true);
    } else if (done) {
      await closeAgent(options.backend, agent).catch(() => undefined);
      options.onState?.(name, "error", true);
    } else {
      options.onState?.(name, "error", false);
    }
    throw error;
  }
}

const ScopeSchema = StringEnum(["user", "project", "both"] as const, { default: "user" });
const TaskSchema = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Agent role. Defaults to worker; explicit roles are always respected." }),
  ),
  task: Type.String(),
  cwd: Type.Optional(Type.String()),
});

export default function herdrSubagentExtension(pi: ExtensionAPI) {
  let backend: SubagentBackend | undefined;
  // Created on first use so loading the extension outside Herdr does not fail.
  function getBackend(): SubagentBackend {
    backend ??= createBackend((command, args, options) => pi.exec(command, args, options));
    return backend;
  }
  const displayAgents = new Map<string, DisplayAgent>();
  const backgroundWatches = new Map<string, AbortController>();

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

  async function monitorLaunchedAgent(
    agent: RunningAgent,
    prompt: string,
    ctx: any,
    options: { closeOnComplete: boolean; timeoutMs?: number },
  ): Promise<void> {
    const controller = new AbortController();
    backgroundWatches.get(agent.name)?.abort();
    backgroundWatches.set(agent.name, controller);

    try {
      const backend = getBackend();
      await backend.prompt(agent.name, prompt, { wait: true, timeoutMs: options.timeoutMs, signal: controller.signal });
      if (controller.signal.aborted) return;

      setDisplayAgent(ctx, agent.name, agent.role.name, "collecting");
      const output = await collectOutput(backend, agent);
      if (options.closeOnComplete) {
        await closeAgent(backend, agent);
        setDisplayAgent(ctx, agent.name, agent.role.name, "done", { removeOnSettle: true });
      } else {
        setDisplayAgent(ctx, agent.name, agent.role.name, "waiting");
      }

      pi.sendMessage(
        {
          customType: "herdr-subagent-result",
          content: requireParentSummary(output),
          display: true,
          details: {
            name: agent.name,
            role: agent.role.name,
            tabId: agent.tabId,
            paneId: agent.paneId,
            closed: options.closeOnComplete,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      setDisplayAgent(ctx, agent.name, agent.role.name, "error");
      const message = error instanceof Error ? error.message : String(error);
      try {
        pi.sendMessage(
          {
            customType: "herdr-subagent-result",
            content: `Background subagent ${agent.name} failed: ${message}. Its tab was left open for inspection. Summarize this failure for the user.`,
            display: true,
            details: { name: agent.name, role: agent.role.name, tabId: agent.tabId, paneId: agent.paneId, closed: false },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch {
        // The parent session may have shut down while the background wait was finishing.
      }
    } finally {
      if (backgroundWatches.get(agent.name) === controller) backgroundWatches.delete(agent.name);
    }
  }

  pi.on("agent_settled", (_event, ctx) => {
    for (const [name, item] of displayAgents) {
      if (item.removeOnSettle) displayAgents.delete(name);
    }
    refreshWidget(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    for (const controller of backgroundWatches.values()) controller.abort();
    backgroundWatches.clear();
    displayAgents.clear();
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);
  });


  pi.registerTool({
    name: "subagent",
    label: "Herdr Subagent",
    description: "Delegate one task or parallel tasks to acknowledged Pi subagents in separate Herdr tabs. The default role is worker (GPT-5.6 Terra, medium); always use another role when the user requests one. Each task uses herdr agent prompt, pauses this tool until the child reports its final result and settles idle/done, returns that report to the parent, and closes the child tab.",
    promptSnippet: "Delegate isolated work to Pi agents running in visible Herdr tabs",
    promptGuidelines: [
      "After subagent completes, always summarize its findings for the user in your own words before ending the turn.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
      tasks: Type.Optional(Type.Array(TaskSchema, { maxItems: MAX_PARALLEL })),
      agentScope: Type.Optional(ScopeSchema),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 3_600_000, default: DEFAULT_TIMEOUT_MS })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const hasSingle = Boolean(params.task);
      const hasParallel = Boolean(params.tasks?.length);
      if (Number(hasSingle) + Number(hasParallel) !== 1) {
        throw new Error("Provide exactly one mode: task (agent defaults to worker), or tasks");
      }
      const scope: AgentScope = params.agentScope ?? "user";
      const defaults = {
        backend: getBackend(),
        cwd: ctx.cwd,
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinking: ctx.thinkingLevel,
        signal,
      };

      if (hasSingle && params.task) {
        const role = findRole(ctx.cwd, scope, params.agent ?? "worker");
        onUpdate?.({ content: [{ type: "text", text: `Launching ${role.name} in a Herdr tab…` }], details: {} });
        const result = await runTask({
          ...defaults,
          role,
          task: params.task,
          cwd: params.cwd ?? ctx.cwd,
          onState: (name, status, removeOnSettle) =>
            setDisplayAgent(ctx, name, role.name, status, { task: params.task, removeOnSettle }),
        });
        return {
          content: [{ type: "text", text: requireParentSummary(result.output) }],
          details: { mode: "single", results: [result] },
        };
      }

      const tasks = params.tasks ?? [];
      onUpdate?.({ content: [{ type: "text", text: `Launching ${tasks.length} Herdr agents…` }], details: {} });
      const settled = await Promise.allSettled(
        tasks.map((item) =>
          (() => {
            const role = findRole(ctx.cwd, scope, item.agent ?? "worker");
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
        content: [
          {
            type: "text",
            text: requireParentSummary(
              `${results.length}/${tasks.length} agents completed\n\n${sections.join("\n\n---\n\n")}`,
            ),
          },
        ],
        details: { mode: "parallel", results, failures: failures.length },
      };
    },
    renderCall(args, theme) {
      const label = args.tasks?.length ? `${args.tasks.length} parallel tasks` : `${args.agent ?? "worker"}: ${args.task ?? "…"}`;
      return new Text(theme.fg("toolTitle", theme.bold("herdr subagent ")) + theme.fg("accent", label), 0, 0);
    },
  });

  pi.registerTool({
    name: "herdr_agent_launch",
    label: "Launch Herdr Agent",
    description: "Launch a named Pi agent in a new Herdr tab. With an initial prompt, a background watcher waits for idle/done, collects the final report, optionally closes the tab, and wakes the parent with a structured result. Set notifyParent false only for deliberate fire-and-forget operation.",
    promptGuidelines: [
      "Use herdr_agent_launch with its default notifyParent behavior for persistent work so completed reports wake the parent automatically.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Short live name matching [a-z][a-z0-9_-]{0,31}" }),
      agent: Type.String({ description: "Agent role" }),
      prompt: Type.Optional(Type.String()),
      notifyParent: Type.Optional(
        Type.Boolean({ description: "Watch an initial prompt and wake the parent with its result. Default: true.", default: true }),
      ),
      closeOnComplete: Type.Optional(
        Type.Boolean({ description: "Close the child tab after its report is collected. Defaults to the role's auto-exit setting, then true.", default: true }),
      ),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 86_400_000 })),
      agentScope: Type.Optional(ScopeSchema),
      cwd: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const role = findRole(ctx.cwd, params.agentScope ?? "user", params.agent);
      setDisplayAgent(ctx, params.name, role.name, "launching", { task: params.prompt });
      let agent: RunningAgent;
      try {
        agent = await launchAgent({
          backend: getBackend(),
          cwd: params.cwd ?? ctx.cwd,
          role,
          name: params.name,
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          thinking: ctx.thinkingLevel,
          signal,
        });
        if (params.prompt) {
          setDisplayAgent(ctx, params.name, role.name, "working");
          if (params.notifyParent ?? true) {
            void monitorLaunchedAgent(agent, params.prompt, ctx, {
              closeOnComplete: params.closeOnComplete ?? role.autoExit ?? true,
              timeoutMs: params.timeoutMs,
            });
          } else {
            await getBackend().prompt(agent.name, params.prompt, { wait: false, signal });
          }
        } else {
          setDisplayAgent(ctx, params.name, role.name, "waiting");
        }
      } catch (error) {
        setDisplayAgent(ctx, params.name, role.name, "error", { removeOnSettle: true });
        throw error;
      }
      const watching = Boolean(params.prompt && (params.notifyParent ?? true));
      return {
        content: [
          {
            type: "text",
            text: `Launched ${agent.name} (${role.name}) in tab ${agent.tabId}${params.prompt ? " and submitted the prompt" : ""}.${watching ? " A background watcher will collect the completed report and wake this parent session." : ""}`,
          },
        ],
        details: {
          name: agent.name,
          tabId: agent.tabId,
          paneId: agent.paneId,
          role: role.name,
          watching,
          closeOnComplete: watching ? (params.closeOnComplete ?? role.autoExit ?? true) : false,
        },
      };
    },
  });

  pi.registerTool({
    name: "herdr_agent_prompt",
    label: "Prompt Herdr Agent",
    description: "Communicate with a live named subagent using herdr agent prompt. By default wait until Herdr reports idle or done, return its result to the parent, close its tab, and require a user-facing summary.",
    promptGuidelines: [
      "After herdr_agent_prompt returns a completed report, always summarize its findings for the user before ending the turn.",
    ],
    parameters: Type.Object({
      name: Type.String(),
      prompt: Type.String(),
      wait: Type.Optional(Type.Boolean({ default: true })),
      closeOnDone: Type.Optional(Type.Boolean({ default: true })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 3_600_000, default: DEFAULT_TIMEOUT_MS })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const backend = getBackend();
      const { tabId, paneId, kind } = await backend.locate(params.name, signal);
      const wait = params.wait ?? true;
      const previousRole = displayAgents.get(params.name)?.role ?? kind ?? "agent";
      setDisplayAgent(ctx, params.name, previousRole, "working", { task: params.prompt });
      const settledStatus = await backend.prompt(params.name, params.prompt, {
        wait,
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal,
      });
      if (!wait) {
        return {
          content: [{ type: "text", text: `Prompt submitted to ${params.name}.` }],
          details: { name: params.name, tabId, paneId, status: "submitted", closed: false },
        };
      }

      const pseudoAgent: RunningAgent = { name: params.name, tabId, paneId, role: externalRole("external") };
      const status = settledStatus ?? "idle";
      setDisplayAgent(ctx, params.name, previousRole, "collecting");
      const output = await collectOutput(backend, pseudoAgent);
      // A successful wait is authoritative: the subagent has emitted its report and
      // settled. The parent now owns the result and can terminate the child tab.
      const shouldClose = params.closeOnDone ?? true;
      if (shouldClose) {
        await closeAgent(backend, pseudoAgent);
        setDisplayAgent(ctx, params.name, previousRole, "done", { removeOnSettle: true });
      } else {
        setDisplayAgent(ctx, params.name, previousRole, "waiting");
      }
      return {
        content: [{ type: "text", text: shouldClose ? requireParentSummary(output) : output }],
        details: { name: params.name, tabId, paneId, status, closed: shouldClose },
      };
    },
  });

  pi.registerTool({
    name: "herdr_agent_wait",
    label: "Wait for Herdr Agent",
    description: "Wait for an already-running named subagent to become idle/done, collect its final report, optionally close its tab, and return the report for a user-facing parent summary.",
    promptGuidelines: [
      "After herdr_agent_wait returns, summarize the collected subagent findings for the user before ending the turn.",
    ],
    parameters: Type.Object({
      name: Type.String(),
      closeOnDone: Type.Optional(Type.Boolean({ default: true })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 10_000, maximum: 86_400_000 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const backend = getBackend();
      const { tabId, paneId, kind } = await backend.locate(params.name, signal);
      const role = displayAgents.get(params.name)?.role ?? kind ?? "agent";
      setDisplayAgent(ctx, params.name, role, "working");
      const status = await backend.wait(params.name, { timeoutMs: params.timeoutMs, signal });
      setDisplayAgent(ctx, params.name, role, "collecting");
      const agent: RunningAgent = { name: params.name, tabId, paneId, role: externalRole(role) };
      const output = await collectOutput(backend, agent);
      const shouldClose = params.closeOnDone ?? true;
      if (shouldClose) {
        await closeAgent(backend, agent);
        setDisplayAgent(ctx, params.name, role, "done", { removeOnSettle: true });
      } else {
        setDisplayAgent(ctx, params.name, role, "waiting");
      }
      return {
        content: [{ type: "text", text: requireParentSummary(output) }],
        details: {
          name: params.name,
          tabId,
          paneId,
          status: status ?? "idle",
          closed: shouldClose,
        },
      };
    },
  });

  pi.registerTool({
    name: "herdr_agent_pause",
    label: "Pause Herdr Agent",
    description: "Interrupt a live Herdr agent with ctrl+c. Optionally close its entire tab after interrupting it.",
    parameters: Type.Object({ name: Type.String(), closeTab: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const backend = getBackend();
      const location = await backend.locate(params.name, signal);
      const tabId = location.tabId;
      await backend.interrupt(params.name, signal);
      const role = displayAgents.get(params.name)?.role ?? location.kind ?? "agent";
      if (params.closeTab) {
        await backend.close(params.name, location);
        setDisplayAgent(ctx, params.name, role, "done", { removeOnSettle: true });
      } else {
        setDisplayAgent(ctx, params.name, role, "paused");
      }
      return { content: [{ type: "text", text: `${params.name} interrupted${params.closeTab ? `; tab ${tabId} closed` : ""}.` }], details: { name: params.name, tabId, closed: params.closeTab ?? false } };
    },
  });
}
