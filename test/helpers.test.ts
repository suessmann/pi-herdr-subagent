import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finalAssistantText, makeShortName, parseHerdrJson } from "../extensions/index.ts";

test("parseHerdrJson returns the final JSON record", () => {
  assert.deepEqual(parseHerdrJson("diagnostic\n{\"result\":{\"ok\":true}}\n"), { result: { ok: true } });
});

test("makeShortName returns a valid short Herdr name", () => {
  const name = makeShortName("Code Reviewer!!!", "abc12");
  assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.equal(name, "code-reviewer-abc12");
});

test("makeShortName truncates to 32 characters", () => {
  assert.equal(makeShortName("a".repeat(80), "12345").length, 32);
});

test("finalAssistantText reads the latest textual assistant message", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-test-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "final" }] } }),
    ].join("\n"),
  );
  assert.equal(finalAssistantText(file), "final");
  rmSync(dir, { recursive: true, force: true });
});
