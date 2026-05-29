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

- Working tree **clean**; HEAD = `474f59a`, all pushed to `main`.
- App built + installed + relaunched at `/Applications/yumuHub.app`.
- ⌘K badge + command palette verified live via screenshot.

## Open items / next steps

- **DEFERRED — needs USER personalization:** redesign `~/yumuhub-workspace/yumuHub.md` (the universal system prompt) into a Workflows→Agent→Tools operational playbook (like nanoclaw.md / openclaw.md). Don't do unilaterally — the agent roster/workflow style is the user's call.
- **Architectural backlog (needs a decision, not "obvious gap"):** MCP transport adapter (~400–600 LOC, "highest leverage" per BACKLOG.md) → unlocks RAG + integrations + plugin ecosystem. Then auth/RBAC, visual workflow builder. All bigger than this sprint's scope.
- **Possible smaller polish:** in-chat `@agent` mentions in the composer; "continue generating" when output is truncated; LLM-generated concise titles (vs. the current first-48-chars slice).
- **CODEMAP.md drift:** header says ~6286 lines; file is now ~7,100. New symbols added this session (`CommandPalette`, `fmtTok`, `contextWindowFor`, `fmtMsgTime`, `fork`, `retry`, `sidebarKbdHint`). A full line-number re-audit is its own task — the file's header already says numbers are approximate (grep to confirm).

## Reference

- Codemap regen: `grep -nE '^(class |function |const [A-Z][a-zA-Z]* = |// ─)' src/YumuHub.jsx`
- Inbox/outbox protocol: write `[{"agent_id":"agt_xxx","content":"..."}]` (or `{"chat_id":...}`) to `~/yumuhub-workspace/yumuhub-inbox.json`; tail `~/yumuhub-workspace/yumuhub-outbox.jsonl`.
- Build + install: see "Build command" above. Never skip the `osascript … to quit` step.
