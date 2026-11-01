// End-to-end check against the multiplexer this runs in: Herdr (HERDR_WORKSPACE_ID)
// or herdr-core / the Herdr desktop app (HC_TERMINAL_ID). Spawns real pi children.
// The children use a throwaway role without a model, so they run on pi's default model.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { selectBackendKind } from "../extensions/backends.ts";
import extension from "../extensions/index.ts";

const execFileAsync = promisify(execFile);
const E2E_ROLE = "e2e";
const TASK_TIMEOUT_MS = 180_000;
const NOTIFICATION_TIMEOUT_MS = 240_000;
const tools = new Map<string, any>();
let resolveBackgroundMessage: ((message: any) => void) | undefined;
const backgroundMessage = new Promise<any>((resolve) => {
  resolveBackgroundMessage = resolve;
});

const pi = {
  on() {},
  sendMessage(message: any) {
    resolveBackgroundMessage?.(message);
  },
  registerTool(tool: any) {
    tools.set(tool.name, tool);
  },
  async exec(command: string, args: string[], options: { signal?: AbortSignal; timeout?: number }) {
    try {
      const result = await execFileAsync(command, args, {
        signal: options.signal,
        timeout: options.timeout,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
    } catch (error: any) {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message ?? String(error),
        code: typeof error.code === "number" ? error.code : 1,
        killed: Boolean(error.killed),
      };
    }
  },
};

const project = mkdtempSync(join(tmpdir(), "pi-herdr-e2e-"));
mkdirSync(join(project, ".pi", "agents"), { recursive: true });
writeFileSync(
  join(project, ".pi", "agents", `${E2E_ROLE}.md`),
  `---\nname: ${E2E_ROLE}\ndescription: end-to-end test role\ntools: read\n---\nAnswer exactly as instructed.\n`,
);

try {
  console.error(`backend: ${selectBackendKind(process.env)}`);
  extension(pi as any);
  const context = { cwd: project, model: undefined, thinkingLevel: "off" };
  const subagent = tools.get("subagent");
  const launch = tools.get("herdr_agent_launch");
  if (!subagent || !launch) throw new Error("Expected tools were not registered");

  const result = await subagent.execute(
    "e2e-subagent",
    { agent: E2E_ROLE, agentScope: "project", task: "Reply with exactly E2E_OK and nothing else.", timeoutMs: TASK_TIMEOUT_MS },
    undefined,
    (update: any) => console.error(update.content?.[0]?.text ?? "update"),
    context,
  );
  const text = result.content?.[0]?.text ?? "";
  console.log(text);
  if (!text.includes("E2E_OK")) throw new Error(`Unexpected subagent result: ${text}`);
  if (!text.includes("REQUIRED NEXT STEP")) throw new Error("Subagent result did not require a parent summary");

  const name = `e2e-${Math.random().toString(36).slice(2, 7)}`;
  const launched = await launch.execute(
    "e2e-launch",
    {
      name,
      agent: E2E_ROLE,
      agentScope: "project",
      prompt: "Reply with exactly PROMPT_OK and nothing else.",
      timeoutMs: TASK_TIMEOUT_MS,
    },
    undefined,
    undefined,
    context,
  );
  if (launched.details?.watching !== true) throw new Error("Launch did not arm a background watcher");
  const notification = await Promise.race([
    backgroundMessage,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for parent notification")), NOTIFICATION_TIMEOUT_MS);
      timer.unref();
    }),
  ]);
  const promptedText = notification.content ?? "";
  console.log(promptedText);
  if (!promptedText.includes("PROMPT_OK")) throw new Error(`Unexpected background result: ${promptedText}`);
  if (!promptedText.includes("REQUIRED NEXT STEP")) throw new Error("Background result did not require a parent summary");
  if (notification.details?.closed !== true) throw new Error("Background watcher did not report the agent tab closed");
} finally {
  rmSync(project, { recursive: true, force: true });
}
