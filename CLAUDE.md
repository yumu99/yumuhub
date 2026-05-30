# yumuHub — Project Instructions for Claude Code

## What this is

A Tauri v2 desktop app (macOS) — a chat-native multi-agent hub that orchestrates LLM agents across providers (Anthropic, OpenAI, z.ai, CCR, Mock). Agents can spawn sub-agents, delegate work, use tools, and communicate via a shared message bus.

## Architecture

**Single-file frontend.** The entire React app lives in `src/YumuHub.jsx` (~7,800 LOC). There is no TypeScript, no component library, no CSS framework, no router. Inline styles via a `styles` object at the end of the file. Color palette in `c`, fonts in `fonts`.

**Rust backend.** `src-tauri/src/main.rs` (~1,200 LOC) handles filesystem, sandbox, IPC (inbox/outbox), debug logging, search proxies, CCR lifecycle, the `zai_anthropic_proxy`, and the **MCP client** subsystem (the first long-lived subprocess supervisor: `McpManager` = `Mutex<HashMap>` via `.manage()`, each server spawned in its own process group, per-server reader thread + `mpsc` channel, reaped on quit via `RunEvent::Exit`). Only added Cargo dep: `serde_json`.

**No tests.** Verification is done by building the app, launching it, and exercising features via the UI or the inbox/outbox protocol.

## Build & run

Always use the full quit-then-rebuild chain. `open` against a running app focuses the stale instance — you'll test old code without knowing it.

```sh
cd ~/yumuhub-workspace/yumuhub && source ~/.cargo/env && npx tauri build && \
  { osascript -e 'tell application "yumuHub" to quit' 2>/dev/null; sleep 1; } && \
  ditto src-tauri/target/release/bundle/macos/yumuHub.app /Applications/yumuHub.app && \
  xattr -cr /Applications/yumuHub.app && open /Applications/yumuHub.app
```

First build after clean: ~5 min. Incremental: ~25s.

Use `ditto`, never `cp -r` (cp nests the bundle inside itself).

## How to navigate the source

**Read `CODEMAP.md` first**, not the full source. It's a line-range index of every class, component, tool, and section. Grep for symbol names to confirm line numbers — they drift after edits.

Regenerate the codemap index:
```sh
grep -nE '^(class |function |const [A-Z][a-zA-Z]* = |// ─)' src/YumuHub.jsx
```

## Key architectural facts

- **All state is in localStorage.** Persistence keys prefixed `yumuhub:`. Chat messages stored per-chat. Optional disk mirror via `chatBackup` (idle-flush to `~/yumuhub-workspace/chats/`).
- **Universal system prompt** lives at `~/yumuhub-workspace/yumuHub.md` (not in the repo). Loaded at launch, editable in Settings. Currently a Workflows→Agents→Tools playbook with a `§5 PERSONALIZE` block.
- **Provider adapters** are in a `providers` object (~L1582–L1776). Each has `models`, `send(history, config, signal)`, and optional `noKeyRequired`.
- **z.ai anthropic endpoint** routes through a Rust curl proxy (`zai_anthropic_proxy`) because WebKit can't reach `api.z.ai/api/anthropic` directly. Non-streaming — response lands all at once.
- **Tool registration** happens in `registerBuiltinTools()` (~L900-ish; grep to confirm). Tools are `{ name, description, inputSchema, handler, category, harnessOnly? }` — the schema is JSON-Schema; the JS adapters convert it to each provider's expected shape. MCP tools register the same way (`mcp__<id>__<tool>` under category `mcp:<id>`) — categories are derived dynamically, so they appear in the agent editor + Tools view with no extra wiring.
- **AgentRuntime** is multi-tenant: one runtime per agent config, with per-chat histories, abort controllers, and status tracking.
- **debug_log gotcha** — anything routed through `debug_log` / `redact_secrets` (Rust) MUST be sliced on char boundaries. Both used to byte-slice a `String`, so any non-ASCII (emoji, accents, `…`) sliced mid-codepoint → panic across the FFI boundary → whole-app SIGABRT. Fixed; keep it that way when editing those paths.

## Editing guidelines

- **Edit `src/YumuHub.jsx` for almost everything.** Rust side (`main.rs`) only for filesystem ops, shell commands, and network proxies.
- **Don't split into multiple files.** The single-file architecture is intentional — it enables the `OWN_SOURCE` self-read and the `Improve source code` feature.
- **Don't add npm dependencies** unless explicitly asked. The app has only React, Tauri API, and Vite.
- **Use the `c` color palette** for all colors. Don't hardcode hex in component styles.
- **Styles go in the `styles` object** at the end of the file, not inline in JSX (except one-off overrides).
- **Action log event colors** (`ACTION_KIND_COLORS`) must use raw hex strings, not `c.<name>` refs.

## Testing via inbox/outbox

For headless testing without clicking through the UI:

```sh
# Send a message to an agent
echo '[{"agent_id":"agt_xxx","content":"Hello"}]' > ~/yumuhub-workspace/yumuhub-inbox.json

# Or to a chat
echo '[{"chat_id":"chat_xxx","content":"Hello"}]' > ~/yumuhub-workspace/yumuhub-inbox.json

# Watch replies
tail -f ~/yumuhub-workspace/yumuhub-outbox.jsonl
```

The inbox poller picks up messages within `pollSec` seconds and deletes the file. Each reply appends one JSON line to the outbox.

## Sandbox (self-editing)

Agents can read/write a beta copy of the app via `sandbox_*` tools. The sandbox lives at `~/yumuhub-workspace/yumuhub-beta/`. All paths are jail-checked by `resolve_in_sandbox` in Rust — no escaping the sandbox root.

## Other reference files

| File | Purpose |
|------|---------|
| `CODEMAP.md` | Line-range index of YumuHub.jsx and main.rs — read this before editing |
| `REBUILD.md` | Build chain with rationale for each step |
| `BACKLOG.md` | Feature backlog ranked by effort and strategic priority |
| `HANDOFF.md` | Session handoff state — what was done, what's open |
