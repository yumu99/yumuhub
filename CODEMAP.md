# yumuHub Coding Map

A line-range index of the source. **Re-read this file (not the whole source) when planning a small edit** — then `sandbox_read` only the slice you need.

> Line numbers are approximate. Off-by-a-few is normal after edits — search for the symbol name to confirm.

---

## `src/YumuHub.jsx` (~7,100 lines)

> **Line-number drift notice:** the per-section ranges below predate several feature sprints and now run ~800 lines low in the later sections (e.g. `ChatView` is actually ~L3452, not L2655). Treat every range as approximate and `grep` the symbol name to confirm. Symbols added in the most recent UX sprint are listed accurately under **"Recent UI additions"** below.

### Imports & build-time source embed — **L1–L9**
- L1 React imports
- L2 `OWN_SOURCE` — Vite `?raw` import of this file (build-time inline)
- L4–L9 `DIAGNOSE_SOURCE` — `OWN_SOURCE` with the `const styles = {…}` object stripped, so smaller models fit when Self-Diagnose runs

### Persistence (localStorage) — **L11–L67**
- `STORAGE` — key prefix constants (`AGENTS`, `VAULT`, `VAULT_GROUPS`, `VAULT_META`, `VAULT_ORDER`, `CHAT_MSGS`, `CHATS`, `PROJECTS`, `ACTIVE`, `SETTINGS`, `HANDOFF`, `HIST`)
- `persist` — save/load Agents, Vault (keys + groups + meta + order), per-chat messages, chats/projects indexes, active state, settings, handoff snapshots
- L56–L58 `newId(prefix)` + `chatTopic(id)` helpers

### Universal system prompt (`universal` singleton) — **L69–L91**
- Cached in memory + localStorage; disk source of truth at `~/yumuHub.md`
- Methods: `load()`, `save(text)`, `reveal()` (opens in Finder via Tauri)
- L93 `AGENT_PREAMBLE` — max-6-word status before every action

### Constants — **L93–L132**
- L98 `BLUNT_PREAMBLE` — social_context=0, politeness=0 override
- L100–L115 `MODEL_CATEGORY_COLORS` / `MODEL_CATEGORY_LABELS` — color + label maps for model categories (reasoning/language/vision/image/video/recognition)
- L117–L132 `providersWithKeys(vault)` — returns Set of provider ids that have at least one matching vault key. **Always includes `mock` + `ccr`** (noKeyRequired providers)

### User settings (`settings` singleton) — **L134–L218**
- `DEFAULT_SETTINGS` (L135) — `idleSec`, `maxTurns`, `loopLimit`, `pollSec`, `bluntMode`, `handoffMode` (archive|delete|keep), `archivePurgeDays` (null = never), `colors` (notifications + agentIdle/agentBusy + vaultUnused/One/Many/Overloaded), `protection` (doubleClickVaultDelete, exitWithoutSavingNotice, doubleClickActionLogClear), `dismissedNotices` (array of stable notice IDs).
- L185 `NESTED_SETTING_KEYS` — `["colors", "protection", "contentFilter", "toolApprovals", "diskPersistence", "evalHarness"]`
- `settings.current` is the merged live values. Nested objects are merged on load/set so new keys inherit defaults.
- `noticeIsDismissed(id)` / `dismissNotice(id)` (L212–L218) — universal "never show again" helpers.
- CCR-specific persisted keys: `ccrUrl`, `ccrApiKey`, `ccrConfig` (tiers map)

### Core classes — **L220–L755**

| Class | Range | Notes |
|---|---|---|
| `MessageBus` | L221–L239 | Inbox map, pub/sub by topic, addressed routing, change listeners |
| `Vault` | L242–L259 | Keys persisted to localStorage; `vault://keys/<handle>` references. `meta` field holds per-key metadata (group, quarantined). `resolve()` returns null for quarantined keys. |
| `Notifier` | L261–L269 | Shared listener base class |
| `ChatRegistry` | L271–L385 | Chat/project CRUD + message persistence. Methods include: `createChat`, `updateChat`, `archiveChat`, `purgeOldArchived(days)`, `deleteChat`, `getChat`, `getMessages`, `saveMessages`, `clearMessages`, `setResponder`, project CRUD, `migrateFromLegacy`. **Chat shape has `pinned: bool`, `archivedAt: ts`, `overrides: { model?, tools? } | null`.** |
| `ActionLog` | L387–L441 | Persistent chronological action log (localStorage-backed, 2000-entry cap). API: `record`, `startHarness`, `recordCall`, `recordReply`, `recordSpawn`, `recordSpawnReply`, `recordError`, `recordToolCall`, `recordToolResult`, `getAll`, `clear`, `archive()`, `getArchived()`, `purgeArchive()`. |
| `SearchStats` | L442–L464 | Per-backend usage counter (Brave/Tavily monthly quota tracking) |
| `titleFromHistory` | L465–L471 | Extracts short title from first user message |
| `levenshtein` | L473–L490 | Edit distance for fuzzy model matching |
| `closestModelSuggestion` | L491–L504 | Finds closest model id from candidate list |
| `estimateCost` | L517–L519 | Per-model cost lookup from `COST_PER_1K` rate table (L508) |
| `CostStats` | L521–L561 | Per-agent cost / token / latency stats. `record()`, `totals()`, `perModel()`, `timeline()`. |
| `evaluateContentFilter` | L565–L577 | Pre-send guardrail. Evaluates patterns against text. |
| `ApprovalQueue` | L581–L627 | Human-in-the-loop tool approval. Promise-based gate with `enqueue()` / `approve()` / `reject()`. |
| `AgentVersions` | L629–L668 | Agent config version history (snapshots on save). `push()`, `list()`, `restore()`. |
| `chatBackup` | L672–L695 | Idle-flush chat backup to disk via Tauri `chat_backup_{read,write,list}`. `schedule()`, `flush()`. |
| `ToolGate` | L700–L714 | Global tool deny-list. `toggle(name)` / `has(name)` / `enableAll()`. Persisted as `yumuhub:toolsDisabled`. |
| `HiddenModels` | L716–L733 | Per-provider display filter for model pickers. `toggle(provider, id)` / `has(provider, id)`. |
| `PluginHost` | L735–L755 | Tool registry + execute. Holds refs to runtimes, spawn/remove/update callbacks, agent list provider. |

### `pickSubagentKey(parent, vault, runtimes)` — **L757–L770**
- Picks an idle vault key that's not the parent's. Returns `{ keyRef, note }`.

### Built-in tools (`registerBuiltinTools`) — **L772–L1427**

| Tool | Range | Category | Notes |
|---|---|---|---|
| `calc` | L773–L790 | math | Sandboxed expression eval |
| `web_search` | L791–L858 | web | DuckDuckGo Instant Answer API. Message tells agents NOT to retry with reworded queries |
| `file_read` | L859–L882 | files | File picker dialog → read text contents. Accept list: `.txt,.md,.json,.js,…` text formats only |
| `send_to_agent` | L884–L913 | agents | Calls `target.chat()`; bubbles `parentResetIdleTimer`. `harnessOnly: true` |
| `spawn_agent` | L915–L990 | agents | Creates child agent with idle key. **Hard cap: 6 concurrent** (`SPAWN_CAP` L914). Case-insensitive model lookup. `harnessOnly: true` |
| `list_agents` | L991–L1001 | agents | One-line summary per agent |
| `remove_agent` | L1002–L1023 | agents | Removes ephemeral children only |
| `list_models` | L1024–L1047 | agents | All models across providers, shows key availability + categories |
| `configure_agent` | L1048–L1103 | agents | Reconfigure tools/model/provider/systemPrompt/bluntMode. Case-insensitive model lookup |
| `sandbox_status` | L1104–L1113 | self-edit | Tauri `beta_status` |
| `sandbox_init` | L1114–L1123 | self-edit | Tauri `clone_sandbox` |
| `sandbox_read` | L1124–L1137 | self-edit | Tauri `beta_read` |
| `sandbox_list` | L1138–L1153 | self-edit | Tauri `beta_list` |
| `sandbox_write` | L1154–L1180 | self-edit | Tauri `beta_write` (saves `.bak`) |
| `truth_only` | L1181–L1203 | reasoning | Re-answer with social_context=0 via transient no-tools sub-call |
| `adhd_reason` | L1204–L1259 | reasoning | Surface K tangentially-related angles via transient sub-call |
| `pick_audio_file` | L1260–L1289 | media | File picker → `{name, mime, size, base64}`, 25MB cap |
| `zai_transcribe` | L1290–L1327 | media | `glm-asr-2512`, POST `/api/paas/v4/audio/transcriptions` |
| `zai_image` | L1328–L1361 | media | `cogView-4-250304` or `glm-image`, POST `/api/paas/v4/images/generations` |
| `zai_video` | L1362–L1427 | media | `cogvideox-3` default, async polling with 5s interval, 5-min cap |

z.ai helpers (L1235–L1259): `resolveZaiKey(ctx, keyHandle)`, `formatZaiError(status, body)` — auto-appends billing hint on balance errors.

### Multimodal content converters — **L1428–L1449**
- `toAnthropicContent(content)` (L1431) — maps `{type:"image", base64, mime}` → Anthropic image source format
- `toOpenAIContent(content)` (L1440) — maps `{type:"image", base64, mime}` → OpenAI image_url format
- Strings and non-array values pass through unchanged

### History ↔ provider format converters — **L1450–L1499**
- L1450 `toAnthropicMessages` — uses `toAnthropicContent` for user msgs; handles `tool_use` blocks in assistant, `tool_result` in user
- L1474 `toOpenAIMessages` — uses `toOpenAIContent`; flattens tool calls into `tool_calls[]`, results into role=`tool`

### SSE streaming — **L1500–L1580**
- L1501 `readSSE` — generic SSE line-parser, respects AbortSignal
- L1527 `postProvider` — shared POST + error wrapper
- L1533 `streamOpenAICompatible` — used by both OpenAI and z.ai

### Provider adapters — **L1576–L1776**
- L1576 `normalizeModels` — coerces bare string ids into `{id, label, category, description}` objects
- L1582 `providers` object:
  - L1584 `anthropic` — own SSE handler (content_block_start / _delta). Models: claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5
  - **L1634 `ccr`** — Claude Code Router (local daemon). `noKeyRequired: true`. Speaks Anthropic SSE format, hits `${settings.ccrUrl}/v1/messages`. Auth via `settings.ccrApiKey` as `Authorization: Bearer`. Models: `default`, `background`, `think`, `longContext`, `webSearch`
  - L1692 `openai` — GPT-4o, GPT-4o-mini
  - L1708 `zai` — OpenAI-compatible, 27 models across 6 categories (reasoning/language/vision/image/video/recognition)
  - L1759 `mock` — synthetic word-by-word stream

### `AgentRuntime` class — **L1778–L2079**
- Constructor — multi-tenant: `histories[chatId]`, `statuses[chatId]`, `_aborts[chatId]`, `_transient` set. Holds `this.registry` ref for chat-overrides lookup.
- Per-chat accessors: `getHistory(chatId)`, `setHistory(chatId, msgs)`, `statusOf(chatId)`, `anyBusy()`, `dropChat(chatId)`
- `notifyStream()` — rAF-coalesced notification for streaming
- `abort(chatId)` — sets `_abortReason="user"` and aborts fetch
- `_finish(chatId, status)` — persist + update status
- **`chat(userMessage, opts)`** — main entry. Reads `chat.overrides` from registry: `effectiveModel = ov.model || this.config.model`, `effectiveAgent = { ...this.config, tools: ov.tools }` when present.
- **`_toolLoop`** — `MAX_TURNS` from settings (L1973), loop detection via signature comparison. Records tool_call / tool_result to ActionLog.
- `clearHistory(chatId)`, `destroy()`

### Globals & seed data — **L2080–L2142**
- L2080 singletons: `bus`, `vault`, `pluginHost`, `registry`, `actionLog` + `registerBuiltinTools(pluginHost)`
- L2088 `SEED_AGENTS` — Receptionist, Research, Coder, Media Studio, Self-Editor
- L2117 `pickDefaultResponder(agents)` — Receptionist by id/name, or first
- L2128 `migrateAgents(list)` — ensures agents with spawn_agent also get list_agents + remove_agent + list_models + configure_agent

### Reducer & icons — **L2143–L2182**
- L2144 `appReducer` — `SET_AGENTS|SET_ACTIVE|SET_VIEW|SET_RUNTIMES|SET_ACTIVE_CHAT|TICK`
- L2157 `Icon` — inline SVG sprite (send, plus, settings, chat, bus, key, trash, bot, inbox, wand, x, tool, paperclip, file, search, refresh, chevL, chevR, chevD, stop, grip)

### Helpers — **L2184–L2219**
- L2185 `computeDiff(a, b)` — LCS-based line diff. 400k cell cap → fallback
- L2206 `detectMedia(result)` — matches media URLs/data-URIs for inline image/video rendering

### React components

| Component | Range | What it owns |
|---|---|---|
| `ToolCallCard` | L2221–L2275 | Collapsible card showing input/output; inline image/video preview via `detectMedia` |
| `Sidebar` | L2276–L2325 | Brand block, workspace nav (chat/agents/tools/bus/vault/settings), collapse/expand |
| `SidebarChatSection` | L2326–L2500 | SESSIONS section: projects + ungrouped chats + archived toggle + `+ Chat` / `+ Project` buttons. Pinned-first sort. Drag-to-reorder sessions + drag-to-project. |
| `relTime` | L2501–L2510 | Relative timestamp helper |
| `RowMenu` | L2511–L2529 | Hover popover menu, click-outside-to-dismiss |
| `ChatRow` | L2530–L2592 | Single chat in sidebar: status dot, pin/unpin, rename, archive/delete, move-to-project, drag handles |
| `ProjectFolder` | L2593–L2641 | Collapsible project folder with child chats + drop target |
| `HandoffBubble` | L2642–L2654 | Auto-archive handoff seed bubble. Collapsed-by-default. |
| **`ChatView`** | L2655–L3142 | Full chat panel: header (Customize/Stop/Diagnose/Handoff/Clear), agent picker, message list, **multimodal paste**, file/image/document attachments, **drag-and-drop file attachment** (`onFileDrop` + binary file detection via `BINARY_EXTS` + `isBinaryFile`). **Binary files (.docx, .xlsx, .pptx, .pdf, .zip, etc.) read as base64 via `readAsDataURL`; text files read as text.** Per-chat customize panel (model + tools overrides). Handoff branches on `settings.handoffMode`. |
| `AgentEditorToolGroup` | L3143–L3180 | Collapsible category block with three-state master checkbox |
| `AgentEditor` | L3181–L3335 | Form: name, provider, model, key, prompt, temperature, categorized tool selection. `onDirtyChange` for auto-close. |
| `AgentVersionHistory` | L3336–L3379 | Collapsible version list with restore button |
| `AgentMiniChat` | L3380–L3427 | Mini input + last-2-messages preview embedded in agent cards |
| `AgentsView` | L3428–L3466 | Grid of agent cards with working dot, edit, mini-chat |
| `ToolRow` | L3467–L3520 | One tool: global checkbox + expandable per-agent grant grid, drag handles |
| `ToolCategory` | L3521–L3589 | Collapsible group of ToolRows by category, drag-to-reorder |
| `ToolsView` | L3590–L3676 | All tools grouped by category |
| `formatDateKey` / `formatDateLabel` | L3677–L3690 | Date grouping helpers for action log |
| `ACTION_KIND_COLORS` / `_ICONS` | L3666–L3676 | Color + glyph maps for action-log event kinds. **Must use raw hex, not `c.<name>` refs.** |
| `BusView` (Action Log) | L3691–L3840 | Live action log + filter + date grouping. Clear archives (soft) instead of permanent-delete. Collapsible archived section. |
| `UsageOverview` | L3841–L3909 | Consolidated LLM totals + search-backend cards under one collapsible "Usage" header |
| `SearchKeyCard` | L3910–L3953 | Per-backend (Brave/Tavily) usage card with monthly counter, key add/remove |
| `VaultView` | L3954–L4369 | Key management: semantic status dots, bulk actions (Group/Delete/Quarantine/Replace), key grouping with subgroups, drag-and-drop keys, quarantine, soft-delete with restore drawer. |
| `ImproveSourceSection` | L4370–L4556 | "Improve source code" — routes through a user-picked agent. Focus prompt picker, diff view |
| `CcrSection` | L4557–L4844 | CCR setup wizard. `CCR_TEMPLATES` (L4507) + `CCR_TIERS` (L4550). Tier selector, URL config, Test/Apply, daemon lifecycle. Auto-generates APIKEY. `pickKeyForProvider` distributes vault keys. |
| `ModelSelectionSection` / `ProviderModelGroup` | L4845–L4931 | Settings → Model selection. Collapsible per-provider with three-state master, category colors. |
| `ObservabilitySection` | L4933–L5074 | Per-agent latency / tokens / cost / error rate panel |
| `GuardrailsSection` | L5075–L5186 | Pre-send content filter + tool approval gates |
| `DiskPersistenceSection` | L5187–L5210 | Mirror chat messages to disk on idle |
| `EvalHarnessSection` | L5211–L5340 | Run prompt suites against an agent and score replies |
| `SettingsView` | L5341–L5621 | idleSec/maxTurns/loopLimit/pollSec, bluntMode, handoffMode, archivePurgeDays, status colors, CCR, model selection, protection toggles, universal prompt, ImproveSourceSection. Reset → 8s Undo banner. Tracks `settingsDirty` via `onDirtyChange`. |
| `ViewBoundary` | L5622–L5636 | Error boundary with retry button |

### Recent UI additions (chat-UX parity sprint) — *accurate line numbers*

| Symbol | Line | What it is |
|---|---|---|
| `fmtTok(n)` | L3276 | Compact token count formatter (e.g. `12.4k`). |
| `contextWindowFor(provider, model)` | L3285 | Context-window size lookup for the header meter. |
| `fmtMsgTime(ts)` | L3295 | Per-message timestamp formatter (time today, else `Mon D, time`). |
| `ChatView` | L3452 | (was listed above at the stale L2655) — now also hosts the **◔ context meter** (header), **`fork(idx)`** (L3745, branch a new chat from a message), **`retry()`** (L3763, replay last user msg from the error banner), and per-message **timestamps**. |
| `CommandPalette` | L7174 | ⌘K palette: fuzzy-search chats/agents/actions + nav, arrow-key navigation, `onOpenPalette` opens it. |
| `sidebarKbdHint` (style) | L7484 | The `⌘K` badge shown in the empty sidebar search; click opens the palette. |

**App-level keyboard wiring** (in `YumuHub`, see Root component below): `kbdRef` (useRef, refreshed each render just before `return`) + the global keydown effect (~L6769) own **⌘K** (palette toggle), **⌘N** (new chat), **Esc** (close palette / abort active generation). `onOpenPalette` is threaded App → `Sidebar` → `SidebarChatSection`.

### MCP client adapter (external Model Context Protocol tool servers)

yumuHub is an **MCP client**: it spawns external MCP servers as stdio subprocesses (Rust side) and registers their tools into the same `pluginHost` as built-ins. Because tool categories are derived dynamically, MCP tools appear in the Agent editor + Tools view with no extra UI wiring, and their `inputSchema` flows unchanged to every provider.

| Symbol | Line | What it is |
|---|---|---|
| `PluginHost.unregister` / `unregisterByPrefix` | L853–L854 | Drop a tool, or all tools under a prefix (used to clear an MCP server's tools on restart/stop). |
| `// ─── MCP client ───` block | L2609–L2693 | All JS-side MCP plumbing. |
| `formatMcpResult(raw)` | L2623 | Parse the JSON-RPC `result` string from Rust → plain text; throws on `isError`. |
| `registerMcpTools(serverId, tools)` | L2640 | Register discovered tools as `mcp__<id>__<tool>` (category `mcp:<id>`); handler routes to `mcp_call_tool`. |
| `startMcpServer(server)` / `stopMcpServer(id)` | L2662 / L2677 | Spawn+handshake+register / kill+unregister. `mcpStatus` (L2620) holds per-server `{running, toolCount, error}`. |
| `startEnabledMcpServers()` | L2685 | Launch hook — starts every server with `enabled:true`. Called from an App `useEffect`. |
| `McpServersSection` | L6490 | Settings UI: per-server id/label/command/args/env, Start/Stop, auto-start checkbox. Modeled on `EvalHarnessSection`. |

Persistence: `DEFAULT_SETTINGS.mcpServers = { servers: [{ _uid, id, label, command, argsText, envText, enabled }] }` (in `NESTED_SETTING_KEYS`). Rust side: see `mcp_start` / `mcp_call_tool` / `mcp_stop` in main.rs.

### Root component (`YumuHub`) — **L5638–L5987**
- `useReducer` initial state + migration
- Wires `pluginHost` callbacks (spawn / remove / update)
- Subscribes to `registry` + `actionLog` → TICK
- Loads `universal` from disk on launch
- Auto-purge sweeper: `useEffect` runs `registry.purgeOldArchived(archivePurgeDays)` on launch + hourly
- Persists `activeChatId` + `sidebarCollapsed`; marks active chat as "seen"
- Syncs runtimes ↔ agents
- **Inbox poller** — every `pollSec` s, routes `{chat_id|agent_id, content}` into `runtime.chat`. Replies → `~/yumuhub-outbox.jsonl`.
- `editing` + `editorDirty` state, `maybeCloseEditor()` (auto-close clean editor on nav)
- `settingsDirty` + `navConfirm` + `navGuard(action)` — intercepts nav when settings dirty
- Draft chat + `startDraftChat` / `createNewChat` / `promoteDraft`
- JSX: Sidebar + main view router wrapped in `ViewBoundary`. `ApprovalModal` rendered at root.

### `ApprovalModal` — **L5988–L6014**
- Renders the human-in-the-loop tool approval dialog from `approvalQueue`.

### `NavConfirmModal` — **L6015–L6036**
- Modal shown when navigating away from dirty settings. "Never show again" checkbox.

### Styles — **L6037–end**
- L6038 `fonts` — display / mono / body family map
- L6039 `c` — color palette (`ink`, `paper`, `paper2`, `rust`, `rustDeep`, `moss`, `gold`, `sky`, `line`)
- L6041 `borderLight`, L6042 `baseSmallBtn` — shared style fragments
- L6044 `styles` — single object. Scrollbar CSS in the inline `<style>` block: 9px with 3px gap. `chatRow`, `projectHeader`, `navItem` have `userSelect: "none"`.

---

## `src-tauri/src/main.rs` (~1,030 lines)

> Line numbers in this table predate the MCP subsystem and are approximate — grep to confirm. The MCP client (~L847–end) is documented at the bottom of the table.

| Region | Range | Notes |
|---|---|---|
| `workspace_root` | L6 | `$HOME/yumuhub-workspace` |
| `sandbox_root` / `live_root` | L11–L17 | `workspace/yumuhub-beta` and `workspace/yumuhub` |
| `resolve_in_sandbox` | L19–L42 | Canonicalizes + checks `starts_with(sandbox)`. **All beta_\* commands path through this.** |
| `beta_read` | L44–L48 | |
| `beta_write` | L50–L74 | Saves `.bak` before overwriting |
| `beta_list` | L76–L90 | |
| `beta_status` | L91–L102 | |
| `copy_dir_excluding` | L104–L125 | Recursive copy with name-based skip list |
| `clone_sandbox` | L127–L143 | Excludes `node_modules`, `target`, `dist`, `.git`, `.DS_Store` |
| `inbox_path` | L145–L148 | `$WORKSPACE/yumuhub-inbox.json` |
| `inbox_pop` | L149–L160 | Reads file, **deletes it**, returns contents (or `[]` if missing) |
| `outbox_path` | L162–L165 | `$WORKSPACE/yumuhub-outbox.jsonl` |
| `outbox_append` | L166–L178 | Appends a JSON-line reply |
| `debug_path` | L180–L183 | `$WORKSPACE/yumuhub-debug.log` |
| `universal_path` | L185–L188 | `$HOME/yumuHub.md` |
| `read_universal` | L189–L195 | Reads the universal prompt file |
| `write_universal` | L196–L202 | Writes the universal prompt file |
| `reveal_universal` | L203–L217 | Opens `~/yumuHub.md` in Finder via `open -R` |
| `open_url` | L218–L225 | Opens a URL in the default browser |
| `urlencode` | L227–L241 | URL-encodes a string for query params |
| `brave_search` | L242–L288 | Server-side Brave Web Search API call (avoids CORS) |
| `ccr_config_path` | L289–L296 | Returns `~/.claude-code-router/config.json` path |
| `run_login_shell` | L297–L306 | Runs a command through `/bin/zsh -l -c` to inherit user PATH |
| `ccr_write_config` | L307–L320 | Writes ccr config JSON + `.bak` backup |
| `ccr_check_installed` | L321–L326 | `command -v ccr` via login shell |
| `ccr_install` | L327–L380 | `npm i -g`; on EACCES, retries via `osascript` for macOS admin password prompt |
| `ccr_start` | L381–L391 | `ccr start` — daemonizes itself |
| `ccr_stop` | L392–L399 | `ccr stop` — treats "not running" as success |
| `chats_dir` | L400–L405 | `$WORKSPACE/chats/` directory |
| `safe_chat_id` | L406–L417 | Validates chat ID (alphanumeric + underscore) |
| `chat_backup_write` | L418–L425 | Writes chat JSON to `chats/<id>.json` |
| `chat_backup_read` | L426–L433 | Reads chat JSON from disk |
| `chat_backup_list` | L434–L448 | Lists all backed-up chat IDs |
| `debug_log` | L449–L464 | Appends timestamped line to debug log |
| **MCP client** (`struct McpServer` / `McpManager`, `mcp_start` / `mcp_call_tool` / `mcp_stop`) | ~L847–L1024 | First long-lived subprocess subsystem. `McpManager` = `Mutex<HashMap<id, McpServer>>` registered via `.manage()`. Each server: child spawned through `zsh -l -c 'exec "$0" "$@"'` (login PATH, clean args) with a reader thread draining stdout → `mpsc` channel; `McpServer::request` writes newline-delimited JSON-RPC and matches the response by id with a fixed deadline. `mcp_start` runs initialize → `notifications/initialized` → `tools/list` and returns the tools JSON. Uses `serde_json` (the one added dep). stderr → `Stdio::null()` to avoid pipe deadlock. |
| `main` / handlers | ~L1027–end | `invoke_handler!` list — **add new commands here**. `.manage(McpManager::default())` registers MCP state. |

---

## Chat / Project data shapes
```js
Chat    = { id, title, topic: "chat:<id>", members: [agentId], responder: agentId|null,
            projectId: id|null, archived, archivedAt, created, lastActivity, lastSeen,
            pinned: bool, overrides: { model?, tools? } | null }
Project = { id, name, archived, created }
```
- Storage keys: `yumuhub:chats`, `yumuhub:projects`, `yumuhub:chat:<id>` (messages), `yumuhub:active` (last open chatId + sidebarCollapsed)
- Action log: `yumu_actionlog` (JSON array, max 2000 entries)

## Attachment handling (ChatView)
- **Text files** (`.txt`, `.md`, `.json`, `.js`, etc.) → `FileReader.readAsText()` → `{ type: "file", name, size, content }`
- **Image files** → `FileReader.readAsDataURL()` → `{ type: "image", name, size, mime, base64, dataUrl }`
- **Binary/document files** (`.docx`, `.xlsx`, `.pptx`, `.pdf`, `.zip`, `.odt`, `.epub`, etc.) → `FileReader.readAsDataURL()` → `{ type: "document", name, size, mime, base64 }` — detected via `BINARY_EXTS` set + `isBinaryFile()` at ~L2704

## Rebuild & install

```sh
cd ~/yumuhub-workspace/yumuhub && source ~/.cargo/env && npx tauri build && \
  ditto src-tauri/target/release/bundle/macos/yumuHub.app /Applications/yumuHub.app && \
  xattr -cr /Applications/yumuHub.app && open /Applications/yumuHub.app
```

## External I/O for headless testing

- **Drop a message in**: write `[{"agent_id":"agt_xxx","content":"..."}]` or `[{"chat_id":"chat_xxx","content":"..."}]` to `~/yumuhub-workspace/yumuhub-inbox.json`. Poller picks it up within `pollSec` seconds, then deletes the file.
- **Read a reply out**: tail `~/yumuhub-workspace/yumuhub-outbox.jsonl`. Each inbox-originated reply appends one JSON line: `{"chat_id":"…","agent_id":"…","ts":…,"content":"…","reply":"…","error":null}`.
- **Debug mode**: `localStorage.setItem("yumuhub:debug", "1")` → `~/yumuhub-workspace/yumuhub-debug.log`.

## Where to make small edits

| You want to change… | Edit around line |
|---|---|
| A tool's behavior | search for `ph.register({ name: "<tool>"` inside `registerBuiltinTools` (L772–L1427) |
| Add a new tool | Add `ph.register({…})` inside `registerBuiltinTools`, then opt-in agents via `tools:[]` |
| Idle-timeout / loop-detection thresholds | `DEFAULT_SETTINGS` (L135) or live via Settings tab |
| Sub-agent key selection | `pickSubagentKey()` (L757–L770) |
| Streaming UX (cursor, dots) | `ChatView` render — `streamCursor` / `typing` / `typingDot` styles |
| Streaming render performance | `AgentRuntime.notifyStream` — rAF-coalesced |
| Add a new sidebar entry | `NAV_ITEMS` array (L2267) + new view component + router in root JSX |
| A provider's request shape | `providers.<name>.send` (L1582–L1776) |
| Seed-agent defaults | `SEED_AGENTS` (L2088) |
| Inbox / outbox protocol | JS: inbox poller in root component. Rust: `inbox_pop`, `outbox_append`, `debug_log` |
| Chat / project CRUD | `ChatRegistry` methods (L271–L385) |
| Unread tracking | `lastSeen` on chat, active-chat useEffect marks as seen |
| Tool global on/off | `ToolGate` class (L700–L714) |
| Universal prompt (yumuHub.md) | `universal` singleton (L69–L91) + Rust `read_universal` / `write_universal` / `reveal_universal` |
| Improve UI agent picker | `ImproveSourceSection` (L4370) in SettingsView |
| Handoff behavior (↻ button) | `ChatView` → `const handoff = async ()` |
| Window drag region | Add `data-tauri-drag-region` to any large top-edge div |
| Colors / spacing | `fonts` + `c` objects at L6038–L6039 — everything else references these |
| Model selection (show/hide) | `ModelSelectionSection` (L4845) / `ProviderModelGroup` (L4862) |
| File attachment handling | `readFileAsAttachment` + `BINARY_EXTS` + `isBinaryFile` at ~L2703, `send()` at ~L2775 |
| Action Log | `ActionLog` class (L387), `BusView` component (L3691) |
| Multimodal / image paste | `onPaste` handler + `readFileAsAttachment` + `toAnthropicContent` / `toOpenAIContent` converters |
| CCR provider config | `providers.ccr` (L1634) |
| CCR setup wizard | `CcrSection` (L4557), `CCR_TEMPLATES` (L4507), `CCR_TIERS` (L4550) |
| CCR Tauri commands | `main.rs` L289–L399 |
| Observability panel | `ObservabilitySection` (L4933) |
| Content filter / tool approval | `GuardrailsSection` (L5075), `evaluateContentFilter` (L565), `ApprovalQueue` (L581) |
| Disk persistence | `DiskPersistenceSection` (L5187), `chatBackup` (L672) |
| Eval harness | `EvalHarnessSection` (L5211) |
| Agent versioning / rollback | `AgentVersions` (L629), `AgentVersionHistory` (L3336) |
| Cost tracking | `CostStats` (L521), `COST_PER_1K` (L508) |
