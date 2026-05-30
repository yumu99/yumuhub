## What we were doing

**Feature-parity sprint** against top chat UIs (ChatGPT, Claude, Claude Code, popular OSS multi-agent interfaces). Working autonomously under the directive: *"close all the obvious lacks of features"* — only pausing for things that need the user's personalization. Shipped 7 chat-UX features and confirmed many other "expected" features already existed.

## Shipped this session (all committed + pushed to `main`)

| Feature | Commit | Where |
|---------|--------|-------|
| **Context/token meter** in chat header (◔ pill, color-ramps at 65%/85%) | `3fb4f7b` | ChatView header; `fmtTok`/`contextWindowFor` helpers; `_toolLoop` stores `usage` |
| **⌘K command palette** (search chats/agents/actions, keyboard nav) | `2f4d637` | new `CommandPalette` component (before `// ─── STYLES ───`); `paletteOpen` state in App |
| **Fork from any message** (branch a new chat from a point) | `a8675cb` | `fork(idx)` in ChatView; user + assistant row buttons |
| **Retry on error** (replay last user message) | `c3dbd42` | `retry()` in ChatView; error banner button |
| **Per-message timestamps** (on hover) | `62ad7ab` | `fmtMsgTime()` helper; spans in user + assistant rows |
| **Keyboard shortcuts** ⌘N (new chat) · Esc (stop generation) | `7083899` | `kbdRef` + extended global keydown effect in App |
| **Shortcut discoverability** (⌘K badge in search; ⌘N/Esc in tooltips) | `474f59a` | `sidebarKbdHint` badge; `onOpenPalette` threaded App→Sidebar→SidebarChatSection |

## Phase 2 — bigger tracks (after "go ahead on all")

- **`yumuHub.md` → rev-2 playbook** (NOT in repo — lives at `~/yumuhub-workspace/yumuHub.md`; rev-1 backed up at `yumuHub.md.rev1.bak`). Full Workflows→Agents→Tools→Voice operating playbook grounded in the real 23 tools / 11 categories, with a marked **§5 PERSONALIZE** block for the user's roster. App reloads it from disk on launch.
- **MCP client adapter** — *shipped + verified end-to-end*. yumuHub now spawns external Model Context Protocol servers (stdio) and registers their tools as `mcp__<id>__<tool>`. **Rust** (`main.rs` ~L847–end): `McpManager` = `Mutex<HashMap<id,McpServer>>` via `.manage()`; `mcp_start`/`mcp_call_tool`/`mcp_stop`; per-server reader thread + `mpsc`; spawn via `zsh -l -c 'exec "$0" "$@"'`; added `serde_json` dep. **JS** (~L2609–2693): `registerMcpTools`/`startMcpServer`/`stopMcpServer`/`startEnabledMcpServers` + `PluginHost.unregisterByPrefix`; `McpServersSection` in Settings (L6490); `mcpServers` in `DEFAULT_SETTINGS`+`NESTED_SETTING_KEYS`. Verified via `/tmp/mock_mcp.py` (a minimal stdio MCP fixture) → `add(2,40)=42`, `echo` round-trip, both through the real `pluginHost.execute` path. Direction chosen: **client** (consume external servers) over server (expose ours), since that's what "unlock RAG/integrations/plugins" needs.
- **MCP hardening** (after a subagent deliberation flagged the subprocess supervisor as the thing to harden before widening): children spawn in their own **process group** (`process_group(0)`) and are reaped on quit via `kill_tree` (SIGTERM the group → no orphaned `npx→node` trees). macOS fires **`RunEvent::Exit`** on quit (NOT `ExitRequested` — that was the bug; the run-loop closure now matches both + `WindowEvent`). **stderr is captured** into a 4 KB tail and surfaced in failure messages (was `/dev/null` → silent timeouts). MCP `tools/call` output **capped at 100 KB**. Verified: stubborn fixture (`/tmp/mock_mcp_stub.py`, ignores stdin-EOF) is reaped on quit; bad command surfaces stderr.
- **Fixed a serious latent crash in `debug_log`/`redact_secrets`** (`main.rs`): both sliced a `String` on **byte** indices, so ANY non-ASCII char in a logged line (emoji, accents, CJK, the `…` we emit) sliced mid-codepoint → panic → **whole-app SIGABRT** across the command FFI boundary. Now char-boundary-safe (and `redact_secrets` no longer mojibakes multibyte via `bytes[i] as char`). Found because MCP stderr snippets contain `…`.

## Already existed (audited, NOT gaps)

Copy message (`CopyBtn`) · copy code block (`mdCodeCopy`) · scroll-to-bottom / "Jump to latest" (`stickToBottom`/`jumpToLatest`) · **content search across all chats** with snippets (`SidebarChatSection`, L~3072) · **auto-title** from first message (ChatView.send, L~3610) · whole-chat **export** MD+JSON (`exportChat`, L~3258) · **pin** to top (`onPin`) · **image paste** (multimodal, L~3541) · edit message · regenerate · stop · archive · rename. yumuHub was more complete than the brief implied.

## Key facts / constraints (still load-bearing)

- **Single-file frontend**: `src/YumuHub.jsx` (~7,100 LOC). No TS, no component lib, no router. Styles in the `styles` object at file end; palette in `c`, fonts in `fonts`.
- **React is NOT default-imported** — only named hooks (`useState, useEffect, useRef, useCallback, useReducer, Component, memo`). **`useMemo` is NOT imported** — compute inline. Use `` const Tag = `h${n}` `` JSX, never `React.createElement`.
- **No npm deps** unless explicitly asked.
- **App component** (~L6703): `useReducer` state `{agents, activeAgentId, activeChatId, view, runtimes, tick}`. Global keydown effect (~L6769) owns ⌘K/⌘N/Esc via `kbdRef.current` (refreshed each render just before `return`, ~L7036).
- **macOS-only** → ⌘ glyphs in shortcut hints are correct.
- **No native menu** binds ⌘N/Esc (confirmed in main.rs + tauri.conf.json) — the webview keydown listener gets them.

### Build command (mandatory form)
Always quit-then-relaunch — `open` against a running app focuses the stale instance:
```sh
cd ~/yumuhub-workspace/yumuhub && source ~/.cargo/env && npx tauri build && \
  { osascript -e 'tell application "yumuHub" to quit' 2>/dev/null; sleep 1; } && \
  ditto src-tauri/target/release/bundle/macos/yumuHub.app /Applications/yumuHub.app && \
  xattr -cr /Applications/yumuHub.app && open /Applications/yumuHub.app
```
`npx vite build` (~0.6s) for fast JS syntax validation before the full build.

## Where we are right now

- App built + installed + relaunched at `/Applications/yumuHub.app` (clean production build — TEMP-VERIFY reverted, confirmed no MCP-VERIFY lines in a fresh launch).
- Frontend now ~7,300 LOC; `main.rs` ~1,030 LOC (+`serde_json` dep, +`Cargo.lock` churn).
- ⌘K badge + palette verified via screenshot; MCP verified via debug-log round-trip.

## Standing directive from the user (IMPORTANT)

At any future "what should I build next?" fork, **do NOT stop to ask** — spawn subagents to deliberate the most natural path forward, then proceed autonomously. (Stated verbatim mid-session.)

## Open items / next steps

- **MCP follow-ups:** remote/SSE transport (stdio only today). No per-tool approval gating specific to MCP tools. **Next natural step (per subagent deliberation):** one-click preset servers (filesystem / fetch) in `McpServersSection`, with a pre-flight existence check so a missing binary gives a clear message. (Hardening already done — see below.)
- **`yumuHub.md` §5:** still has placeholder PERSONALIZE bullets — the user may want to fill in their real roster/house-style.
- **Possible smaller polish:** in-chat `@agent` mentions in the composer; "continue generating" on truncated output (needs `stop_reason` plumbed through the SSE parsers — not currently captured); LLM-generated concise titles (vs. the current first-48-chars slice).
- **Architectural backlog:** auth/RBAC, visual workflow builder (per BACKLOG.md). RAG is now reachable via MCP servers.
- **CODEMAP.md drift:** ranges predate recent sprints (JS ~7,300 LOC, Rust ~1,030). The file has a drift notice + accurate "Recent UI additions" and MCP blocks; a full re-audit is its own task.

## Reference

- Codemap regen: `grep -nE '^(class |function |const [A-Z][a-zA-Z]* = |// ─)' src/YumuHub.jsx`
- Inbox/outbox protocol: write `[{"agent_id":"agt_xxx","content":"..."}]` (or `{"chat_id":...}`) to `~/yumuhub-workspace/yumuhub-inbox.json`; tail `~/yumuhub-workspace/yumuhub-outbox.jsonl`.
- Build + install: see "Build command" above. Never skip the `osascript … to quit` step.
