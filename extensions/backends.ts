import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
export type Exec = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

/** Where a running child lives. For herdr-core, `paneId` is the terminal address. */
export interface AgentLocation {
  tabId: string;
  paneId: string;
  /** Program kind reported by the multiplexer, used as a fallback role label. */
  kind?: string;
}

export interface StartOptions {
  name: string;
  cwd: string;
  /** Arguments for the child `pi` process. */
  piArgs: string[];
  signal?: AbortSignal;
}

/** Final status of a turn; only "idle" and "done" mean the child settled normally. */
export type TurnStatus = string | undefined;

export interface SubagentBackend {
  readonly kind: "herdr" | "herdr-core";
  /** How the parent is addressed in the child's subagent contract. */
  parentTarget(): string;
  /** Start an interactive pi child and return once it accepts prompts. Cleans up on failure. */
  start(options: StartOptions): Promise<AgentLocation>;
  /** Submit a prompt; with `wait`, block until the turn settles and return its status. */
  prompt(
    name: string,
    text: string,
    options: { wait: boolean; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<TurnStatus>;
  /** Wait until the child stops working and return its status. */
  wait(name: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<TurnStatus>;
  locate(name: string, signal?: AbortSignal): Promise<AgentLocation>;
  /** Absolute path of the child's pi session file, if known. */
  sessionPath(name: string): Promise<string | undefined>;
  /** Recent screen text, the fallback when no session file is readable. */
  readScreen(name: string, lines: number): Promise<string>;
  /** End the child and remove its tab/terminal. */
  close(name: string, location: AgentLocation): Promise<void>;
  /** Stop the child's current turn without ending it. */
  interrupt(name: string, signal?: AbortSignal): Promise<void>;
}

const SHORT_TIMEOUT_MS = 15_000;
const CREATE_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 60_000;
const EXEC_GRACE_MS = 10_000;
/** Bound for waits without a caller timeout; herdr-core needs an explicit value. */
const UNBOUNDED_WAIT_MS = 24 * 60 * 60 * 1000;

export function parseLastJson(text: string, program = "Herdr"): any {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Ignore non-JSON diagnostics and keep looking.
    }
  }
  throw new Error(`${program} returned no JSON: ${text.trim() || "(empty output)"}`);
}

function commandError(program: string, args: string[], result: ExecResult): Error {
  const diagnostic = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`${program} ${args.join(" ")} failed: ${diagnostic}`);
}

function sessionDirFromEnv(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions");
}

/** Find `<anything>_<sessionId>.jsonl` one level below pi's per-cwd session directories. */
export function findSessionFile(sessionsDir: string, sessionId: string): string | undefined {
  const suffix = `_${sessionId}.jsonl`;
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = path.join(sessionsDir, project.name);
    const match = fs.readdirSync(dir).find((file) => file.endsWith(suffix));
    if (match) return path.join(dir, match);
  }
  return undefined;
}

function findOnPath(program: string, searchPath = process.env.PATH ?? ""): string | undefined {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, program);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Herdr (`herdr` CLI, tab/pane/agent API)
// ---------------------------------------------------------------------------

export class HerdrBackend implements SubagentBackend {
  readonly kind = "herdr";

  constructor(
    private readonly exec: Exec,
    private readonly binary: string,
    private readonly workspaceId: string,
  ) {}

  private run(args: string[], signal?: AbortSignal, timeout?: number): Promise<ExecResult> {
    return this.exec(this.binary, args, { signal, timeout });
  }

  private async json(args: string[], signal?: AbortSignal, timeout?: number): Promise<any> {
    const result = await this.run(args, signal, timeout);
    if (result.code !== 0) throw commandError("herdr", args, result);
    return parseLastJson(result.stdout);
  }

  parentTarget(): string {
    return process.env.HERDR_PANE_ID ?? "the parent Pi session";
  }

  async start(options: StartOptions): Promise<AgentLocation> {
    const created = await this.json(
      ["tab", "create", "--workspace", this.workspaceId, "--cwd", options.cwd, "--label", options.name, "--no-focus"],
      options.signal,
      CREATE_TIMEOUT_MS,
    );
    const tabId = created?.result?.tab?.tab_id;
    const paneId = created?.result?.root_pane?.pane_id;
    if (typeof tabId !== "string" || typeof paneId !== "string") {
      throw new Error("Herdr tab create response did not include tab and root pane IDs");
    }
    try {
      const startArgs = ["agent", "start", options.name, "--kind", "pi", "--pane", paneId, "--timeout", String(START_TIMEOUT_MS)];
      if (options.piArgs.length > 0) startArgs.push("--", ...options.piArgs);
      await this.json(startArgs, options.signal, START_TIMEOUT_MS + EXEC_GRACE_MS);
    } catch (error) {
      await this.run(["tab", "close", tabId], undefined, SHORT_TIMEOUT_MS).catch(() => undefined);
      throw error;
    }
    return { tabId, paneId };
  }

  async prompt(name: string, text: string, options: { wait: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<TurnStatus> {
    const args = ["agent", "prompt", name, text];
    if (!options.wait) {
      await this.json(args, options.signal, CREATE_TIMEOUT_MS);
      return undefined;
    }
    args.push("--wait", "--until", "idle", "--until", "done");
    if (options.timeoutMs) args.push("--timeout", String(options.timeoutMs));
    const response = await this.json(args, options.signal, options.timeoutMs ? options.timeoutMs + EXEC_GRACE_MS : undefined);
    return response?.result?.agent?.agent_status;
  }

  async wait(name: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<TurnStatus> {
    const args = ["agent", "wait", name, "--until", "idle", "--until", "done"];
    if (options.timeoutMs) args.push("--timeout", String(options.timeoutMs));
    const response = await this.json(args, options.signal, options.timeoutMs ? options.timeoutMs + EXEC_GRACE_MS : undefined);
    return response?.result?.agent?.agent_status ?? "idle";
  }

  async locate(name: string, signal?: AbortSignal): Promise<AgentLocation> {
    const info = await this.json(["agent", "get", name], signal, SHORT_TIMEOUT_MS);
    const agent = info?.result?.agent;
    if (typeof agent?.tab_id !== "string" || typeof agent?.pane_id !== "string") {
      throw new Error("Agent lookup did not return its tab and pane IDs");
    }
    return { tabId: agent.tab_id, paneId: agent.pane_id, kind: agent.agent };
  }

  async sessionPath(name: string): Promise<string | undefined> {
    const info = await this.json(["agent", "get", name], undefined, SHORT_TIMEOUT_MS);
    const session = info?.result?.agent?.agent_session;
    return session?.kind === "path" && typeof session.value === "string" && path.isAbsolute(session.value)
      ? session.value
      : undefined;
  }

  async readScreen(name: string, lines: number): Promise<string> {
    const args = ["agent", "read", name, "--source", "recent-unwrapped", "--lines", String(lines)];
    const result = await this.run(args, undefined, READ_TIMEOUT_MS);
    if (result.code !== 0) throw commandError("herdr", args, result);
    return result.stdout;
  }

  async close(_name: string, location: AgentLocation): Promise<void> {
    const args = ["tab", "close", location.tabId];
    const result = await this.run(args, undefined, SHORT_TIMEOUT_MS);
    if (result.code !== 0) throw commandError("herdr", args, result);
  }

  async interrupt(name: string, signal?: AbortSignal): Promise<void> {
    await this.json(["agent", "send-keys", name, "ctrl+c"], signal, SHORT_TIMEOUT_MS);
  }
}

// ---------------------------------------------------------------------------
// herdr-core (`hc`, used by the Herdr desktop app)
// ---------------------------------------------------------------------------

/** herdr-core exit code for an unknown terminal. */
const HC_NOT_FOUND = 3;
/** Set in every child so pane-persistence extensions can skip subagents. */
export const SUBAGENT_ENV = "PI_HERDR_SUBAGENT";
const SPACE_LABEL = "herdr.space";
const TAB_LABEL = "herdr.tab";
const ROLE_LABEL = "pi.subagent";

/**
 * Interpret the `wait` record of `hc wait` / `hc send --wait`. A settled turn
 * returns its status; anything else (timeout, exit, blocked, error) throws so
 * the child is left open for inspection.
 */
export function settledStatusFromHcWait(name: string, wait: any): string {
  const status = wait?.status;
  if (wait?.reason === "status" && (status === "idle" || status === "done")) return status;
  if (wait?.reason === "timeout") throw new Error(`Agent ${name} is still ${status ?? "working"} after the timeout`);
  if (wait?.ended && wait?.reason === "exit") {
    throw new Error(`Agent ${name} exited (code ${wait.exit_code ?? "?"}, signal ${wait.signal ?? "none"})`);
  }
  throw new Error(`Agent ${name} stopped with status ${String(status)} (${String(wait?.reason)})`);
}

function timeoutSeconds(timeoutMs: number | undefined): string {
  return String(Math.ceil((timeoutMs ?? UNBOUNDED_WAIT_MS) / 1000));
}

export class HerdrCoreBackend implements SubagentBackend {
  readonly kind = "herdr-core";
  private readonly sessionIds = new Map<string, string>();

  constructor(
    private readonly exec: Exec,
    private readonly binary: string,
    private readonly parentTerminal: string,
    private readonly piBinary: string,
    /** PATH for the child; herdr-core's own PATH usually lacks pi, node and user tools. */
    private readonly childPath = process.env.PATH ?? "",
    private readonly sessionsDir = sessionDirFromEnv(),
    /** A tab of its own per child (PI_SUBAGENT_TABS=1). Default: nested under the parent's terminal, no tab. */
    private readonly ownTabs = process.env.PI_SUBAGENT_TABS === "1",
  ) {}

  private run(args: string[], signal?: AbortSignal, timeout?: number): Promise<ExecResult> {
    return this.exec(this.binary, args, { signal, timeout });
  }

  private async json(args: string[], signal?: AbortSignal, timeout?: number): Promise<any> {
    // Right after the subcommand: anything after `--` belongs to the child program.
    const [command, ...rest] = args;
    const result = await this.run([command, "--json", ...rest], signal, timeout);
    if (result.code !== 0) throw commandError("herdr-core", args, result);
    return parseLastJson(result.stdout, "herdr-core");
  }

  parentTarget(): string {
    return `herdr-core terminal ${this.parentTerminal}`;
  }

  /** The parent's space: with a space label (and no tab), the desktop app gives the child a tab of its own. */
  private async parentSpace(signal?: AbortSignal): Promise<string | undefined> {
    const parent = await this.json(["get", this.parentTerminal], signal, SHORT_TIMEOUT_MS);
    const space = parent?.labels?.[SPACE_LABEL];
    return typeof space === "string" ? space : undefined;
  }

  async start(options: StartOptions): Promise<AgentLocation> {
    const sessionId = randomUUID();
    // Nested by default: a child of the parent's terminal without a space label stays
    // under the parent in the app's agent list (open it from there) and opens no tab.
    const args = ["run", "--bg", "--name", options.name, "--no-notify", "--cwd", options.cwd, "--label", `${ROLE_LABEL}=1`,
      "--parent", this.parentTerminal];
    if (this.ownTabs) {
      const space = await this.parentSpace(options.signal);
      if (space) args.push("--label", `${SPACE_LABEL}=${space}`);
    }
    args.push(
      "--",
      "/usr/bin/env",
      `${SUBAGENT_ENV}=1`,
      `PATH=${this.childPath}`,
      this.piBinary,
      "--session-id",
      sessionId,
      ...options.piArgs,
    );
    await this.json(args, options.signal, CREATE_TIMEOUT_MS);
    try {
      // pi reports `idle` once it accepts input; a prompt sent earlier can be dropped.
      const response = await this.json(["wait", options.name, "--timeout", timeoutSeconds(START_TIMEOUT_MS)], options.signal, START_TIMEOUT_MS + EXEC_GRACE_MS);
      settledStatusFromHcWait(options.name, response);
    } catch (error) {
      await this.forceClose(options.name);
      throw error;
    }
    this.sessionIds.set(options.name, sessionId);
    return this.locate(options.name, options.signal);
  }

  async prompt(name: string, text: string, options: { wait: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<TurnStatus> {
    if (!options.wait) {
      await this.json(["send", name, text], options.signal, CREATE_TIMEOUT_MS);
      return undefined;
    }
    const response = await this.json(
      ["send", "--wait", "--timeout", timeoutSeconds(options.timeoutMs), name, text],
      options.signal,
      (options.timeoutMs ?? UNBOUNDED_WAIT_MS) + EXEC_GRACE_MS,
    );
    return settledStatusFromHcWait(name, response?.wait);
  }

  async wait(name: string, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<TurnStatus> {
    const response = await this.json(
      ["wait", name, "--timeout", timeoutSeconds(options.timeoutMs)],
      options.signal,
      (options.timeoutMs ?? UNBOUNDED_WAIT_MS) + EXEC_GRACE_MS,
    );
    return settledStatusFromHcWait(name, response);
  }

  async locate(name: string, signal?: AbortSignal): Promise<AgentLocation> {
    const info = await this.json(["get", name], signal, SHORT_TIMEOUT_MS);
    if (typeof info?.address !== "string") throw new Error(`herdr-core lookup of ${name} returned no address`);
    const tab = info.labels?.[TAB_LABEL];
    return { tabId: typeof tab === "string" ? tab : info.address, paneId: info.address, kind: info.status?.app };
  }

  async sessionPath(name: string): Promise<string | undefined> {
    const sessionId = this.sessionIds.get(name);
    return sessionId ? findSessionFile(this.sessionsDir, sessionId) : undefined;
  }

  async readScreen(name: string, lines: number): Promise<string> {
    const args = ["read", name, "--lines", String(lines)];
    const result = await this.run(args, undefined, READ_TIMEOUT_MS);
    if (result.code !== 0) throw commandError("herdr-core", args, result);
    return result.stdout;
  }

  async close(name: string, _location: AgentLocation): Promise<void> {
    const kill = await this.run(["kill", "--json", name], undefined, SHORT_TIMEOUT_MS);
    if (kill.code !== 0 && kill.code !== HC_NOT_FOUND) throw commandError("herdr-core", ["kill", name], kill);
    const remove = await this.run(["rm", "--json", name], undefined, SHORT_TIMEOUT_MS);
    if (remove.code !== 0 && remove.code !== HC_NOT_FOUND) throw commandError("herdr-core", ["rm", name], remove);
    this.sessionIds.delete(name);
  }

  private async forceClose(name: string): Promise<void> {
    await this.close(name, { tabId: name, paneId: name }).catch(() => undefined);
  }

  async interrupt(name: string, signal?: AbortSignal): Promise<void> {
    await this.json(["interrupt", name], signal, SHORT_TIMEOUT_MS);
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type BackendKind = SubagentBackend["kind"];

/**
 * Pick the multiplexer the parent pi runs in. `PI_SUBAGENT_BACKEND` forces one;
 * otherwise herdr-core (desktop app) wins when both are present, since that is
 * the terminal the user is looking at.
 */
export function selectBackendKind(env: NodeJS.ProcessEnv): BackendKind {
  const forced = env.PI_SUBAGENT_BACKEND;
  if (forced === "herdr" || forced === "herdr-core") return forced;
  if (forced) throw new Error(`PI_SUBAGENT_BACKEND must be "herdr" or "herdr-core", got ${JSON.stringify(forced)}`);
  if (env.HC_TERMINAL_ID) return "herdr-core";
  if (env.HERDR_ENV === "1" && env.HERDR_WORKSPACE_ID) return "herdr";
  throw new Error(
    "This extension must run inside a Herdr pane (HERDR_WORKSPACE_ID) or a herdr-core terminal (HC_TERMINAL_ID)",
  );
}

function herdrCoreBinary(env: NodeJS.ProcessEnv): string {
  if (env.HC_BIN_PATH) return env.HC_BIN_PATH;
  const appInstalled = path.join(os.homedir(), ".local", "bin", "herdr-core");
  return fs.existsSync(appInstalled) ? appInstalled : "herdr-core";
}

/** The pi the parent runs: an explicit override, pi's managed launcher, then PATH. */
export function resolvePiBinary(env: NodeJS.ProcessEnv): string {
  if (env.PI_BIN_PATH) return env.PI_BIN_PATH;
  if (env.PI_MANAGED_INSTALL_ROOT) {
    const launcher = path.join(path.dirname(env.PI_MANAGED_INSTALL_ROOT), "bin", "pi");
    if (findOnPath("pi", path.dirname(launcher)) === launcher) return launcher;
  }
  const found = findOnPath("pi", env.PATH);
  if (!found) throw new Error("Cannot find the pi executable on PATH; set PI_BIN_PATH");
  return found;
}

export function createBackend(exec: Exec, env: NodeJS.ProcessEnv = process.env): SubagentBackend {
  const kind = selectBackendKind(env);
  if (kind === "herdr-core") {
    const terminal = env.HC_TERMINAL_ID;
    if (!terminal) throw new Error("PI_SUBAGENT_BACKEND=herdr-core requires a herdr-core terminal (HC_TERMINAL_ID)");
    return new HerdrCoreBackend(exec, herdrCoreBinary(env), terminal, resolvePiBinary(env), env.PATH ?? "");
  }
  const workspaceId = env.HERDR_WORKSPACE_ID;
  if (!workspaceId) throw new Error("PI_SUBAGENT_BACKEND=herdr requires a Herdr pane (HERDR_WORKSPACE_ID)");
  return new HerdrBackend(exec, env.HERDR_BIN_PATH || "herdr", workspaceId);
}
