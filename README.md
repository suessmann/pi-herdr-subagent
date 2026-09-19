# pi-herdr-subagent

A [Pi](https://github.com/earendil-works/pi-mono) extension that runs subagents through [Herdr agent automation](https://herdr.dev/docs/agent-automation/).

Unlike Pi's process-based subagent example, every child is a normal interactive Pi session in its own visible Herdr tab:

1. `herdr tab create` creates a tab and root pane.
2. `herdr agent start <short-name> --kind pi` starts the child.
3. A system-prompt contract tells the child that it is a subordinate agent whose final message is a report to the parent.
4. `herdr agent prompt` submits work and waits for Herdr's `idle` or `done` state.
5. The extension reads the child's report from its native Pi session and returns it as the parent tool result.
6. The parent-side extension closes the completed child tab.

The parent tool call remains paused while Herdr waits. The child prefixes normal delegated reports with `SUBAGENT_RESULT:` and becomes idle after reporting. A separate pause tool sends `ctrl+c` when an in-progress child must be interrupted.

In Pi's TUI, a compact **Subagents** widget appears directly above the prompt. It lists each managed agent's short name, role, lifecycle state, and elapsed time. Completed task agents remain visible as `done` until the parent turn settles; persistent agents remain listed until they are closed.

## Requirements

- Herdr 0.9.1 or newer
- Pi running inside a Herdr pane
- The official Pi lifecycle integration:

```bash
herdr integration install pi
```

## Install

```bash
pi install git:github.com/suessmann/pi-herdr-subagent
```

Restart Pi or run `/reload` after installation.

For local development:

```bash
pi -e ./extensions/index.ts
```

## Tools

### `subagent`

Compatible with the common Pi subagent shape:

```json
{ "agent": "worker", "task": "Implement the requested change" }
```

Run up to four tasks in parallel:

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find the authentication flow" },
    { "agent": "reviewer", "task": "Review the current diff" }
  ]
}
```

Each child gets a generated short live name such as `scout-k3m9x`. Successful children are closed after Herdr reports `idle` or `done` and the parent has collected the final report. Accepting both states is important because a completion already observed by a Herdr client is represented as `idle`. A timed-out or blocked child is intentionally left visible so it can be inspected and resumed.

### `herdr_agent_launch`

Launch a persistent child in a new tab with an explicit short name:

```json
{ "name": "api-review", "agent": "reviewer", "prompt": "Inspect the API changes" }
```

Names follow Herdr's `[a-z][a-z0-9_-]{0,31}` rule.

### `herdr_agent_prompt`

Communicate with a live child through `herdr agent prompt`:

```json
{ "name": "api-review", "prompt": "Now focus on authorization" }
```

By default it waits for `done`, returns the final response, and closes the child's tab. Set `wait: false` for fire-and-forget communication or `closeOnDone: false` to keep the tab.

### `herdr_agent_pause`

Interrupt the active turn with `ctrl+c`:

```json
{ "name": "api-review" }
```

Set `closeTab: true` to close the tab after interrupting.

## Agent definitions

Bundled roles: `worker`, `scout`, `planner`, and `reviewer`.

Override them with Markdown definitions in:

- `~/.pi/agent/agents/*.md`
- `.pi/agents/*.md` when `agentScope` is `project` or `both`

```markdown
---
name: reviewer
description: Reviews a change
tools: read, grep, find, ls, bash
model: anthropic/claude-sonnet-4-5
---

Review for correctness and regressions. Do not edit files.
```

User definitions override bundled definitions. Project definitions override both when enabled. If a role omits `model`, it inherits the parent's active model and thinking level.

## Failure behavior

- Startup failures close the newly created tab.
- User cancellation closes the child tab.
- Timeout, blocked state, or prompt errors leave the tab open for inspection.
- Successful `idle`/`done` tasks are read first and then closed by the parent-side tool.
- `agent prompt --wait` does not identify individual turns when prompting an already-working agent; this is a Herdr semantic documented in its agent automation guide.

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
