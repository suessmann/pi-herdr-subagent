import { execFile } from "node:child_process";
import { promisify } from "node:util";
import extension from "../extensions/index.ts";

const execFileAsync = promisify(execFile);
const tools = new Map<string, any>();

const pi = {
  on() {},
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

extension(pi as any);
const context = { cwd: process.cwd(), model: undefined, thinkingLevel: "off" };
const subagent = tools.get("subagent");
const launch = tools.get("herdr_agent_launch");
const prompt = tools.get("herdr_agent_prompt");
if (!subagent || !launch || !prompt) throw new Error("Expected tools were not registered");

const result = await subagent.execute(
  "e2e-subagent",
  { agent: "worker", task: "Reply with exactly E2E_OK and nothing else.", timeoutMs: 180_000 },
  undefined,
  (update: any) => console.error(update.content?.[0]?.text ?? "update"),
  context,
);
const text = result.content?.[0]?.text ?? "";
console.log(text);
if (!text.includes("E2E_OK")) throw new Error(`Unexpected subagent result: ${text}`);

const name = `e2e-${Math.random().toString(36).slice(2, 7)}`;
await launch.execute("e2e-launch", { name, agent: "worker" }, undefined, undefined, context);
const prompted = await prompt.execute(
  "e2e-prompt",
  { name, prompt: "Reply with exactly PROMPT_OK and nothing else.", timeoutMs: 180_000 },
  undefined,
  undefined,
  context,
);
const promptedText = prompted.content?.[0]?.text ?? "";
console.log(promptedText);
if (!promptedText.includes("PROMPT_OK")) throw new Error(`Unexpected prompt result: ${promptedText}`);
if (prompted.details?.closed !== true) throw new Error("Prompted agent tab was not reported closed");
