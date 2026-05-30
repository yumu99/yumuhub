# yumuHub Backlog

Items parked during active development. Ranked by implementation effort (lines of code) within each tier. Updated automatically when something is put on hold.

---

## Shipped 2026-05-26

- ✅ **Closest-model-id suggestion** — Levenshtein helper, threshold ⌈35%⌉ of len. Active in `spawn_agent` and `configure_agent`.
- ✅ **Basic cost tracking** — `CostStats` singleton + provider `usage` extraction (Anthropic/CCR `message_*` events, OpenAI-compatible `stream_options.include_usage`). Rollup in vault top + Settings → Observability.
- ✅ **Content filter guardrails** — `settings.contentFilter.patterns[]` with regex/scope/label, block-or-warn mode. Pre-send hook in `AgentRuntime.chat`. UI in Settings → Guardrails.
- ✅ **Tool execution approval** — `ApprovalQueue` singleton + modal. Per-tool rules: auto-approve / ask / session / auto-deny. Settings → Guardrails.
- ✅ **Disk-backup chat persistence** — Idle-flush mirror to `~/yumuhub-workspace/chats/<id>.json` via Tauri `chat_backup_*` commands. Toggle in Settings.
- ✅ **Observability panel** — Per-agent calls / tokens / cost / latency / error rate table + per-model breakdown + last-60 LLM call timeline. Settings → Observability.
- ✅ **Agent versioning + rollback** — `AgentVersions` snapshots OLD config before every `saveAgent` and `configure_agent`. Version-history collapsible inside `AgentEditor` with "Load into form" restore.
- ✅ **Eval / benchmarking harness** — `settings.evalHarness.suites{}` with prompt + expected + mode (contains / exact / regex). Per-suite runner inside Settings.

## Medium (150–400 lines)

## Large (400–800 lines)

- **MCP Server Mode (transport adapter)** — Expose tool registry over stdio/SSE MCP protocol. Map existing tools to MCP definitions. ~400–600 lines. The reverse of the shipped client — lets *other* MCP clients use yumuHub's tools.
- ✅ **DONE — MCP client** — Connect to external MCP servers (stdio) as tool providers; discovered tools register as `mcp__<id>__<tool>` and are grantable per agent. Settings → MCP servers. This is the RAG / knowledge-base on-ramp (point it at any MCP RAG server). Rust: `mcp_start`/`mcp_call_tool`/`mcp_stop` in main.rs; JS client ~L2609. Hardened: process-group reap-on-quit (no orphans), stderr capture, 100 KB output cap. Remaining: remote/SSE transport, one-click preset servers, MCP-specific approval gating.

## Very Large (800+ lines)

- **Authentication / RBAC / multi-tenancy** — Session tokens, user accounts, permission model, key isolation. ~800–1500 lines.
- **Enterprise integrations (Slack, Gmail, etc.)** — ~300–500 lines per connector.
- **Visual workflow builder** — Drag-and-drop agent pipelines. ~2000+ lines. Deferred — targets developers.

---

## Phase 4+ (blocked on role-redesign)

These require user decisions on the role contract before implementation:

- **Tools tab settings UI** — Per-tool config surface (e.g. committee `temps`). Blocked by tool-role binding design.
- **Non-inheritable tools** — `childInherit: false` flag or role-based assignment. User prefers "easy non-interpretable setup that is safe."
- **Tool request mechanism** — Children ask parent for tools they don't have. Likely shape: structured envelope, parent decides.
- **send_to_agent future** — May be eliminated or made redundant post-ACL. Parent→child may be the only surviving direction.
- **Rate-limit-aware send queue** — Per-key concurrency semaphore in provider adapters. Mitigates cascade storms.

---

## Strategic Priority Order

1. Closest-model suggestion (trivial, immediate QoL)
2. Cost tracking (users need this to manage API spend)
3. ✅ MCP client adapter (done — external MCP servers' tools usable per-agent)
4. MCP **server** mode (expose yumuHub's tools to other clients — the reverse direction)
5. Observability panel (builds on cost tracking)
6. Basic guardrails (compliance checkbox)
7. Persistent state (most-requested UX gap)

---

## Competitive Context

- yumuHub scores ~18–21/30 vs best-in-class (Dify ~22–25, LangGraph ~23–26, Google ADK ~24–26)
- Defensible niche: chat-native multi-agent hub between code frameworks and visual builders
- 2 genuinely novel tools: `adhd_reason`, `truth_only`
- MCP **client** shipped (the highest-leverage gap) — external tools/RAG now plug in. Server-mode (exposing our tools) is the next MCP step.
