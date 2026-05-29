# yumuHub — Rebuild Guide

## The one file you edit
`src/YumuHub.jsx` — the entire app lives here.

## Rebuild and install after changes

**Always use this single chained command** — it quits the running app, builds, installs, and relaunches in one shot. Skipping the quit step means `open` just focuses the stale running instance and any test runs against the OLD code:

```bash
cd ~/yumuhub-workspace/yumuhub && \
  source ~/.cargo/env && \
  npx tauri build && \
  { osascript -e 'tell application "yumuHub" to quit' 2>/dev/null; sleep 1; } && \
  ditto src-tauri/target/release/bundle/macos/yumuHub.app /Applications/yumuHub.app && \
  xattr -cr /Applications/yumuHub.app && \
  open /Applications/yumuHub.app
```

> **Why the quit step is non-negotiable**: `open` against a running app just brings its existing window to the front. The old binary stays loaded in memory, so any test you run silently passes/fails against the previous code — a stealth false-positive for "the fix is live." The `osascript … to quit` is graceful (triggers any onQuit handlers); `2>/dev/null` swallows the "app isn't running" error so the chain doesn't break on a cold launch. The `sleep 1` lets the process fully exit before `ditto` overwrites the bundle.
>
> Use `ditto`, **not** `cp -r`. When the destination .app already exists, `cp -r` copies the new bundle *inside* the old one (`/Applications/yumuHub.app/yumuHub.app/…`), and Launchpad keeps running the stale outer binary. `ditto` replaces the contents in place.

First build after a clean: ~5 min (Rust recompiles).
Subsequent builds: ~25 sec (cache warm).

## Folder layout

```
src/YumuHub.jsx          ← edit this
src/main.jsx             ← React entry (rarely touch)
src-tauri/               ← Tauri/Rust shell (rarely touch)
src-tauri/icons/         ← app icons
src-tauri/target/        ← Rust compile cache (820 MB, keep it)
docs/yumuHub-spec.html   ← design spec
```

## Providers

| Provider   | Handle convention  | Endpoint                                  |
|------------|--------------------|-------------------------------------------|
| Anthropic  | `anthropic_key`    | api.anthropic.com                         |
| OpenAI     | `openai_key`       | api.openai.com                            |
| z.ai       | `zai_key`          | api.z.ai/api/coding/paas/v4               |
| Mock       | (none needed)      | local — for testing without a key         |
