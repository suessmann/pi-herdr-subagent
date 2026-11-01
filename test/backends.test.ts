import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type Exec,
  type ExecResult,
  findSessionFile,
  HerdrCoreBackend,
  resolvePiBinary,
  SUBAGENT_ENV,
  selectBackendKind,
  settledStatusFromHcWait,
} from "../extensions/backends.ts";

const PARENT = "t1";
const SPACE = "sp-test";
const PI_BIN = "/opt/pi/bin/pi";
const HC_BIN = "/opt/hc";

function ok(value: unknown): ExecResult {
  return { stdout: `${JSON.stringify(value)}\n`, stderr: "", code: 0, killed: false };
}

/** Fake herdr-core: records calls and answers by subcommand. */
function fakeHc(answers: Record<string, ExecResult>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    assert.equal(command, HC_BIN);
    calls.push(args);
    const answer = answers[args[0]];
    if (!answer) throw new Error(`unexpected hc ${args.join(" ")}`);
    return answer;
  };
  return { exec, calls };
}

test("selectBackendKind prefers herdr-core, honours the override and rejects unknown hosts", () => {
  const herdr = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" };
  assert.equal(selectBackendKind(herdr), "herdr");
  assert.equal(selectBackendKind({ ...herdr, HC_TERMINAL_ID: PARENT }), "herdr-core");
  assert.equal(selectBackendKind({ HC_TERMINAL_ID: PARENT, PI_SUBAGENT_BACKEND: "herdr" }), "herdr");
  assert.throws(() => selectBackendKind({}), /Herdr pane/);
  assert.throws(() => selectBackendKind({ PI_SUBAGENT_BACKEND: "tmux" }), /PI_SUBAGENT_BACKEND/);
});

test("settledStatusFromHcWait accepts settled turns and rejects everything else", () => {
  assert.equal(settledStatusFromHcWait("a", { reason: "status", status: "done" }), "done");
  assert.equal(settledStatusFromHcWait("a", { reason: "status", status: "idle" }), "idle");
  assert.throws(() => settledStatusFromHcWait("a", { reason: "timeout", status: "working" }), /after the timeout/);
  assert.throws(() => settledStatusFromHcWait("a", { reason: "status", status: "blocked" }), /blocked/);
  assert.throws(() => settledStatusFromHcWait("a", { reason: "exit", ended: true, exit_code: 1 }), /exited/);
});

test("findSessionFile locates a session by id across project directories", () => {
  const sessionId = "0000-abcd";
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-sessions-"));
  mkdirSync(join(dir, "--a--"));
  mkdirSync(join(dir, "--b--"));
  writeFileSync(join(dir, "--a--", "2026_other.jsonl"), "");
  writeFileSync(join(dir, "--b--", `2026_${sessionId}.jsonl`), "");
  assert.equal(findSessionFile(dir, sessionId), join(dir, "--b--", `2026_${sessionId}.jsonl`));
  assert.equal(findSessionFile(dir, "missing"), undefined);
  assert.equal(findSessionFile(join(dir, "nope"), sessionId), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("HerdrCoreBackend starts pi beside the parent and waits until it accepts input", async () => {
  const name = "worker-abc12";
  const address = "t9";
  const { exec, calls } = fakeHc({
    get: ok({ address, labels: { "herdr.space": SPACE }, status: { app: "pi" } }),
    run: ok({ address, name }),
    wait: ok({ reason: "status", status: "idle", ended: true }),
  });
  const childPath = "/parent/bin:/usr/bin";
  const backend = new HerdrCoreBackend(exec, HC_BIN, PARENT, PI_BIN, childPath);
  const piArgs = ["--model", "m", "--append-system-prompt", "/tmp/s.md"];

  const location = await backend.start({ name, cwd: "/work", piArgs });

  assert.deepEqual(location, { tabId: address, paneId: address, kind: "pi" });
  const run = calls.find((args) => args[0] === "run");
  assert.ok(run);
  assert.equal(run[1], "--json", "--json must precede the child's argv");
  assert.ok(run.includes(`herdr.space=${SPACE}`));
  const child = run.slice(run.indexOf("--") + 1);
  assert.deepEqual(child.slice(0, 4), ["/usr/bin/env", `${SUBAGENT_ENV}=1`, `PATH=${childPath}`, PI_BIN]);
  assert.equal(child[4], "--session-id");
  assert.deepEqual(child.slice(6), piArgs);
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["get", "run", "wait", "get"],
    "the child must report idle before start() returns",
  );
});

test("resolvePiBinary prefers the override, then pi's managed launcher, then PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-herdr-bin-"));
  const managedBin = join(root, "agent", "bin");
  const pathBin = join(root, "path-bin");
  for (const dir of [managedBin, pathBin]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pi"), "#!/bin/sh\n", { mode: 0o755 });
  }
  const managed = { PI_MANAGED_INSTALL_ROOT: join(root, "agent", "install"), PATH: pathBin };
  assert.equal(resolvePiBinary({ ...managed, PI_BIN_PATH: PI_BIN }), PI_BIN);
  assert.equal(resolvePiBinary(managed), join(managedBin, "pi"));
  assert.equal(resolvePiBinary({ PATH: pathBin }), join(pathBin, "pi"));
  assert.throws(() => resolvePiBinary({ PATH: join(root, "empty") }), /PI_BIN_PATH/);
  rmSync(root, { recursive: true, force: true });
});

test("HerdrCoreBackend removes a child that never becomes ready", async () => {
  const { exec, calls } = fakeHc({
    get: ok({ address: PARENT, labels: {} }),
    run: ok({ address: "t9" }),
    wait: ok({ reason: "exit", ended: true, exit_code: 1 }),
    kill: ok({}),
    rm: ok({}),
  });
  const backend = new HerdrCoreBackend(exec, HC_BIN, PARENT, PI_BIN);
  await assert.rejects(backend.start({ name: "w", cwd: "/", piArgs: [] }), /exited/);
  assert.deepEqual(calls.slice(-2).map((args) => args[0]), ["kill", "rm"]);
});
