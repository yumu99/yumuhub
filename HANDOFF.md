## What we were doing

Full audit-and-fix sprint: dispatched 3 parallel sub-agents to triage Runtime/Persistence/UI, shipped **42 fixes** in 8 batches, then drove a follow-up to unblock z.ai's Coding-Plan throttling by switching to the Anthropic-format endpoint via a Rust-side proxy. App is freshly built + relaunched with the new default.

## Key decisions / facts established

### Build command (mandatory form)
Always quit-then-relaunch — `open` against a running app focuses the stale instance:
```sh
cd ~/yumuhub-workspace/yumuhub && source ~/.cargo/env && npx tauri build && \
  { osascript -e 'tell application "yumuHub" to quit' 2>/dev/null; sleep 1; } && \
  ditto src-tauri/target/release/bundle/macos/yumuHub.app /Applications/yumuHub.app && \
  xattr -cr /Applications/yumuHub.app && open /Applications/yumuHub.app
```
Documented in `REBUILD.md` with a "non-negotiable" warning.

### z.ai endpoint architecture (the big change)
- **Default: `zaiEndpoint = "anthropic"`** (was `coding`). One-shot migration auto-bumps existing installs via sentinel `yumuhub:zaiEndpointMigrated_v1` ([YumuHub.jsx:204](src/YumuHub.jsx#L204)).
- **WebKit cannot reach `api.z.ai/api/anthropic`** directly — throws `TypeError: Load failed` after ~7s. curl works fine. Routed through new Rust command `zai_anthropic_proxy` ([main.rs:413](src-tauri/src/main.rs#L413)) using curl + 10-min cap; returns `{status, body}` JSON like `brave_search`.
- JS adapter at [YumuHub.jsx:~2076](src/YumuHub.jsx#L2076) routes by `settings.zaiEndpoint`: `anthropic` → Rust proxy (non-streaming, response lands at end), `coding` → OpenAI-format with Coding Plan throttle, `general` → OpenAI-format with API balance.
- Trade-off: no live token streaming on anthropic route. Future work: Tauri Channels for true streaming.
- **CCR is now optional** — only useful for multi-provider routing (OpenRouter/Anthropic-as-Claude), no longer needed for "use z.ai with Coding Plan".

### Model output caps (per z.ai's own docs)
`MAX_OUT_TOKENS` map at [YumuHub.jsx:~1600](src/YumuHub.jsx#L1600). GLM-5.x family = **128K output** (not the 4K-32K we had been guessing). Anthropic Claude 4.x = 64K. GPT-4o = 16K. Per-call override via `opts.maxOutputTokens` plumbed through chat() → _toolLoop → adapter.send.

### `send_to_agent` upgrades ([YumuHub.jsx:~1090](src/YumuHub.jsx#L1090))
New params: `maxOutputTokens` (cap reply), `chunkInput` (split message ≥12KB into sequential turns). Hard input limit 200KB. Description tells LLM to instruct receiver to `sandbox_read` files rather than pasting them (LLM-output-cap bottleneck).

### Critical bug fixes shipped
- **C1** `pickSubagentKey` was reading non-existent `rt.status` → use `rt.anyBusy?.()` (and filter quarantined handles)
- **C2** `debug_log` rotation at 1MB + secret redaction + line cap
- **H1** `harnessOnly` actually enforced — `PluginHost.execute` blocks ephemeral children from `spawn_agent`/`send_to_agent` (`ctx.fromHarness = !this.config.ephemeral`)
- **H2** Abort-after-tool_use synthesizes tool_result entries so history stays Anthropic-valid
- **H3** `dropChat` aborts in-flight before deleting; `_finish` guards against histories[chatId]===undefined wiping registry
- **H4** Loop detection ring-buffer (catches A→B→A→B oscillation)
- **H5–H8** `open_url` https-only, `ccr_install` validates npm_path, `beta_write` atomic+rotating-bak, `chat_backup_delete` Tauri cmd + wired to deleteChat/purgeOldArchived
- **K1/M14** Silent `JSON.parse(tc.args) catch {}` now surfaces `argError` to LLM with byte count + tail snippet
- **K3** `postProvider` AND `readSSE` both wrap fetch errors with size + elapsed + hint
- **N1** `resolve_in_sandbox` accepts `.`/`/`/`""` (short-circuits to sandbox root) and rejects absolute paths cleanly
- **N2** Lexical path-collapse pre-check → uniform `Path escapes sandbox` error regardless of target existence

Full ledger of all 42 fixes lives in this conversation's transcript.

### Files touched (load-bearing)
- `src/YumuHub.jsx` — now ~6400 LOC; major edits across providers, AgentRuntime, ChatView, VaultView, SettingsView
- `src-tauri/src/main.rs` — now ~870 LOC; new `chat_backup_delete`, `zai_anthropic_proxy`, hardened `debug_log`/`open_url`/`ccr_install`/`beta_write`/`resolve_in_sandbox`
- `REBUILD.md` — quit-then-relaunch baked into the chain
- `CODEMAP.md` — **stale** (line numbers from before this session's edits)

## Where we are right now

- App built + installed + relaunched at `/Applications/yumuHub.app`.
- `zaiEndpoint` setting auto-migrated to `anthropic` on first launch of the new build.
- Verified live: PING, calc (incl. M3 abuse-block), list_agents/models, send_to_agent, spawn_agent + cap + remove, **H1 enforcement live-fires the exact error**, truth_only, adhd_reason, configure_agent, web_search (Tavily hit), sandbox_status/list/read/write, atomic .bak rotation (v3/v2/v1 order correct), path traversal blocked uniformly, parallel send_to_agent (3 concurrent, no losses), M5 outbox `seq` field (continuous), **K1/M14 live-fired in action log** (Vertifier truncated → argError surfaced), **long generation (~800 words) through proxy** works without 60s throttle, tool calls through proxy work.
- 41 outbox replies recorded in `~/yumuhub-workspace/yumuhub-outbox.jsonl` (now with `seq` + `wseq_ts`).

## Open questions / blockers

- **CODEMAP.md is stale.** All line refs in this handoff are from the post-fix source. Regenerate before any non-trivial edit: `grep -nE '^(class |function |const [A-Z][a-zA-Z]* = |// ─)' src/YumuHub.jsx`.
- **Anthropic-endpoint streaming UX**: response lands all at once (no typewriter). Future work — Tauri Channels (v2 `ipc::Channel`) to stream curl stdout chunks. Sketch: spawn `curl -sN` as child, pipe stdout, emit lines via channel, JS feeds existing readSSE.
- **Untested surfaces**: `file_read`, `pick_audio_file`, `zai_image`, `zai_transcribe`, `zai_video` (UI/cost gated); UI fixes H9/H10/M8/M9/M10/M11/M12/M13 (code-verified, never UI-verified — would need manual interaction or browser MCP).
- **CCR's future**: still wired (CCR provider works) but unnecessary for the user's main case. Decide whether to keep its Settings UI prominent, demote, or remove. Currently still defaulted-visible.
- **z.ai's anthropic endpoint with much larger payloads (>50KB, >2K-token responses)**: untested beyond 800-word essay. Curl handles 50-min timeouts; the proxy's `--max-time 600` (10 min) might cap real use cases. Bump if needed.
- **Inbox testing harness lives at `/tmp/yh-test.sh`** — handy template; copy to `~/.claude/projects/-Users-svein-yumuhub/memory/` if you want to keep it.

## Reference

- Codemap regen: `grep -nE '^(class |function |const [A-Z][a-zA-Z]* = |// ─)' src/YumuHub.jsx`
- Inbox/outbox protocol: write `[{"agent_id":"agt_xxx","content":"..."}]` to `~/yumuhub-workspace/yumuhub-inbox.json`; tail `~/yumuhub-workspace/yumuhub-outbox.jsonl` (now each line has `seq` + `wseq_ts` + the original fields).
- Build + install: see "Build command" above. Never skip the `osascript … to quit` step.
