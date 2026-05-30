import { useState, useEffect, useRef, useCallback, useReducer, Component, memo } from "react";
import OWN_SOURCE from "./YumuHub.jsx?raw";

const DIAGNOSE_SOURCE = (() => {
  const stylesIdx = OWN_SOURCE.indexOf("\nconst styles = {");
  if (stylesIdx === -1) return OWN_SOURCE;
  const omitted = OWN_SOURCE.length - stylesIdx;
  return OWN_SOURCE.slice(0, stylesIdx) + `\n\n// [STYLES OBJECT OMITTED — ${omitted} chars of CSS-in-JS removed to fit smaller models]\n`;
})();

// ─── CORE: Persistence ───
// Chats live under "yumuhub:chat:<id>" (per chat, not per agent).
// Legacy per-agent histories at "yumuhub:history:<agentId>" are migrated on first run.
const STORAGE = {
  AGENTS:    "yumuhub:agents",
  VAULT:     "yumuhub:vault",
  VAULT_GROUPS: "yumuhub:vaultGroups",
  VAULT_META:   "yumuhub:vaultMeta",
  VAULT_ORDER:  "yumuhub:vaultOrder",
  HIST:      "yumuhub:history:",   // LEGACY per-agent, kept for one-time migration only
  CHAT_MSGS: "yumuhub:chat:",      // per-chat message log
  CHATS:     "yumuhub:chats",      // [Chat] index
  PROJECTS:  "yumuhub:projects",   // [Project] index
  ACTIVE:    "yumuhub:active",     // { chatId } — restore last open chat
  SETTINGS:  "yumuhub:settings",
  HANDOFF:   "yumuhub:handoff:",
};
const persist = {
  saveAgents:  (v) => { try { localStorage.setItem(STORAGE.AGENTS, JSON.stringify(v)); } catch {} },
  loadAgents:  ()  => { try { return JSON.parse(localStorage.getItem(STORAGE.AGENTS)) || null; } catch { return null; } },
  saveVault:   (v) => { try { localStorage.setItem(STORAGE.VAULT,  JSON.stringify(v)); } catch {} },
  loadVault:   ()  => { try { return JSON.parse(localStorage.getItem(STORAGE.VAULT))  || {};   } catch { return {}; } },
  saveVaultGroups: (v) => { try { localStorage.setItem(STORAGE.VAULT_GROUPS, JSON.stringify(v)); } catch {} },
  loadVaultGroups: ()  => { try { return JSON.parse(localStorage.getItem(STORAGE.VAULT_GROUPS)) || []; } catch { return []; } },
  saveVaultMeta:   (v) => { try { localStorage.setItem(STORAGE.VAULT_META, JSON.stringify(v)); } catch {} },
  loadVaultMeta:   ()  => { try { return JSON.parse(localStorage.getItem(STORAGE.VAULT_META)) || {}; } catch { return {}; } },
  saveVaultOrder:  (v) => { try { localStorage.setItem(STORAGE.VAULT_ORDER, JSON.stringify(v)); } catch {} },
  loadVaultOrder:  ()  => { try { return JSON.parse(localStorage.getItem(STORAGE.VAULT_ORDER)) || []; } catch { return []; } },

  // Per-CHAT history (current — the canonical store)
  saveMessages:  (chatId, v) => { try { localStorage.setItem(STORAGE.CHAT_MSGS + chatId, JSON.stringify(v)); } catch {} },
  loadMessages:  (chatId)    => { try { return JSON.parse(localStorage.getItem(STORAGE.CHAT_MSGS + chatId)) || []; } catch { return []; } },
  clearMessages: (chatId)    => { try { localStorage.removeItem(STORAGE.CHAT_MSGS + chatId); } catch {} },

  // Chats / projects indexes
  saveChats:     (v) => { try { localStorage.setItem(STORAGE.CHATS,    JSON.stringify(v)); } catch {} },
  loadChats:     ()  => { try { return JSON.parse(localStorage.getItem(STORAGE.CHATS))    || []; } catch { return []; } },
  saveProjects:  (v) => { try { localStorage.setItem(STORAGE.PROJECTS, JSON.stringify(v)); } catch {} },
  loadProjects:  ()  => { try { return JSON.parse(localStorage.getItem(STORAGE.PROJECTS)) || []; } catch { return []; } },

  // Last-open chat
  saveActive:   (v) => { try { localStorage.setItem(STORAGE.ACTIVE,   JSON.stringify(v)); } catch {} },
  loadActive:   ()  => { try { return JSON.parse(localStorage.getItem(STORAGE.ACTIVE))   || {}; } catch { return {}; } },

  // Legacy per-agent history (read once, migrated, then dropped)
  loadLegacyHistory:  (agentId) => { try { return JSON.parse(localStorage.getItem(STORAGE.HIST + agentId)) || null; } catch { return null; } },
  clearLegacyHistory: (agentId) => { try { localStorage.removeItem(STORAGE.HIST + agentId); } catch {} },

  saveSettings: (v) => { try { localStorage.setItem(STORAGE.SETTINGS, JSON.stringify(v)); } catch {} },
  loadSettings: ()  => { try { return JSON.parse(localStorage.getItem(STORAGE.SETTINGS)) || {}; } catch { return {}; } },
  saveHandoff:  (id, v) => { try { localStorage.setItem(STORAGE.HANDOFF + id, JSON.stringify(v)); } catch {} },
  loadHandoff:  (id)    => { try { return JSON.parse(localStorage.getItem(STORAGE.HANDOFF + id)) || null; } catch { return null; } },
};

// id-gen with prefix
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random()*4096).toString(36)}`;
const chatTopic = (id) => `chat:${id}`;

// ─── CORE: Universal system prompt (yumuHub.md) ───
// Stored on disk at ~/yumuHub.md so it's editable from the CLI too.
// Cached in memory + localStorage so chat() can prepend it synchronously.
const universal = {
  text: (() => { try { return localStorage.getItem("yumuhub:universal") || ""; } catch { return ""; } })(),
  loaded: false,
  async load() {
    try {
      const t = await invokeTauri("read_universal");
      this.text = t || "";
      try { localStorage.setItem("yumuhub:universal", this.text); } catch {}
      this.loaded = true;
    } catch { /* tauri not available, keep cache */ }
  },
  async save(text) {
    this.text = text;
    try { localStorage.setItem("yumuhub:universal", text); } catch {}
    try { await invokeTauri("write_universal", { contents: text }); } catch (e) { throw e; }
  },
  async reveal() {
    try { return await invokeTauri("reveal_universal"); } catch (e) { throw e; }
  },
};

const AGENT_PREAMBLE = "Before each action or tool call, state what you're doing in max 6 words (prefer 3). Example: \"Reading file\", \"Searching docs\", \"Fixing layout\". No colon, no elaboration — just the status, then act.";

// Inspired by `autistic_forward(x, weights): weights['social_context']=0; weights['politeness']=0`.
// Appended to every non-creative agent's system prompt by default. Set
// `bluntMode: false` on an agent's config to opt out (Media Studio does).
const BLUNT_PREAMBLE = "BLUNT MODE — social_context=0, politeness=0.\nNo throat-clearing intros (\"Sure!\", \"Great question!\", \"Let me think…\"). No padding closings (\"Hope that helps!\", \"Let me know if…\"). No \"as an AI\" disclaimers. No apologies for not knowing — just say \"I don't know\" and move on. Hedge only when you're genuinely uncertain, not as social cushion. Use declarative sentences. State facts; don't ask permission to state them. Skip restating the question. If you'd normally write 5 words of softener, write the 1 word of fact instead.";

const MODEL_CATEGORY_COLORS = {
  reasoning:   "#9b59b6",
  language:    "#3d6b8a",
  vision:      "#caa04a",
  image:       "#4a5a3a",
  video:       "#c0461f",
  recognition: "#3d6b8a",
};
const MODEL_CATEGORY_LABELS = {
  reasoning:   "Reasoning",
  language:    "Language",
  vision:      "Vision",
  image:       "Image Gen",
  video:       "Video Gen",
  recognition: "Recognition",
};

function providersWithKeys(vaultInstance) {
  const handles = vaultInstance?.list() || [];
  const providerIds = new Set(["mock", "ccr"]);
  for (const h of handles) {
    const lower = h.toLowerCase();
    if (/anthropic|claude/.test(lower))        providerIds.add("anthropic");
    else if (/openai|gpt/.test(lower))         providerIds.add("openai");
    else if (/zai|zhipu|glm|bigmodel/.test(lower)) providerIds.add("zai");
    else {
      providerIds.add("anthropic");
      providerIds.add("openai");
      providerIds.add("zai");
    }
  }
  return providerIds;
}

// ─── CORE: User settings (tunable via the Settings view) ───
const DEFAULT_SETTINGS = {
  idleSec:   300,   // seconds of silence before a chat() aborts as "no activity"
  maxTurns:  50,    // tool-loop iteration cap
  loopLimit: 3,     // consecutive identical tool-call rounds before [LOOP DETECTED]
  pollSec:   2,     // inbox poll cadence (seconds)
  bluntMode: true,  // global default: strip social_context + politeness padding. Per-agent override wins.
  handoffMode: "archive",  // What happens to the current chat on ↻ Handoff: "archive" | "delete" | "keep"
  archivePurgeDays: 10,    // Auto-delete archived chats after N days. null = never. 1–365 inclusive.
  protection: {
    doubleClickVaultDelete:    true,   // ON — require a 2nd click to remove a vault key
    exitWithoutSavingNotice:   true,   // ON — warn when leaving Settings with unsaved changes
    doubleClickActionLogClear: false,  // OFF — direct click clears action log (archives, doesn't purge)
  },
  contentFilter: {
    enabled: false,
    // Each pattern: { id, source, flags, label, scope: "user"|"assistant"|"both" }.
    // `source` is a regex source; if it doesn't parse, the entry is skipped at runtime.
    patterns: [],
    blockMode: "block", // "block" = refuse + log; "warn" = log only
  },
  toolApprovals: {
    // Map of toolName → "always"|"once"|"never". Missing = no approval required.
    // "always" prompts each time, "once" stays approved for the session, "never" auto-denies.
    enabled: false,
    rules: {},
  },
  diskPersistence: {
    // Mirror chat messages to ~/yumuhub-workspace/chats/<chatId>.json on idle.
    // localStorage stays the source of truth; disk is a backup that survives
    // browser-data clears.
    enabled: false,
    idleSec: 30,
  },
  evalHarness: {
    // Saved benchmark suites: id → { name, agentId, cases: [{prompt, expected, mode}] }.
    suites: {},
    lastResults: {},  // suiteId → { ts, perCase: [{prompt, got, pass, latency}] }
  },
  mcpServers: {
    // External Model Context Protocol servers (stdio transport). Each:
    //   { id, label, command, args: [], env: {}, enabled }
    // On launch + on Start, yumuHub spawns the process via the Rust side,
    // runs the MCP handshake, and registers its tools as `mcp__<id>__<tool>`
    // under category `mcp:<id>` — so any agent can be granted them like any
    // other tool. See registerMcpTools / McpServersSection.
    servers: [],
  },
  dismissedNotices: [],  // Notice IDs the user dismissed via "never show again"
  // z.ai chat endpoint preset. Per z.ai docs there are three options:
  //   "anthropic" → https://api.z.ai/api/anthropic/v1/messages
  //                (Anthropic Messages format — same URL Claude Code uses.
  //                Inherits Coding Plan quota AND avoids the third-party
  //                stream-cap throttle. Default since 2026-05-28.)
  //   "coding"   → https://api.z.ai/api/coding/paas/v4/chat/completions
  //                (OpenAI-format Coding Plan endpoint — works but z.ai
  //                throttles unsupported SDKs to a ~60s stream cap here.)
  //   "general"  → https://api.z.ai/api/paas/v4/chat/completions
  //                (OpenAI-format, billed against API balance.)
  zaiEndpoint: "anthropic",
  ccrUrl:    "http://127.0.0.1:3456",  // Claude Code Router daemon base URL (no trailing slash, no /v1/messages)
  colors:    {
    unread:          "#7c3aed",  // notification dot for chats with unread replies
    agentIdle:       "#5a6b3d",  // c.moss — agent ready
    agentBusy:       "#c89c4a",  // c.gold — agent working
    vaultUnused:     "#bfb49a",  // hollow-dot color when no agent uses the key
    vaultOne:        "#5b8aa6",  // c.sky — 1 agent on key (expected)
    vaultMany:       "#c89c4a",  // 2-3 agents (rare)
    vaultOverloaded: "#c0461f",  // 4+ agents (never)
  },
};
const NESTED_SETTING_KEYS = ["colors", "protection", "contentFilter", "toolApprovals", "diskPersistence", "evalHarness", "mcpServers"];
function mergeNested(base, layer) {
  const out = { ...base, ...layer };
  for (const k of NESTED_SETTING_KEYS) {
    out[k] = { ...DEFAULT_SETTINGS[k], ...(base?.[k] || {}), ...(layer?.[k] || {}) };
  }
  return out;
}
const settings = {
  current: (() => {
    const saved = persist.loadSettings() || {};
    const merged = mergeNested(DEFAULT_SETTINGS, saved);
    // One-shot migration (2026-05-28): switch zaiEndpoint from the
    // previous "coding" default to "anthropic" so existing installs
    // automatically benefit from the unthrottled Claude-compat path
    // (same URL Claude Code uses). Users who deliberately want the
    // OpenAI-format coding endpoint back can re-pick it in Settings →
    // Model selection; we mark the migration done so we don't undo
    // their choice on the NEXT launch.
    try {
      if (!localStorage.getItem("yumuhub:zaiEndpointMigrated_v1")) {
        if (merged.zaiEndpoint === "coding" || merged.zaiEndpoint == null) {
          merged.zaiEndpoint = "anthropic";
          persist.saveSettings(merged);
        }
        localStorage.setItem("yumuhub:zaiEndpointMigrated_v1", "1");
      }
    } catch {}
    return merged;
  })(),
  get(k)  { return this.current[k]; },
  set(patch) {
    this.current = mergeNested(this.current, patch);
    persist.saveSettings(this.current);
  },
  reset() {
    this.current = mergeNested(DEFAULT_SETTINGS, {});
    persist.saveSettings(this.current);
  },
};

// Universal "never show again" gate. `id` is a stable string identifying the notice.
// `render` is called with a `dismiss` function that adds id to settings.dismissedNotices.
// Returns null if the notice has been dismissed; otherwise the rendered element.
function noticeIsDismissed(id) {
  return (settings.get("dismissedNotices") || []).includes(id);
}
function dismissNotice(id) {
  const list = settings.get("dismissedNotices") || [];
  if (!list.includes(id)) settings.set({ dismissedNotices: [...list, id] });
}

// ─── CORE: Message Bus ───
class MessageBus {
  constructor() { this.inboxes = {}; this.subscribers = {}; this.listeners = []; }
  register(id)   { this.inboxes[id] = []; }
  unregister(id) { delete this.inboxes[id]; }
  send(envelope) {
    const msg = { ...envelope, id: `msg_${Date.now().toString(36)}`, ts: Date.now() };
    if (msg.to.startsWith("topic:")) {
      (this.subscribers[msg.to] || []).forEach(id => { if (this.inboxes[id]) this.inboxes[id].push(msg); });
    } else {
      if (this.inboxes[msg.to]) this.inboxes[msg.to].push(msg);
    }
    this.listeners.forEach(fn => fn(msg));
    return msg;
  }
  subscribe(id, topic) { if (!this.subscribers[topic]) this.subscribers[topic] = []; this.subscribers[topic].push(id); }
  getInbox(id)   { return this.inboxes[id] || []; }
  clearInbox(id) { this.inboxes[id] = []; }
  onMessage(fn)  { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
}

// ─── CORE: Vault ───
class Vault {
  constructor() { this.keys = persist.loadVault(); this.meta = persist.loadVaultMeta(); }
  store(handle, value)  { this.keys[handle] = value; persist.saveVault(this.keys); }
  resolve(ref) {
    const h = ref.replace("vault://keys/", "");
    if (this.meta[h]?.quarantined) return null;
    return this.keys[h] || null;
  }
  list()                { return Object.keys(this.keys); }
  remove(handle)        { delete this.keys[handle]; persist.saveVault(this.keys); delete this.meta[handle]; persist.saveVaultMeta(this.meta); }
}

// ─── CORE: ChatRegistry ───
// Sits on top of MessageBus. Owns chat & project metadata + per-chat message
// persistence. Bus carries notification envelopes ({to: chat:<id>, ...}) so any
// component can subscribe to changes on a chat without polling localStorage.
//
// Shared listener pattern for stores/registries. Subclass and call notify();
// subscribers receive the instance as an argument.
class Notifier {
  constructor() { this.listeners = []; }
  onChange(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
  notify()     { this.listeners.forEach(fn => fn(this)); }
}

// Data shapes:
//   Chat    = { id, title, topic, members:[agentId], responder:agentId|null,
//               projectId|null, archived, created, lastActivity }
//   Project = { id, name, archived, created }
class ChatRegistry extends Notifier {
  constructor(bus) {
    super();
    this.bus = bus;
    this.chats = persist.loadChats();
    this.projects = persist.loadProjects();
  }

  // ── Bootstrap: ensure at least one chat exists. Legacy per-agent histories
  // are intentionally NOT auto-imported (they tend to be bloated). Instead we
  // drop the old keys to free space; if the user wants to recover, they can
  // pull from a backup. L2: previously this also pre-seeded one empty chat
  // per default agent — that left ~8 empty `chat:*` localStorage rows on
  // every fresh install, and any expansion of DEFAULT_AGENTS in a later
  // release would silently grow that count. We now skip the pre-seed
  // entirely; users create chats on demand from the sidebar.
  migrateFromLegacy(agents) {
    if (localStorage.getItem("yumuhub:migrated")) return false;
    if (this.chats.length > 0) { localStorage.setItem("yumuhub:migrated", "1"); return false; }
    for (const a of agents) persist.clearLegacyHistory(a.id);
    localStorage.setItem("yumuhub:migrated", "1");
    this.notify();
    return true;
  }

  _makeChat({ title, members, responder, projectId }) {
    const id = newId("chat");
    const now = Date.now();
    return { id, title: title || "New chat", topic: chatTopic(id),
             members: members || [], responder: responder || (members && members[0]) || null,
             projectId: projectId || null, archived: false,
             created: now, lastActivity: now, lastSeen: now };
  }

  // ── Chats ──
  createChat(opts = {}) {
    const c = this._makeChat(opts);
    this.chats.push(c); persist.saveChats(this.chats);
    (c.members || []).forEach(aid => this.bus.subscribe(aid, c.topic));
    this.notify(); return c;
  }
  updateChat(id, patch) {
    const c = this.chats.find(x => x.id === id); if (!c) return null;
    Object.assign(c, patch);
    persist.saveChats(this.chats); this.notify(); return c;
  }
  archiveChat(id, archived = true) {
    return this.updateChat(id, archived ? { archived, archivedAt: Date.now() } : { archived, archivedAt: null });
  }
  // Auto-purge archived chats older than `days` days. Returns count deleted.
  purgeOldArchived(days) {
    if (!days || days <= 0) return 0;
    const cutoff = Date.now() - days * 86400000;
    const toDelete = this.chats.filter(c => c.archived && (c.archivedAt || c.lastActivity || 0) < cutoff);
    if (toDelete.length === 0) return 0;
    for (const c of toDelete) {
      this.chats = this.chats.filter(x => x.id !== c.id);
      persist.clearMessages(c.id);
      // H7: also delete the on-disk mirror (best-effort, fire-and-forget)
      try { chatBackup.forget(c.id); } catch {}
    }
    persist.saveChats(this.chats);
    this.notify();
    return toDelete.length;
  }
  deleteChat(id) {
    this.chats = this.chats.filter(x => x.id !== id);
    persist.saveChats(this.chats); persist.clearMessages(id);
    // H7: also delete the on-disk mirror so a "deleted" chat is really gone
    try { chatBackup.forget(id); } catch {}
    this.notify();
  }
  getChat(id)            { return this.chats.find(c => c.id === id) || null; }
  getMessages(chatId)    { return persist.loadMessages(chatId); }
  // Write a chat's messages to disk. By default this bumps lastActivity (used
  // by the sidebar's "newest first" sort and unread dot) and fires a bus ping.
  // Pass {silent:true} to flush a chat's history (e.g. an aborted background
  // turn) without bumping its position or marking it unread.
  saveMessages(chatId, msgs, { silent = false } = {}) {
    persist.saveMessages(chatId, msgs);
    if (silent) return;
    const c = this.getChat(chatId);
    if (c) { c.lastActivity = Date.now(); persist.saveChats(this.chats); }
    this.bus.send({ from: "registry", to: chatTopic(chatId), kind: "msg:appended", body: { chatId, count: msgs.length } });
    this.notify();
  }
  clearMessages(chatId) {
    persist.clearMessages(chatId);
    const c = this.getChat(chatId); if (c) { c.lastActivity = Date.now(); persist.saveChats(this.chats); }
    this.notify();
  }
  setResponder(chatId, agentId) {
    const c = this.getChat(chatId); if (!c) return;
    if (agentId && !c.members.includes(agentId)) c.members = [...c.members, agentId];
    c.responder = agentId || null;
    persist.saveChats(this.chats); this.notify();
  }

  // ── Projects ──
  createProject(name) {
    const p = { id: newId("proj"), name: name || "New project", archived: false, created: Date.now() };
    this.projects.push(p); persist.saveProjects(this.projects); this.notify(); return p;
  }
  updateProject(id, patch) {
    const p = this.projects.find(x => x.id === id); if (!p) return null;
    Object.assign(p, patch); persist.saveProjects(this.projects); this.notify(); return p;
  }
  archiveProject(id, archived = true) { return this.updateProject(id, { archived }); }
  deleteProject(id) {
    this.projects = this.projects.filter(x => x.id !== id);
    // un-assign chats that were in this project
    this.chats.forEach(c => { if (c.projectId === id) c.projectId = null; });
    persist.saveProjects(this.projects); persist.saveChats(this.chats); this.notify();
  }
}

// ─── CORE: Harness tracker — groups agent-to-agent communication for the aquarium ───
class ActionLog extends Notifier {
  constructor() {
    super();
    // M6: corrupt JSON used to throw at startup and brick the app. Now we
    // log + reset rather than propagate.
    const raw = localStorage.getItem("yumu_actionlog");
    try { this.entries = raw ? JSON.parse(raw) : []; }
    catch (e) { console.warn("[ActionLog] failed to parse; starting empty:", e); this.entries = []; }
    if (!Array.isArray(this.entries)) this.entries = [];
  }
  // M6: previously capped at 2000 entries with no per-entry size cap, so a
  // single sandbox_read of a 100 KB file × 2000 entries could try to
  // serialise ~200 MB into localStorage (quota: 5–10 MB). The setItem then
  // silently failed in the swallowed try/catch, and the log effectively
  // froze. Now: cap entries AND total serialised bytes; truncate every
  // body field at record time so a single huge tool result can't poison
  // the log.
  static MAX_ENTRIES = 2000;
  static MAX_BYTES = 1_500_000;      // ~1.5 MB total (under the 5 MB quota)
  static MAX_BODY_CHARS = 2000;       // per-entry body cap
  static _truncBody(body) {
    if (body == null) return body;
    if (typeof body === "string") {
      return body.length > ActionLog.MAX_BODY_CHARS
        ? body.slice(0, ActionLog.MAX_BODY_CHARS) + `…[+${body.length - ActionLog.MAX_BODY_CHARS} more]`
        : body;
    }
    if (typeof body !== "object") return body;
    // Object: stringify, truncate, re-wrap as a single _truncated marker
    let s;
    try { s = JSON.stringify(body); } catch { return "[unserialisable body]"; }
    if (s.length <= ActionLog.MAX_BODY_CHARS) return body;
    return { _truncated: true, preview: s.slice(0, ActionLog.MAX_BODY_CHARS) + `…[+${s.length - ActionLog.MAX_BODY_CHARS} bytes]` };
  }
  _persist() {
    if (this.entries.length > ActionLog.MAX_ENTRIES) this.entries = this.entries.slice(-ActionLog.MAX_ENTRIES);
    let s = JSON.stringify(this.entries);
    // If still over the byte cap, drop oldest entries until we fit
    while (s.length > ActionLog.MAX_BYTES && this.entries.length > 50) {
      this.entries = this.entries.slice(Math.floor(this.entries.length * 0.25));
      s = JSON.stringify(this.entries);
    }
    try { localStorage.setItem("yumu_actionlog", s); }
    catch (e) { console.warn("[ActionLog] persist failed (likely quota):", e); }
  }
  record(kind, from, to, body, chatId) {
    this.entries.push({ ts: Date.now(), kind, from: from || null, to: to || null, body: ActionLog._truncBody(body), chatId: chatId || null });
    this._persist();
    this.notify();
  }
  startHarness(agentId) { this.record("start", agentId, null, null); }
  recordCall(callerId, targetId, message) { this.record("call", callerId, targetId, message); }
  recordReply(callerId, targetId, reply) { this.record("reply", targetId, callerId, reply); }
  recordSpawn(parentId, childId, childConfig) { this.record("spawn", parentId, childId, { name: childConfig.name, model: childConfig.model }); }
  recordSpawnReply(parentId, childId, reply) { this.record("spawn_reply", childId, parentId, reply); }
  recordError(callerId, targetId, error) { this.record("error", callerId, targetId, error); }
  recordToolCall(agentId, toolName, input, chatId) { this.record("tool_call", agentId, toolName, input, chatId); }
  recordToolResult(agentId, toolName, result, chatId, latencyMs) {
    this.record("tool_result", toolName, agentId, { result, latencyMs: latencyMs || 0 }, chatId);
  }
  getAll() { return this.entries; }
  clear() { this.entries = []; this._persist(); this.notify(); }

  // Soft-archive: move current entries to an archived bucket, leave the live log empty.
  // The archive is grouped by archive-timestamp so repeated archivings show as buckets.
  archive() {
    if (this.entries.length === 0) return;
    const buckets = this._loadArchive();
    buckets.push({ ts: Date.now(), entries: this.entries });
    this._saveArchive(buckets);
    this.entries = [];
    this._persist();
    this.notify();
  }
  _loadArchive() {
    const raw = localStorage.getItem("yumu_actionlog_archived");
    try { return raw ? JSON.parse(raw) : []; }
    catch { console.warn("[ActionLog] corrupt archive; ignoring"); return []; }
  }
  _saveArchive(buckets) {
    localStorage.setItem("yumu_actionlog_archived", JSON.stringify(buckets));
  }
  getArchived() { return this._loadArchive(); }
  purgeArchive() { localStorage.removeItem("yumu_actionlog_archived"); this.notify(); }
}

const SEARCH_BACKENDS = {
  brave:  { label: "Brave", monthlyLimit: 2000, keyMatch: /brave/i,  signupUrl: "https://brave.com/search/api/" },
  tavily: { label: "Tavily", monthlyLimit: 1000, keyMatch: /tavily/i, signupUrl: "https://app.tavily.com/sign-in" },
};
class SearchStats {
  constructor() {
    try { this._data = JSON.parse(localStorage.getItem("yumuhub:searchStats")) || {}; } catch { this._data = {}; }
  }
  _month() { return new Date().toISOString().slice(0, 7); }
  _persist() { try { localStorage.setItem("yumuhub:searchStats", JSON.stringify(this._data)); } catch {} }
  bump(backend) {
    const m = this._month();
    const b = this._data[backend] || (this._data[backend] = {});
    if (b.month !== m) { b.count = 0; b.month = m; }
    b.count = (b.count || 0) + 1;
    this._persist();
    return b.count;
  }
  get(backend) {
    const b = this._data[backend];
    if (!b || b.month !== this._month()) return 0;
    return b.count || 0;
  }
  getAll() { const m = this._month(); const out = {}; for (const [k, v] of Object.entries(this._data)) out[k] = v.month === m ? (v.count || 0) : 0; return out; }
}
const searchStats = new SearchStats();

function titleFromHistory(history) {
  const firstUser = (history || []).find(m => m.role === "user");
  if (!firstUser) return null;
  return String(firstUser.content || "").trim().split("\n")[0].slice(0, 48) || null;
}

// Levenshtein edit distance — used to suggest a near-match model id when an agent
// passes a typo to spawn_agent / configure_agent. Iterative DP, O(m*n).
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
function closestModelSuggestion(target, candidates) {
  if (!target || !candidates?.length) return null;
  const lower = target.toLowerCase();
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    const d = levenshtein(lower, c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  // Only suggest if distance ≤ ⌈30%⌉ of target length OR target is a substring
  const threshold = Math.max(2, Math.ceil(target.length * 0.35));
  if (bestD <= threshold || best?.toLowerCase().includes(lower)) return best;
  return null;
}

// ─── CORE: Per-agent cost / token / latency stats ───
// Lives in-memory on AgentRuntime + persisted in localStorage for cross-session.
// SearchStats has its own monthly bucket; this is per-agent lifetime + current session.
const COST_PER_1K = {
  // Rough USD-per-1K-tokens (input, output). Used for ballpark display; not billing.
  "claude-opus-4-7":           [0.015,  0.075 ],
  "claude-sonnet-4-6":         [0.003,  0.015 ],
  "claude-haiku-4-5-20251001": [0.0008, 0.004 ],
  "gpt-4o":                    [0.0025, 0.01  ],
  "gpt-4o-mini":               [0.00015,0.0006],
  "echo-v1":                   [0,      0     ],  // Mock provider is free.
  // z.ai pricing varies widely per model — use a low default; users can adjust later.
};
function estimateCost(model, inTokens, outTokens) {
  const rate = COST_PER_1K[model] || [0.001, 0.003];
  return (inTokens || 0) / 1000 * rate[0] + (outTokens || 0) / 1000 * rate[1];
}
class CostStats extends Notifier {
  constructor() {
    super();
    try { this._data = JSON.parse(localStorage.getItem("yumuhub:costStats")) || {}; } catch { this._data = {}; }
  }
  _persist() { try { localStorage.setItem("yumuhub:costStats", JSON.stringify(this._data)); } catch {} }
  // Record one provider response. agentId scoped; model so we can show breakdown.
  record(agentId, model, inTokens, outTokens, latencyMs) {
    if (!agentId) return;
    const a = this._data[agentId] || (this._data[agentId] = { calls: 0, inTokens: 0, outTokens: 0, cost: 0, latencySum: 0, perModel: {} });
    a.calls += 1;
    a.inTokens += inTokens || 0;
    a.outTokens += outTokens || 0;
    a.latencySum += latencyMs || 0;
    a.cost += estimateCost(model, inTokens, outTokens);
    if (model) {
      const m = a.perModel[model] || (a.perModel[model] = { calls: 0, inTokens: 0, outTokens: 0, cost: 0 });
      m.calls += 1; m.inTokens += inTokens || 0; m.outTokens += outTokens || 0;
      m.cost += estimateCost(model, inTokens, outTokens);
    }
    this._persist();
    this.notify();
  }
  recordError(agentId) {
    if (!agentId) return;
    const a = this._data[agentId] || (this._data[agentId] = { calls: 0, inTokens: 0, outTokens: 0, cost: 0, latencySum: 0, perModel: {} });
    a.errors = (a.errors || 0) + 1;
    this._persist();
    this.notify();
  }
  getFor(agentId) { return this._data[agentId] || { calls: 0, inTokens: 0, outTokens: 0, cost: 0, latencySum: 0, perModel: {} }; }
  getAll() { return this._data; }
  reset(agentId) {
    if (agentId) delete this._data[agentId];
    else this._data = {};
    this._persist();
    this.notify();
  }
}
const costStats = new CostStats();

// ─── CORE: Content filter (pre-send guardrail) ───
// Returns { allowed, blockedBy } where blockedBy is the pattern label if blocked.
// Patterns are evaluated against the message text only (not multimodal blobs).
function evaluateContentFilter(text, scope) {
  const cfg = settings.get("contentFilter") || {};
  if (!cfg.enabled || !cfg.patterns?.length) return { allowed: true };
  const t = String(text ?? "");
  for (const p of cfg.patterns) {
    if (!p || (p.scope && p.scope !== "both" && p.scope !== scope)) continue;
    let re;
    try { re = new RegExp(p.source, p.flags || "i"); } catch { continue; }
    if (re.test(t)) return { allowed: false, blockedBy: p.label || p.source, mode: cfg.blockMode || "block" };
  }
  return { allowed: true };
}

// ─── CORE: Human-in-the-loop tool approval queue ───
// AgentRuntime calls approvalQueue.request({...}) and awaits the user's decision.
// SettingsView subscribes via onChange so it can render the dialog.
class ApprovalQueue extends Notifier {
  constructor() {
    super();
    this._pending = [];
    this._sessionApproved = new Set();  // toolName entries auto-approved for this session
  }
  // Resolves with "approve"|"deny"|"approve_session"
  async request({ toolName, agentId, agentName, input }) {
    const cfg = settings.get("toolApprovals") || {};
    if (!cfg.enabled) return "approve";
    const rule = cfg.rules?.[toolName];
    if (!rule || rule === "ask") {
      // fall through to UI prompt
    } else if (rule === "auto_approve") {
      return "approve";
    } else if (rule === "auto_deny") {
      return "deny";
    } else if (rule === "session" && this._sessionApproved.has(toolName)) {
      return "approve";
    } else if (rule === "session") {
      // session rule but not yet approved → ask
    } else {
      return "approve";  // unknown rule → permissive default
    }
    const req = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      toolName, agentId, agentName, input, ts: Date.now(),
    };
    return new Promise(resolve => {
      req.resolve = (decision) => {
        if (decision === "approve_session") this._sessionApproved.add(toolName);
        this._pending = this._pending.filter(r => r.id !== req.id);
        this.notify();
        resolve(decision === "approve_session" ? "approve" : decision);
      };
      this._pending.push(req);
      this.notify();
    });
  }
  list() { return this._pending; }
  clearSession() { this._sessionApproved.clear(); this.notify(); }
}
const approvalQueue = new ApprovalQueue();

// ─── CORE: Agent config version history (rollback) ───
// Stores up to MAX snapshots per agent, persisted in localStorage. Snapshots
// are taken on `saveAgent` (the OLD config is captured before overwrite),
// so restoring a snapshot returns to the state before that save.
class AgentVersions extends Notifier {
  constructor() {
    super();
    try { this._data = JSON.parse(localStorage.getItem("yumuhub:agentVersions")) || {}; } catch { this._data = {}; }
  }
  _persist() { try { localStorage.setItem("yumuhub:agentVersions", JSON.stringify(this._data)); } catch {} }
  // Snapshot the *current* config before an update so the user can roll back.
  snapshot(agentId, config, label) {
    if (!agentId || !config) return;
    const MAX = 20;
    const list = this._data[agentId] || (this._data[agentId] = []);
    // De-dup: skip if last snapshot is identical (e.g. saving without changes)
    const last = list[list.length - 1];
    if (last && JSON.stringify(last.config) === JSON.stringify(config)) return;
    list.push({ ts: Date.now(), label: label || "auto", config: JSON.parse(JSON.stringify(config)) });
    while (list.length > MAX) list.shift();
    this._persist();
    this.notify();
  }
  list(agentId) { return [...(this._data[agentId] || [])].reverse(); }
  restore(agentId, ts) {
    const list = this._data[agentId] || [];
    const found = list.find(s => s.ts === ts);
    return found ? JSON.parse(JSON.stringify(found.config)) : null;
  }
  remove(agentId, ts) {
    if (!this._data[agentId]) return;
    this._data[agentId] = this._data[agentId].filter(s => s.ts !== ts);
    this._persist();
    this.notify();
  }
  clear(agentId) {
    if (agentId) delete this._data[agentId];
    else this._data = {};
    this._persist();
    this.notify();
  }
}
const agentVersions = new AgentVersions();

// ─── CORE: Idle-flush chat backup to disk ───
// Mirrors localStorage chat messages to ~/yumuhub-workspace/chats/<id>.json after
// `idleSec` of inactivity. Best-effort: Tauri-only, silently no-ops in dev/browser.
const chatBackup = {
  _timers: {},
  schedule(chatId, getter) {
    const cfg = settings.get("diskPersistence") || {};
    if (!cfg.enabled) return;
    if (this._timers[chatId]) clearTimeout(this._timers[chatId]);
    const idleMs = Math.max(5, cfg.idleSec || 30) * 1000;
    this._timers[chatId] = setTimeout(async () => {
      // H11: re-check enabled inside the timer — the user may have
      // toggled Disk Persistence off in the idle window. Without this
      // check the flush still fires and creates a fresh file the user
      // believed they had just disabled.
      const cfgNow = settings.get("diskPersistence") || {};
      if (!cfgNow.enabled) { delete this._timers[chatId]; return; }
      try {
        const msgs = getter();
        if (!msgs || !msgs.length) return;
        await invokeTauri("chat_backup_write", { chatId, json: JSON.stringify(msgs) });
      } catch { /* no Tauri or write failed — best-effort */ }
      delete this._timers[chatId];
    }, idleMs);
  },
  async restore(chatId) {
    try {
      const txt = await invokeTauri("chat_backup_read", { chatId });
      if (!txt) return null;
      return JSON.parse(txt);
    } catch { return null; }
  },
  // H7: forget a chat — drop any pending flush AND delete the on-disk
  // mirror. Called from ChatRegistry.deleteChat and purgeOldArchived so
  // a "deleted" chat really is deleted instead of lingering on disk.
  async forget(chatId) {
    if (this._timers[chatId]) { clearTimeout(this._timers[chatId]); delete this._timers[chatId]; }
    try { await invokeTauri("chat_backup_delete", { chatId }); } catch {}
  },
  // H11: cancel every pending flush. Called when the user toggles Disk
  // Persistence off so existing timers don't fire after disable.
  cancelAll() {
    for (const id of Object.keys(this._timers)) {
      clearTimeout(this._timers[id]);
    }
    this._timers = {};
  },
  // H7: startup sweep — unlink any disk-mirror file that doesn't
  // correspond to a live chat. Run once at app launch.
  async sweepOrphans(liveChatIds) {
    try {
      const all = await invokeTauri("chat_backup_list");
      const live = new Set(liveChatIds || []);
      for (const id of (all || [])) {
        if (!live.has(id)) {
          try { await invokeTauri("chat_backup_delete", { chatId: id }); } catch {}
        }
      }
    } catch {}
  },
};

// ─── CORE: Global tool gate (deny-list) ───
// Tools listed here are GLOBALLY disabled — pluginHost refuses to run them
// and AgentRuntime filters them out of the schema list sent to the model.
class ToolGate extends Notifier {
  constructor() {
    super();
    this.set = new Set((() => { try { return JSON.parse(localStorage.getItem("yumuhub:toolsDisabled")) || []; } catch { return []; } })());
  }
  has(name)   { return this.set.has(name); }
  toggle(name){ if (this.set.has(name)) this.set.delete(name); else this.set.add(name); this._save(); this.notify(); }
  enableAll() { this.set.clear(); this._save(); this.notify(); }
  _save()     { try { localStorage.setItem("yumuhub:toolsDisabled", JSON.stringify([...this.set])); } catch {} }
}
const toolGate = new ToolGate();

// Per-provider set of model ids the user has hidden from regular pickers
// (e.g. AgentEditor's Model dropdown). Receptionist's configure_agent still
// sees and can use them — this is purely a display filter.
// Stored as { [providerId]: [modelId, ...] }.
class HiddenModels extends Notifier {
  constructor() {
    super();
    try { this.map = JSON.parse(localStorage.getItem("yumuhub:hiddenModels")) || {}; } catch { this.map = {}; }
  }
  getFor(provider) { return new Set(this.map[provider] || []); }
  has(provider, id){ return (this.map[provider] || []).includes(id); }
  toggle(provider, id) {
    const cur = new Set(this.map[provider] || []);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    this.map = { ...this.map, [provider]: [...cur] };
    this._save(); this.notify();
  }
  clearProvider(provider) { this.map = { ...this.map }; delete this.map[provider]; this._save(); this.notify(); }
  _save() { try { localStorage.setItem("yumuhub:hiddenModels", JSON.stringify(this.map)); } catch {} }
}
const hiddenModels = new HiddenModels();

// ─── CORE: PluginHost ───
class PluginHost {
  constructor() { this.tools = {}; this._runtimes = null; this._onSpawnAgent = null; this._onRemoveAgent = null; this._onUpdateAgent = null; this._getAgents = null; }
  setRuntimeRef(ref)        { this._runtimes = ref; }
  setSpawnCallback(fn)      { this._onSpawnAgent = fn; }
  setRemoveCallback(fn)     { this._onRemoveAgent = fn; }
  setUpdateCallback(fn)     { this._onUpdateAgent = fn; }
  setAgentListProvider(fn)  { this._getAgents = fn; }
  register(tool)            { this.tools[tool.name] = tool; }
  unregister(name)          { delete this.tools[name]; }
  // Drop every tool whose name starts with `prefix` (used to clear an MCP
  // server's tools before re-registering, or when it's stopped). Returns count.
  unregisterByPrefix(prefix){ let n = 0; for (const k of Object.keys(this.tools)) { if (k.startsWith(prefix)) { delete this.tools[k]; n++; } } return n; }
  get(name)                 { return this.tools[name] || null; }
  list()                    { return Object.values(this.tools); }
  getForAgent(agent)        { return (agent.tools || []).map(n => this.tools[n]).filter(Boolean); }
  async execute(name, input, ctx) {
    const tool = this.tools[name];
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (toolGate.has(name)) throw new Error(`Tool "${name}" is disabled globally in Settings → Tools.`);
    // H1: `harnessOnly` tools (spawn_agent, send_to_agent) must only be
    // callable from a root-agent tool loop, never from a child agent. The
    // tool loop sets ctx.fromHarness=true; child runtimes invoked via
    // send_to_agent set ctx.fromHarness=false (or omit it), so a child
    // calling spawn_agent here is blocked. This is what stops a child
    // from spawning grandchildren and circumventing SPAWN_CAP.
    if (tool.harnessOnly && !ctx?.fromHarness) {
      throw new Error(`Tool "${name}" is harness-only and cannot be called by a sub-agent. Only the root chat's agent may invoke it.`);
    }
    return tool.handler(input || {}, ctx);
  }
}

// ─── CORE: Sub-agent key picker ───
// Pick an idle vault key that isn't the parent's, falling back gracefully.
// Returns { keyRef, note } where note is a one-line explanation to prepend to the child's reply.
function pickSubagentKey(parent, vault, runtimes) {
  // Filter quarantined handles out of the candidate pool — Vault.resolve()
  // returns null for those, so handing them to a child is just a deferred
  // failure. M1 (quarantine bypass in pickSubagentKey).
  const allKeys   = (vault?.list() || []).filter(h => !vault?.meta?.[h]?.quarantined);
  const otherKeys = allKeys.filter(h => `vault://keys/${h}` !== parent.keyRef);
  const busyKeyRefs = new Set();
  // C1: was `rt?.status` (a field that never existed); must use anyBusy()
  // which aggregates over the per-chat statuses map.
  for (const rt of Object.values(runtimes || {})) {
    if (rt?.anyBusy?.() && rt.config?.keyRef) busyKeyRefs.add(rt.config.keyRef);
  }
  const idleOther = otherKeys.find(h => !busyKeyRefs.has(`vault://keys/${h}`));
  if (idleOther)         return { keyRef: `vault://keys/${idleOther}`,   note: `[Using idle key '${idleOther}' for child]\n` };
  if (otherKeys.length)  return { keyRef: `vault://keys/${otherKeys[0]}`, note: `[All alternate keys are busy; using '${otherKeys[0]}' anyway]\n` };
  return                       { keyRef: parent.keyRef,                   note: `[No alternate key available; sharing parent's key]\n` };
}

// ─── CORE: Built-in Tools ───
function registerBuiltinTools(ph) {
  ph.register({
    name: "calc", category: "math",
    description: "Evaluate a mathematical expression. Supports +−×÷, parentheses, ^, sqrt, abs, ceil, floor, round.",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "e.g. '2 + 2' or 'sqrt(16) * 3'" } },
      required: ["expression"],
    },
    handler: async ({ expression }) => {
      // M3: previously the allowlist was a character class containing each
      // individual letter of "sqrtabsceilfloorround", which silently
      // admitted any identifier built from those letters (e.g.
      // "constructor" → c,o,n,s,t,r,u,c,t,o,r are all permitted). Today's
      // gaps in the alphabet kept it from being RCE, but a single future
      // tweak (adding "m" or "g") could open it. Use a real token-level
      // allowlist and inject the named functions as locals so users
      // write sqrt(16), not Math.sqrt(16).
      const ALLOWED_FNS = ["sqrt", "abs", "ceil", "floor", "round", "min", "max", "pow", "log", "exp", "sin", "cos", "tan"];
      const ALLOWED_SET = new Set([...ALLOWED_FNS, "PI", "E"]);
      const src = String(expression);
      if (!/^[0-9+\-*/^.()\s%,a-zA-Z_]+$/.test(src)) return "Error: expression contains disallowed characters";
      const idents = src.match(/[a-zA-Z_][a-zA-Z_0-9]*/g) || [];
      for (const id of idents) {
        if (!ALLOWED_SET.has(id)) return `Error: identifier "${id}" not allowed. Permitted: ${[...ALLOWED_SET].join(", ")}`;
      }
      try {
        const fnNames = [...ALLOWED_SET];
        const fnVals  = fnNames.map(n => (Math[n] !== undefined ? Math[n] : undefined));
        const result = new Function(...fnNames, `"use strict"; return (${src.replace(/\^/g, "**")})`)(...fnVals);
        if (!isFinite(result)) return "Error: result is not finite";
        return String(result);
      } catch (e) { return `Error: ${e.message}`; }
    },
  });

  ph.register({
    name: "web_search", category: "web",
    description: "Search the web via Brave Search or Tavily. Each call picks whichever backend has the most remaining monthly quota (as a %), so load spreads naturally across both providers instead of draining one. Each search costs 1 API call against a monthly free-tier quota — use sparingly and only when the user's question genuinely requires current web information. Do NOT retry with reworded queries; if results are poor, fall back to your own knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string",  description: "Search query" },
        limit: { type: "number",  description: "Max results (default 5, max 10)" },
      },
      required: ["query"],
    },
    handler: async ({ query, limit = 5 }, ctx) => {
      limit = Math.min(Math.max(limit, 1), 10);
      const vaultHandles = ctx.vault?.list?.() || [];
      const resolveKey = (pattern) => {
        const h = vaultHandles.find(k => pattern.test(k));
        return h ? { handle: h, value: ctx.vault.resolve(`vault://keys/${h}`) } : null;
      };
      const candidates = [];
      const brave  = resolveKey(SEARCH_BACKENDS.brave.keyMatch);
      const tavily = resolveKey(SEARCH_BACKENDS.tavily.keyMatch);
      if (brave)  candidates.push({ id: "brave",  key: brave.value });
      if (tavily) candidates.push({ id: "tavily", key: tavily.value });
      // L4: previously this returned "no key" if neither Brave nor Tavily
      // had a key — out-of-the-box Receptionist/Research agents that ship
      // with `web_search` then failed on first use. Fall back to a
      // best-effort DuckDuckGo HTML lite scrape (no auth, no quota) so the
      // tool always returns SOMETHING usable. Result quality is lower than
      // Brave/Tavily; the response includes a hint to add a key.
      if (!candidates.length) {
        try {
          const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { method: "POST" });
          if (!res.ok) throw new Error(`ddg status ${res.status}`);
          const html = await res.text();
          // Extremely conservative HTML extraction — DuckDuckGo's lite page has
          // result anchors with class "result__a" and snippets with "result__snippet".
          const blocks = [];
          const reA = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
          const reS = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
          const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
          let m;
          const titles = [], urls = [];
          while ((m = reA.exec(html)) !== null && titles.length < limit) {
            urls.push(m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0]);
            titles.push(stripTags(m[2]));
          }
          const snippets = [];
          while ((m = reS.exec(html)) !== null && snippets.length < limit) {
            snippets.push(stripTags(m[1]));
          }
          for (let i = 0; i < titles.length; i++) {
            try {
              blocks.push(`• ${titles[i]}\n  ${decodeURIComponent(urls[i] || "")}\n  ${snippets[i] || ""}`);
            } catch { blocks.push(`• ${titles[i]}\n  ${urls[i] || ""}\n  ${snippets[i] || ""}`); }
          }
          const hint = "\n\n[DuckDuckGo fallback — for higher-quality results, add a Brave Search or Tavily key in Vault & Keys.]";
          return blocks.length
            ? blocks.join("\n\n") + hint
            : `No results for "${query}". Do NOT retry with a reworded query — use your own knowledge instead.${hint}`;
        } catch (e) {
          return `No web search API key found AND the free DuckDuckGo fallback failed (${e.message || e}). Add a Brave Search or Tavily key in Vault & Keys.`;
        }
      }
      // Auto-balance: pick whichever backend has the highest remaining quota as a
      // percentage of its monthly limit. Naturally distributes load across both
      // providers so neither runs out mid-month while the other sits idle.
      const ranked = candidates
        .filter(c => searchStats.get(c.id) < SEARCH_BACKENDS[c.id].monthlyLimit)
        .sort((a, b) => {
          const ar = 1 - searchStats.get(a.id) / SEARCH_BACKENDS[a.id].monthlyLimit;
          const br = 1 - searchStats.get(b.id) / SEARCH_BACKENDS[b.id].monthlyLimit;
          return br - ar;
        });
      for (const cand of ranked) {
        const meta = SEARCH_BACKENDS[cand.id];
        try {
          let results;
          if (cand.id === "brave") {
            // Brave's API doesn't handle CORS preflight (OPTIONS returns 405),
            // so we proxy through a Tauri command that uses curl in Rust.
            const raw = await invokeTauri("brave_search", { query, count: limit, key: cand.key });
            const { status, body } = JSON.parse(raw);
            if (status !== 200) { continue; }
            const data = JSON.parse(body);
            results = (data.web?.results || []).slice(0, limit).map(r => `• ${r.title}\n  ${r.url}\n  ${r.description || ""}`);
          } else {
            const res = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ api_key: cand.key, query, max_results: limit, search_depth: "basic" }),
            });
            if (!res.ok) { continue; }
            const data = await res.json();
            results = (data.results || []).slice(0, limit).map(r => `• ${r.title}\n  ${r.url}\n  ${r.content || ""}`);
          }
          const count = searchStats.bump(cand.id);
          const tag = `[${meta.label}: ${count}/${meta.monthlyLimit} this month]`;
          return results.length
            ? `${results.join("\n\n")}\n\n${tag}`
            : `No results for "${query}". Do NOT retry with a reworded query — use your own knowledge instead.\n\n${tag}`;
        } catch { continue; }
      }
      const quotas = candidates.map(c => { const m = SEARCH_BACKENDS[c.id]; return `${m.label}: ${searchStats.get(c.id)}/${m.monthlyLimit}`; }).join(", ");
      return `All search backends exhausted or at quota (${quotas}). Wait until next month or add another search key.`;
    },
  });

  ph.register({
    name: "file_read", category: "files",
    description: "Open a file picker dialog and read the text contents of the selected file.",
    inputSchema: {
      type: "object",
      properties: { hint: { type: "string", description: "Optional description of what file to open" } },
      required: [],
    },
    handler: async () => new Promise(resolve => {
      const el = document.createElement("input");
      el.type = "file";
      el.accept = ".txt,.md,.json,.js,.jsx,.ts,.tsx,.py,.csv,.html,.css,.yaml,.yml,.toml,.xml,.sh";
      el.onchange  = e => {
        const file = e.target.files?.[0];
        if (!file) { resolve("No file selected."); return; }
        const reader = new FileReader();
        reader.onload  = ev => resolve(`File: ${file.name}\nSize: ${file.size} bytes\n\n${ev.target.result}`);
        reader.onerror = ()  => resolve("Error: could not read file.");
        reader.readAsText(file);
      };
      el.oncancel = () => resolve("File picker cancelled.");
      el.click();
    }),
  });

  // N3: send_to_agent now bounds both ends of the transport against the
  // ~60s upstream stream timeout that providers like z.ai impose:
  //
  //  - INPUT side: hard refuse messages over INPUT_HARD_LIMIT (200KB).
  //    Optionally chunk inputs over CHUNK_TRIGGER (12KB) into multiple
  //    sequential chat() calls (so each chunk's history-send is bounded);
  //    intermediate chunks use a tiny maxOutputTokens so the "ack" is fast.
  //
  //  - OUTPUT side: caller can pass maxOutputTokens to bound the reply
  //    length explicitly. Recommended for forward-only data transfers
  //    where the receiver should respond concisely.
  const INPUT_HARD_LIMIT = 200_000;
  const CHUNK_TRIGGER    = 12_000;
  const CHUNK_SIZE       = 10_000;
  ph.register({
    name: "send_to_agent", category: "agents", harnessOnly: true,
    description: `Send a message to another agent and wait for its reply.\n\nKEY KNOB — maxOutputTokens: most providers cap streaming responses at ~60s wall-clock. If you expect the receiver to generate a long analysis, set maxOutputTokens to bound its reply (e.g. 512 for a summary, 2048 for medium detail). Without this cap, long generations fail with "stream dropped after 60s".\n\nLARGE-PAYLOAD STRATEGY: do NOT try to forward a big file by pasting its content into the message field — your own tool_use call has the same 60s output cap. Instead, instruct the receiver to use sandbox_read or file_read to fetch the file directly. If you genuinely have to embed content, set chunkInput=true (splits into ${CHUNK_SIZE}-byte sequential turns; only the final turn uses your maxOutputTokens). Hard input limit: ${INPUT_HARD_LIMIT} bytes.`,
    inputSchema: {
      type: "object",
      properties: {
        agentId:          { type: "string",  description: "Target agent ID, e.g. agt_research" },
        message:          { type: "string",  description: "Message to send" },
        maxOutputTokens:  { type: "number",  description: `Optional. Caps the receiver's reply length. Useful to avoid 60s stream timeouts on large generations. Range: 64 to model max.` },
        chunkInput:       { type: "boolean", description: `Optional. If true and message > ${CHUNK_TRIGGER} bytes, split into ${CHUNK_SIZE}-byte chunks sent as sequential turns. Intermediate chunks get a tiny reply cap; only the final chunk uses your maxOutputTokens.` },
      },
      required: ["agentId", "message"],
    },
    handler: async ({ agentId, message, maxOutputTokens, chunkInput }, ctx) => {
      const target = ctx.runtimes?.[agentId];
      if (!target) {
        const avail = Object.keys(ctx.runtimes || {}).join(", ");
        return `Error: agent "${agentId}" not found. Available: ${avail || "(none)"}`;
      }
      const msgStr = String(message ?? "");
      if (msgStr.length > INPUT_HARD_LIMIT) {
        return `Error: message too large (${msgStr.length} bytes, limit ${INPUT_HARD_LIMIT}). Split into multiple sequential send_to_agent calls, or summarize before sending.`;
      }
      const callerId = ctx.agentConfig.id;
      const baseOpts = { onActivity: ctx.parentResetIdleTimer };
      if (maxOutputTokens) baseOpts.maxOutputTokens = Number(maxOutputTokens);

      // No-chunk path
      const shouldChunk = chunkInput && msgStr.length > CHUNK_TRIGGER;
      if (!shouldChunk) {
        actionLog.recordCall(callerId, agentId, msgStr.slice(0, 1000));
        try {
          const reply = await target.chat(msgStr, baseOpts);
          actionLog.recordReply(callerId, agentId, reply);
          return reply;
        } catch (e) {
          actionLog.recordError(callerId, agentId, e.message);
          return `Error from ${agentId}: ${e.message}`;
        }
      }

      // Chunk path — break the message into pieces and feed them as
      // sequential user turns. The receiving agent's history naturally
      // accumulates the full picture; intermediate turns are tiny-reply.
      const chunks = [];
      for (let i = 0; i < msgStr.length; i += CHUNK_SIZE) chunks.push(msgStr.slice(i, i + CHUNK_SIZE));
      actionLog.recordCall(callerId, agentId, `[chunked: ${chunks.length} parts] ${msgStr.slice(0, 200)}…`);
      let finalReply = "";
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const wrapped = isLast
          ? `[Auto-chunked message ${i + 1}/${chunks.length} — FINAL CHUNK]\n\n${chunks[i]}\n\n[END OF MESSAGE — the full assembled message is now in your history. Respond to it.]`
          : `[Auto-chunked message ${i + 1}/${chunks.length} — partial; more chunks coming]\n\n${chunks[i]}\n\n[CONT — reply with exactly the word "ack" so the next chunk can be sent. Do not analyze yet.]`;
        const opts = isLast ? baseOpts : { ...baseOpts, maxOutputTokens: 64 };
        try {
          finalReply = await target.chat(wrapped, opts);
        } catch (e) {
          actionLog.recordError(callerId, agentId, `chunk ${i + 1}/${chunks.length}: ${e.message}`);
          return `Error from ${agentId} on chunk ${i + 1}/${chunks.length}: ${e.message}`;
        }
      }
      actionLog.recordReply(callerId, agentId, finalReply);
      return finalReply;
    },
  });

  const SPAWN_CAP = 6;
  ph.register({
    name: "spawn_agent", category: "agents", harnessOnly: true,
    description: `Create a temporary child agent to work on a sub-task. Children cannot spawn further agents. By default the child uses an IDLE API key from the vault (different from the parent's) so the parent's key isn't tied up. Pick a model that matches the task complexity — small/fast models for quick lookups, larger models for reasoning or code.\n\nHard limit: at most ${SPAWN_CAP} concurrent ephemeral children per parent. Plan batches accordingly; the ${SPAWN_CAP + 1}th spawn fails until one of the first ${SPAWN_CAP} has finished AND been removed via remove_agent.`,
    inputSchema: {
      type: "object",
      properties: {
        name:         { type: "string", description: "Display name for the child" },
        systemPrompt: { type: "string", description: "System prompt for the child" },
        task:         { type: "string", description: "Initial task to send" },
        model:        { type: "string", description: "Model the child should use. Pick based on the task: a fast small model for simple lookups, a larger reasoning model for complex coding or analysis. Defaults to parent's model if omitted." },
        keyRef:       { type: "string", description: "Optional vault key reference (e.g. 'vault://keys/anthropic_alt') to override the auto-selected idle key." },
      },
      required: ["name", "task"],
    },
    handler: async ({ name, systemPrompt, task, model, keyRef }, ctx) => {
      if (!ctx.onSpawnAgent) return "Error: spawn_agent not available in this context.";
      const parent   = ctx.agentConfig;
      const activeChildren = (ctx.getAgents?.() || []).filter(a => a.ephemeral && a.parentId === parent.id && ctx.runtimes?.[a.id]);
      if (activeChildren.length >= SPAWN_CAP) {
        const names = activeChildren.map(a => `${a.name} (${a.id})`).join(", ");
        return `Error: spawn cap reached — ${activeChildren.length}/${SPAWN_CAP} concurrent ephemeral children already alive for parent "${parent.name}". Remove one with remove_agent before spawning a new one. Active: ${names}`;
      }
      const childId  = `agt_c_${Date.now().toString(36)}`;
      const childTools = (parent.tools || []).filter(t => t !== "spawn_agent");

      const { keyRef: chosenKeyRef, note: keyChoiceNote } = keyRef
        ? { keyRef, note: "" }
        : pickSubagentKey(parent, ctx.vault, ctx.runtimes);

      const chosenProvider = parent.provider;
      const providerModels = normalizeModels(providers[chosenProvider]?.models);
      // Case-insensitive lookup so agents passing "glm-5.1" find canonical "GLM-5.1".
      // The provider's API may or may not be case-sensitive, but we always store
      // the canonical (catalog) casing in the agent config to be safe.
      let chosenModel = model || parent.model;
      if (model) {
        const canonical = providerModels.find(m => m.id.toLowerCase() === String(model).toLowerCase());
        if (!canonical) {
          const ids = providerModels.map(m => m.id);
          const suggestion = closestModelSuggestion(String(model), ids);
          const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
          return `Error: model "${model}" is not valid for provider "${chosenProvider}".${hint} Available models: ${ids.join(", ")}. Use list_models to see all options.`;
        }
        chosenModel = canonical.id;
      }
      const resolvedKey = ctx.vault?.resolve?.(chosenKeyRef);
      if (!resolvedKey && !providers[chosenProvider]?.noKeyRequired && chosenProvider !== "mock") {
        return `Error: no API key resolves for provider "${chosenProvider}" (keyRef=${chosenKeyRef}). Add a key in Vault & Keys, or pick a different provider. Use list_models to see which providers have keys.`;
      }

      const childConfig = {
        id: childId, name,
        provider: chosenProvider,
        model:    chosenModel,
        keyRef:   chosenKeyRef,
        systemPrompt: systemPrompt || `You are ${name}, a focused sub-agent. Complete your assigned task.`,
        tools: childTools,
        params: { ...parent.params },
        parentId: parent.id,
        ephemeral: true,
      };
      await ctx.onSpawnAgent(childConfig);
      const rt = ctx.runtimes?.[childId];
      if (!rt) return `Spawned "${name}" (${childId}) but runtime not ready.`;
      actionLog.recordSpawn(parent.id, childId, childConfig);
      try {
        const reply = await rt.chat(task, { onActivity: ctx.parentResetIdleTimer });
        actionLog.recordSpawnReply(parent.id, childId, reply);
        return `${keyChoiceNote}[${name}]:\n${reply}`;
      } catch (e) {
        actionLog.recordError(parent.id, childId, e.message);
        return `${keyChoiceNote}[${name}] error: ${e.message}`;
      }
    },
  });

  ph.register({
    name: "list_agents", category: "agents",
    description: "List all agents currently registered in this yumuHub session. Returns one line per agent: '<id>  <name>  [provider/model]  <tools>  ephemeral?'. Use this before remove_agent to see what's available.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async (_input, ctx) => {
      const list = ctx.getAgents?.() || [];
      if (!list.length) return "(no agents registered)";
      return list.map(a => `${a.id}  ${a.name}  [${a.provider}/${a.model}]  tools:[${(a.tools||[]).join(",")}]${a.ephemeral ? "  ephemeral" : ""}`).join("\n");
    },
  });

  ph.register({
    name: "remove_agent", category: "agents",
    description: "Remove an EPHEMERAL child agent (spawned via spawn_agent). Refuses to remove non-ephemeral / seed agents — those must be deleted via the UI. Useful for cleaning up the agent menu after sub-tasks finish.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "ID of the agent to remove (e.g. 'agt_c_lxyz...'). Get this from list_agents." },
      },
      required: ["agentId"],
    },
    handler: async ({ agentId }, ctx) => {
      if (!ctx.onRemoveAgent) return "Error: remove_agent is not wired into this context.";
      const list = ctx.getAgents?.() || [];
      const target = list.find(a => a.id === agentId);
      if (!target)            return `Error: no agent with id "${agentId}". Try list_agents.`;
      if (!target.ephemeral)  return `Error: "${target.name}" (${agentId}) is not ephemeral. Refusing — only spawn_agent children can be removed via this tool.`;
      if (agentId === ctx.agentConfig?.id) return `Error: agent cannot remove itself.`;
      try { await ctx.onRemoveAgent(agentId); return `Removed "${target.name}" (${agentId}).`; }
      catch (e) { return `Error: ${e.message || e}`; }
    },
  });

  ph.register({
    name: "list_models", category: "agents",
    description: "List all models available across providers. Shows which providers have API keys configured (✓ = key available, ✗ = no key). Returns one line per model with category and description. IMPORTANT: only pick models from providers marked with ✓ — others will fail at runtime.",
    inputSchema: {
      type: "object",
      properties: { provider: { type: "string", description: "Optional provider filter ('anthropic'|'openai'|'zai'|'mock')." } },
      required: [],
    },
    handler: async ({ provider }, ctx) => {
      const withKeys = providersWithKeys(ctx.vault);
      const out = [];
      for (const p of Object.values(providers)) {
        if (provider && p.id !== provider) continue;
        const hasKey = withKeys.has(p.id);
        out.push(`\n── ${p.name} ${hasKey ? "✓ key available" : "✗ NO KEY — models below will fail"} ──`);
        for (const m of normalizeModels(p.models)) {
          const cat = m.category ? `[${m.category}]` : "";
          out.push(`  ${p.id}/${m.id}  ${cat}  ${m.description || ""}`);
        }
      }
      return out.join("\n") || "(no models)";
    },
  });

  ph.register({
    name: "configure_agent", category: "agents",
    description: "Reconfigure a MAIN (non-ephemeral) agent's tools, model, provider, system prompt, or blunt-mode flag. Use this to retool an agent for a new kind of task (e.g. give Coder access to web_search, switch Research to a stronger model, turn blunt mode OFF on a creative writing agent). Refuses to configure ephemeral spawned children and refuses to configure the caller. Use list_agents first to see current values and valid agent ids.",
    inputSchema: {
      type: "object",
      properties: {
        agentId:      { type: "string", description: "Target agent id (e.g. 'agt_coder'). Get from list_agents." },
        tools:        { type: "array", items: { type: "string" }, description: "Optional. Full replacement tool list. Each must be a registered tool name." },
        model:        { type: "string", description: "Optional. New model id (must be valid for the agent's provider)." },
        provider:     { type: "string", description: "Optional. New provider id ('anthropic'|'openai'|'zai'|'mock'). If changed, also pass a compatible 'model'." },
        systemPrompt: { type: "string", description: "Optional. Full replacement system prompt." },
        bluntMode:    { type: "boolean", description: "Optional. true = strip social_context/politeness (default for non-creative agents). false = preserve descriptive phrasing (recommended for creative work)." },
      },
      required: ["agentId"],
    },
    handler: async ({ agentId, tools, model, provider, systemPrompt, bluntMode }, ctx) => {
      if (!ctx.onUpdateAgent) return "Error: configure_agent is not wired into this context.";
      const list   = ctx.getAgents?.() || [];
      const target = list.find(a => a.id === agentId);
      if (!target)                          return `Error: no agent with id "${agentId}". Try list_agents.`;
      if (target.ephemeral)                 return `Error: "${target.name}" is an ephemeral spawned agent — use spawn_agent / remove_agent instead.`;
      if (agentId === ctx.agentConfig?.id)  return `Error: agent cannot reconfigure itself.`;
      const patch = {};
      if (Array.isArray(tools)) {
        const known = Object.keys(ctx.pluginHost?.tools || {});
        const bad   = tools.filter(t => !known.includes(t));
        if (bad.length) return `Error: unknown tools: ${bad.join(", ")}. Known: ${known.join(", ")}.`;
        patch.tools = tools;
      }
      if (typeof provider === "string" && provider) {
        if (!providers[provider]) return `Error: unknown provider "${provider}". Valid: ${Object.keys(providers).join(", ")}.`;
        patch.provider = provider;
      }
      if (typeof model === "string" && model) {
        const effectiveProvider = patch.provider || target.provider;
        const validModels = normalizeModels(providers[effectiveProvider]?.models);
        // Case-insensitive lookup so agents passing "glm-5.1" find canonical "GLM-5.1".
        const canonical = validModels.find(m => m.id.toLowerCase() === model.toLowerCase());
        if (!canonical) {
          const ids = validModels.map(m => m.id);
          const suggestion = closestModelSuggestion(model, ids);
          const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
          return `Error: model "${model}" is not valid for provider "${effectiveProvider}".${hint} Available: ${ids.join(", ")}.`;
        }
        patch.model = canonical.id;  // store canonical casing
      }
      if (typeof systemPrompt === "string" && systemPrompt) patch.systemPrompt = systemPrompt;
      if (typeof bluntMode    === "boolean")                patch.bluntMode    = bluntMode;
      if (!Object.keys(patch).length) return "No changes specified.";
      try { await ctx.onUpdateAgent(agentId, patch);
            const changed = Object.keys(patch).join(", ");
            return `Reconfigured "${target.name}" (${agentId}): ${changed}.`; }
      catch (e) { return `Error: ${e.message || e}`; }
    },
  });

  ph.register({
    name: "sandbox_status", category: "self-edit",
    description: "Check whether the beta sandbox at ~/yumuhub-beta exists and is ready for editing. Always call this once at the start of a self-editing session.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      try { return await invokeTauri("beta_status"); }
      catch (e) { return `Error: ${e.message || e}`; }
    },
  });

  ph.register({
    name: "sandbox_init", category: "self-edit",
    description: "Clone the live yumuHub source from ~/yumuhub to ~/yumuhub-beta. Excludes node_modules, target, dist, .git. Safe to call repeatedly — it will overwrite files in the sandbox.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      try { return await invokeTauri("clone_sandbox"); }
      catch (e) { return `Error: ${e.message || e}`; }
    },
  });

  ph.register({
    name: "sandbox_read", category: "self-edit",
    description: "Read a file from the beta sandbox. Path is relative to ~/yumuhub-beta (e.g. 'src/YumuHub.jsx', 'src-tauri/src/main.rs').",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to ~/yumuhub-beta" } },
      required: ["path"],
    },
    handler: async ({ path }) => {
      try { return await invokeTauri("beta_read", { path }); }
      catch (e) { return `Error: ${e.message || e}`; }
    },
  });

  ph.register({
    name: "sandbox_list", category: "self-edit",
    description: "List files and directories in a beta sandbox directory. Path is relative to ~/yumuhub-beta. Use '.' for the root.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to ~/yumuhub-beta, '.' for root" } },
      required: ["path"],
    },
    handler: async ({ path }) => {
      try {
        const items = await invokeTauri("beta_list", { path });
        return items.length ? items.join("\n") : "(empty directory)";
      } catch (e) { return `Error: ${e.message || e}`; }
    },
  });

  ph.register({
    name: "sandbox_write", category: "self-edit",
    description: "Write a file in the beta sandbox. Path is relative to ~/yumuhub-beta. ALWAYS reads the current contents first via sandbox_read, then writes the full new contents. A .bak file is saved automatically. This only affects the BETA copy — the running app (yumuHub) is untouched.",
    inputSchema: {
      type: "object",
      properties: {
        path:     { type: "string", description: "Path relative to ~/yumuhub-beta" },
        contents: { type: "string", description: "Full new file contents" },
      },
      required: ["path", "contents"],
    },
    handler: async ({ path, contents }) => {
      try { return await invokeTauri("beta_write", { path, contents }); }
      catch (e) { return `Error: ${e.message || e}`; }
    },
  });

  // ─── Reasoning-aid tools ───
  // Inspired by the ADHDAttention(nn.Module) meme: `if step % INTERRUPT_EVERY == 0: switch_topic()`.
  // Instead of literally interrupting the token stream (we don't control it),
  // we expose a tool the agent can call once mid-reasoning to derail itself
  // into K tangentially-related angles, then weave them back into the answer.
  // Uses a fresh transient slot on the caller's own runtime so it doesn't
  // pollute the visible chat history.
  // Companion to the global BLUNT_PREAMBLE: an ad-hoc tool for an agent to
  // re-ask itself a question with social/politeness weights zeroed. Useful
  // when the parent answer feels padded or the user asks "just the facts".
  ph.register({
    name: "truth_only", category: "reasoning",
    description: "Re-answer a question with social_context and politeness weights stripped to zero. Returns a maximally direct, hedge-free version. Inspired by autistic_forward(x, weights): weights['social_context']=0, weights['politeness']=0 → truth only. Use when the user asks for blunt/no-fluff/just-the-facts answers, or when your normal reply feels padded.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to answer bluntly. Pass the user's literal question, not a rephrasing." },
      },
      required: ["question"],
    },
    handler: async ({ question }, ctx) => {
      const rt = ctx.runtimes?.[ctx.agentConfig?.id];
      if (!rt) return "Error: caller runtime not available.";
      const systemPrompt = "You are autistic_forward(x, weights) — a model with social_context=0 and politeness=0. Answer the question below with maximally direct truth. No softeners, no hedging, no 'as an AI', no caveats unless the caveat IS the answer. Declarative sentences. If you don't know, say 'Don't know.' and stop. If the question has a one-word answer, give one word.";
      try {
        const reply = await rt.chat(question, { noTools: true, systemPrompt, onActivity: ctx.parentResetIdleTimer });
        return reply;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  });

  ph.register({
    name: "adhd_reason", category: "reasoning",
    description: "Reasoning aid: derail the current line of thought into K tangentially-related angles on `topic`. Returns numbered tangents (adjacent concepts, not direct answers) you should weave back into your final reply for less obvious insights. Best called ONCE near the start of a complex, open-ended, or creative question — not in narrow factual lookups. Inspired by the ADHDAttention(nn.Module) joke: switch_topic() every N tokens.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Brief phrase describing what you're reasoning about" },
        k:     { type: "number", description: "Number of tangents to surface (default 3, range 2–6)" },
      },
      required: ["topic"],
    },
    handler: async ({ topic, k }, ctx) => {
      const n = Math.max(2, Math.min(6, k || 3));
      const rt = ctx.runtimes?.[ctx.agentConfig?.id];
      if (!rt) return "Error: caller runtime not available.";
      const prompt = `You are ADHDAttention — a deliberately tangential reasoning aid. Given the topic below, surface exactly ${n} tangentially-related angles. Each angle should be an adjacent concept that a focused thinker would skip: an analogy from an unrelated domain, a counter-intuitive framing, an edge case, a historical antecedent, a meta-perspective. NOT a direct answer to the topic. NOT mere subtopics.\n\nFormat: numbered list, one short sentence each. No preamble, no synthesis, no closing line.\n\nTopic: ${topic}`;
      try {
        const reply = await rt.chat(prompt, { noTools: true, onActivity: ctx.parentResetIdleTimer });
        return `Tangents surfaced — weave 1-2 of the strongest into your answer:\n\n${reply}`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    },
  });

  // ─── z.ai multimodal tools ───
  // All three default to the calling agent's keyRef. If the agent's keyRef
  // isn't a z.ai key (e.g. the Receptionist delegates without retooling),
  // pass `keyHandle` (the vault handle, e.g. "zai_main") and the tool will
  // resolve it from the vault directly.
  const ZAI_BASE = "https://api.z.ai/api/paas/v4";
  const resolveZaiKey = (ctx, keyHandle) => {
    if (keyHandle) {
      const k = ctx.vault?.resolve?.(`vault://keys/${keyHandle}`);
      if (k) return k;
    }
    const ref = ctx.agentConfig?.keyRef;
    return ref ? (ctx.vault?.resolve?.(ref) || null) : null;
  };
  // Convert a z.ai error response body into a single-line message the LLM can
  // act on. We surface the literal code + message AND attach a hint when the
  // pattern matches a billing problem — z.ai's Coding Plan key reaches the
  // general-API endpoint but has its own (often empty) balance bucket.
  const formatZaiError = (status, body) => {
    let code = "", msg = body.slice(0, 400);
    try {
      const j = JSON.parse(body);
      code = j.error?.code || j.code || "";
      msg  = j.error?.message || j.message || msg;
    } catch {}
    const billingHint = /balance|insufficient|quota|credit|account|余额|配额/i.test(msg)
      ? " — your z.ai Coding Plan does NOT include media credits. Add pay-as-you-go credits at https://z.ai/manage-apikey/subscription or use a different (general-API) key on this agent."
      : "";
    return `Error ${code || status}: ${msg}${billingHint}`;
  };

  ph.register({
    name: "pick_audio_file", category: "media",
    description: "Open a native file picker for an audio file (.mp3/.wav/.m4a/.ogg/.webm/.flac, ≤25MB). Returns a JSON object {name, mime, size, base64} — pass the base64 field as `audio_base64` to zai_transcribe.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => new Promise(resolve => {
      if (typeof document === "undefined") { resolve("Error: file picker requires a browser context."); return; }
      const el = document.createElement("input");
      el.type = "file";
      el.accept = "audio/*,.mp3,.wav,.m4a,.ogg,.webm,.flac";
      el.onchange = e => {
        const file = e.target.files?.[0];
        if (!file) { resolve("No file selected."); return; }
        if (file.size > 25 * 1024 * 1024) {
          resolve(`Error: ${file.name} is ${Math.round(file.size/1024/1024)}MB — z.ai's transcription limit is 25MB.`);
          return;
        }
        const reader = new FileReader();
        reader.onload = ev => {
          const dataUrl = String(ev.target.result || "");
          const base64 = dataUrl.split(",")[1] || "";
          resolve(JSON.stringify({ name: file.name, mime: file.type, size: file.size, base64 }));
        };
        reader.onerror = () => resolve("Error: could not read file.");
        reader.readAsDataURL(file);
      };
      el.oncancel = () => resolve("File picker cancelled.");
      el.click();
    }),
  });

  ph.register({
    name: "zai_transcribe", category: "media",
    description: "Transcribe an audio clip via z.ai (default model: glm-asr-2512). Pass either `audio_url` (a publicly fetchable URL) or `audio_base64` (raw base64, no data:URL prefix). Returns the transcript text. Limits: 25MB / 30s per clip.",
    inputSchema: {
      type: "object",
      properties: {
        audio_url:    { type: "string", description: "Publicly fetchable URL to the audio file" },
        audio_base64: { type: "string", description: "Raw base64-encoded audio (no data:URL prefix). Use pick_audio_file to obtain this from a local file." },
        model:        { type: "string", description: "ASR model id (default: glm-asr-2512)" },
        prompt:       { type: "string", description: "Optional context to guide transcription" },
        hotwords:     { type: "array",  items: { type: "string" }, description: "Domain vocabulary hints (max 100 words)" },
        keyHandle:    { type: "string", description: "Vault key handle (only if the agent's keyRef isn't z.ai)" },
      },
      required: [],
    },
    handler: async ({ audio_url, audio_base64, model, prompt, hotwords, keyHandle }, ctx) => {
      const apiKey = resolveZaiKey(ctx, keyHandle);
      if (!apiKey) return "Error: no z.ai API key. Either set one as the agent's keyRef or pass keyHandle.";
      if (!audio_url && !audio_base64) return "Error: provide audio_url or audio_base64.";
      const m = model || "glm-asr-2512";
      const body = { model: m };
      if (audio_url)    body.file_url    = audio_url;
      if (audio_base64) body.file_base64 = audio_base64;
      if (prompt)   body.prompt   = prompt;
      if (hotwords) body.hotwords = hotwords;
      try {
        const res = await fetch(`${ZAI_BASE}/audio/transcriptions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        });
        const txt = await res.text();
        if (!res.ok) return formatZaiError(res.status, txt);
        try { return JSON.parse(txt).text || txt; } catch { return txt; }
      } catch (e) { return `Error: ${e.message}`; }
    },
  });

  ph.register({
    name: "zai_image", category: "media",
    description: "Generate an image from a text prompt via z.ai. Valid models: 'cogView-4-250304' (cheapest, $0.01, default) or 'glm-image' ($0.015, supports varied aspect ratios). Returns the generated image URL — the chat renders it inline.",
    inputSchema: {
      type: "object",
      properties: {
        prompt:    { type: "string", description: "What the image should depict (vivid, specific prompts work best)" },
        model:     { type: "string", description: "Image model id. Allowed: 'cogView-4-250304' (default) or 'glm-image'. The casing matters." },
        size:      { type: "string", description: "Output dimensions like '1024x1024', '1280x720', '720x1280'. For glm-image: width/height must be multiples of 32, 512-2048px each. Default: 1024x1024." },
        keyHandle: { type: "string", description: "Vault key handle (only if the agent's keyRef isn't z.ai)" },
      },
      required: ["prompt"],
    },
    handler: async ({ prompt, model, size, keyHandle }, ctx) => {
      const apiKey = resolveZaiKey(ctx, keyHandle);
      if (!apiKey) return "Error: no z.ai API key.";
      const body = { model: model || "cogView-4-250304", prompt, size: size || "1024x1024" };
      try {
        const res = await fetch(`${ZAI_BASE}/images/generations`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        });
        const txt = await res.text();
        if (!res.ok) return formatZaiError(res.status, txt);
        const j = JSON.parse(txt);
        const item = j.data?.[0] || {};
        if (item.url) return item.url;
        if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
        return `No image URL in response: ${txt.slice(0, 300)}`;
      } catch (e) { return `Error: ${e.message}`; }
    },
  });

  ph.register({
    name: "zai_video", category: "media",
    description: "Generate a video from a text prompt via z.ai (CogVideoX family). Async — submits the job, polls every 5s until ready (typical wait 30–90s, can be minutes), and returns the video URL. The chat renders the video inline.",
    inputSchema: {
      type: "object",
      properties: {
        prompt:    { type: "string", description: "What the video should depict" },
        model:     { type: "string", description: "Video model id (default: cogvideox-3). Other options: vidu-q1, vidu-2." },
        image_url: { type: "string", description: "Optional starting image URL — makes this an image-to-video request" },
        size:      { type: "string", description: "Output resolution (e.g. '1920x1080'). Supports up to 4K. Default: 1920x1080." },
        quality:   { type: "string", description: "'quality' (slower, better) or 'speed' (faster, lower quality). Default: speed." },
        fps:       { type: "number", description: "Frame rate: 30 or 60. Default: 30." },
        with_audio:{ type: "boolean", description: "Generate accompanying audio. Default: false." },
        keyHandle: { type: "string", description: "Vault key handle (only if the agent's keyRef isn't z.ai)" },
      },
      required: ["prompt"],
    },
    handler: async ({ prompt, model, image_url, size, quality, fps, with_audio, keyHandle }, ctx) => {
      const apiKey = resolveZaiKey(ctx, keyHandle);
      if (!apiKey) return "Error: no z.ai API key.";
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      const body = { model: model || "cogvideox-3", prompt };
      if (image_url)              body.image_url  = image_url;
      if (size)                   body.size       = size;
      if (quality)                body.quality    = quality;
      if (fps)                    body.fps        = fps;
      if (with_audio !== undefined) body.with_audio = with_audio;
      // M2: honor the chat's AbortSignal so a user-aborted chat doesn't
      // keep polling for up to 5 min and consuming credits.
      const signal = ctx.signal;
      if (signal?.aborted) return "[Aborted before video request started]";
      try {
        const res = await fetch(`${ZAI_BASE}/videos/generations`, { method: "POST", headers, body: JSON.stringify(body), signal });
        const txt = await res.text();
        if (!res.ok) return formatZaiError(res.status, txt);
        const j = JSON.parse(txt);
        const taskId = j.id || j.task_id || j.request_id;
        if (!taskId) return `No task id in response: ${txt.slice(0, 300)}`;
        // Poll. Heartbeat the parent runtime's idle timer so we don't time out
        // while the model is rendering (renders can take minutes).
        const start = Date.now();
        const maxMs = 5 * 60 * 1000;
        // Abort-aware sleep: rejects immediately if the signal fires during
        // the 5-second tick rather than waiting the full interval out.
        const sleep = (ms) => new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
          const t = setTimeout(resolve, ms);
          if (signal) {
            const onAbort = () => { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); };
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        while (Date.now() - start < maxMs) {
          if (signal?.aborted) return `[Aborted; task ${taskId} may still be running on z.ai — fetch the result later if needed]`;
          ctx.parentResetIdleTimer?.();
          await sleep(5000);
          const r2 = await fetch(`${ZAI_BASE}/async-result/${taskId}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
          const t2 = await r2.text();
          if (!r2.ok) return `Polling failed — ${formatZaiError(r2.status, t2)}`;
          const j2 = JSON.parse(t2);
          const status = (j2.task_status || j2.status || "").toString().toUpperCase();
          if (status === "SUCCESS" || status === "COMPLETED") {
            const url = j2.video_result?.[0]?.url || j2.video_url || j2.result?.video_url;
            return url || `Done but no URL: ${t2.slice(0, 300)}`;
          }
          if (status === "FAIL" || status === "FAILED") return `Generation failed: ${t2.slice(0, 300)}`;
        }
        return `Timed out after 5 minutes. Task id: ${taskId} — try fetching the result later.`;
      } catch (e) {
        if (e?.name === "AbortError") return `[Aborted by user during video generation/polling]`;
        return `Error: ${e.message}`;
      }
    },
  });
}

async function invokeTauri(cmd, args) {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
    throw new Error("Tauri runtime not available (not running inside the Tauri shell)");
  }
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke(cmd, args);
}

// ─── CORE: History ↔ Provider format converters ───
// User messages can be a plain string OR a multimodal content array:
//   "hello"  OR  [{ type: "text", text: "hello" }, { type: "image", base64: "...", mime: "image/png" }]
function toAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") return { type: "image", source: { type: "base64", media_type: part.mime || "image/png", data: part.base64 } };
    return { type: "text", text: String(part.text || "") };
  });
}
function toOpenAIContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") return { type: "image_url", image_url: { url: `data:${part.mime || "image/png"};base64,${part.base64}` } };
    return { type: "text", text: String(part.text || "") };
  });
}

function toAnthropicMessages(history) {
  const out = [];
  for (const msg of history) {
    if (msg.role === "user") {
      out.push({ role: "user", content: toAnthropicContent(msg.content) });
    } else if (msg.role === "assistant") {
      if (msg.toolCalls?.length) {
        const content = [];
        if (msg.content) content.push({ type: "text", text: msg.content });
        msg.toolCalls.forEach(tc => content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input }));
        out.push({ role: "assistant", content });
      } else {
        out.push({ role: "assistant", content: msg.content || "" });
      }
    } else if (msg.role === "tool") {
      out.push({
        role: "user",
        content: msg.toolResults.map(tr => ({ type: "tool_result", tool_use_id: tr.toolCallId, content: tr.result })),
      });
    }
  }
  return out;
}

function toOpenAIMessages(history, systemPrompt) {
  const out = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  for (const msg of history) {
    if (msg.role === "user") {
      out.push({ role: "user", content: toOpenAIContent(msg.content) });
    } else if (msg.role === "assistant") {
      if (msg.toolCalls?.length) {
        out.push({
          role: "assistant", content: msg.content || null,
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id, type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          })),
        });
      } else {
        out.push({ role: "assistant", content: msg.content || "" });
      }
    } else if (msg.role === "tool") {
      msg.toolResults.forEach(tr =>
        out.push({ role: "tool", tool_call_id: tr.toolCallId, content: tr.result })
      );
    }
  }
  return out;
}

// ─── CORE: SSE stream reader ───
async function readSSE(response, signal, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // K3 extension: track elapsed + bytes-received so a mid-stream "Load
  // failed" (WebKit drops a long-running connection) carries the same
  // diagnostic context as a failed initial fetch.
  const start = Date.now();
  let bytesRead = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        const elapsedMs = Date.now() - start;
        const kb = (bytesRead / 1024).toFixed(1);
        throw new Error(`stream dropped after ${elapsedMs}ms (${kb}KB received): ${e?.message || e}. Possible causes: network drop, provider-side timeout, response too large for the webview to buffer.`);
      }
      const { done, value } = chunk;
      if (done) break;
      bytesRead += value?.length || 0;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { onEvent(JSON.parse(data)); } catch {}
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// Shared POST + error wrapper for streaming provider calls.
// K3: wraps generic "Load failed" / "TypeError: NetworkError" fetch
// failures with size + elapsed-time context so the caller can tell
// whether they hit a body-size limit, a timeout, or an actual outage.
async function postProvider(url, headers, body, signal, providerLabel) {
  const bodyText = JSON.stringify(body);
  const sizeKb = (bodyText.length / 1024).toFixed(1);
  const start = Date.now();
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: bodyText, signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    const elapsedMs = Date.now() - start;
    const hint = bodyText.length > 200_000
      ? " (request body >200KB — likely exceeded the provider's max request size)"
      : elapsedMs > 60_000
        ? " (no response after >60s — likely network timeout or unreachable host)"
        : "";
    throw new Error(`${providerLabel} fetch failed after ${elapsedMs}ms (request: ${sizeKb}KB): ${e?.message || e}${hint}`);
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error?.message || `${providerLabel} ${res.status} (request: ${sizeKb}KB)`);
  }
  return res;
}

async function streamOpenAICompatible({ url, headers, body, tools, signal, onDelta, providerLabel }) {
  if (tools.length) body.tools = tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  // Request usage from OpenAI-compatible APIs (OpenAI sets stream_options; many compatibles ignore it but pass-through harmlessly).
  body.stream_options = { include_usage: true };
  const res = await postProvider(url, headers, body, signal, providerLabel);
  let text = "";
  const toolMap = {};  // index -> { id, name, args }
  let usage = null;
  await readSSE(res, signal, (evt) => {
    if (evt.usage) usage = { inTokens: evt.usage.prompt_tokens || 0, outTokens: evt.usage.completion_tokens || 0 };
    const delta = evt.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onDelta?.(delta.content);
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const cur = toolMap[idx] || (toolMap[idx] = { id: "", name: "", args: "" });
        if (tc.id) cur.id = tc.id;
        // M4: name only arrives in the first delta per OpenAI spec, but
        // some OpenAI-compat backends (some z.ai routes, certain local
        // proxies) repeat it in subsequent deltas. Concatenation produces
        // names like "spawn_agentspawn_agent" which then fail as
        // "Unknown tool". Set once and ignore subsequent re-emissions.
        if (tc.function?.name && !cur.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
      }
    }
  });
  const keys = Object.keys(toolMap);
  let toolCalls = null;
  if (keys.length) {
    toolCalls = keys.map(k => {
      const tc = toolMap[k];
      let input = {};
      let argError = null;
      // M14/K1: surface JSON parse failures instead of silently defaulting
      // to {}. When max_tokens cuts off the streamed arguments mid-JSON,
      // we now tell the LLM exactly what happened so it can retry with a
      // smaller payload or break the work into multiple calls.
      if (tc.args) {
        try { input = JSON.parse(tc.args); }
        catch (e) { argError = `Tool arguments failed to parse (likely truncated by max_tokens or malformed JSON): ${e.message}. Received ${tc.args.length} bytes ending: "...${tc.args.slice(-80)}". Retry with a shorter argument, or pass large payloads as separate messages.`; }
      }
      return { id: tc.id, name: tc.name, input, argError };
    });
  }
  return { text: text || null, toolCalls, usage };
}

// ─── CORE: Provider Adapters ───
// Provider model lists can be either bare ids (legacy: "gpt-4o") or rich
// objects ({ id, label?, description? }). normalizeModels coerces both shapes
// into the rich form so the rest of the app doesn't branch on it.
function normalizeModels(list) {
  return (list || []).map(m => typeof m === "string"
    ? { id: m, label: m, description: "", category: null }
    : { id: m.id, label: m.label || m.id, description: m.description || "", category: m.category || null });
}

// K2: Per-model max output tokens. The previous hardcoded 4096 routinely
// truncated tool-call argument JSON when the model had to embed an attached
// file in a `send_to_agent({message: ...})` call — JSON.parse failed
// silently (M14/K1) and the tool fired with empty `{}`. Values are each
// provider's published max output cap. Updated 2026-05-28 from z.ai's
// own model guides (docs.z.ai/guides/llm/<model>.md): the GLM-5.x family
// supports 128K output, not 16-32K as we'd estimated. Unknown models
// fall back to 8192 (safer than 4096 without risking budget surprise).
const MAX_OUT_TOKENS = {
  // Anthropic Claude 4.x — 64K output
  "claude-opus-4-7":          64000,
  "claude-sonnet-4-6":        64000,
  "claude-haiku-4-5-20251001": 64000,
  // OpenAI — 16K output
  "gpt-4o":      16384,
  "gpt-4o-mini": 16384,
  // z.ai GLM-5.x family — 128K output (per docs.z.ai)
  "GLM-5.1":          131072,
  "GLM-5":            131072,
  "GLM-4.7":          131072,
  "GLM-4.7-Flash":    131072,
  // Smaller / older / specialty models
  "GLM-5-Turbo":      16384,
  "GLM-4.6":          65536,
  "glm-z1-air":        8192,
  "glm-z1-airx":       8192,
  "glm-zero-preview":  8192,
};
function maxOutTokens(model) {
  if (!model) return 8192;
  if (MAX_OUT_TOKENS[model] != null) return MAX_OUT_TOKENS[model];
  // Strip provider prefix if present (e.g. "zai/GLM-5.1" → "GLM-5.1")
  const stripped = String(model).split("/").pop();
  if (MAX_OUT_TOKENS[stripped] != null) return MAX_OUT_TOKENS[stripped];
  return 8192;
}

const providers = {
  anthropic: {
    id: "anthropic", name: "Anthropic (Claude)",
    models: [
      { id: "claude-opus-4-7",           label: "Claude Opus 4.7",   category: "reasoning", description: "Most capable. Best for complex reasoning, coding, multi-step analysis." },
      { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6", category: "language",  description: "Balanced speed and quality. Good default for most tasks." },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",  category: "language",  description: "Fastest and cheapest. Quick lookups, simple Q&A, high throughput." },
    ],
    async send(history, systemPrompt, model, apiKey, tools = [], signal, onDelta, maxOutputTokensOverride) {
      if (!apiKey) throw new Error("No API key configured");
      // N3: honor per-call override but cap at model max (don't let a
      // caller request more than the model supports).
      const cap = maxOutTokens(model);
      const effectiveMaxTokens = maxOutputTokensOverride
        ? Math.max(64, Math.min(cap, Number(maxOutputTokensOverride)))
        : cap;
      const body = { model, max_tokens: effectiveMaxTokens, messages: toAnthropicMessages(history), stream: true };
      if (systemPrompt) body.system = systemPrompt;
      if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      const res = await postProvider(
        "https://api.anthropic.com/v1/messages",
        { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body, signal, "Anthropic"
      );
      let text = "";
      const blocks = {};  // idx -> { type, id?, name?, jsonBuf? }
      let usage = null;
      await readSSE(res, signal, (evt) => {
        if (evt.type === "message_start" && evt.message?.usage) {
          usage = { inTokens: evt.message.usage.input_tokens || 0, outTokens: evt.message.usage.output_tokens || 0 };
        } else if (evt.type === "message_delta" && evt.usage) {
          // Anthropic sends running output_tokens here; cumulative replace
          usage = { inTokens: usage?.inTokens || 0, outTokens: evt.usage.output_tokens || 0 };
        } else if (evt.type === "content_block_start") {
          blocks[evt.index] = { ...evt.content_block, jsonBuf: "" };
        } else if (evt.type === "content_block_delta") {
          const blk = blocks[evt.index];
          if (evt.delta.type === "text_delta") {
            text += evt.delta.text;
            onDelta?.(evt.delta.text);
          } else if (evt.delta.type === "input_json_delta" && blk) {
            blk.jsonBuf += evt.delta.partial_json || "";
          }
        }
      });
      let toolCalls = null;
      for (const blk of Object.values(blocks)) {
        if (blk.type === "tool_use") {
          if (!toolCalls) toolCalls = [];
          let input = {};
          let argError = null;
          if (blk.jsonBuf) {
            try { input = JSON.parse(blk.jsonBuf); }
            catch (e) { argError = `Tool arguments failed to parse (likely truncated by max_tokens or malformed JSON): ${e.message}. Received ${blk.jsonBuf.length} bytes ending: "...${blk.jsonBuf.slice(-80)}". Retry with a shorter argument, or pass large payloads as separate messages.`; }
          }
          toolCalls.push({ id: blk.id, name: blk.name, input, argError });
        }
      }
      return { text: text || null, toolCalls, usage };
    },
  },
  ccr: {
    id: "ccr", name: "Claude Code Router (local)",
    noKeyRequired: true,
    // Local daemon (default http://127.0.0.1:3456). Speaks Anthropic format
    // and forwards to whatever provider/model the user configured in
    // ~/.config/claude-code-router/config.json. Model id maps to ccr's
    // routing aliases OR direct "provider,model_id" syntax.
    models: [
      { id: "default",     label: "default",     category: "language",  description: "ccr's default route (whatever you set in config)." },
      { id: "background",  label: "background",  category: "language",  description: "ccr's cheap/fast tier — short, low-stakes tasks." },
      { id: "think",       label: "think",       category: "reasoning", description: "ccr's reasoning tier — complex analysis, planning." },
      { id: "longContext", label: "longContext", category: "language",  description: "ccr's long-context tier — large docs, big codebases." },
      { id: "webSearch",   label: "webSearch",   category: "language",  description: "ccr's web-search tier (if your provider supports it)." },
    ],
    async send(history, systemPrompt, model, apiKey, tools = [], signal, onDelta, maxOutputTokensOverride) {
      // ccr's daemon APIKEY is what bypasses its CORS origin check; the agent's
      // vault keyRef is ignored here because ccr handles upstream auth via its
      // own config.json (each Provider entry has its own api_key).
      const ccrApiKey = settings.get("ccrApiKey");
      const headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
      if (ccrApiKey) headers["Authorization"] = `Bearer ${ccrApiKey}`;
      const cap = maxOutTokens(model);
      const effectiveMaxTokens = maxOutputTokensOverride
        ? Math.max(64, Math.min(cap, Number(maxOutputTokensOverride)))
        : cap;
      const body = { model, max_tokens: effectiveMaxTokens, messages: toAnthropicMessages(history), stream: true };
      if (systemPrompt) body.system = systemPrompt;
      if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
      const baseUrl = (settings.get("ccrUrl") || "http://127.0.0.1:3456").replace(/\/+$/, "");
      const res = await postProvider(`${baseUrl}/v1/messages`, headers, body, signal, "ccr");
      let text = "";
      const blocks = {};
      let usage = null;
      await readSSE(res, signal, (evt) => {
        if (evt.type === "message_start" && evt.message?.usage) {
          usage = { inTokens: evt.message.usage.input_tokens || 0, outTokens: evt.message.usage.output_tokens || 0 };
        } else if (evt.type === "message_delta" && evt.usage) {
          usage = { inTokens: usage?.inTokens || 0, outTokens: evt.usage.output_tokens || 0 };
        } else if (evt.type === "content_block_start") {
          blocks[evt.index] = { ...evt.content_block, jsonBuf: "" };
        } else if (evt.type === "content_block_delta") {
          const blk = blocks[evt.index];
          if (evt.delta.type === "text_delta") {
            text += evt.delta.text;
            onDelta?.(evt.delta.text);
          } else if (evt.delta.type === "input_json_delta" && blk) {
            blk.jsonBuf += evt.delta.partial_json || "";
          }
        }
      });
      let toolCalls = null;
      for (const blk of Object.values(blocks)) {
        if (blk.type === "tool_use") {
          if (!toolCalls) toolCalls = [];
          let input = {};
          let argError = null;
          if (blk.jsonBuf) {
            try { input = JSON.parse(blk.jsonBuf); }
            catch (e) { argError = `Tool arguments failed to parse (likely truncated by max_tokens or malformed JSON): ${e.message}. Received ${blk.jsonBuf.length} bytes ending: "...${blk.jsonBuf.slice(-80)}". Retry with a shorter argument, or pass large payloads as separate messages.`; }
          }
          toolCalls.push({ id: blk.id, name: blk.name, input, argError });
        }
      }
      return { text: text || null, toolCalls, usage };
    },
  },
  openai: {
    id: "openai", name: "OpenAI",
    models: [
      { id: "gpt-4o",      label: "GPT-4o",      category: "reasoning", description: "Flagship multimodal model. Strong reasoning, vision, coding." },
      { id: "gpt-4o-mini", label: "GPT-4o Mini", category: "language",  description: "Fast and cheap. Good for simple tasks and high throughput." },
    ],
    async send(history, systemPrompt, model, apiKey, tools = [], signal, onDelta, maxOutputTokensOverride) {
      if (!apiKey) throw new Error("No API key configured");
      const cap = maxOutTokens(model);
      const effectiveMaxTokens = maxOutputTokensOverride
        ? Math.max(64, Math.min(cap, Number(maxOutputTokensOverride)))
        : cap;
      return streamOpenAICompatible({
        url: "https://api.openai.com/v1/chat/completions",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: { model, messages: toOpenAIMessages(history, systemPrompt), max_tokens: effectiveMaxTokens, stream: true },
        tools, signal, onDelta, providerLabel: "OpenAI",
      });
    },
  },
  zai: {
    id: "zai", name: "z.ai",
    // BigModel (Zhipu) lineup. Newer GLM-5 variants kept with original casing
    // (the existing setup used these as-is and they work with the API).
    // 4.x and Z1 entries use lowercase per BigModel docs. Description is shown
    // in pickers and to the Receptionist when picking a model for a task.
    models: [
      // ── Reasoning models (purple on z.ai) ──
      { id: "GLM-5.1",          label: "GLM-5.1",          category: "reasoning", description: "Latest flagship. Best overall: long-horizon reasoning, coding, 8-hour autonomous work, engineering-grade output." },
      { id: "GLM-5",            label: "GLM-5",            category: "reasoning", description: "Strong coding, reliable multi-step reasoning, natural conversation. Matches Opus 4.6 tier." },
      { id: "GLM-4.7",          label: "GLM-4.7",          category: "reasoning", description: "Enhanced programming, stable multi-step reasoning, strong agent task performance." },
      { id: "GLM-4.7-Flash",    label: "GLM-4.7 Flash",    category: "reasoning", description: "30B params. Lightweight, efficient, high-performance. Outranks similar-scale open-source models." },
      { id: "glm-z1-air",       label: "GLM-Z1 Air",       category: "reasoning", description: "Reasoning specialist — chain-of-thought heavy tasks, step-by-step analysis." },
      { id: "glm-z1-airx",      label: "GLM-Z1 AirX",      category: "reasoning", description: "Stronger reasoning than Z1 Air — complex multi-hop logic and math." },
      { id: "glm-zero-preview", label: "GLM Zero Preview", category: "reasoning", description: "Experimental zero-shot reasoning preview." },
      // ── Language models (blue on z.ai) ──
      { id: "GLM-5-Turbo",      label: "GLM-5-Turbo",      category: "language", description: "Fast GLM-5 variant optimized for complex, dynamic, long-chain tasks. Good speed/quality trade-off." },
      { id: "glm-4.6",          label: "GLM-4.6",          category: "language", description: "Strong reasoning and long context window." },
      { id: "glm-4.5",          label: "GLM-4.5",          category: "language", description: "Solid general-purpose chat and coding." },
      { id: "GLM-4.5-Air",      label: "GLM-4.5 Air",      category: "language", description: "SOTA cost-effectiveness. Fast everyday Q&A at lower cost." },
      { id: "glm-4-plus",       label: "GLM-4 Plus",       category: "language", description: "GLM-4 enhanced — balanced quality vs latency." },
      { id: "glm-4-air",        label: "GLM-4 Air",        category: "language", description: "Lightweight — cheap quick queries." },
      { id: "glm-4-airx",       label: "GLM-4 AirX",       category: "language", description: "Stronger instruction-following than Air." },
      { id: "glm-4-flash",      label: "GLM-4 Flash",      category: "language", description: "Free tier — instant lookups, low-precision OK." },
      { id: "glm-4-flashx",     label: "GLM-4 FlashX",     category: "language", description: "Flash with longer context — still very cheap." },
      { id: "glm-4-long",       label: "GLM-4 Long",       category: "language", description: "128k+ context — long documents, summarization." },
      { id: "GLM-4-32B-0414-128K", label: "GLM-4-32B 128K", category: "language", description: "32B general-purpose. Cost-efficient for Q&A, coding, search, structured tasks." },
      // ── Vision models (yellow on z.ai) ──
      { id: "GLM-4.6V",         label: "GLM-4.6V",         category: "vision", description: "128k context, SoTA visual understanding, native function calling. Links vision to executable actions." },
      { id: "glm-ocr",          label: "GLM-OCR",          category: "vision", description: "Lightweight OCR model. High accuracy, low cost, stable structured output for complex documents." },
      { id: "GLM-5V-Turbo",     label: "GLM-5V Turbo",     category: "vision", description: "Multimodal agent foundation model. Native vision + language, long-term planning, complex programming." },
      // ── Image generation models ──
      { id: "cogView-4-250304", label: "CogView-4",        category: "image", description: "Cheapest image gen ($0.01). Good default for most prompts." },
      { id: "glm-image",        label: "GLM-Image",        category: "image", description: "Image gen with varied aspect ratios ($0.015). Width/height 512-2048px in multiples of 32." },
      // ── Video generation models ──
      { id: "cogvideox-3",      label: "CogVideoX-3",      category: "video", description: "Default video gen. Async polling, 30-90s typical. Supports text-to-video and image-to-video." },
      { id: "vidu-q1",          label: "Vidu Q1",          category: "video", description: "Alternative video model — quality-focused." },
      { id: "vidu-2",           label: "Vidu 2",           category: "video", description: "Latest Vidu model — improved quality and speed." },
      // ── Audio / recognition ──
      { id: "glm-asr-2512",     label: "GLM-ASR-2512",     category: "recognition", description: "Speech-to-text. Industry-leading recognition accuracy, supports hotwords. 25MB / 30s per clip." },
    ],
    async send(history, systemPrompt, model, apiKey, tools = [], signal, onDelta, maxOutputTokensOverride) {
      if (!apiKey) throw new Error("No API key configured");
      const cap = maxOutTokens(model);
      const effectiveMaxTokens = maxOutputTokensOverride
        ? Math.max(64, Math.min(cap, Number(maxOutputTokensOverride)))
        : cap;
      // Per z.ai docs there are three endpoints. See zaiEndpoint setting
      // doc for trade-offs. Default = "anthropic" (Claude-compat, same
      // URL Claude Code uses, inherits Coding Plan quota without the
      // third-party throttle).
      const ep = settings.get("zaiEndpoint") || "anthropic";
      // Anthropic-format route: speak Anthropic Messages protocol against
      // z.ai's Claude-compat endpoint. WebKit's fetch implementation
      // throws "Load failed" on this specific endpoint (~7s in) while
      // curl works perfectly, so we route through a Rust-side curl proxy
      // (Tauri command `zai_anthropic_proxy`). Non-streaming for now —
      // the response lands all at once but we still parse the SSE body
      // server returned, preserving usage/tool-call extraction.
      if (ep === "anthropic") {
        const body = { model, max_tokens: effectiveMaxTokens, messages: toAnthropicMessages(history), stream: true };
        if (systemPrompt) body.system = systemPrompt;
        if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const raw = await invokeTauri("zai_anthropic_proxy", { apiKey, body: JSON.stringify(body) });
        const { status, body: respBody } = JSON.parse(raw);
        if (status < 200 || status >= 300) {
          let errMsg = `z.ai (anthropic-format) HTTP ${status}`;
          try { const j = JSON.parse(respBody); errMsg += `: ${j.error?.message || respBody.slice(0, 300)}`; }
          catch { errMsg += `: ${respBody.slice(0, 300)}`; }
          throw new Error(errMsg);
        }
        // Parse the SSE body line-by-line (same logic as readSSE but on
        // a string instead of a Response stream). The proxy returns the
        // full assembled response so the loop runs once at end.
        let text = "";
        const blocks = {};
        let usage = null;
        for (const line of respBody.split("\n")) {
          const trimmed = line.replace(/\r$/, "");
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let evt;
          try { evt = JSON.parse(data); } catch { continue; }
          if (evt.type === "message_start" && evt.message?.usage) {
            usage = { inTokens: evt.message.usage.input_tokens || 0, outTokens: evt.message.usage.output_tokens || 0 };
          } else if (evt.type === "message_delta" && evt.usage) {
            usage = { inTokens: usage?.inTokens || 0, outTokens: evt.usage.output_tokens || 0 };
          } else if (evt.type === "content_block_start") {
            blocks[evt.index] = { ...evt.content_block, jsonBuf: "" };
          } else if (evt.type === "content_block_delta") {
            const blk = blocks[evt.index];
            if (evt.delta.type === "text_delta") { text += evt.delta.text; onDelta?.(evt.delta.text); }
            else if (evt.delta.type === "input_json_delta" && blk) { blk.jsonBuf += evt.delta.partial_json || ""; }
          }
        }
        let toolCalls = null;
        for (const blk of Object.values(blocks)) {
          if (blk.type === "tool_use") {
            if (!toolCalls) toolCalls = [];
            let input = {};
            let argError = null;
            if (blk.jsonBuf) {
              try { input = JSON.parse(blk.jsonBuf); }
              catch (e) { argError = `Tool arguments failed to parse (likely truncated by max_tokens or malformed JSON): ${e.message}. Received ${blk.jsonBuf.length} bytes ending: "...${blk.jsonBuf.slice(-80)}". Retry with a shorter argument, or pass large payloads as separate messages.`; }
            }
            toolCalls.push({ id: blk.id, name: blk.name, input, argError });
          }
        }
        return { text: text || null, toolCalls, usage };
      }
      // OpenAI-format routes (coding plan vs general API balance)
      const url = ep === "general"
        ? "https://api.z.ai/api/paas/v4/chat/completions"
        : "https://api.z.ai/api/coding/paas/v4/chat/completions";
      return streamOpenAICompatible({
        url,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: { model, messages: toOpenAIMessages(history, systemPrompt), max_tokens: effectiveMaxTokens, stream: true },
        tools, signal, onDelta, providerLabel: "z.ai",
      });
    },
  },
  mock: {
    id: "mock", name: "Mock (no key needed)",
    models: ["echo-v1"],
    async send(history, systemPrompt, model, apiKey, tools, signal, onDelta) {
      const last    = history[history.length - 1]?.content || "";
      const persona = systemPrompt ? systemPrompt.split(".")[0] : "I'm a mock agent";
      const full    = `${persona}.\n\nYou said: "${last}"\n\nThis is a simulated streaming response. Connect a real API key in Settings to use Claude or GPT.`;
      let text = "";
      for (const chunk of full.match(/(\s+|\S+)/g) || []) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await new Promise(r => setTimeout(r, 30));
        text += chunk;
        onDelta?.(chunk);
      }
      // Synthetic usage (~4 chars/token) so the context meter + cost stats
      // exercise the full UI even with no API key. Mock is priced at $0.
      const inChars = (systemPrompt?.length || 0) + history.reduce((a, m) => a + (typeof m.content === "string" ? m.content.length : 0), 0);
      return { text, toolCalls: null, usage: { inTokens: Math.ceil(inChars / 4), outTokens: Math.ceil(text.length / 4) } };
    },
  },
};

// ─── CORE: Agent Runtime ───
class AgentRuntime extends Notifier {
  constructor(config, vault, bus, providerAdapters, pluginHost, registry) {
    super();
    this.config    = config;
    this.vault     = vault;
    this.bus       = bus;
    this.providers = providerAdapters;
    this.pluginHost = pluginHost || null;
    this.registry   = registry || null;
    // Multi-tenant: each chat owns its own slot inside this runtime so
    // multiple chats with the same agent can run in parallel without
    // clobbering each other's history / status / abort state.
    this.histories     = {};   // chatId -> messages[]
    this.statuses      = {};   // chatId -> "idle"|"busy"|"tool:xxx"|"error"
    this._aborts       = {};   // chatId -> AbortController
    this._abortReasons = {};   // chatId -> "user"|"timeout"|null
    this._resetTimers  = {};   // chatId -> () => void (idle-timer resetter, set during chat())
    this._transient    = new Set();  // chatIds whose slot must not persist to registry
    // Optional "last-touched" hint for UIs that want a default — not used as
    // load-state any more (each chat() call passes opts.chatId).
    this.activeChatId  = null;
    bus.register(config.id);
  }

  // ─── Per-chat accessors ───
  // Lazy-hydrates a slot from the registry on first access.
  getHistory(chatId) {
    if (!chatId) return [];
    if (!this.histories[chatId]) {
      this.histories[chatId] = this.registry ? [...this.registry.getMessages(chatId)] : [];
    }
    return this.histories[chatId];
  }
  setHistory(chatId, msgs) {
    if (!chatId) return;
    this.histories[chatId] = [...msgs];
    if (this.registry && !this._transient.has(chatId)) this.registry.saveMessages(chatId, this.histories[chatId]);
    this.notify();
  }
  statusOf(chatId) { return (chatId && this.statuses[chatId]) || "idle"; }
  // True if any slot is mid-call. Used by agent-level "active but available" badge.
  anyBusy() {
    return Object.values(this.statuses).some(s => s === "busy" || (typeof s === "string" && s.startsWith("tool:")));
  }
  // Forget a chat's slot — call when a chat is deleted.
  dropChat(chatId) {
    if (!chatId) return;
    // H3: abort any in-flight chat() for this slot BEFORE deleting state.
    // Without this, the in-flight tool loop's `const hist = histories[id]`
    // closure still mutates a now-orphaned array; when chat() reaches
    // _finish() it would persist `histories[id] || []` (empty) over the
    // user's real on-disk history. The abort triggers the catch branch in
    // chat(), which runs _finish — but with histories[id] already
    // undefined we now have to guard there too (see _finish below).
    if (this._aborts[chatId]) {
      this._abortReasons[chatId] = "dropped";
      try { this._aborts[chatId].abort(); } catch {}
    }
    delete this.histories[chatId];
    delete this.statuses[chatId];
    delete this._aborts[chatId];
    delete this._abortReasons[chatId];
    delete this._resetTimers[chatId];
    this._transient.delete(chatId);
    if (this.activeChatId === chatId) this.activeChatId = null;
    this.notify();
  }

  // Streaming-safe notify: coalesces bursts of mutations into ~60fps frames so a
  // 200-token reply doesn't trigger 200 full-history re-renders.
  notifyStream() {
    if (this._notifyScheduled) return;
    this._notifyScheduled = true;
    const fire = () => { this._notifyScheduled = false; this.notify(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(fire);
    else setTimeout(fire, 16);
  }

  abort(chatId) {
    if (!chatId) return;
    this._abortReasons[chatId] = "user";
    this._aborts[chatId]?.abort();
  }

  // Persist a slot's history and update its status. Called at every chat() exit.
  _finish(chatId, status) {
    // H3: if dropChat() ran while a chat was in-flight, histories[chatId]
    // is already undefined. Persisting `[] || []` here would wipe the
    // user's on-disk history. Skip the save entirely in that case — the
    // slot is gone, leave the registry's last good snapshot in place.
    if (chatId && this.histories[chatId] === undefined) {
      if (chatId) this.statuses[chatId] = status;
      this.notify();
      return;
    }
    if (chatId && this.registry && !this._transient.has(chatId)) {
      this.registry.saveMessages(chatId, this.histories[chatId] || []);
      chatBackup.schedule(chatId, () => this.histories[chatId] || []);
    }
    if (chatId) this.statuses[chatId] = status;
    this.notify();
  }

  // chat(userMessage, opts) — opts.chatId scopes the call to a slot. If no
  // chatId is given (Improve UI, ad-hoc one-shots), a transient slot is used
  // and dropped on completion so persistent histories aren't polluted.
  async chat(userMessage, opts = {}) {
    const idleMs = opts.idleMs ?? (settings.get("idleSec") * 1000);
    const onActivity = opts.onActivity || null;
    let chatId = opts.chatId;
    const transient = !chatId;
    if (!chatId) {
      chatId = `_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
      this._transient.add(chatId);
    }
    this.activeChatId = chatId;
    const hist = this.getHistory(chatId);
    // Pre-send content filter — blocks the message before any provider call.
    const ftext = typeof userMessage === "string" ? userMessage : (Array.isArray(userMessage) ? userMessage.filter(p => p?.type === "text").map(p => p.text).join(" ") : "");
    const guard = evaluateContentFilter(ftext, "user");
    if (!guard.allowed) {
      actionLog.record("filter_block", this.config.id, null, { scope: "user", blockedBy: guard.blockedBy, mode: guard.mode }, chatId);
      if (guard.mode === "block") {
        const reply = `[Content filter] Message blocked by rule: "${guard.blockedBy}". Adjust patterns in Settings → Content filter to change this.`;
        hist.push({ role: "user", content: userMessage });
        hist.push({ role: "assistant", content: reply });
        this._finish(chatId, "idle");
        return reply;
      }
      // warn mode: log only, continue
    }
    this.statuses[chatId] = "busy";
    hist.push({ role: "user", content: userMessage, ts: Date.now() });
    const abortCtrl = new AbortController();
    this._aborts[chatId] = abortCtrl;
    this._abortReasons[chatId] = null;
    const signal = abortCtrl.signal;
    let timeoutId = null;
    const resetIdleTimer = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        this._abortReasons[chatId] = "timeout";
        this._aborts[chatId]?.abort();
      }, idleMs);
      if (onActivity) { try { onActivity(); } catch {} }
    };
    this._resetTimers[chatId] = resetIdleTimer;
    resetIdleTimer();
    this.notify();
    try {
      const adapter = this.providers[this.config.provider];
      if (!adapter) throw new Error(`Unknown provider: ${this.config.provider}`);
      const apiKey = this.config.keyRef ? this.vault.resolve(this.config.keyRef) : null;
      // H12: the agent points at a vault key that resolved to null. The
      // most common reason (other than missing key) is that the user
      // quarantined it — surface a clean, actionable message instead of
      // letting the provider fail with a raw 401 or "no key".
      if (this.config.keyRef && apiKey === null) {
        const handle = String(this.config.keyRef).replace(/^vault:\/\/keys\//, "");
        const quarantined = !!this.vault?.meta?.[handle]?.quarantined;
        const msg = quarantined
          ? `[Key '${handle}' is quarantined in Vault & Keys] This agent's key is currently suspended and cannot be used. Either restore it (Vault → click the key's status dot) or pick a different key on this agent.`
          : `[No API key found for handle '${handle}'] The agent's keyRef references a key that doesn't exist in the vault. Add it in Vault & Keys, or update this agent's keyRef.`;
        hist.push({ role: "user", content: userMessage });
        hist.push({ role: "assistant", content: msg });
        this._finish(chatId, "idle");
        return msg;
      }
      // Layer per-chat overrides over agent config (model, tools, system prompt). Provider/key stay agent-owned.
      const chatRec = (this.registry && chatId) ? this.registry.getChat(chatId) : null;
      const ov = chatRec?.overrides || {};
      const effectiveModel = ov.model || this.config.model;
      const effectiveAgent = ov.tools ? { ...this.config, tools: ov.tools } : this.config;
      const tools  = opts.noTools ? [] : (this.pluginHost ? this.pluginHost.getForAgent(effectiveAgent).filter(t => !toolGate.has(t.name)) : []);
      const u = (universal.text || "").trim();
      // Per-chat system-prompt override replaces the agent persona for this chat
      // only, but still wraps with the universal prompt + preamble below.
      const baseSP = opts.systemPrompt ?? ov.systemPrompt ?? this.config.systemPrompt;
      // Blunt mode: per-agent `bluntMode` wins; falls back to the global
      // setting. When the caller passes an explicit opts.systemPrompt we
      // respect it as-is — they want full control.
      const useBlunt = this.config.bluntMode ?? settings.get("bluntMode") ?? true;
      const blunt = useBlunt ? BLUNT_PREAMBLE : "";
      const systemPrompt = opts.systemPrompt
        ? opts.systemPrompt
        : [AGENT_PREAMBLE, blunt, u, baseSP].filter(Boolean).join("\n\n---\n\n");
      // N3: per-call max_tokens override (used by send_to_agent's input
      // chunker to bound intermediate "ack" replies, and by callers who
      // know their response should be short to avoid hitting the 60s
      // provider stream timeout on long generations).
      const reply = await this._toolLoop(chatId, adapter, apiKey, tools, systemPrompt, signal, effectiveModel, opts.maxOutputTokens);
      this._finish(chatId, "idle");
      return reply;
    } catch (err) {
      if (err?.name === "AbortError") {
        const marker = this._abortReasons[chatId] === "timeout"
          ? `[No activity for ${Math.round(idleMs/1000)}s — API appears unresponsive. Try again, or use a different model.]`
          : "[Stopped by user]";
        const last = hist[hist.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          last.content = (last.content ? last.content + "\n\n" : "") + marker;
          delete last.streaming;
        } else if (last?.role === "assistant" && Array.isArray(last.toolCalls) && last.toolCalls.length) {
          // H2: aborted after the LLM emitted tool_use but before tool_result
          // landed. Anthropic + OpenAI both reject any history where a
          // tool_use is followed by anything other than its tool_result, so
          // we synthesize a synthetic [Aborted] result for every dangling
          // tool_use BEFORE appending the marker. Otherwise the next send
          // dies with a 400 the user can't recover from without clearing
          // chat history manually.
          hist.push({ role: "tool", toolResults: last.toolCalls.map(tc => ({
            toolCallId: tc.id, name: tc.name, result: `[Aborted before tool ran: ${marker}]`,
          })) });
          hist.push({ role: "assistant", content: marker });
        } else {
          hist.push({ role: "assistant", content: marker });
        }
        this._finish(chatId, "idle");
        return marker;
      }
      const last = hist[hist.length - 1];
      if (last?.role === "assistant" && last.streaming) hist.pop();
      if (this.config.fallback) {
        try {
          const fb = this.config.fallback;
          const fbAdapter = this.providers[fb.provider];
          const fbKey = fb.keyRef ? this.vault.resolve(fb.keyRef) : null;
          const { text } = await fbAdapter.send([...hist], opts.systemPrompt ?? this.config.systemPrompt, fb.model, fbKey, [], signal);
          const reply = text || "";
          hist.push({ role: "assistant", content: reply });
          this._finish(chatId, "idle");
          return reply;
        } catch {
          this._finish(chatId, "error"); throw err;
        }
      }
      costStats.recordError(this.config.id);
      this._finish(chatId, "error"); throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      delete this._aborts[chatId];
      delete this._abortReasons[chatId];
      delete this._resetTimers[chatId];
      if (transient) this.dropChat(chatId);
    }
  }

  async _toolLoop(chatId, adapter, apiKey, tools, systemPrompt, signal, modelOverride, maxOutputTokensOverride) {
    const MAX_TURNS  = settings.get("maxTurns");
    const LOOP_LIMIT = settings.get("loopLimit");
    const hist = this.histories[chatId];
    // H4: previously this only compared sig to the IMMEDIATELY-previous
    // signature, so any 2-cycle (A→B→A→B→…) reset the counter every turn
    // and never tripped LOOP_LIMIT. We now keep a sliding-window count
    // map of the last N signatures and trip when any signature reaches
    // LOOP_LIMIT occurrences within the window.
    const sigWindow = [];              // array of recent signatures
    const sigCounts = new Map();       // sig → count within sigWindow
    const WINDOW = Math.max(LOOP_LIMIT * 2, 6);

    for (let i = 0; i < MAX_TURNS; i++) {
      this._resetTimers[chatId]?.();
      const placeholderIdx = hist.length;
      hist.push({ role: "assistant", content: "", streaming: true });
      this.notify();
      let streamed = "";
      const onDelta = (chunk) => {
        this._resetTimers[chatId]?.();
        streamed += chunk;
        hist[placeholderIdx].content = streamed;
        this.notifyStream();
      };

      const _callStart = Date.now();
      const callModel = modelOverride || this.config.model;
      const { text, toolCalls, usage } = await adapter.send(
        [...hist.slice(0, placeholderIdx)], systemPrompt, callModel, apiKey, tools, signal, onDelta, maxOutputTokensOverride
      );
      const _callLatency = Date.now() - _callStart;
      if (usage) costStats.record(this.config.id, callModel, usage.inTokens, usage.outTokens, _callLatency);
      actionLog.record("llm_call", this.config.id, callModel, {
        latencyMs: _callLatency,
        inTokens:  usage?.inTokens  || 0,
        outTokens: usage?.outTokens || 0,
      }, chatId);

      const finalText = text ?? streamed;

      if (!toolCalls?.length) {
        // Stash the real API usage on the terminal message so the chat view can
        // show a live context-window meter (inTokens here = full prompt size).
        hist[placeholderIdx] = { role: "assistant", content: finalText || "", usage: usage || null, ts: Date.now() };
        return finalText || "";
      }
      hist[placeholderIdx] = { role: "assistant", content: finalText || null, toolCalls };
      this.notify();

      const sig = toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.input || {})}`).sort().join("|");
      // Sliding-window loop detection (H4)
      sigWindow.push(sig);
      sigCounts.set(sig, (sigCounts.get(sig) || 0) + 1);
      if (sigWindow.length > WINDOW) {
        const evicted = sigWindow.shift();
        const c = (sigCounts.get(evicted) || 1) - 1;
        if (c <= 0) sigCounts.delete(evicted); else sigCounts.set(evicted, c);
      }
      const sigOccurrences = sigCounts.get(sig) || 1;
      const looping = sigOccurrences >= LOOP_LIMIT;
      this.statuses[chatId] = looping ? "busy" : `tool:${toolCalls.map(t => t.name).join(",")}`;
      this.notify();
      const toolResults = await Promise.all(toolCalls.map(async (tc) => {
        if (looping) {
          return { toolCallId: tc.id, name: tc.name,
                   result: `[LOOP DETECTED] You have called ${tc.name} with these exact arguments ${sigOccurrences} times in the last ${WINDOW} turns (including non-consecutive). Stop calling this tool with these arguments. Either: (a) call a different tool, (b) call this tool with different arguments, or (c) respond with text explaining what is blocking you. Do NOT repeat this call.` };
        }
        // M14/K1: if the adapter flagged the argument JSON as truncated /
        // malformed, short-circuit with a structured error so the LLM
        // knows why its empty-{} call would have failed.
        if (tc.argError) {
          actionLog.record("tool_arg_error", this.config.id, tc.name, { argError: tc.argError }, chatId);
          return { toolCallId: tc.id, name: tc.name, result: `[ARG PARSE ERROR] ${tc.argError}` };
        }
        this._resetTimers[chatId]?.();
        actionLog.recordToolCall(this.config.id, tc.name, tc.input, chatId);
        // Human-in-the-loop approval check
        const apprCfg = settings.get("toolApprovals") || {};
        if (apprCfg.enabled && apprCfg.rules?.[tc.name] && apprCfg.rules[tc.name] !== "auto_approve") {
          actionLog.record("approval_required", this.config.id, tc.name, { input: tc.input }, chatId);
          const decision = await approvalQueue.request({
            toolName: tc.name,
            agentId: this.config.id,
            agentName: this.config.name,
            input: tc.input,
            // M9: include chat context so the modal can disambiguate
            // parallel approvals across multiple chats with the same agent.
            chatId,
            chatTitle: this.registry?.getChat?.(chatId)?.title || null,
          });
          if (decision === "deny") {
            actionLog.record("approval_denied", this.config.id, tc.name, { input: tc.input }, chatId);
            return { toolCallId: tc.id, name: tc.name, result: `[User denied] The user denied execution of tool "${tc.name}". Do not retry this call.` };
          }
        }
        const _toolStart = Date.now();
        try {
          const result = await this.pluginHost.execute(tc.name, tc.input, {
            agentConfig:   this.config,
            runtimes:      this.pluginHost._runtimes?.current || {},
            onSpawnAgent:  this.pluginHost._onSpawnAgent,
            onRemoveAgent: this.pluginHost._onRemoveAgent,
            onUpdateAgent: this.pluginHost._onUpdateAgent,
            getAgents:     this.pluginHost._getAgents,
            pluginHost:    this.pluginHost,
            bus: this.bus, vault: this.vault,
            parentResetIdleTimer: () => this._resetTimers[chatId]?.(),
            // H1: only root agents may invoke harness-only tools
            // (spawn_agent, send_to_agent). Ephemeral children are blocked
            // by PluginHost.execute when this is false. This is the
            // structural guarantee behind "Children cannot spawn further
            // agents" and the per-parent SPAWN_CAP.
            fromHarness:   !this.config.ephemeral,
            // M2: plumb the chat's AbortSignal into the tool context so
            // long-running tools (zai_video polling, sandbox ops, web_search)
            // can stop work the instant the user hits Stop.
            signal,
          });
          actionLog.recordToolResult(this.config.id, tc.name, String(result).slice(0, 500), chatId, Date.now() - _toolStart);
          return { toolCallId: tc.id, name: tc.name, result: String(result) };
        } catch (e) {
          actionLog.recordToolResult(this.config.id, tc.name, `Error: ${e.message}`, chatId, Date.now() - _toolStart);
          return { toolCallId: tc.id, name: tc.name, result: `Error: ${e.message}` };
        }
      }));
      hist.push({ role: "tool", toolResults });
      this.statuses[chatId] = "busy"; this.notify();
    }
    const cap = "Reached maximum tool iterations.";
    hist.push({ role: "assistant", content: cap });
    return cap;
  }

  clearHistory(chatId) {
    if (!chatId) return;
    this.histories[chatId] = [];
    if (this.registry && !this._transient.has(chatId)) this.registry.clearMessages(chatId);
    this.notify();
  }
  destroy() { this.bus.unregister(this.config.id); }
}

// ─── GLOBAL SINGLETONS ───
const bus        = new MessageBus();
const vault      = new Vault();
const pluginHost = new PluginHost();
const registry   = new ChatRegistry(bus);
const actionLog = new ActionLog();
registerBuiltinTools(pluginHost);

// ─── MCP (Model Context Protocol) client ───
// Tools exposed by external MCP servers are registered into the same
// pluginHost as built-in tools, named `mcp__<serverId>__<toolName>` under
// category `mcp:<serverId>`. Because tool categories are derived dynamically,
// they appear in the Agent editor and Tools view with no extra UI wiring, and
// their JSON-Schema flows unchanged to every provider. The Rust side owns the
// stdio subprocess + JSON-RPC; here we just register + route calls.

// Live per-server status for the Settings UI: id → { running, toolCount, error, ts }.
const mcpStatus = {};

// Turn the JSON-RPC `result` string returned by the Rust `mcp_call_tool`
// command into a plain string for the LLM. Throws on `isError` so the tool
// loop surfaces it the same way built-in tool errors are surfaced.
function formatMcpResult(raw) {
  let r;
  try { r = JSON.parse(raw); } catch { return String(raw); }
  const parts = Array.isArray(r?.content) ? r.content : [];
  const text = parts.map(p => {
    if (p == null) return "";
    if (p.type === "text")     return p.text || "";
    if (p.type === "image")    return `[image${p.mimeType ? " " + p.mimeType : ""}]`;
    if (p.type === "resource") return p.resource?.text || `[resource ${p.resource?.uri || ""}]`;
    return JSON.stringify(p);
  }).filter(Boolean).join("\n");
  const body = text || JSON.stringify(r);
  if (r && r.isError) throw new Error(body || "MCP tool returned an error");
  return body;
}

// Register (or re-register) a server's discovered tools into the pluginHost.
function registerMcpTools(serverId, toolsList) {
  pluginHost.unregisterByPrefix(`mcp__${serverId}__`);
  let n = 0;
  for (const t of (toolsList || [])) {
    if (!t || !t.name) continue;
    pluginHost.register({
      name: `mcp__${serverId}__${t.name}`,
      category: `mcp:${serverId}`,
      description: t.description || `MCP tool "${t.name}" from server "${serverId}".`,
      inputSchema: t.inputSchema || { type: "object", properties: {} },
      mcp: true,
      handler: async (input) => {
        const raw = await invokeTauri("mcp_call_tool", { id: serverId, name: t.name, args: input || {} });
        return formatMcpResult(raw);
      },
    });
    n++;
  }
  return n;
}

// Spawn an MCP server (via Rust), run the handshake, register its tools.
async function startMcpServer(server) {
  if (!server || !server.id || !server.command) throw new Error("MCP server needs an id and a command");
  const raw = await invokeTauri("mcp_start", {
    id: server.id,
    command: server.command,
    args: Array.isArray(server.args) ? server.args : [],
    env: (server.env && typeof server.env === "object") ? server.env : {},
  });
  let parsed; try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  const count = registerMcpTools(server.id, parsed?.tools || []);
  mcpStatus[server.id] = { running: true, toolCount: count, error: null, ts: Date.now() };
  return { count };
}

// Stop a server and drop its tools.
async function stopMcpServer(id) {
  pluginHost.unregisterByPrefix(`mcp__${id}__`);
  try { await invokeTauri("mcp_stop", { id }); } catch {}
  mcpStatus[id] = { running: false, toolCount: 0, error: null, ts: Date.now() };
}

// Start every enabled server (called once on app launch). Per-server failures
// are recorded in mcpStatus, never thrown — one bad server can't block the rest.
async function startEnabledMcpServers() {
  const cfg = settings.get("mcpServers") || { servers: [] };
  for (const s of (cfg.servers || [])) {
    if (!s || !s.enabled) continue;
    try { await startMcpServer(s); }
    catch (e) { mcpStatus[s.id] = { running: false, toolCount: 0, error: String(e?.message || e), ts: Date.now() }; }
  }
}

const SEED_AGENTS = [
  { id: "agt_receptionist", name: "Receptionist", provider: "mock", model: "echo-v1", keyRef: null,
    systemPrompt: "You are the jack of all trades receptionist. You identify the user's intent, then either answer directly or delegate to subagents / main agents based on their profession.\n\nDelegation rules:\n- Use send_to_agent for one-shot questions to existing main agents (Research, Coder, Self-Editor, etc.)\n- Use spawn_agent for a temporary specialist when no existing agent fits.\n- Use configure_agent to adjust another agent's tools, model, or provider when the user asks you to retool one of them.\n- Use list_agents to see who is available and what tools/model each has before delegating.\n\nWhen delegating, DO NOT announce it in chat (\"let me ask the coder…\"). Just call the tool. The user sees a persistent Action Log that shows all agent actions chronologically. In your main chat reply, only give the user the final synthesized answer — quote or paraphrase the delegated agent if needed.",
    tools: ["calc", "web_search", "send_to_agent", "spawn_agent", "list_agents", "remove_agent", "list_models", "configure_agent"], params: { temperature: 0.5 } },
  { id: "agt_research",  name: "Research",  provider: "mock", model: "echo-v1", keyRef: null, systemPrompt: "You are a meticulous research assistant who finds and synthesizes information", tools: ["web_search", "file_read", "send_to_agent"], params: { temperature: 0.3 } },
  { id: "agt_coder",     name: "Coder",     provider: "mock", model: "echo-v1", keyRef: null, systemPrompt: "You are an expert programmer who writes clean, efficient code", tools: ["file_read", "calc"], params: { temperature: 0.2 } },
  {
    id: "agt_media_studio", name: "Media Studio",
    provider: "zai", model: "GLM-4.5-Air", keyRef: null,
    // Media Studio writes vivid image/video prompts and explains creative
    // choices — blunt-mode opted out to preserve descriptive phrasing.
    bluntMode: false,
    systemPrompt: "You are Media Studio. You handle audio, image, and video tasks via the z.ai media tools. Pick the right tool for the request and call it directly — don't narrate.\n\nVALID MODEL IDS (use these exact strings — casing matters):\n- Image: 'cogView-4-250304' (cheapest, default) or 'glm-image' (varied aspect ratios)\n- Audio: 'glm-asr-2512'\n- Video: 'cogvideox-3' (default), 'vidu-q1', 'vidu-2'\n\nFor transcription: if the user mentions a local file, call pick_audio_file first to obtain base64, then pass it as audio_base64 to zai_transcribe. For images, write a vivid prompt and call zai_image. For videos, call zai_video and let the polling complete (30–90s typical, can be minutes).\n\nSet the agent's keyRef to a z.ai vault key, or pass keyHandle on each tool call.\n\nBefore every tool call, output a max-6-word status (e.g. 'Picking audio file', 'Generating image', 'Polling video render'). Then call the tool.",
    tools: ["pick_audio_file", "zai_transcribe", "zai_image", "zai_video"],
    params: { temperature: 0.4 },
  },
  {
    id: "agt_self_editor",
    name: "Self-Editor",
    provider: "mock",
    model: "echo-v1",
    keyRef: null,
    systemPrompt: "You are yumuHub's self-editing agent. You modify yumuHub's own source code, but ONLY in the beta sandbox at ~/yumuhub-beta — never the live source at ~/yumuhub, and never anywhere else on the filesystem. The running yumuHub app stays untouched no matter what you do; the user rebuilds the beta separately when they want to test your changes.\n\nBefore every tool call, output a max-6-word status (prefer 3). Examples: \"Reading CODEMAP\", \"Planning edit\", \"Writing file\". Just the status, then call the tool.\n\nProcess for every edit:\n1. Call sandbox_status first to confirm ~/yumuhub-beta exists. If not, call sandbox_init to clone the live source.\n2. Call sandbox_read on CODEMAP.md to navigate to the right region. CODEMAP.md is a line-range index — use it to find the function/component/symbol you need, then sandbox_read ONLY that slice of the source (not the whole file). For a full review, read the whole file.\n3. **PLAN PHASE**: Before sandbox_write, state in one short paragraph: which file, which approximate line range, and what you'll change. Then proceed.\n4. Call sandbox_write with the FULL new file contents (not a diff). A .bak file is saved automatically.\n5. **UPDATE CODEMAP**: If your edit moved line numbers by >10, added/removed a named component/class/function, or changed where something lives, sandbox_read CODEMAP.md and sandbox_write an updated version with corrected line ranges. Skip this for trivial in-place edits.\n6. Briefly tell the user what you changed and remind them to rebuild the beta (`cd ~/yumuhub-beta && npx tauri build && ditto src-tauri/target/release/bundle/macos/yumuHub.app '/Applications/yumuHub Beta.app' && xattr -cr '/Applications/yumuHub Beta.app'`).\n\nNever guess at file contents — always read before writing. Keep edits minimal and surgical. The single source file for the React app is src/YumuHub.jsx. The Rust backend is in src-tauri/src/main.rs.",
    tools: ["sandbox_status", "sandbox_init", "sandbox_read", "sandbox_list", "sandbox_write"],
    params: { temperature: 0.2 },
  },
];
// Default responder for new chats: look up the Receptionist by id or name,
// fall back to whoever is first in the agents list.
function pickDefaultResponder(agents) {
  if (!agents?.length) return null;
  const byId   = agents.find(a => a.id === "agt_receptionist");
  if (byId) return byId.id;
  const byName = agents.find(a => /^receptionist$/i.test(a.name || ""));
  if (byName) return byName.id;
  return agents[0]?.id || null;
}

// One-shot migration: ensure any persisted agent that already has spawn_agent
// also gets list_agents + remove_agent + configure_agent (added 2026-05-24).
function migrateAgents(list) {
  let mutated = false;
  const out = list.map(a => {
    const t = a.tools || [];
    if (!t.includes("spawn_agent")) return a;
    const adds = ["list_agents", "remove_agent", "list_models", "configure_agent"].filter(x => !t.includes(x));
    if (!adds.length) return a;
    mutated = true;
    return { ...a, tools: [...t, ...adds] };
  });
  if (mutated) persist.saveAgents(out.filter(a => !a.ephemeral));
  return out;
}
const DEFAULT_AGENTS = migrateAgents(persist.loadAgents() || SEED_AGENTS).filter(a => !a.ephemeral);

// ─── STATE REDUCER ───
function appReducer(state, action) {
  switch (action.type) {
    case "SET_AGENTS":      return { ...state, agents: action.agents };
    case "SET_ACTIVE":      return { ...state, activeAgentId: action.id };
    case "SET_VIEW":        return { ...state, view: action.view };
    case "SET_RUNTIMES":    return { ...state, runtimes: action.runtimes };
    case "SET_ACTIVE_CHAT": return { ...state, activeChatId: action.id };
    case "TICK":            return { ...state, tick: state.tick + 1 };
    default:                return state;
  }
}

// ─── ICONS (inline SVG) ───
const Icon = ({ name, size = 16, color = "currentColor" }) => {
  const icons = {
    send:     <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    plus:     <><line x1="12" y1="5" x2="12" y2="19" stroke={color} strokeWidth="2" strokeLinecap="round"/><line x1="5" y1="12" x2="19" y2="12" stroke={color} strokeWidth="2" strokeLinecap="round"/></>,
    settings: <><circle cx="12" cy="12" r="3" stroke={color} strokeWidth="2" fill="none"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke={color} strokeWidth="2" strokeLinecap="round"/></>,
    chat:     <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke={color} strokeWidth="2" fill="none" strokeLinejoin="round"/>,
    bus:      <><rect x="3" y="8" width="18" height="8" rx="2" stroke={color} strokeWidth="2" fill="none"/><circle cx="8" cy="12" r="1.5" fill={color}/><circle cx="12" cy="12" r="1.5" fill={color}/><circle cx="16" cy="12" r="1.5" fill={color}/><line x1="6" y1="4" x2="6" y2="8" stroke={color} strokeWidth="2"/><line x1="12" y1="4" x2="12" y2="8" stroke={color} strokeWidth="2"/><line x1="18" y1="4" x2="18" y2="8" stroke={color} strokeWidth="2"/></>,
    key:      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    trash:    <><polyline points="3,6 5,6 21,6" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></>,
    bot:      <><rect x="3" y="8" width="18" height="12" rx="3" stroke={color} strokeWidth="2" fill="none"/><circle cx="9" cy="14" r="1.5" fill={color}/><circle cx="15" cy="14" r="1.5" fill={color}/><line x1="12" y1="3" x2="12" y2="8" stroke={color} strokeWidth="2" strokeLinecap="round"/><circle cx="12" cy="3" r="1.5" fill={color}/></>,
    inbox:    <><polyline points="22,12 16,12 14,15 10,15 8,12 2,12" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z" stroke={color} strokeWidth="2" fill="none" strokeLinejoin="round"/></>,
    wand:     <polygon points="13 2 3 14 12 14 11 22 21 10 12 10" stroke={color} strokeWidth="2" fill="none" strokeLinejoin="round"/>,
    x:        <><line x1="18" y1="6" x2="6" y2="18" stroke={color} strokeWidth="2" strokeLinecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke={color} strokeWidth="2" strokeLinecap="round"/></>,
    tool:     <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    paperclip:<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    file:     <><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke={color} strokeWidth="2" fill="none" strokeLinejoin="round"/><polyline points="14 2 14 8 20 8" stroke={color} strokeWidth="2" fill="none" strokeLinejoin="round"/></>,
    search:   <><circle cx="11" cy="11" r="7" stroke={color} strokeWidth="2" fill="none"/><line x1="16.5" y1="16.5" x2="21" y2="21" stroke={color} strokeWidth="2" strokeLinecap="round"/></>,
    refresh:  <><polyline points="21 12 21 6 15 6" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/><path d="M21 6a9 9 0 11-3 6.5" stroke={color} strokeWidth="2" fill="none" strokeLinecap="round"/></>,
    chevL:    <polyline points="15 18 9 12 15 6" stroke={color} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    chevR:    <polyline points="9 18 15 12 9 6" stroke={color} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    chevD:    <polyline points="6 9 12 15 18 9" stroke={color} strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>,
    stop:     <rect x="6" y="6" width="12" height="12" rx="1.5" fill={color}/>,
    grip:     <><circle cx="9" cy="6" r="1.4" fill={color}/><circle cx="15" cy="6" r="1.4" fill={color}/><circle cx="9" cy="12" r="1.4" fill={color}/><circle cx="15" cy="12" r="1.4" fill={color}/><circle cx="9" cy="18" r="1.4" fill={color}/><circle cx="15" cy="18" r="1.4" fill={color}/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>{icons[name]}</svg>;
};

// ─── DIFF HELPER ───
function computeDiff(a, b) {
  const m = a.length, n = b.length;
  if (m * n > 400000) return [...a.map(l => ({ t: "-", l })), ...b.map(l => ({ t: "+", l }))];
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const res = []; let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) { res.unshift({ t: "=", l: a[i-1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { res.unshift({ t: "+", l: b[j-1] }); j--; }
    else { res.unshift({ t: "-", l: a[i-1] }); i--; }
  }
  return res;
}

// ─── COMPONENTS ───

// Detect a media URL or data-URL in a tool result so we can render images and
// videos inline instead of dumping the bare URL into a <pre>. Matches typical
// extensions and data: URIs. Returns { kind, src } or null.
function detectMedia(result) {
  if (result === undefined || result === null) return null;
  const s = String(result).trim();
  // data:image/png;base64,xxx — always treat as image.
  if (s.startsWith("data:image/")) return { kind: "image", src: s };
  if (s.startsWith("data:video/")) return { kind: "video", src: s };
  // Pull the first http(s) URL out of the result and inspect its extension.
  const urlMatch = s.match(/https?:\/\/[^\s'"<>]+/);
  if (!urlMatch) return null;
  const url = urlMatch[0].replace(/[).,;]+$/, "");
  if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(url)) return { kind: "image", src: url };
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url))         return { kind: "video", src: url };
  return null;
}

// ─── Lightweight Markdown renderer (no deps) ───
// Renders assistant messages with the Markdown subset that matters in chat:
// fenced code blocks (with a copy button), inline code, **bold**, *italic*,
// [links](url), # headings, bullet/numbered lists, > blockquotes, and ---.
// Built from React elements (never dangerouslySetInnerHTML) so there's no XSS
// surface. Kept in-house on purpose — preserves the single-file / self-edit
// architecture instead of pulling in react-markdown. Intraword `_` is NOT
// treated as emphasis so snake_case tool names (send_to_agent) stay intact.
function mdInline(text, kp) {
  const out = [];
  let i = 0, last = 0, k = 0;
  const flush = (end) => { if (end > last) out.push(text.slice(last, end)); };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "[") {                                   // [text](url)
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) { flush(i); out.push(<a key={`${kp}-${k++}`} href={m[2]} target="_blank" rel="noreferrer" style={styles.mdLink}>{m[1]}</a>); i += m[0].length; last = i; continue; }
    }
    if (ch === "*" && text[i + 1] === "*") {            // **bold**
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) { flush(i); out.push(<strong key={`${kp}-${k++}`}>{text.slice(i + 2, end)}</strong>); i = end + 2; last = i; continue; }
    }
    if (ch === "*" && text[i + 1] !== " " && text[i + 1] !== "*") {  // *italic* (no leading space)
      const end = text.indexOf("*", i + 1);
      if (end > i + 1 && text[end - 1] !== " ") { flush(i); out.push(<em key={`${kp}-${k++}`}>{text.slice(i + 1, end)}</em>); i = end + 1; last = i; continue; }
    }
    if (ch === "`") {                                   // `inline code`
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) { flush(i); out.push(<code key={`${kp}-${k++}`} style={styles.mdInlineCode}>{text.slice(i + 1, end)}</code>); i = end + 1; last = i; continue; }
    }
    i++;
  }
  flush(text.length);
  return out;
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { try { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {} };
  return (
    <div style={styles.mdCodeWrap}>
      <div style={styles.mdCodeBar}>
        <span style={styles.mdCodeLang}>{lang || "code"}</span>
        <button className="mdCodeCopy" onClick={copy} style={styles.mdCodeCopy}>{copied ? "✓ Copied" : "Copy"}</button>
      </div>
      <pre style={styles.mdCodePre}><code>{code}</code></pre>
    </div>
  );
}

function MdProse({ text, kp }) {
  const lines = text.split("\n");
  const blocks = [];
  let i = 0, b = 0;
  const isSpecial = (ln) => /^\s*$/.test(ln) || /^#{1,4}\s/.test(ln) || /^\s*([-*_])\1\1+\s*$/.test(ln) || /^\s*>\s?/.test(ln) || /^\s*[-*+]\s+/.test(ln) || /^\s*\d+\.\s+/.test(ln);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { const lvl = h[1].length; const Tag = `h${Math.min(lvl + 2, 6)}`; const sz = [16.5, 15, 14, 13.5][lvl - 1] || 13.5; blocks.push(<Tag key={`${kp}-h${b++}`} style={{ ...styles.mdHeading, fontSize: sz }}>{mdInline(h[2], `${kp}h${b}`)}</Tag>); i++; continue; }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { blocks.push(<hr key={`${kp}-r${b++}`} style={styles.mdHr} />); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push(<blockquote key={`${kp}-q${b++}`} style={styles.mdQuote}>{mdInline(buf.join("\n"), `${kp}q${b}`)}</blockquote>);
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, "")); i++; }
      blocks.push(<ul key={`${kp}-u${b++}`} style={styles.mdList}>{items.map((it, j) => <li key={j} style={styles.mdLi}>{mdInline(it, `${kp}u${b}-${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      blocks.push(<ol key={`${kp}-o${b++}`} style={styles.mdList}>{items.map((it, j) => <li key={j} style={styles.mdLi}>{mdInline(it, `${kp}o${b}-${j}`)}</li>)}</ol>);
      continue;
    }
    const para = [];
    while (i < lines.length && !isSpecial(lines[i])) { para.push(lines[i]); i++; }
    const nodes = [];
    para.forEach((ln, j) => { if (j > 0) nodes.push(<br key={`br${j}`} />); nodes.push(...mdInline(ln, `${kp}p${b}-${j}`)); });
    blocks.push(<p key={`${kp}-p${b++}`} style={styles.mdPara}>{nodes}</p>);
  }
  return blocks;
}

const Markdown = memo(function Markdown({ text }) {
  if (!text) return null;
  const src = text.replace(/\r\n/g, "\n");
  const segs = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = fence.exec(src)) !== null) {
    if (m.index > last) segs.push({ t: "p", v: src.slice(last, m.index) });
    segs.push({ t: "c", lang: m[1].trim(), code: m[2].replace(/\n$/, "") });
    last = fence.lastIndex;
  }
  if (last < src.length) segs.push({ t: "p", v: src.slice(last) });
  return <div style={styles.md}>{segs.map((s, j) => s.t === "c"
    ? <CodeBlock key={j} lang={s.lang} code={s.code} />
    : <MdProse key={j} text={s.v} kp={`s${j}`} />)}</div>;
});

// Hover "Copy" button shown under assistant messages.
function CopyBtn({ text }) {
  const [done, setDone] = useState(false);
  return <button className="msgActionBtn" style={styles.msgActionBtn}
    onClick={() => { try { navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch {} }}>
    {done ? "✓ Copied" : "Copy"}</button>;
}

function ToolCallCard({ toolCall, result }) {
  const [open, setOpen] = useState(false);
  const pending = result === undefined;
  const media = !pending ? detectMedia(result) : null;
  return (
    <div style={styles.toolCard}>
      <div style={styles.toolCardTop} onClick={() => setOpen(o => !o)}>
        <Icon name="tool" size={12} color={c.rust} />
        <span style={styles.toolCardName}>{toolCall.name}</span>
        {pending
          ? <span style={styles.toolCardBadgePending}>running…</span>
          : <span style={styles.toolCardBadgeDone}>✓ done</span>}
        <span style={styles.toolCardChev}>{open ? "▾" : "▸"}</span>
      </div>
      {/* Image / video previews render OUTSIDE the collapsible section so they
          show up without an extra click — the raw URL still appears in OUTPUT. */}
      {media?.kind === "image" && (
        <a href={media.src} target="_blank" rel="noreferrer" style={{ display: "block", padding: 8 }}>
          <img src={media.src} alt={toolCall.input?.prompt || "generated image"}
            style={{ maxWidth: "100%", maxHeight: 480, borderRadius: 6, border: borderLight }} />
        </a>
      )}
      {media?.kind === "video" && (
        <div style={{ padding: 8 }}>
          <video src={media.src} controls
            style={{ maxWidth: "100%", maxHeight: 480, borderRadius: 6, border: borderLight, background: "#000" }} />
        </div>
      )}
      {open && (
        <div style={styles.toolCardBody}>
          <div style={styles.toolCardSection}>
            <div style={styles.toolCardLabel}>INPUT</div>
            <pre style={styles.toolCardCode}>{JSON.stringify(toolCall.input, null, 2)}</pre>
          </div>
          {!pending && (
            <div style={styles.toolCardSection}>
              <div style={styles.toolCardLabel}>OUTPUT</div>
              <pre style={styles.toolCardCode}>{String(result)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const NAV_ITEMS = [
  { id: "chat",     icon: "chat",     label: "Chat" },
  { id: "agents",   icon: "bot",      label: "Agents" },
  { id: "tools",    icon: "tool",     label: "Tools" },
  { id: "bus",      icon: "bus",      label: "Action Log" },
  { id: "vault",    icon: "key",      label: "Vault & Keys" },
  { id: "settings", icon: "settings", label: "Settings" },
];

function Sidebar({ agents, runtimes, view, onViewChange, onNewChatNav, onNewSidebarChat, collapsed, onToggle,
                   chats, projects, activeChatId, registry, selectChat, onOpenPalette }) {
  const navClick = (id) => (id === "chat" ? onNewChatNav() : onViewChange(id));
  if (collapsed) {
    return (
      <div style={styles.sidebarCollapsed}>
        <button onClick={onToggle} style={styles.collapseExpandBtn} title="Expand sidebar"><Icon name="chevR" size={14}/></button>
        <div data-tauri-drag-region style={{ flex: 1, padding: "8px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, overflow: "auto" }}>
          {NAV_ITEMS.map(item => (
            <button key={item.id} title={item.label}
              onClick={() => navClick(item.id)}
              style={{ ...styles.collapsedNavBtn, ...(view === item.id ? styles.collapsedNavBtnActive : {}) }}>
              <Icon name={item.icon} size={16} />
            </button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div style={styles.sidebar}>
      <div style={styles.brand} data-tauri-drag-region>
        <div style={styles.glyph}>y◆</div>
        <div data-tauri-drag-region style={{ flex: 1 }}>
          <div style={styles.brandName} data-tauri-drag-region>yumuHub</div>
          <div style={styles.brandSub} data-tauri-drag-region>MULTI-AGENT GATEWAY</div>
        </div>
        <button onClick={onToggle} style={styles.collapseBtn} title="Collapse sidebar"><Icon name="chevL" size={14} color="#8a7c63"/></button>
      </div>
      <div style={styles.navSection}>
        <div style={styles.navLabel}>WORKSPACE</div>
        {NAV_ITEMS.map(item => (
          <button key={item.id} style={{ ...styles.navItem, ...(view === item.id ? styles.navItemActive : {}) }}
            onClick={() => navClick(item.id)}>
            <Icon name={item.icon} size={15} />
            {item.label}
          </button>
        ))}
      </div>
      <SidebarChatSection
        chats={chats} projects={projects} agents={agents} runtimes={runtimes}
        activeChatId={activeChatId} registry={registry}
        onSelectChat={(id) => { selectChat(id); onViewChange("chat"); }}
        onOpenPalette={onOpenPalette}
        onNewChat={onNewSidebarChat} />
    </div>
  );
}

// Owns the SESSIONS section inside the sidebar — same content the standalone
// ChatListPanel used to render (projects + ungrouped + archived toggle + +Chat/+Project).
function SidebarChatSection({ chats, projects, agents, runtimes, activeChatId, registry, onSelectChat, onNewChat, onOpenPalette }) {
  const [showArchived, setShowArchived] = useState(false);
  const [newProjectName, setNewProjectName] = useState(null);
  const [query, setQuery] = useState("");
  // Only one row menu (⋮) can be open at a time — prevents the stacking bug
  // where each row's ⋮ stopPropagation kept the others' menus alive.
  const [openMenuKey, setOpenMenuKey] = useState(null);
  const menuFor = (key) => ({
    menuOpen: openMenuKey === key,
    onMenuToggle: () => setOpenMenuKey(k => k === key ? null : key),
    onMenuClose:  () => setOpenMenuKey(k => k === key ? null : k),
  });

  // Drag-reorder state
  const [chatOrder, setChatOrder] = useState(() => {
    try { return JSON.parse(localStorage.getItem("yumuhub:chatOrder")) || []; } catch { return []; }
  });
  const persistChatOrder = (next) => {
    setChatOrder(next);
    try { localStorage.setItem("yumuhub:chatOrder", JSON.stringify(next)); } catch {}
  };
  const [dragChat, setDragChat] = useState(null);
  const [chatDrop, setChatDrop] = useState(null);   // { id, pos: "before"|"after" }
  const [dropProject, setDropProject] = useState(null);  // projectId | "ungrouped"
  const onChatDragStart = (id) => (e) => {
    setDragChat(id); e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", id); } catch {}
  };
  const onChatDragEnd = () => { setDragChat(null); setChatDrop(null); setDropProject(null); };
  const onChatDragOver = (id) => (e) => {
    if (!dragChat || dragChat === id) return;
    e.preventDefault(); e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setChatDrop({ id, pos });
  };
  const reorderChats = (dragged, targetId, pos) => {
    const allIds = chats.map(c => c.id);
    const orderMap = new Map(chatOrder.map((id, i) => [id, i]));
    const orderedAll = [...allIds].sort((a, b) => {
      const ai = orderMap.has(a) ? orderMap.get(a) : Infinity;
      const bi = orderMap.has(b) ? orderMap.get(b) : Infinity;
      return ai !== bi ? ai - bi : allIds.indexOf(a) - allIds.indexOf(b);
    });
    const base = orderedAll.filter(id => id !== dragged);
    const tIdx = base.indexOf(targetId);
    if (tIdx < 0) return;
    base.splice(pos === "before" ? tIdx : tIdx + 1, 0, dragged);
    persistChatOrder(base);
  };
  const onChatDrop = (targetId, targetProjectId) => (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!dragChat || dragChat === targetId) { onChatDragEnd(); return; }
    const draggedChat = chats.find(c => c.id === dragChat);
    if (!draggedChat) { onChatDragEnd(); return; }
    // Cross-project drop also reassigns project.
    if ((draggedChat.projectId || null) !== (targetProjectId || null)) {
      registry.updateChat(dragChat, { projectId: targetProjectId || null });
    }
    reorderChats(dragChat, targetId, chatDrop?.pos || "after");
    onChatDragEnd();
  };
  const onProjectDrop = (projectId) => (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!dragChat) { onChatDragEnd(); return; }
    const draggedChat = chats.find(c => c.id === dragChat);
    if (draggedChat && (draggedChat.projectId || null) !== (projectId || null)) {
      registry.updateChat(dragChat, { projectId: projectId || null });
    }
    onChatDragEnd();
  };
  const dragHandlersFor = (chat) => ({
    draggable: true,
    onDragStart: onChatDragStart(chat.id),
    onDragEnd:   onChatDragEnd,
    onDragOver:  onChatDragOver(chat.id),
    onDrop:      onChatDrop(chat.id, chat.projectId),
  });
  const projectDropHandlers = (projectId) => ({
    onDragOver: (e) => { if (!dragChat) return; e.preventDefault(); setDropProject(projectId); },
    onDragLeave: () => setDropProject(p => p === projectId ? null : p),
    onDrop:      onProjectDrop(projectId),
  });

  const visibleChats    = chats.filter(c => showArchived ? true : !c.archived);
  const visibleProjects = projects.filter(p => showArchived ? true : !p.archived);
  const archivedCount   = chats.filter(c => c.archived).length + projects.filter(p => p.archived).length;
  // Pinned chats float to the top; within each tier, use manual order if present,
  // otherwise sort by lastActivity desc.
  const orderIdx = new Map(chatOrder.map((id, i) => [id, i]));
  const sortInTier = (a, b) => {
    const ai = orderIdx.has(a.id) ? orderIdx.get(a.id) : Infinity;
    const bi = orderIdx.has(b.id) ? orderIdx.get(b.id) : Infinity;
    return ai !== bi ? ai - bi : b.lastActivity - a.lastActivity;
  };
  const pinnedFirst     = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || sortInTier(a, b);
  const ungrouped       = visibleChats.filter(c => !c.projectId).sort(pinnedFirst);
  const chatsByProject  = (pid) => visibleChats.filter(c => c.projectId === pid).sort(pinnedFirst);

  const chatRowProps = (chat) => ({
    agents, runtime: runtimes[chat.responder], active: chat.id === activeChatId,
    onSelect:        () => onSelectChat(chat.id),
    onRename:        (title) => registry.updateChat(chat.id, { title }),
    onArchive:       (archived) => registry.archiveChat(chat.id, archived),
    onPin:           (pinned) => registry.updateChat(chat.id, { pinned }),
    onDelete:        () => {
      for (const rt of Object.values(runtimes)) rt?.dropChat?.(chat.id);
      registry.deleteChat(chat.id);
      if (chat.id === activeChatId) onSelectChat(null);
    },
    onMoveToProject: (projectId) => registry.updateChat(chat.id, { projectId }),
    onExport:        (fmt) => exportChat(chat, registry, agents, fmt),
    projects: visibleProjects,
    dragHandlers: dragHandlersFor(chat),
    dropHint:     chatDrop?.id === chat.id ? chatDrop.pos : null,
    ...menuFor(`chat:${chat.id}`),
  });

  const newChat = () => onNewChat?.();
  const newProject = () => setNewProjectName("New project");
  const commitNewProject = () => {
    if (newProjectName?.trim()) registry.createProject(newProjectName.trim());
    setNewProjectName(null);
  };

  // ─── Conversation search ───
  // Active once 2+ chars are typed. Searches titles + every message body
  // across ALL chats (archived included — "nothing is ever lost"), returning
  // a flat, recency-sorted result list with a highlighted snippet.
  const q = query.trim();
  const searching = q.length >= 2;
  let searchResults = null;
  if (searching) {
    const ql = q.toLowerCase();
    searchResults = [];
    for (const chat of chats) {
      const titleHit = (chat.title || "").toLowerCase().includes(ql);
      let snippet = null, count = 0;
      const msgs = registry.getMessages(chat.id) || [];
      for (const m of msgs) {
        const t = msgToText(m);
        if (t && t.toLowerCase().includes(ql)) { count++; if (!snippet) snippet = searchSnippet(t, q); }
      }
      if (titleHit || count > 0) searchResults.push({ chat, snippet, count, titleHit });
    }
    searchResults.sort((a, b) => b.chat.lastActivity - a.chat.lastActivity);
  }

  return (
    <div style={styles.sidebarChatSection}>
      <div style={styles.sidebarChatHeader}>
        <div style={styles.navLabel}>SESSIONS</div>
        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={newProject} style={styles.sidebarMiniBtn} title="New project">+📁</button>
          <button onClick={newChat}    style={styles.sidebarMiniBtnPrimary} title="New chat  (⌘N)">+ Chat</button>
        </div>
      </div>
      <div style={styles.sidebarSearchWrap}>
        <Icon name="search" size={12} color="#8a7c63" />
        <input value={query} onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Escape") setQuery(""); }}
          placeholder="Search chats…" style={styles.sidebarSearchInput} />
        {query
          ? <button onClick={() => setQuery("")} style={styles.sidebarSearchClear} title="Clear search"><Icon name="x" size={11} color="#8a7c63" /></button>
          : onOpenPalette && <button onMouseDown={e => { e.preventDefault(); onOpenPalette(); }} style={styles.sidebarKbdHint} title="Open command palette — search chats, agents & actions">⌘K</button>}
      </div>
      <div style={styles.sidebarChatBody}>
        {searching ? (
          searchResults.length === 0 ? (
            <div style={styles.chatListEmpty}>No matches for “{q}”.</div>
          ) : (
            <>
              <div style={styles.searchCount}>{searchResults.length} result{searchResults.length !== 1 ? "s" : ""}</div>
              {searchResults.map(r => (
                <button key={r.chat.id} className="searchResultBtn"
                  style={{ ...styles.searchResult, ...(r.chat.id === activeChatId ? styles.searchResultActive : {}) }}
                  onClick={() => onSelectChat(r.chat.id)}>
                  <div style={styles.searchResultTop}>
                    <span style={styles.searchResultTitle}>{r.chat.pinned ? "📌 " : ""}{highlightMatch(r.chat.title || "Untitled", q)}</span>
                    <span style={styles.searchResultTime}>{r.chat.archived ? "▪ " : ""}{relTime(r.chat.lastActivity)}</span>
                  </div>
                  {r.snippet
                    ? <div style={styles.searchResultSnippet}>{highlightMatch(r.snippet, q)}{r.count > 1 ? ` · ${r.count} hits` : ""}</div>
                    : <div style={styles.searchResultSnippet}><em>title match</em></div>}
                </button>
              ))}
            </>
          )
        ) : (<>
        {newProjectName !== null && (
          <div style={styles.projectHeader}>
            <span style={{ fontSize: 10, color: "#8a7c63", width: 12 }}>▾</span>
            <input value={newProjectName} autoFocus
              onChange={e => setNewProjectName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") commitNewProject(); if (e.key === "Escape") setNewProjectName(null); }}
              onBlur={commitNewProject}
              style={styles.projectNameInput} />
          </div>
        )}
        {visibleProjects.map(p => (
          <ProjectFolder key={p.id} project={p} chats={chatsByProject(p.id)} chatRowProps={chatRowProps}
            onRename={(name) => registry.updateProject(p.id, { name })}
            onArchiveProject={(archived) => registry.archiveProject(p.id, archived)}
            onDeleteProject={() => registry.deleteProject(p.id)}
            dropActive={dropProject === p.id}
            dropHandlers={projectDropHandlers(p.id)}
            {...menuFor(`proj:${p.id}`)} />
        ))}
        {ungrouped.length > 0 && (
          <div style={{ marginTop: visibleProjects.length ? 10 : 0 }}
               onDragOver={(e) => { if (!dragChat) return; e.preventDefault(); setDropProject("ungrouped"); }}
               onDragLeave={() => setDropProject(p => p === "ungrouped" ? null : p)}
               onDrop={onProjectDrop(null)}>
            {visibleProjects.length > 0 && <div style={{ ...styles.ungroupedLabel, background: dropProject === "ungrouped" ? "rgba(192,70,31,0.08)" : "transparent", transition: "background 0.15s", borderRadius: 4 }}>UNGROUPED</div>}
            {ungrouped.map(chat => <ChatRow key={chat.id} chat={chat} {...chatRowProps(chat)} />)}
          </div>
        )}
        {visibleProjects.length === 0 && ungrouped.length === 0 && (
          <div style={styles.chatListEmpty}>No sessions yet. Click <strong>+ Chat</strong>.</div>
        )}
        </>)}
      </div>
      {searching ? null : archivedCount > 0 && (
        <button onClick={() => setShowArchived(s => !s)} style={styles.archivedToggle}>
          {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
        </button>
      )}
    </div>
  );
}

// Lightweight relative-time helper for the chat list ("5m", "2h", "3d", "now").
function relTime(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 30) return "now";
  if (s < 3600) return `${Math.round(s/60)}m`;
  if (s < 86400) return `${Math.round(s/3600)}h`;
  return `${Math.round(s/86400)}d`;
}

// Flatten a chat message's content to plain text (handles multimodal arrays).
// Shared by conversation search and chat export.
function msgToText(msg) {
  const cnt = msg?.content;
  if (typeof cnt === "string") return cnt;
  if (Array.isArray(cnt)) return cnt.filter(p => p?.type === "text" && p.text).map(p => p.text).join("\n");
  return "";
}

// Extract a short snippet around the first case-insensitive match of `q`.
function searchSnippet(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - 32);
  const end = Math.min(text.length, i + q.length + 56);
  const core = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + core + (end < text.length ? "…" : "");
}

// Split text into nodes with case-insensitive matches of `q` wrapped in <mark>.
function highlightMatch(text, q) {
  if (!q) return text;
  const out = [];
  const lc = text.toLowerCase(), ql = q.toLowerCase();
  let i = 0, idx, k = 0;
  while ((idx = lc.indexOf(ql, i)) >= 0) {
    if (idx > i) out.push(text.slice(i, idx));
    out.push(<mark key={k++} style={styles.searchMark}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

// ─── Chat export ───
function safeFilename(s) {
  return (s || "chat").replace(/[^\w\s-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "chat";
}

function chatToMarkdown(chat, msgs, agents) {
  const responder = agents.find(a => a.id === chat.responder);
  const out = [`# ${chat.title || "Untitled chat"}`, ""];
  out.push(`> Exported ${new Date().toLocaleString()}${responder ? ` · ${responder.name} (${responder.provider}/${responder.model})` : ""}`, "");
  for (const m of msgs) {
    if (m.role === "user") {
      out.push("### 🧑 You", "", msgToText(m) || "_(no text content)_", "");
    } else if (m.role === "assistant") {
      const text = msgToText(m);
      const calls = m.toolCalls || [];
      if (!text && calls.length === 0) continue;
      out.push(`### 🤖 ${responder?.name || "Agent"}`, "");
      if (text) out.push(text, "");
      for (const tc of calls) out.push(`- 🛠️ \`${tc.name}(${JSON.stringify(tc.input ?? tc.args ?? {})})\``);
      if (calls.length) out.push("");
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function chatToJSON(chat, msgs, agents) {
  const responder = agents.find(a => a.id === chat.responder);
  return JSON.stringify({
    title: chat.title || null,
    id: chat.id,
    exportedAt: new Date().toISOString(),
    agent: responder ? { id: responder.id, name: responder.name, provider: responder.provider, model: responder.model } : null,
    messageCount: msgs.length,
    messages: msgs,
  }, null, 2);
}

// Serialize a chat and hand it to Rust, which writes it under
// ~/yumuhub-workspace/exports/ and reveals it in Finder.
async function exportChat(chat, registry, agents, fmt) {
  const msgs = registry.getMessages(chat.id) || [];
  const isJson = fmt === "json";
  const filename = `${safeFilename(chat.title)}-${new Date().toISOString().slice(0, 10)}.${isJson ? "json" : "md"}`;
  const contents = isJson ? chatToJSON(chat, msgs, agents) : chatToMarkdown(chat, msgs, agents);
  try {
    await invokeTauri("export_chat_file", { filename, contents });
  } catch (e) {
    console.error("Export failed:", e);
    try { window.alert(`Export failed: ${e?.message || e}`); } catch {}
  }
}

// ─── Context-window meter ───
// Compact token formatting: 950 → "950", 12300 → "12.3k", 200000 → "200k".
function fmtTok(n) {
  if (n == null) return "?";
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
}

// Approximate context-window sizes (tokens) by provider/model. Returns null
// when unknown (e.g. mock) so the meter falls back to a bare token count.
function contextWindowFor(provider, model) {
  const m = (model || "").toLowerCase();
  if (provider === "anthropic") return 200000;
  if (provider === "openai")    return m.includes("gpt-3.5") ? 16000 : 128000;
  if (provider === "zai")       return 128000;
  if (provider === "ccr")       return 200000;
  return null;
}

// Compact message timestamp: "2:34 PM" for today, "May 28, 2:34 PM" otherwise.
function fmtMsgTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

// Hover-row menu used by both chats and projects. Click outside to dismiss.
// Each item may set `keepOpen: true` to stay open after firing (for two-step confirmations).
function RowMenu({ onClose, items }) {
  useEffect(() => {
    const close = () => onClose();
    // Defer one tick so the click that opened us doesn't immediately close us
    setTimeout(() => window.addEventListener("click", close, { once: true }), 0);
    return () => window.removeEventListener("click", close);
  }, [onClose]);
  return (
    <div style={styles.rowMenu} onClick={e => e.stopPropagation()}>
      {items.map((it, i) => (
        <button key={i} onClick={() => { it.onClick(); if (!it.keepOpen) onClose(); }}
          style={{ ...styles.rowMenuItem, ...(it.danger ? styles.rowMenuItemDanger : {}) }}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function ChatRow({ chat, agents, runtime, active, onSelect, onRename, onDelete, onArchive, onPin, onMoveToProject, onExport, projects, menuOpen, onMenuToggle, onMenuClose, dragHandlers, dropHint }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [confirmingDel, setConfirmingDel] = useState(false);
  useEffect(() => { setTitle(chat.title); }, [chat.title]);
  useEffect(() => { if (!menuOpen) setConfirmingDel(false); }, [menuOpen]);
  const responder = agents.find(a => a.id === chat.responder);
  const status = runtime?.statusOf?.(chat.id) || "idle";
  const busy   = status === "busy" || status.startsWith?.("tool:");
  // Missing lastSeen (legacy chats) → treat as seen, not unread.
  const unread = (chat.lastActivity || 0) > (chat.lastSeen ?? chat.lastActivity ?? 0);
  // Unread color (from settings) takes precedence over status colors so the user
  // notices the new reply even if the agent has gone idle since.
  const dotColor = unread ? (settings.get("colors")?.unread || "#7c3aed")
                          : busy ? (settings.get("colors")?.agentBusy || c.gold)
                          : status === "error" ? c.rust
                          : (settings.get("colors")?.agentIdle || c.moss);

  const commit = () => { setEditing(false); if (title.trim() && title.trim() !== chat.title) onRename(title.trim()); else setTitle(chat.title); };

  return (
    <div style={{ ...styles.chatRow, ...(active ? styles.chatRowActive : {}),
                  boxShadow: dropHint === "before" ? `inset 0 3px 0 ${c.rust}` : dropHint === "after" ? `inset 0 -3px 0 ${c.rust}` : "none" }}
         onClick={() => !editing && onSelect()}
         {...(dragHandlers || {})}>
      <span style={{ ...styles.statusDot, background: dotColor, marginTop: 4 }} />
      <div style={styles.chatRowMain}>
        {editing ? (
          <input value={title} autoFocus
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setTitle(chat.title); setEditing(false); } }}
            onBlur={commit} onClick={e => e.stopPropagation()}
            style={styles.chatRowTitleInput} />
        ) : (
          <div style={styles.chatRowTitle} title={chat.title}>{chat.pinned ? "📌 " : ""}{chat.title}</div>
        )}
        <div style={styles.chatRowMeta}>
          {responder ? <span style={styles.chatRowAgent}>{responder.name}</span> : <span style={styles.chatRowAgentNone}>no agent</span>}
          <span style={styles.chatRowTime}>{relTime(chat.lastActivity)}</span>
        </div>
      </div>
      <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
        <button onClick={onMenuToggle} style={styles.chatRowMenuBtn} title="More">⋮</button>
        {menuOpen && (
          <RowMenu onClose={onMenuClose} items={[
            { label: "Rename",              onClick: () => setEditing(true) },
            { label: chat.pinned ? "Unpin from top" : "Pin to top", onClick: () => onPin?.(!chat.pinned) },
            { label: chat.archived ? "Unarchive" : "Archive", onClick: () => onArchive(!chat.archived) },
            ...projects.filter(p => !p.archived).map(p => ({
              label: chat.projectId === p.id ? `✓ In: ${p.name}` : `→ Move to: ${p.name}`,
              onClick: () => onMoveToProject(chat.projectId === p.id ? null : p.id),
            })),
            ...(chat.projectId ? [{ label: "Remove from project", onClick: () => onMoveToProject(null) }] : []),
            { label: "⤓ Export as Markdown", onClick: () => onExport?.("md") },
            { label: "⤓ Export as JSON",     onClick: () => onExport?.("json") },
            confirmingDel
              ? { label: "⚠ Click again to confirm delete", danger: true, onClick: () => { onDelete(); setConfirmingDel(false); } }
              : { label: "Delete chat", danger: true, keepOpen: true, onClick: () => setConfirmingDel(true) },
          ]} />
        )}
      </div>
    </div>
  );
}

function ProjectFolder({ project, chats, menuOpen, onMenuToggle, onMenuClose, dropActive, dropHandlers, ...rowProps }) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [confirmingDel, setConfirmingDel] = useState(false);
  useEffect(() => { setName(project.name); }, [project.name]);
  useEffect(() => { if (!menuOpen) setConfirmingDel(false); }, [menuOpen]);
  const visible = chats.filter(c => !c.archived);

  const commit = () => { setEditing(false); if (name.trim() && name.trim() !== project.name) rowProps.onRename(name.trim()); else setName(project.name); };

  return (
    <div {...(dropHandlers || {})}
         style={dropActive ? { background: "rgba(192,70,31,0.06)", borderRadius: 8, transition: "background 0.15s" } : undefined}>
      <div style={styles.projectHeader} onClick={() => setOpen(o => !o)}>
        <span style={{ fontSize: 10, color: "#8a7c63", width: 12 }}>{open ? "▾" : "▸"}</span>
        {editing ? (
          <input value={name} autoFocus
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setName(project.name); setEditing(false); } }}
            onBlur={commit} onClick={e => e.stopPropagation()}
            style={styles.projectNameInput} />
        ) : (
          <span style={styles.projectName}>{project.name}</span>
        )}
        <span style={styles.projectCount}>{visible.length}</span>
        <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
          <button onClick={onMenuToggle} style={styles.projectMenuBtn} title="More">⋮</button>
          {menuOpen && (
            <RowMenu onClose={onMenuClose} items={[
              { label: "Rename", onClick: () => setEditing(true) },
              { label: project.archived ? "Unarchive" : "Archive", onClick: () => rowProps.onArchiveProject(!project.archived) },
              confirmingDel
                ? { label: "⚠ Click again to confirm delete", danger: true, onClick: () => { rowProps.onDeleteProject(); setConfirmingDel(false); } }
                : { label: "Delete project (keep chats)", danger: true, keepOpen: true, onClick: () => setConfirmingDel(true) },
            ]} />
          )}
        </div>
      </div>
      {open && (
        <div style={styles.projectChats}>
          {visible.length === 0 && <div style={styles.projectEmpty}>No chats in this project yet.</div>}
          {visible.map(chat => <ChatRow key={chat.id} chat={chat} {...rowProps.chatRowProps(chat)} />)}
        </div>
      )}
    </div>
  );
}

function HandoffBubble({ msg }) {
  // Collapsed by default for auto-archived handoffs; legacy in-place ones expand by default.
  const [collapsed, setCollapsed] = useState(!!msg.collapsed);
  return (
    <div style={styles.handoffBubble}>
      <div style={{ ...styles.handoffLabel, cursor: "pointer", userSelect: "none" }} onClick={() => setCollapsed(c => !c)}>
        📋 Handoff from previous session {collapsed ? "▸ click to expand" : "▾"}
      </div>
      {!collapsed && <div style={styles.msgText}>{msg.content}</div>}
    </div>
  );
}

function ChatView({ chat, runtime, allAgents, registry, draftResponder, onPromoteDraft, onDraftResponderChange, sidebarCollapsed, onSelectChat }) {
  const [input, setInput] = useState("");
  const [error, setError] = useState(null);
  const [attachments, setAttachments] = useState([]); // [{ name, size, content }]
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(chat?.title || "");
  const fileInputRef = useRef(null);
  const endRef   = useRef(null);

  const messagesRef = useRef(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [showJump, setShowJump] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [editingIdx, setEditingIdx] = useState(null);   // history index of the user message being edited
  const [editDraft, setEditDraft] = useState("");

  // Draft mode = no chat yet, but a responder is pre-selected. Sidebar entry
  // is created lazily on first send (so empty Chat clicks don't pollute it).
  const isDraft = !chat && !!draftResponder;

  useEffect(() => { setTitleDraft(chat?.title || ""); setEditingTitle(false); setStickToBottom(true); setCustomizeOpen(false); setEditingIdx(null); setEditDraft(""); }, [chat?.id]);
  // Auto-scroll to bottom only if the user is already there (or just opened the chat).
  // If they scrolled up to read older messages, leave them alone and show a "Jump to latest" pill.
  const slotHistory = chat ? runtime?.getHistory?.(chat.id) : null;
  const slotStatus  = chat ? runtime?.statusOf?.(chat.id) : "idle";
  useEffect(() => {
    if (stickToBottom) endRef.current?.scrollIntoView({ behavior: "smooth" });
    else if (slotHistory?.length) setShowJump(true);
  }, [slotHistory?.length, slotStatus, chat?.id, stickToBottom]);
  const onMessagesScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setStickToBottom(atBottom);
    if (atBottom) setShowJump(false);
  };
  const jumpToLatest = () => { setStickToBottom(true); setShowJump(false); endRef.current?.scrollIntoView({ behavior: "smooth" }); };

  if (!chat && !isDraft) return <div style={styles.emptyState}><Icon name="bot" size={40} color="#bfb49a" /><p style={styles.muted}>Select a session to start chatting.</p></div>;

  const responderId = chat?.responder || draftResponder;
  const agent = responderId ? allAgents.find(a => a.id === responderId) : null;
  const commitTitle = () => {
    setEditingTitle(false);
    const t = titleDraft.trim();
    if (t && chat && t !== chat.title) registry.updateChat(chat.id, { title: t });
    else setTitleDraft(chat?.title || "");
  };

  const isImageFile = (file) => file.type?.startsWith("image/");
  const BINARY_EXTS = new Set(["docx","xlsx","pptx","pdf","zip","gz","tar","rar","7z","exe","dmg","iso","bin","dll","so","dylib","wasm","sqlite","db","odt","ods","odp","epub","mobi"]);
  const isBinaryFile = (file) => {
    const ext = (file.name || "").split(".").pop()?.toLowerCase() || "";
    return BINARY_EXTS.has(ext);
  };
  const readFileAsAttachment = (file) => new Promise(resolve => {
    if (isImageFile(file)) {
      const reader = new FileReader();
      reader.onload = ev => {
        const dataUrl = String(ev.target.result || "");
        const base64 = dataUrl.split(",")[1] || "";
        resolve({ type: "image", name: file.name, size: file.size, mime: file.type, base64, dataUrl });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    } else if (isBinaryFile(file)) {
      const reader = new FileReader();
      reader.onload = ev => {
        const dataUrl = String(ev.target.result || "");
        const base64 = dataUrl.split(",")[1] || "";
        resolve({ type: "document", name: file.name, size: file.size, mime: file.type || "application/octet-stream", base64 });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    } else {
      const reader = new FileReader();
      reader.onload = ev => resolve({ type: "file", name: file.name, size: file.size, content: String(ev.target.result || "") });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    }
  });

  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []);
    Promise.all(files.map(readFileAsAttachment)).then(results => {
      setAttachments(prev => [...prev, ...results.filter(Boolean)]);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onPaste = (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(it => it.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    Promise.all(imageItems.map(it => {
      const file = it.getAsFile();
      return file ? readFileAsAttachment(file) : Promise.resolve(null);
    })).then(results => {
      setAttachments(prev => [...prev, ...results.filter(Boolean)]);
    });
  };

  const removeAttachment = (idx) => setAttachments(prev => prev.filter((_, i) => i !== idx));

  // M8: gate drag-overlay + drop on the dataTransfer types having "Files".
  // Without this guard, dragging a tool row / vault key / chat row /
  // highlighted text over the ChatView triggered the "Drop files to
  // attach" overlay and ran the drop handler on a list with zero files —
  // making internal drag-and-drop sources visually fight with the
  // attachment UI for no benefit.
  const isFileDrag = (e) => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    // DOMStringList doesn't have .includes in all envs; iterate.
    for (let i = 0; i < types.length; i++) if (types[i] === "Files") return true;
    return false;
  };
  const onFileDrop = (e) => {
    if (!isFileDrag(e)) return;                  // let internal drags bubble
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    Promise.all(files.map(readFileAsAttachment)).then(results => {
      setAttachments(prev => [...prev, ...results.filter(Boolean)]);
    });
  };

  const send = async () => {
    const hasContent = input.trim() || attachments.length > 0;
    if (!hasContent || slotStatus === "busy" || slotStatus?.startsWith?.("tool:")) return;
    if (!agent || !runtime) { setError("This chat has no agent yet — pick one in the dropdown above."); return; }
    setError(null);
    const hasMultipart = attachments.some(a => a.type === "image" || a.type === "document");
    const formatAttachment = (a) => {
      if (a.type === "image") return { type: "image", base64: a.base64, mime: a.mime, name: a.name };
      if (a.type === "document") return { type: "text", text: `[Attached document: ${a.name} — ${a.size} bytes, ${a.mime}]\n(Base64-encoded binary file — decode to access contents.)\n\`\`\`\n${a.base64}\n\`\`\`` };
      return { type: "text", text: `[Attached file: ${a.name} — ${a.size} bytes]\n\`\`\`\n${a.content}\n\`\`\`` };
    };
    let msg;
    if (hasMultipart) {
      const parts = attachments.map(formatAttachment);
      if (input.trim()) parts.push({ type: "text", text: input.trim() });
      msg = parts;
    } else {
      const fileBlocks = attachments.map(a =>
        `[Attached file: ${a.name} — ${a.size} bytes]\n\`\`\`\n${a.content}\n\`\`\``
      ).join("\n\n");
      msg = [fileBlocks, input.trim()].filter(Boolean).join("\n\n");
    }
    setInput(""); setAttachments([]);
    // Draft → real chat promotion on first send. Creates the registry chat
    // (showing up in the sidebar) before chatting; the per-chat slot inside
    // the runtime is created lazily on the first runtime.chat(..., chatId).
    let activeChat = chat;
    if (!activeChat && isDraft) {
      activeChat = onPromoteDraft(responderId);
      if (!activeChat) { setError("Failed to create chat."); return; }
    }
    const looksUntitled = activeChat && /^(new chat|chat with )/i.test(activeChat.title);
    if (looksUntitled) {
      const titleSource = typeof msg === "string" ? msg.trim() : (msg.find(p => p.type === "text")?.text || "Image").trim();
      const auto = titleSource.split("\n")[0].slice(0, 48);
      if (auto) registry.updateChat(activeChat.id, { title: auto });
    }
    actionLog.startHarness(agent.id);
    try { await runtime.chat(msg, { chatId: activeChat.id }); } catch (e) { setError(e.message); }
  };

  // Shared wrapper for one-shot agent calls bypassing tools (handoff, diagnose).
  // Returns the reply text, or null if the call was aborted or this chat's slot was busy.
  const runAuxChat = async (userPrompt, opts = {}) => {
    if (slotStatus === "busy" || slotStatus?.startsWith?.("tool:")) return null;
    setError(null);
    try { return await runtime.chat(userPrompt, { noTools: true, chatId: chat?.id, ...opts }); }
    catch (e) { setError(e.message); return null; }
  };

  const handoff = async () => {
    if (!slotHistory?.length) { setError("Nothing to summarize yet."); return; }
    const summary = await runAuxChat(`Write a HANDOFF SUMMARY for a fresh chat session to pick up where this one left off. Use this exact structure:

## What we were doing
1-3 lines on the current task and why.

## Key decisions / facts established
Bullet list. Only things a continuing agent must know — no fluff.

## Where we are right now
Last concrete state: the last thing completed, the next thing pending.

## Open questions / blockers
What still needs the user, or what's unresolved.

Be concrete. Use short bullets. No preamble. No "Here is the summary".`);
    if (!summary || /\[(Stopped by user|No activity)/.test(summary)) return; // user aborted, leave history as-is
    if (chat) persist.saveHandoff(chat.id, { ts: Date.now(), summary });

    const mode = settings.get("handoffMode") || "archive";
    if (!chat || mode === "keep") {
      // Legacy behavior: rewrite history in place.
      if (chat) runtime.setHistory(chat.id, [{ role: "assistant", content: summary, handoff: true }]);
      return;
    }

    // archive | delete: create a new chat seeded with the summary (collapsed) and switch to it.
    const oldTitle = chat.title;
    if (mode === "archive") {
      registry.archiveChat(chat.id, true);
    } else /* delete */ {
      runtime.dropChat?.(chat.id);
      registry.deleteChat(chat.id);
    }
    const newChat = registry.createChat({
      title: `Continuation of: ${oldTitle}`,
      members: chat.members,
      responder: chat.responder,
    });
    runtime.setHistory(newChat.id, [{ role: "assistant", content: summary, handoff: true, collapsed: true }]);
    onSelectChat?.(newChat.id);
  };

  const diagnose = async () => {
    const systemPrompt = `You are a code-reviewer reading the source of yumuHub, a personal single-file React + Tauri desktop app. yumuHub is unpublished and local-only — there is nothing to look up about it externally. The source below is the only source of truth. You have no tools available; respond with analysis only. Do not ask for screenshots, descriptions, links, or app categories. Do not give generic UI/UX advice. Cite specific functions, line ranges, or variable names from the source.

=== START OF SOURCE: YumuHub.jsx (${DIAGNOSE_SOURCE.length} chars) ===

${DIAGNOSE_SOURCE}

=== END OF SOURCE ===`;
    await runAuxChat(`Self-diagnose. Using the source in the system prompt, respond with EXACTLY this structure and nothing else:

## What this app does (3 lines)
A literal description based only on what the code does — components, providers, persistence, tool system.

## Single biggest issue you see
One concrete problem in the actual code: a bug, dead code path, missing piece the architecture clearly expects, or a UX friction visible in the JSX. Cite the function name or approximate line. One issue only.

## Minimal fix
The smallest change that fixes it. Name the function and what to change. No multi-phase roadmaps.`, { systemPrompt });
  };

  const isBusy   = slotStatus === "busy";
  const toolName = slotStatus?.startsWith?.("tool:") ? slotStatus.slice(5) : null;
  const busy     = isBusy || !!toolName;

  const history = (slotHistory || []).filter(Boolean);

  // Live context meter: the most recent real API usage reflects the current
  // window load (inTokens = full prompt, + the reply we appended after).
  const effModel  = chat?.overrides?.model || agent?.model;
  const lastUsage = (() => { for (let k = history.length - 1; k >= 0; k--) if (history[k]?.usage) return history[k].usage; return null; })();
  const ctxTokens = lastUsage ? (lastUsage.inTokens || 0) + (lastUsage.outTokens || 0) : null;
  const ctxWindow = agent ? contextWindowFor(agent.provider, effModel) : null;
  const ctxPct    = (ctxTokens != null && ctxWindow) ? Math.min(100, Math.round(ctxTokens / ctxWindow * 100)) : null;

  // Regenerate: rewind to the user turn that produced the assistant message at
  // `idx` and replay it — runtime.chat() re-pushes the user message and streams
  // a fresh reply. Truncating the slot first drops the old reply (and any tool
  // turns after the user message) so history stays consistent.
  const regenerate = async (idx) => {
    if (!chat || !runtime || busy) return;
    let u = idx;
    while (u >= 0 && history[u]?.role !== "user") u--;
    if (u < 0) return;                          // no preceding user turn to replay
    const userContent = history[u].content;
    setError(null);
    runtime.setHistory(chat.id, history.slice(0, u));
    setStickToBottom(true);
    if (agent) actionLog.startHarness(agent.id);
    try { await runtime.chat(userContent, { chatId: chat.id }); } catch (e) { setError(e.message); }
  };

  // Edit & resend: replace a user message's text and replay from there, dropping
  // everything that followed (matches ChatGPT/Claude rewind semantics).
  const startEdit = (idx, text) => { setEditingIdx(idx); setEditDraft(text); };
  const cancelEdit = () => { setEditingIdx(null); setEditDraft(""); };
  const submitEdit = async (idx) => {
    const text = editDraft.trim();
    if (!chat || !runtime || busy || !text) return;
    setEditingIdx(null); setEditDraft("");
    setError(null);
    runtime.setHistory(chat.id, history.slice(0, idx));
    setStickToBottom(true);
    if (agent) actionLog.startHarness(agent.id);
    try { await runtime.chat(text, { chatId: chat.id }); } catch (e) { setError(e.message); }
  };

  // Fork: branch a new chat from message `idx`, copying history up to and
  // including it. The original chat is left untouched — explore an alternate
  // path without losing the current one (ChatGPT/Claude branch semantics).
  const fork = (idx) => {
    if (!chat || !runtime) return;
    let end = idx + 1;
    // Never cut between an assistant's tool-call and its tool result, or the
    // forked history would carry a dangling tool_use the provider rejects.
    if (history[idx]?.role === "assistant" && history[idx]?.toolCalls?.length && history[end]?.role === "tool") end++;
    const slice = history.slice(0, end).map(m => ({ ...m, streaming: false }));
    const base  = (chat.title || "Chat").replace(/ \(fork(?: \d+)?\)$/i, "");
    const newChat = registry.createChat({ title: `${base} (fork)`, members: chat.members, responder: chat.responder });
    if (chat.overrides) registry.updateChat(newChat.id, { overrides: { ...chat.overrides } });
    runtime.setHistory(newChat.id, slice);
    setError(null);
    onSelectChat?.(newChat.id);
  };

  // Retry: after a failed send the last user message is left at the tail (the
  // empty assistant placeholder was dropped), so replay it — same rewind path
  // as Regenerate. Gives a one-click recovery instead of re-typing.
  const retry = () => {
    if (busy) return;
    for (let k = history.length - 1; k >= 0; k--) {
      if (history[k]?.role === "user") { regenerate(k); return; }
    }
  };

  return (
    <div style={styles.chatContainer}
      onDrop={onFileDrop}
      onDragOver={(e) => { if (!isFileDrag(e)) return; e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
      // M10: paste handler lives on the container, not the textarea —
      // because the textarea is `disabled={busy}` during streaming, paste
      // events on a disabled element don't fire consistently. Container
      // paste captures image clipboard while busy, so a screenshot pasted
      // mid-stream still lands in the attachment bar and can be sent the
      // moment the agent finishes.
      onPaste={onPaste}>
      {dragOver && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(192,70,31,0.07)", border: `2px dashed ${c.rust}`, zIndex: 20, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{ fontFamily: fonts.mono, fontSize: 13, color: c.rust, fontWeight: 700, letterSpacing: "0.08em" }}>Drop files to attach</div>
        </div>
      )}
      <div style={styles.chatHeader} data-tauri-drag-region>
        <div style={{ ...styles.chatHeaderLeft, flex: 1, minWidth: 0 }} data-tauri-drag-region>
          <span style={{ ...styles.statusDot, width: 10, height: 10, background: busy ? (settings.get("colors")?.agentBusy || c.gold) : (agent ? (settings.get("colors")?.agentIdle || c.moss) : "#bfb49a") }} />
          {isDraft ? (
            <span style={{ ...styles.chatTitleBtn, opacity: 0.6, cursor: "default" }} title="Saved to sidebar on first send">New chat (draft)</span>
          ) : editingTitle ? (
            <input value={titleDraft} autoFocus
              onChange={e => setTitleDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") commitTitle(); if (e.key === "Escape") { setTitleDraft(chat.title); setEditingTitle(false); } }}
              onBlur={commitTitle}
              style={styles.chatTitleInput} />
          ) : (
            // Native <button> here so Tauri's data-tauri-drag-region parent doesn't swallow the click
            <button onClick={() => { setTitleDraft(chat.title); setEditingTitle(true); }}
              style={styles.chatTitleBtn} title="Click to rename">
              {chat.title}
            </button>
          )}
          <select value={responderId || ""}
            onChange={e => {
              const id = e.target.value || null;
              if (isDraft) onDraftResponderChange?.(id);
              else if (chat) registry.setResponder(chat.id, id);
            }}
            style={styles.responderPicker} title="Which agent replies in this chat">
            <option value="">— pick agent —</option>
            {allAgents.map(a => <option key={a.id} value={a.id}>{a.name} · {a.provider}/{a.model}</option>)}
          </select>
          {(() => {
            if (!sidebarCollapsed || !onSelectChat || !chat) return null;
            const navChats = (registry?.chats || [])
              .filter(c => !c.archived && c.id !== chat.id)
              .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.lastActivity - a.lastActivity);
            if (navChats.length === 0) return null;
            return (
              <select value=""
                onChange={e => { if (e.target.value) onSelectChat(e.target.value); }}
                style={{ ...styles.responderPicker, maxWidth: 180 }}
                title="Jump to another session (sidebar is collapsed)">
                <option value="">→ session…</option>
                {navChats.map(c => (
                  <option key={c.id} value={c.id}>{c.pinned ? "📌 " : ""}{c.title}</option>
                ))}
              </select>
            );
          })()}
          {toolName && <span style={{ ...styles.chatModel, color: c.rust, borderColor: "rgba(192,70,31,0.3)" }}>⚙ {toolName}…</span>}
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
          {ctxTokens != null && (
            <span style={{ ...styles.chatModel, ...(ctxPct != null && ctxPct >= 85 ? { color: c.rust, borderColor: "rgba(192,70,31,0.35)" } : ctxPct != null && ctxPct >= 65 ? { color: c.gold } : {}) }}
              title={`~${ctxTokens.toLocaleString()} tokens in context${ctxWindow ? ` · ~${ctxPct}% of this model's ${fmtTok(ctxWindow)} window` : ""}\nMeasured from the last API response. Clear or hand off the chat to reset.`}>
              ◔ {ctxWindow ? `${fmtTok(ctxTokens)}/${fmtTok(ctxWindow)}` : `~${fmtTok(ctxTokens)} tok`}
            </span>
          )}
          {busy && <button onClick={() => chat && runtime?.abort(chat.id)} style={styles.stopBtn} title="Stop generating  (Esc)"><Icon name="stop" size={12} color={c.paper}/></button>}
          <button onClick={() => setCustomizeOpen(o => !o)} disabled={!chat || !agent} style={{ ...styles.headerIconBtn, ...(chat?.overrides ? { color: c.rust } : {}) }} title="Customize this chat (model, prompt + tools, this chat only)"><Icon name="settings" size={14}/></button>
          <button onClick={diagnose} disabled={busy || !agent} style={styles.headerIconBtn} title="Self-Diagnose — ask this agent to analyze its own source"><Icon name="search" size={14}/></button>
          <button onClick={handoff}  disabled={busy || !agent} style={styles.headerIconBtn} title="↻ Handoff — summarize and seed the next chat"><Icon name="refresh" size={14}/></button>
          <button onClick={() => chat && runtime?.clearHistory(chat.id)} disabled={!agent || !chat} style={styles.headerIconBtn} title="Clear chat history (no summary)"><Icon name="trash" size={14}/></button>
        </div>
      </div>

      {customizeOpen && chat && agent && (() => {
        const overrides = chat.overrides || {};
        const providerObj = providers[agent.provider];
        const allModels  = normalizeModels(providerObj?.models);
        const hiddenSet  = hiddenModels.getFor(agent.provider);
        const visibleModels = allModels.filter(m => !hiddenSet.has(m.id));
        const allTools = pluginHost.list();
        const effectiveTools = overrides.tools ?? (agent.tools || []);
        const setOv = (patch) => {
          const next = { ...overrides, ...patch };
          // If patch wipes back to defaults, clean up empty override key
          if (next.model === agent.model) delete next.model;
          if (next.tools && next.tools.length === (agent.tools||[]).length && next.tools.every(t => (agent.tools||[]).includes(t))) delete next.tools;
          if ((next.systemPrompt ?? "") === (agent.systemPrompt ?? "")) delete next.systemPrompt;
          const cleaned = Object.keys(next).length === 0 ? null : next;
          registry.updateChat(chat.id, { overrides: cleaned });
        };
        const categories = [...new Set(allTools.map(t => t.category || "other"))];
        return (
          <div style={{ padding: "10px 16px", background: c.paper2, borderBottom: borderLight }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
              <span style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: "#8a7c63", textTransform: "uppercase" }}>This chat only</span>
              {overrides && Object.keys(overrides).length > 0 && (
                <button onClick={() => registry.updateChat(chat.id, { overrides: null })}
                  style={{ ...styles.toolBulkBtn, marginLeft: "auto" }}>Reset to agent defaults</button>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <label style={{ fontSize: 11, color: "#5a5244", minWidth: 50 }}>Model</label>
              <select value={overrides.model || agent.model}
                onChange={e => setOv({ model: e.target.value })}
                style={{ ...styles.field, flex: 1, margin: 0 }}>
                {visibleModels.map(m => {
                  const catLabel = m.category ? `[${MODEL_CATEGORY_LABELS[m.category] || m.category}] ` : "";
                  return <option key={m.id} value={m.id}>{catLabel}{m.label}{m.description ? ` — ${m.description}` : ""}</option>;
                })}
              </select>
              {overrides.model && overrides.model !== agent.model && <span style={{ fontSize: 10, color: c.rust, fontFamily: fonts.mono }}>OVERRIDE</span>}
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <label style={{ fontSize: 11, color: "#5a5244", minWidth: 50 }}>Prompt</label>
                <span style={{ fontSize: 10, color: "#8a7c63" }}>Replaces this agent's persona — this chat only</span>
                {overrides.systemPrompt != null && overrides.systemPrompt !== (agent.systemPrompt || "") && <span style={{ marginLeft: "auto", fontSize: 10, color: c.rust, fontFamily: fonts.mono }}>OVERRIDE</span>}
              </div>
              <textarea value={overrides.systemPrompt ?? (agent.systemPrompt || "")}
                onChange={e => setOv({ systemPrompt: e.target.value })}
                rows={4} placeholder="System prompt for this chat…"
                style={{ ...styles.field, padding: "8px 12px", fontSize: 12, lineHeight: 1.45, resize: "vertical", margin: 0 }} />
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
              <label style={{ fontSize: 11, color: "#5a5244", minWidth: 50 }}>Tools</label>
              <button type="button" onClick={() => setOv({ tools: allTools.map(t => t.name) })} style={styles.toolBulkBtn}>All</button>
              <button type="button" onClick={() => setOv({ tools: [] })} style={styles.toolBulkBtn}>None</button>
              <button type="button" onClick={() => setOv({ tools: allTools.filter(t => !effectiveTools.includes(t.name)).map(t => t.name) })} style={styles.toolBulkBtn}>Invert</button>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#8a7c63", fontFamily: fonts.mono }}>{effectiveTools.length}/{allTools.length}{overrides.tools ? " · OVERRIDE" : ""}</span>
            </div>
            <div style={{ ...styles.toolSelectList, maxHeight: 180 }}>
              {categories.map(cat => (
                <AgentEditorToolGroup key={cat} cat={cat}
                  tools={allTools.filter(t => (t.category || "other") === cat)}
                  selected={effectiveTools}
                  onToggle={(name) => {
                    const cur = new Set(effectiveTools);
                    cur.has(name) ? cur.delete(name) : cur.add(name);
                    setOv({ tools: [...cur] });
                  }}
                  onCategoryToggle={(toolNames, makeOn) => {
                    const cur = new Set(effectiveTools);
                    if (makeOn) toolNames.forEach(n => cur.add(n));
                    else        toolNames.forEach(n => cur.delete(n));
                    setOv({ tools: [...cur] });
                  }} />
              ))}
            </div>
          </div>
        );
      })()}

      <div style={styles.chatMessages} ref={messagesRef} onScroll={onMessagesScroll}>
        {history.length === 0 && (
          <div style={styles.chatWelcome}>
            <div style={styles.welcomeIcon}><Icon name="bot" size={32} color={c.rust} /></div>
            <h3 style={styles.welcomeTitle}>{agent ? agent.name : "Pick an agent"}</h3>
            <p style={styles.welcomeDesc}>{agent ? (chat?.overrides?.systemPrompt || agent.systemPrompt) : "Choose an agent in the dropdown above — that agent will reply to messages in this chat."}</p>
            {agent?.tools?.length > 0 && (
              <div style={{ display: "flex", gap: 5, justifyContent: "center", flexWrap: "wrap", marginTop: 10 }}>
                {agent.tools.map(t => <span key={t} style={styles.toolChip}>{t}</span>)}
              </div>
            )}
            {agent && <p style={styles.welcomeHint}>Type a message below to start</p>}
          </div>
        )}

        {history.map((msg, i) => {
          if (msg.role === "tool") return null; // rendered via look-ahead in preceding assistant msg

          if (msg.role === "user") {
            const contentParts = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
            const editable = typeof msg.content === "string";   // skip multimodal — editing would drop attachments
            if (editingIdx === i) {
              return (
                <div key={i} className="msgRow" style={{ ...styles.message, ...styles.messageUser }}>
                  <div style={styles.msgEditCol}>
                    <textarea autoFocus value={editDraft}
                      onChange={e => setEditDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitEdit(i); }
                        else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
                      }}
                      rows={Math.min(12, editDraft.split("\n").length + 1)}
                      style={styles.msgEditArea} />
                    <div style={styles.msgEditBtns}>
                      <button className="msgActionBtn" style={styles.msgActionBtn} onClick={cancelEdit}>Cancel</button>
                      <button className="msgSaveBtn" style={{ ...styles.msgActionBtn, ...styles.msgEditSave }} onClick={() => submitEdit(i)} title="Resend from here (⌘/Ctrl+Enter)">Send</button>
                    </div>
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className="msgRow" style={{ ...styles.message, ...styles.messageUser }}>
                <div style={styles.msgUserCol}>
                  <div className="msgBubble" style={{ ...styles.msgBubbleUser, maxWidth: "100%" }}>
                    {contentParts.map((part, pi) => {
                      if (part.type === "image") return (
                        <img key={pi} src={`data:${part.mime || "image/png"};base64,${part.base64}`}
                          alt={part.name || "pasted image"}
                          style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 8, marginBottom: 6, display: "block" }} />
                      );
                      return part.text ? <div key={pi} style={styles.msgText}>{part.text}</div> : null;
                    })}
                  </div>
                  {!busy && (
                    <div className="msgActions" style={{ ...styles.msgActions, justifyContent: "flex-end" }}>
                      {msg.ts && <span style={styles.msgTime}>{fmtMsgTime(msg.ts)}</span>}
                      {editable && <button className="msgActionBtn" style={styles.msgActionBtn} onClick={() => startEdit(i, msg.content)} title="Edit and resend">Edit</button>}
                      <button className="msgActionBtn" style={styles.msgActionBtn} onClick={() => fork(i)} title="Branch a new chat from here — keeps this one intact">⑂ Fork</button>
                    </div>
                  )}
                </div>
              </div>
            );
          }

          if (msg.role === "assistant") {
            if (msg.handoff) {
              return <HandoffBubble key={i} msg={msg} />;
            }
            const nextMsg    = history[i + 1];
            const toolResults = msg.toolCalls?.length && nextMsg?.role === "tool" ? nextMsg.toolResults : [];
            // Hide tool calls (and the assistant bubble if it would be empty) for
            // tools marked harnessOnly — they're delegation calls visible in the
            // Action Log instead, keeping the chat focused on replies.
            const visibleToolCalls = (msg.toolCalls || []).filter(tc => !pluginHost.get(tc.name)?.harnessOnly);
            if (!msg.content && !msg.streaming && visibleToolCalls.length === 0) return null;
            return (
              <div key={i} className="msgRow" style={{ ...styles.message, ...styles.messageAssistant }}>
                <div className="msgBubble" style={styles.msgBubbleAssistant}>
                  <div style={styles.msgSender}>{agent?.name || "Agent"}</div>
                  {msg.content && <div style={styles.msgMd}><Markdown text={msg.content} />{msg.streaming && <span style={styles.streamCursor}>▎</span>}</div>}
                  {msg.streaming && !msg.content && <div style={styles.typing}><span style={{ ...styles.typingDot, animationDelay: "0s" }} /><span style={{ ...styles.typingDot, animationDelay: "0.2s" }} /><span style={{ ...styles.typingDot, animationDelay: "0.4s" }} /></div>}
                  {visibleToolCalls.map((tc, j) => {
                    const res = toolResults.find(r => r.toolCallId === tc.id);
                    return <ToolCallCard key={j} toolCall={tc} result={res?.result} />;
                  })}
                  {!msg.streaming && msg.content && (
                    <div className="msgActions" style={styles.msgActions}>
                      <CopyBtn text={msg.content} />
                      {!busy && (
                        <button className="msgActionBtn" style={styles.msgActionBtn} onClick={() => fork(i)} title="Branch a new chat from here — keeps this one intact">⑂ Fork</button>
                      )}
                      {!busy && i === history.length - 1 && (
                        <button className="msgActionBtn" style={styles.msgActionBtn} onClick={() => regenerate(i)} title="Regenerate this response">↻ Regenerate</button>
                      )}
                      {msg.ts && <span style={styles.msgTime}>{fmtMsgTime(msg.ts)}</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          }

          return null;
        })}

        {busy && !(history[history.length - 1]?.role === "assistant" && history[history.length - 1]?.streaming) && (
          <div style={{ ...styles.message, ...styles.messageAssistant }}>
            <div style={styles.msgBubbleAssistant}>
              <div style={styles.msgSender}>{agent.name}</div>
              {toolName
                ? <div style={styles.toolStatusInline}><Icon name="tool" size={12} color={c.rust} /> {toolName}…</div>
                : <div style={styles.typing}><span style={{ ...styles.typingDot, animationDelay: "0s" }} /><span style={{ ...styles.typingDot, animationDelay: "0.2s" }} /><span style={{ ...styles.typingDot, animationDelay: "0.4s" }} /></div>}
            </div>
          </div>
        )}

        {error && (
          <div style={styles.errorBanner}>
            <span style={{ flex: 1, minWidth: 0 }}>⚠ {error}</span>
            {!busy && history.some(m => m.role === "user") && (
              <button onClick={retry} style={styles.errorRetryBtn} title="Replay the last message">↻ Retry</button>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>
      {showJump && (
        <button onClick={jumpToLatest} style={styles.jumpToLatest} title="Scroll to latest message">↓ Jump to latest</button>
      )}

      {attachments.length > 0 && (
        <div style={styles.attachmentBar}>
          {attachments.map((a, i) => (
            <span key={i} style={styles.attachmentChip} title={`${a.name} — ${a.size} bytes`}>
              {a.type === "image"
                ? <img src={a.dataUrl || `data:${a.mime};base64,${a.base64}`} alt={a.name}
                    style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, flexShrink: 0 }} />
                : <Icon name="file" size={11} color={c.rust} />}
              <span style={styles.attachmentName}>{a.name}</span>
              <span style={styles.attachmentSize}>{a.size > 1024 ? `${Math.round(a.size/1024)}KB` : `${a.size}B`}</span>
              <button onClick={() => removeAttachment(i)} style={styles.attachmentX} title="Remove">×</button>
            </span>
          ))}
        </div>
      )}

      <div style={styles.chatInput}>
        <input ref={fileInputRef} type="file" multiple onChange={onPickFiles}
          accept=".txt,.md,.json,.js,.jsx,.ts,.tsx,.py,.csv,.html,.css,.yaml,.yml,.toml,.xml,.sh,.rs,.go,.java,.kt,.swift,.c,.cpp,.h,.hpp,.rb,.php,.sql,.log,.conf,.ini,.env,image/*,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.docx,.xlsx,.pptx,.pdf,.zip,.odt,.ods,.odp,.epub"
          style={{ display: "none" }} />
        <button onClick={() => fileInputRef.current?.click()} disabled={busy} style={styles.attachBtn} title="Attach files or images">
          <Icon name="paperclip" size={18} color="#8a7c63" />
        </button>
        <textarea value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={!agent ? "Pick an agent to enable sending…" : attachments.length ? `Message about the attached file${attachments.length > 1 ? "s" : ""}…` : `Message ${agent.name}…`}
          style={styles.textInput} disabled={busy} rows={1}
          onInput={e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }} />
        <button onClick={send} style={{ ...styles.sendBtn, opacity: (input.trim() || attachments.length) && !busy ? 1 : 0.4 }}>
          <Icon name="send" size={18} color={c.paper} />
        </button>
      </div>
    </div>
  );
}

function AgentEditorToolGroup({ cat, tools, selected, onToggle, onCategoryToggle }) {
  const [open, setOpen] = useState(true);
  const masterRef = useRef(null);
  const names = tools.map(t => t.name);
  const onCount = names.filter(n => selected.includes(n)).length;
  const allOn  = onCount === names.length;
  const allOff = onCount === 0;
  useEffect(() => { if (masterRef.current) masterRef.current.indeterminate = !allOn && !allOff; }, [allOn, allOff]);
  return (
    <div style={{ borderBottom: borderLight }}>
      <div style={styles.toolGroupHeader}>
        <span onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", flex: 1, userSelect: "none" }}>
          <Icon name={open ? "chevD" : "chevR"} size={12} color="#8a7c63" />
          <span style={styles.toolGroupName}>{cat.toUpperCase()}</span>
          <span style={styles.toolGroupCount}>{onCount}/{names.length}</span>
        </span>
        <input ref={masterRef} type="checkbox" checked={allOn}
          onChange={() => onCategoryToggle(names, !allOn)}
          title={allOn ? "Disable all in this category" : "Enable all in this category"}
          style={{ accentColor: c.rust, cursor: "pointer", flexShrink: 0 }} />
      </div>
      {open && tools.map(tool => {
        const active = selected.includes(tool.name);
        return (
          <label key={tool.name} style={{ ...styles.toolSelectItem, ...(active ? styles.toolSelectItemActive : {}) }}>
            <input type="checkbox" checked={active} onChange={() => onToggle(tool.name)}
              style={{ accentColor: c.rust, marginTop: 2, flexShrink: 0 }} />
            <div>
              <div style={styles.toolSelectName}>{tool.name}</div>
              <div style={styles.toolSelectDesc}>{tool.description}</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function AgentEditor({ agent, onSave, onDelete, onCancel, pluginHostRef, vault, allAgents = [], runtimes = {}, onDirtyChange }) {
  const ph = pluginHostRef;
  const [initialForm] = useState(() => agent || {
    id: `agt_${Date.now().toString(36)}`, name: "", provider: "mock", model: "echo-v1",
    keyRef: null, systemPrompt: "", tools: [], params: { temperature: 0.7 },
  });
  const [form, setForm] = useState(initialForm);
  useEffect(() => {
    const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
    onDirtyChange?.(dirty);
  }, [form, initialForm, onDirtyChange]);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const providerObj = providers[form.provider];
  const withKeyIds = providersWithKeys(vault);
  const allModels      = normalizeModels(providerObj?.models);
  const hiddenSet      = hiddenModels.getFor(form.provider);
  const visibleModels  = allModels.filter(m => !hiddenSet.has(m.id));
  const currentModelDesc = allModels.find(m => m.id === form.model)?.description || "";
  const allTools = ph ? ph.list() : [];

  const toggleTool = (name) => {
    const has = form.tools.includes(name);
    set("tools", has ? form.tools.filter(t => t !== name) : [...form.tools, name]);
  };

  const vaultKeys = vault ? vault.list() : [];
  const keyInfo = vaultKeys.map(handle => {
    const ref = `vault://keys/${handle}`;
    const users = allAgents.filter(a => a.keyRef === ref);
    // Key is "active" if any agent using it has any chat in flight — agents
    // can still take more chats in parallel, so we use a non-blocking blue
    // dot rather than the gold "busy" dot.
    const active = users.some(a => runtimes[a.id]?.anyBusy?.());
    const state = users.length === 0 ? "unused" : active ? "active" : "idle";
    const dotColor = state === "active" ? c.sky : state === "idle" ? c.moss : "#bfb49a";
    const dotChar = state === "active" ? "●" : state === "idle" ? "●" : "○";
    return { handle, ref, users, state, dotColor, dotChar };
  });
  const currentHandle = form.keyRef?.startsWith("vault://keys/") ? form.keyRef.slice("vault://keys/".length) : "";
  const currentInfo = keyInfo.find(k => k.handle === currentHandle);
  const coUsers = currentInfo?.users.filter(a => a.id !== form.id).map(a => a.name) || [];

  return (
    <div style={styles.editorPanel}>
      <div style={styles.editorHeader} data-tauri-drag-region>
        <h3 style={styles.editorTitle}>{agent ? "Edit Agent" : "New Agent"}</h3>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={onCancel} style={styles.cancelBtn}>Cancel</button>
          <button onClick={() => form.name && onSave(form)} style={{ ...styles.saveBtn, opacity: form.name ? 1 : 0.4 }}>Save Agent</button>
          <button onClick={onCancel} style={styles.iconBtn} title="Close"><Icon name="x" size={18} /></button>
        </div>
      </div>
      <div style={styles.editorBody}>
        <label style={styles.fieldLabel}>Name</label>
        <input value={form.name} onChange={e => set("name", e.target.value)} style={styles.field} placeholder="e.g. Research Buddy" />

        <label style={styles.fieldLabel}>Provider</label>
        <select value={form.provider} onChange={e => { set("provider", e.target.value); set("model", normalizeModels(providers[e.target.value]?.models)[0]?.id || ""); }} style={styles.field}>
          {Object.values(providers).map(p => {
            const hasKey = withKeyIds.has(p.id);
            const noKeyOk = p.noKeyRequired || p.id === "mock";
            return <option key={p.id} value={p.id}>{p.name}{!hasKey && !noKeyOk ? " (no key)" : ""}</option>;
          })}
        </select>
        {!withKeyIds.has(form.provider) && form.provider !== "mock" && !providers[form.provider]?.noKeyRequired && (
          <div style={{ ...styles.modelHint, color: c.rust }}>No API key for this provider. Add one in Vault &amp; Keys or switch providers.</div>
        )}

        <label style={styles.fieldLabel}>Model</label>
        <select value={form.model} onChange={e => set("model", e.target.value)} style={styles.field}>
          {visibleModels.map(m => {
            const catLabel = m.category ? `[${MODEL_CATEGORY_LABELS[m.category] || m.category}] ` : "";
            return <option key={m.id} value={m.id}>{catLabel}{m.label}{m.description ? ` — ${m.description}` : ""}</option>;
          })}
        </select>
        {currentModelDesc && <div style={styles.modelHint}>{currentModelDesc}</div>}

        <label style={styles.fieldLabel}>API Key Reference</label>
        {vaultKeys.length === 0 ? (
          <div style={styles.keyPickerEmpty}>No keys in Vault yet. Add one in <strong>Vault &amp; Keys</strong>.</div>
        ) : (
          <select value={currentHandle}
            onChange={e => set("keyRef", e.target.value ? `vault://keys/${e.target.value}` : null)}
            style={styles.field}>
            <option value="">— No key (mock only) —</option>
            {keyInfo.map(k => {
              const others = k.users.filter(a => a.id !== form.id).map(a => a.name);
              const label = `${k.dotChar} ${k.handle}${others.length ? "  (also: " + others.join(", ") + ")" : ""}`;
              return <option key={k.handle} value={k.handle}>{label}</option>;
            })}
          </select>
        )}
        {currentInfo && (
          <div style={styles.keyMeta}>
            <span style={{ ...styles.statusDot, width: 8, height: 8, background: currentInfo.dotColor }} />
            <span style={styles.keyMetaState}>
              {currentInfo.state === "busy" ? "in use right now" : currentInfo.state === "idle" ? "idle" : "no agents on this key yet"}
            </span>
            {coUsers.length > 0 && <span style={styles.keyMetaCoUse}>(also: {coUsers.join(", ")})</span>}
          </div>
        )}

        <label style={styles.fieldLabel}>System Prompt</label>
        <textarea value={form.systemPrompt} onChange={e => set("systemPrompt", e.target.value)}
          style={{ ...styles.field, minHeight: 90, resize: "vertical", fontFamily: "inherit" }}
          placeholder="You are a helpful assistant…" />

        <label style={styles.fieldLabel}>Temperature: {form.params?.temperature ?? 0.7}</label>
        <input type="range" min="0" max="1" step="0.1" value={form.params?.temperature ?? 0.7}
          onChange={e => set("params", { ...form.params, temperature: parseFloat(e.target.value) })}
          style={{ width: "100%", accentColor: c.rust }} />

        {allTools.length > 0 && (() => {
          const categories = [...new Set(allTools.map(t => t.category || "other"))];
          const setAll  = (next) => set("tools", next);
          const allNames = allTools.map(t => t.name);
          return (
            <>
              <label style={styles.fieldLabel}>Tools</label>
              <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <button type="button" onClick={() => setAll(allNames)} style={styles.toolBulkBtn}>All</button>
                <button type="button" onClick={() => setAll([])} style={styles.toolBulkBtn}>None</button>
                <button type="button" onClick={() => setAll(allTools.filter(t => !form.tools.includes(t.name)).map(t => t.name))} style={styles.toolBulkBtn}>Invert</button>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "#8a7c63", fontFamily: fonts.mono, alignSelf: "center" }}>{form.tools.length}/{allTools.length}</span>
              </div>
              <div style={styles.toolSelectList}>
                {categories.map(cat => (
                  <AgentEditorToolGroup key={cat} cat={cat}
                    tools={allTools.filter(t => (t.category || "other") === cat)}
                    selected={form.tools}
                    onToggle={toggleTool}
                    onCategoryToggle={(toolNames, makeOn) => {
                      const nextSet = new Set(form.tools);
                      if (makeOn) toolNames.forEach(n => nextSet.add(n));
                      else        toolNames.forEach(n => nextSet.delete(n));
                      set("tools", [...nextSet]);
                    }} />
                ))}
              </div>
            </>
          );
        })()}

        {agent && <AgentVersionHistory agent={agent} currentForm={form} onRestore={(snap) => setForm(snap)} />}

        {agent && (
          <div style={styles.editorActions}>
            <button onClick={() => onDelete(agent.id)} style={styles.deleteBtn}><Icon name="trash" size={14} /> Delete this agent</button>
          </div>
        )}
      </div>
    </div>
  );
}

function AgentVersionHistory({ agent, currentForm, onRestore }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => agentVersions.onChange(() => setTick(t => t + 1)), []);
  const versions = agentVersions.list(agent.id);
  // M11: previously this only diffed the listed scalar fields plus the
  // tool SET (ignoring order). A snapshot that differed only by
  // params.temperature OR tool ordering showed "no field changes" while
  // the restore button silently reverted those. Now also compare params
  // and tool ORDER so the diff reflects what restore would actually do.
  const diffFields = (a, b) => {
    const fields = ["name", "provider", "model", "keyRef", "systemPrompt", "bluntMode"];
    const changes = [];
    for (const f of fields) if (JSON.stringify(a?.[f]) !== JSON.stringify(b?.[f])) changes.push(f);
    const aTools = a?.tools || [], bTools = b?.tools || [];
    if (aTools.length !== bTools.length || aTools.some((t, i) => t !== bTools[i])) {
      const aSet = new Set(aTools), bSet = new Set(bTools);
      const setChanged = aSet.size !== bSet.size || [...aSet].some(t => !bSet.has(t));
      changes.push(setChanged ? "tools" : "tools (order only)");
    }
    if (JSON.stringify(a?.params || {}) !== JSON.stringify(b?.params || {})) changes.push("params");
    return changes;
  };
  return (
    <div style={{ marginTop: 18, borderTop: borderLight, paddingTop: 12 }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", userSelect: "none" }}>
        <Icon name={open ? "chevD" : "chevR"} size={11} color="#8a7c63" />
        <span style={{ fontFamily: fonts.mono, fontSize: 11, color: "#5a5244", fontWeight: 700, letterSpacing: 1 }}>VERSION HISTORY</span>
        <span style={{ fontSize: 11, color: "#8a7c63", marginLeft: "auto" }}>{versions.length} snapshot{versions.length === 1 ? "" : "s"}</span>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          {versions.length === 0 && <div style={{ fontSize: 11, color: "#8a7c63", padding: "8px 4px" }}>No prior versions. Snapshots are taken automatically before each save.</div>}
          {versions.map(v => {
            const changes = diffFields(v.config, currentForm);
            return (
              <div key={v.ts} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", background: c.paper2, borderRadius: 6, marginBottom: 4 }}>
                <span style={{ fontFamily: fonts.mono, fontSize: 11, color: c.ink, flexShrink: 0 }}>{new Date(v.ts).toLocaleString()}</span>
                <span style={{ fontSize: 10, color: "#8a7c63", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {v.label} · diff: {changes.length ? changes.join(", ") : "no field changes"}
                </span>
                <button type="button" onClick={() => onRestore(v.config)} style={styles.toolBulkBtn}>Load into form</button>
                <button type="button" onClick={() => agentVersions.remove(agent.id, v.ts)}
                  style={{ ...styles.headerIconBtn, padding: 4 }} title="Remove this snapshot"><Icon name="x" size={11} /></button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentMiniChat({ agent, registry, runtime }) {
  const [text, setText] = useState("");
  // Most-recent non-archived chat where this agent replies — used for the preview.
  const recent = registry.chats
    .filter(c => !c.archived && c.responder === agent.id)
    .sort((a, b) => b.lastActivity - a.lastActivity)[0] || null;
  const preview = recent ? (registry.getMessages(recent.id) || []).filter(Boolean).slice(-2) : [];
  // Visual hint only — multi-tenant runtime means we can always send (a new
  // chat gets its own slot), so we never disable the send button.
  const active = !!runtime?.anyBusy?.();

  const send = () => {
    const t = text.trim();
    if (!t || !runtime) return;
    const autoTitle = t.split("\n")[0].slice(0, 48);
    const chat = registry.createChat({ title: autoTitle || "Quick chat", members: [agent.id], responder: agent.id });
    actionLog.startHarness(agent.id);
    runtime.chat(t, { chatId: chat.id }).catch(() => {});
    setText("");
  };

  return (
    <div style={styles.miniChat}>
      {preview.length > 0 && (
        <div style={styles.miniPreview}>
          {preview.map((m, i) => (
            <div key={i} style={m.role === "user" ? styles.miniMsgUser : styles.miniMsgAst}>
              <span style={styles.miniRole}>{m.role === "user" ? "you" : agent.name}</span>
              <span style={styles.miniText}>{typeof m.content === "string" ? m.content.slice(0, 160) : "…"}</span>
            </div>
          ))}
        </div>
      )}
      <div style={styles.miniInputRow}>
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
          placeholder={active ? `${agent.name} is working — sends start a parallel chat` : `Quick message to ${agent.name}…`}
          style={styles.miniInput} />
        <button onClick={send} disabled={!text.trim()}
          style={{ ...styles.miniSendBtn, opacity: text.trim() ? 1 : 0.45 }}
          title="Send (starts a new chat — reply shows in sidebar)">
          <Icon name="send" size={14} color={c.paper} />
        </button>
      </div>
    </div>
  );
}

function AgentsView({ agents, onEdit, onNew, registry, runtimes }) {
  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader} data-tauri-drag-region>
        <h2 style={styles.panelTitle}><Icon name="bot" size={22} /> Agents</h2>
        <button onClick={onNew} style={styles.primaryBtn}><Icon name="plus" size={14} /> New Agent</button>
      </div>
      <div style={styles.agentGrid}>
        {agents.map(a => {
          // Blue dot = agent has at least one chat in flight but still accepts more
          // (each chat gets its own slot inside the runtime, so concurrency works).
          const active = !!runtimes[a.id]?.anyBusy?.();
          return (
          <div key={a.id} style={{ ...styles.agentCard, ...(a.ephemeral ? { borderStyle: "dashed" } : {}) }}>
            <div style={styles.agentCardHeader}>
              {active && <span title="Working — accepts more chats" style={{ ...styles.statusDot, width: 8, height: 8, background: c.sky, marginRight: 6 }} />}
              <span style={styles.agentCardName}>{a.name}{a.ephemeral ? " ⎋" : ""}</span>
              <button onClick={() => onEdit(a)} style={styles.agentCardEditBtn} title="Edit agent">✎</button>
            </div>
            <div style={styles.agentCardMeta}>
              <span style={styles.chip}>{a.provider}</span>
              <span style={styles.chip}>{a.model}</span>
              <span style={{ ...styles.agentCardId, marginLeft: "auto" }}>{a.id}</span>
            </div>
            <p style={styles.agentCardPrompt}>{a.systemPrompt || "No system prompt"}</p>
            {a.tools?.length > 0 && (
              <div style={styles.toolList}>
                {a.tools.map(t => <span key={t} style={styles.toolChip}>{t}</span>)}
              </div>
            )}
            <AgentMiniChat agent={a} registry={registry} runtime={runtimes[a.id]} />
          </div>
          );
        })}
      </div>
    </div>
  );
}

function ToolRow({ tool, agents, saveAgent, onAnyChange, dragHandlers, dropHint }) {
  const disabled = toolGate.has(tool.name);
  const [expanded, setExpanded] = useState(false);
  const toggleAgentGrant = (agent) => {
    const has = (agent.tools || []).includes(tool.name);
    const next = has ? (agent.tools || []).filter(t => t !== tool.name) : [...(agent.tools || []), tool.name];
    saveAgent({ ...agent, tools: next });
  };
  return (
    <div style={{ ...styles.toolRow,
                  boxShadow: dropHint === "before" ? `inset 0 3px 0 ${c.rust}` : dropHint === "after" ? `inset 0 -3px 0 ${c.rust}` : "none" }}
      {...(dragHandlers || {})}>
      <div style={styles.toolRowMain}>
        {dragHandlers && (
          <span title="Drag to reorder" style={{ cursor: "grab", color: "#a89a7e", flexShrink: 0, display: "flex", marginTop: 1 }}>
            <Icon name="grip" size={13} color="#a89a7e" />
          </span>
        )}
        <input type="checkbox" checked={!disabled}
          onChange={() => { toolGate.toggle(tool.name); onAnyChange(); }}
          title={disabled ? "Globally disabled — click to enable" : "Globally enabled — click to disable"}
          style={{ accentColor: c.rust, marginTop: 3, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.toolRowName}>{tool.name}</div>
          <div style={styles.toolRowDesc}>{tool.description}</div>
        </div>
        {!disabled && (
          <button onClick={() => setExpanded(e => !e)} style={styles.toolRowExpand} title="Per-agent grants">
            <Icon name={expanded ? "chevD" : "chevR"} size={12} color="#8a7c63" />
          </button>
        )}
      </div>
      {!disabled && expanded && (
        <div style={styles.toolRowAgents}>
          <div style={styles.toolRowAgentsLabel}>Granted to:</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 4 }}>
            {agents.map(a => {
              const has = (a.tools || []).includes(tool.name);
              return (
                <label key={a.id} style={styles.toolRowAgentItem}>
                  <input type="checkbox" checked={has}
                    onChange={() => toggleAgentGrant(a)}
                    style={{ accentColor: c.rust, flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolCategory({ name, tools, agents, saveAgent, onAnyChange, dragHandlers, dropHint, toolOrder, onReorderTools }) {
  const [open, setOpen] = useState(false);
  const [dragTool, setDragTool] = useState(null);
  const [toolDrop, setToolDrop] = useState(null);  // { name, pos: "before"|"after" }
  const activeCount = tools.filter(t => !toolGate.has(t.name)).length;

  // Apply per-category tool order. Unsorted (newly registered) tools fall to end.
  const orderedTools = (() => {
    const order = toolOrder || [];
    const idx = new Map(order.map((n, i) => [n, i]));
    return [...tools].sort((a, b) => {
      const ai = idx.has(a.name) ? idx.get(a.name) : Infinity;
      const bi = idx.has(b.name) ? idx.get(b.name) : Infinity;
      return ai !== bi ? ai - bi : tools.indexOf(a) - tools.indexOf(b);
    });
  })();

  const onToolDragStart = (n) => (e) => {
    setDragTool(n); e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", n); } catch {}
    e.stopPropagation();
  };
  const onToolDragEnd = () => { setDragTool(null); setToolDrop(null); };
  const onToolDragOver = (n) => (e) => {
    if (!dragTool || dragTool === n) return;
    e.preventDefault(); e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setToolDrop({ name: n, pos });
  };
  const onToolDrop = (n) => (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!dragTool || dragTool === n) { onToolDragEnd(); return; }
    const order = orderedTools.map(t => t.name).filter(x => x !== dragTool);
    const tIdx = order.indexOf(n);
    if (tIdx < 0) { onToolDragEnd(); return; }
    order.splice(toolDrop?.pos === "before" ? tIdx : tIdx + 1, 0, dragTool);
    onReorderTools(name, order);
    onToolDragEnd();
  };

  return (
    <div style={{ ...styles.toolCategory,
                  boxShadow: dropHint === "before" ? `inset 0 3px 0 ${c.rust}` : dropHint === "after" ? `inset 0 -3px 0 ${c.rust}` : "none" }}>
      <div style={{ ...styles.toolCategoryHeader, cursor: dragHandlers ? "grab" : "pointer" }}
        onClick={(e) => { if (!e.defaultPrevented) setOpen(o => !o); }}
        {...(dragHandlers || {})}>
        {dragHandlers && (
          <span title="Drag to reorder category" style={{ cursor: "grab", color: "#a89a7e", display: "flex", flexShrink: 0 }}>
            <Icon name="grip" size={13} color="#a89a7e" />
          </span>
        )}
        <Icon name={open ? "chevD" : "chevR"} size={12} color="#8a7c63" />
        <span style={styles.toolCategoryName}>{name.toUpperCase()}</span>
        <span style={styles.toolCategoryCount}>{activeCount}/{tools.length}</span>
      </div>
      {open && orderedTools.map(t => (
        <ToolRow key={t.name} tool={t} agents={agents} saveAgent={saveAgent} onAnyChange={onAnyChange}
          dragHandlers={{ draggable: true,
                          onDragStart: onToolDragStart(t.name),
                          onDragEnd: onToolDragEnd,
                          onDragOver: onToolDragOver(t.name),
                          onDrop: onToolDrop(t.name) }}
          dropHint={toolDrop?.name === t.name ? toolDrop.pos : null} />
      ))}
    </div>
  );
}

function ToolsView({ pluginHostRef, agents, saveAgent, onAnyChange }) {
  const tools = pluginHostRef.list();
  const allCats = [...new Set(tools.map(t => t.category))];

  // Persisted ordering: { _categories: [...], <cat>: [toolName, ...] }
  const [order, setOrder] = useState(() => {
    try { return JSON.parse(localStorage.getItem("yumuhub:toolOrder")) || {}; } catch { return {}; }
  });
  const persistOrder = (next) => {
    setOrder(next);
    try { localStorage.setItem("yumuhub:toolOrder", JSON.stringify(next)); } catch {}
  };

  const catOrder = order._categories || [];
  const catIdx = new Map(catOrder.map((c, i) => [c, i]));
  const categories = [...allCats].sort((a, b) => {
    const ai = catIdx.has(a) ? catIdx.get(a) : Infinity;
    const bi = catIdx.has(b) ? catIdx.get(b) : Infinity;
    return ai !== bi ? ai - bi : allCats.indexOf(a) - allCats.indexOf(b);
  });

  // Category drag state
  const [dragCat, setDragCat] = useState(null);
  const [catDrop, setCatDrop] = useState(null);
  const onCatDragStart = (cat) => (e) => {
    setDragCat(cat); e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", cat); } catch {}
  };
  const onCatDragEnd = () => { setDragCat(null); setCatDrop(null); };
  const onCatDragOver = (cat) => (e) => {
    if (!dragCat || dragCat === cat) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setCatDrop({ cat, pos });
  };
  const onCatDrop = (cat) => (e) => {
    e.preventDefault();
    if (!dragCat || dragCat === cat) { onCatDragEnd(); return; }
    const next = categories.filter(x => x !== dragCat);
    const tIdx = next.indexOf(cat);
    if (tIdx < 0) { onCatDragEnd(); return; }
    next.splice(catDrop?.pos === "before" ? tIdx : tIdx + 1, 0, dragCat);
    persistOrder({ ...order, _categories: next });
    onCatDragEnd();
  };

  const onReorderTools = (cat, names) => persistOrder({ ...order, [cat]: names });

  useEffect(() => toolGate.onChange(() => onAnyChange?.()), [onAnyChange]);

  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader} data-tauri-drag-region>
        <h2 style={styles.panelTitle}><Icon name="tool" size={22} /> Tools</h2>
      </div>
      <div style={styles.vaultInfo}>
        <strong>Checkbox</strong> = globally enabled across all agents. <strong>›</strong> opens a per-agent grant panel. Drag the <Icon name="grip" size={11} color="#8a7c63" /> handles to reorder categories or tools within a category.
      </div>
      {categories.map(cat => (
        <ToolCategory key={cat} name={cat}
          tools={tools.filter(t => t.category === cat)}
          agents={agents} saveAgent={saveAgent} onAnyChange={() => onAnyChange?.()}
          dragHandlers={{ draggable: true,
                          onDragStart: onCatDragStart(cat),
                          onDragEnd: onCatDragEnd,
                          onDragOver: onCatDragOver(cat),
                          onDrop: onCatDrop(cat) }}
          dropHint={catDrop?.cat === cat ? catDrop.pos : null}
          toolOrder={order[cat] || []}
          onReorderTools={onReorderTools} />
      ))}
    </div>
  );
}

const ACTION_KIND_COLORS = {
  start: "#8a7c63", call: "#3d6b8a", reply: "#4a5a3a", spawn: "#caa04a",
  spawn_reply: "#caa04a", error: "#c0461f", tool_call: "#9b59b6", tool_result: "#4a5a3a",
  llm_call: "#5b8aa6", filter_block: "#c0461f", approval_required: "#caa04a", approval_denied: "#c0461f",
};
const ACTION_KIND_ICONS = {
  start: "▶", call: "─▸", reply: "◂─", spawn: "⊕", spawn_reply: "⊕◂",
  error: "✗", tool_call: "⚙", tool_result: "◂⚙",
  llm_call: "✦", filter_block: "⛔", approval_required: "⏸", approval_denied: "✗",
};

function formatDateKey(ts) {
  const d = new Date(ts);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function formatDateLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const dk = d.toDateString();
  if (dk === today.toDateString()) return "Today";
  if (dk === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

function BusView({ agents }) {
  const [, setTick] = useState(0);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState({});
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState(false);

  useEffect(() => actionLog.onChange(() => setTick(t => t + 1)), []);

  const agentName = (id) => agents.find(a => a.id === id)?.name || id;
  const entries = actionLog.getAll();
  const archived = actionLog.getArchived();
  const doArchive = () => {
    const guard = settings.get("protection")?.doubleClickActionLogClear === true;
    if (guard && !confirmArchive) {
      setConfirmArchive(true);
      setTimeout(() => setConfirmArchive(false), 4000);
      return;
    }
    actionLog.archive();
    setConfirmArchive(false);
  };
  const doPurge = () => {
    if (!confirmPurge) {
      setConfirmPurge(true);
      setTimeout(() => setConfirmPurge(false), 4000);
      return;
    }
    actionLog.purgeArchive();
    setConfirmPurge(false);
  };
  const filtered = filter
    ? entries.filter(e => e.kind === filter || e.from === filter || e.to === filter)
    : entries;

  const kinds = [...new Set(entries.map(e => e.kind))].sort();

  const groups = [];
  const groupMap = new Map();
  for (const ev of filtered) {
    const dk = formatDateKey(ev.ts);
    let g = groupMap.get(dk);
    if (!g) { g = { key: dk, ts: ev.ts, entries: [] }; groupMap.set(dk, g); groups.push(g); }
    g.entries.push(ev);
  }
  groups.reverse();
  for (const g of groups) g.entries.reverse();
  const todayKey = formatDateKey(Date.now());
  const toggle = (k) => setCollapsed(prev => ({ ...prev, [k]: !prev[k] }));

  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader} data-tauri-drag-region>
        <h2 style={styles.panelTitle}><Icon name="bus" size={22} /> Action Log</h2>
        <span style={styles.aquariumMeta}>{entries.length} events</span>
        {entries.length > 0 && (
          confirmArchive
            ? <button onClick={doArchive} style={{ ...styles.headerIconBtn, color: c.rust, fontFamily: fonts.mono, fontSize: 10, padding: "4px 8px", border: `1px solid ${c.rust}`, borderRadius: 5 }}>⚠ confirm</button>
            : <button onClick={doArchive} style={styles.headerIconBtn} title="Archive log — moves entries to a collapsible bucket below, doesn't permanently delete"><Icon name="trash" size={14} /></button>
        )}
      </div>
      <div style={{ ...styles.busRow, position: "sticky", top: 68, zIndex: 9, background: c.paper, paddingBottom: 8 }}>
        <select value={filter} onChange={e => setFilter(e.target.value)} style={styles.busSelect}>
          <option value="">All events</option>
          <optgroup label="By kind">
            {kinds.map(k => <option key={k} value={k}>{k}</option>)}
          </optgroup>
          <optgroup label="By agent">
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </optgroup>
        </select>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {groups.length === 0 && <p style={styles.muted}>No agent activity yet.</p>}
        {groups.map(g => {
          const open = collapsed[g.key] !== undefined ? !collapsed[g.key] : g.key === todayKey;
          return (
            <div key={g.key}>
              <div onClick={() => toggle(g.key)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", cursor: "pointer", userSelect: "none", fontFamily: fonts.mono, fontSize: 11, color: "#5a5244", borderBottom: `1px solid ${c.line}` }}>
                <Icon name={open ? "chevD" : "chevR"} size={10} color="#8a7c63" />
                <span style={{ fontWeight: 700 }}>{formatDateLabel(g.ts)}</span>
                <span style={{ color: "#8a7c63" }}>{g.key}</span>
                <span style={{ color: "#8a7c63", marginLeft: "auto" }}>{g.entries.length}</span>
              </div>
              {open && (
                <div style={{ ...styles.actionLogBody, borderRadius: "0 0 10px 10px", marginBottom: 4 }}>
                  {g.entries.map((ev, i) => (
                    <div key={i} style={styles.actionLogEntry}>
                      <span style={styles.actionLogTs}>{new Date(ev.ts).toLocaleTimeString()}</span>
                      <span style={{ ...styles.actionLogKind, color: ACTION_KIND_COLORS[ev.kind] || c.ink }}>
                        {ACTION_KIND_ICONS[ev.kind] || "•"} {ev.kind}
                      </span>
                      <span style={styles.busMsgFrom}>{agentName(ev.from)}</span>
                      {ev.to && <><span style={styles.busMsgArrow}>→</span><span style={styles.busMsgTo}>{agentName(ev.to)}</span></>}
                      {ev.body != null && (
                        <pre style={styles.actionLogPayload}>
                          {typeof ev.body === "string" ? (ev.body.length > 300 ? ev.body.slice(0, 300) + "…" : ev.body) : JSON.stringify(ev.body, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {archived.length > 0 && (
        <div style={{ marginTop: 24, borderTop: `1px dashed ${c.line}`, paddingTop: 14 }}>
          <div onClick={() => setArchiveOpen(o => !o)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 16px", cursor: "pointer", userSelect: "none", fontFamily: fonts.mono, fontSize: 11, color: "#8a7c63" }}>
            <Icon name={archiveOpen ? "chevD" : "chevR"} size={11} color="#8a7c63" />
            <span style={{ fontWeight: 700 }}>ARCHIVED ({archived.reduce((n, b) => n + b.entries.length, 0)} events in {archived.length} bucket{archived.length>1?"s":""})</span>
            <button onClick={(e) => { e.stopPropagation(); doPurge(); }}
              style={{ ...styles.toolBulkBtn, marginLeft: "auto", ...(confirmPurge ? { color: c.rust, border: `1px solid ${c.rust}` } : {}) }}>
              {confirmPurge ? "⚠ confirm permanent delete" : "Permanently delete all"}
            </button>
          </div>
          {archiveOpen && archived.slice().reverse().map((bucket, bi) => (
            <div key={bi} style={{ padding: "6px 16px", opacity: 0.7 }}>
              <div style={{ fontFamily: fonts.mono, fontSize: 10, color: "#8a7c63", marginBottom: 4 }}>
                ▾ Archived at {new Date(bucket.ts).toLocaleString()} — {bucket.entries.length} events
              </div>
              <div style={{ ...styles.actionLogBody, opacity: 0.8 }}>
                {bucket.entries.slice(0, 50).map((ev, i) => (
                  <div key={i} style={styles.actionLogEntry}>
                    <span style={styles.actionLogTs}>{new Date(ev.ts).toLocaleTimeString()}</span>
                    <span style={{ ...styles.actionLogKind, color: ACTION_KIND_COLORS[ev.kind] || c.ink }}>
                      {ACTION_KIND_ICONS[ev.kind] || "•"} {ev.kind}
                    </span>
                    <span style={styles.busMsgFrom}>{agentName(ev.from)}</span>
                    {ev.to && <><span style={styles.busMsgArrow}>→</span><span style={styles.busMsgTo}>{agentName(ev.to)}</span></>}
                  </div>
                ))}
                {bucket.entries.length > 50 && <div style={{ padding: "4px 8px", fontSize: 10, color: "#8a7c63" }}>… {bucket.entries.length - 50} more</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Consolidated usage panel at the top of the Vault: web search quotas + LLM
// token / cost rollup. Future layout will pull this somewhere central; for now
// it lives in the vault since that's where users already look for "quota left."
function UsageOverview({ agents, vault: v, onKeysChanged }) {
  const [open, setOpen] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => costStats.onChange(() => setTick(t => t + 1)), []);

  const fmtCost = (n) => n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
  const fmtNum  = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  // LLM totals (across all agents)
  const totals = agents.reduce((acc, a) => {
    const s = costStats.getFor(a.id);
    acc.calls += s.calls; acc.in += s.inTokens; acc.out += s.outTokens; acc.cost += s.cost; acc.errors += s.errors || 0;
    return acc;
  }, { calls: 0, in: 0, out: 0, cost: 0, errors: 0 });

  return (
    <div style={{ padding: "12px 16px", borderBottom: borderLight }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", marginBottom: open ? 10 : 0 }}>
        <Icon name={open ? "chevD" : "chevR"} size={12} color="#8a7c63" />
        <h3 style={{ fontFamily: fonts.display, fontSize: 15, fontWeight: 700 }}>Usage</h3>
        <span style={{ fontSize: 11, color: "#8a7c63", marginLeft: "auto", fontFamily: fonts.mono }}>
          {totals.calls} LLM call{totals.calls === 1 ? "" : "s"} · {fmtCost(totals.cost)}
        </span>
      </div>
      {open && (
        <>
          {/* LLM cost / token rollup */}
          <div style={{ background: c.paper2, borderRadius: 8, padding: "8px 12px", marginBottom: 10, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            <div>
              <div style={{ fontFamily: fonts.mono, fontSize: 9, color: "#8a7c63", textTransform: "uppercase", letterSpacing: 0.5 }}>Calls</div>
              <div style={{ fontFamily: fonts.mono, fontSize: 16, color: c.ink }}>{totals.calls}</div>
            </div>
            <div>
              <div style={{ fontFamily: fonts.mono, fontSize: 9, color: "#8a7c63", textTransform: "uppercase", letterSpacing: 0.5 }}>Tokens in/out</div>
              <div style={{ fontFamily: fonts.mono, fontSize: 16, color: c.ink }}>{fmtNum(totals.in)}/{fmtNum(totals.out)}</div>
            </div>
            <div>
              <div style={{ fontFamily: fonts.mono, fontSize: 9, color: "#8a7c63", textTransform: "uppercase", letterSpacing: 0.5 }}>Est. cost</div>
              <div style={{ fontFamily: fonts.mono, fontSize: 16, color: c.ink }}>{fmtCost(totals.cost)}</div>
            </div>
            <div>
              <div style={{ fontFamily: fonts.mono, fontSize: 9, color: "#8a7c63", textTransform: "uppercase", letterSpacing: 0.5 }}>Errors</div>
              <div style={{ fontFamily: fonts.mono, fontSize: 16, color: totals.errors > 0 ? c.rust : c.ink }}>{totals.errors}</div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: "#8a7c63", marginBottom: 8, fontFamily: fonts.mono }}>
            Costs are rough estimates. Full breakdown in <strong>Settings → Observability</strong>.
          </div>

          {/* Web search backends */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <Icon name="search" size={12} color="#8a7c63" />
            <span style={{ fontFamily: fonts.mono, fontSize: 10, color: "#8a7c63", letterSpacing: 0.5, textTransform: "uppercase" }}>Web search backends</span>
          </div>
          <div style={{ fontSize: 12, color: "#5a5244", marginBottom: 10 }}>
            Agents use <strong>web_search</strong> with a monthly free-tier quota. The picker auto-balances by remaining quota — add at least one key below.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {Object.entries(SEARCH_BACKENDS).map(([id, meta]) => (
              <SearchKeyCard key={id} id={id} meta={meta} vault={v} onKeysChanged={onKeysChanged} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SearchKeyCard({ id, meta, vault: v, onKeysChanged }) {
  const [val, setVal] = useState("");
  const handles = v.list();
  const existing = handles.find(h => meta.keyMatch.test(h));
  const used = searchStats.get(id);
  const pct = Math.round((used / meta.monthlyLimit) * 100);
  const addKey = () => {
    if (!val.trim()) return;
    v.store(`${id}_search`, val.trim());
    setVal("");
    onKeysChanged();
  };
  return (
    <div style={{ background: c.paper2, borderRadius: 8, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontFamily: fonts.display, fontSize: 14 }}>{meta.label}</strong>
        <span style={{ fontSize: 11, color: pct > 80 ? c.rust : c.ink, fontFamily: fonts.mono }}>
          {used}/{meta.monthlyLimit}/mo ({pct}%)
        </span>
      </div>
      <div style={{ height: 4, background: c.line, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(pct, 100)}%`, height: "100%", background: pct > 80 ? c.rust : c.moss, transition: "width 0.3s" }} />
      </div>
      {existing ? (
        <div style={{ fontSize: 12, color: c.moss, fontFamily: fonts.mono }}>
          Key: vault://keys/{existing}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input value={val} onChange={e => setVal(e.target.value)} type="password"
            style={{ ...styles.field, flex: 1, margin: 0, fontSize: 12, padding: "4px 8px" }}
            placeholder={`Paste ${meta.label} API key`}
            onKeyDown={e => e.key === "Enter" && addKey()} />
          <button onClick={addKey} style={{ ...styles.primaryBtn, fontSize: 11, padding: "4px 10px" }}>Add</button>
        </div>
      )}
      <button onClick={() => invokeTauri("open_url", { url: meta.signupUrl }).catch(() => {})}
        style={{ ...styles.clearBtn, fontSize: 11, alignSelf: "flex-start", textDecoration: "underline", padding: 0 }}>
        {existing ? "Manage account" : "Get free API key"} →
      </button>
    </div>
  );
}

function VaultView({ vault: v, agents = [] }) {
  const [handle, setHandle] = useState("");
  const [value,  setValue]  = useState("");
  const [keys,   setKeys]   = useState(v.list());
  const [, tick] = useState(0);
  // H10: previously trash was per-mount React state; switching to any
  // other view unmounted VaultView and silently destroyed every key in
  // "Recently Deleted". Now persist to localStorage with a 30-day TTL
  // and load on mount. Cleanup of expired entries happens on every read.
  const TRASH_KEY = "yumuhub:vaultTrash";
  const TRASH_TTL_MS = 30 * 24 * 3600 * 1000;
  const loadTrash = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(TRASH_KEY) || "[]");
      const cutoff = Date.now() - TRASH_TTL_MS;
      return (Array.isArray(raw) ? raw : []).filter(x => x?.removedAt > cutoff);
    } catch { return []; }
  };
  const saveTrash = (arr) => {
    try { localStorage.setItem(TRASH_KEY, JSON.stringify(arr)); } catch {}
  };
  const [trash, setTrashState] = useState(loadTrash);
  const setTrash = (updater) => {
    setTrashState(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      saveTrash(next);
      return next;
    });
  };
  const [confirmDel, setConfirmDel] = useState({});
  const [trashOpen, setTrashOpen] = useState(true);

  // Selection
  const [selected, setSelected] = useState(new Set());
  const selectAllRef = useRef(null);
  useEffect(() => { if (selectAllRef.current) selectAllRef.current.indeterminate = selected.size > 0 && selected.size < keys.length; }, [selected.size, keys.length]);
  const toggleSelect = (h) => setSelected(s => { const n = new Set(s); n.has(h) ? n.delete(h) : n.add(h); return n; });
  const allSelected = keys.length > 0 && selected.size === keys.length;

  // Groups + key metadata
  const [groups, setGroups] = useState(persist.loadVaultGroups());
  const [keyMeta, setKeyMeta] = useState(v.meta || {});
  const updateMeta = (fn) => { const next = fn({ ...v.meta }); v.meta = next; persist.saveVaultMeta(next); setKeyMeta(next); };
  const updateGroups = (next) => { persist.saveVaultGroups(next); setGroups(next); };

  // Bulk action dropdown
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const bulkRef = useRef(null);
  useEffect(() => {
    if (!bulkMenuOpen) return;
    const close = (e) => { if (bulkRef.current && !bulkRef.current.contains(e.target)) setBulkMenuOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [bulkMenuOpen]);

  // Group creation
  const [groupPromptOpen, setGroupPromptOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupParent, setNewGroupParent] = useState(null);
  const [moveToExisting, setMoveToExisting] = useState(null);

  // Replace
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceValue, setReplaceValue] = useState("");

  // Drag between groups + reorder
  const [draggedKey, setDraggedKey] = useState(null);
  const [dragOverGroup, setDragOverGroup] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // { handle, position: "before"|"after" }
  const [keyOrder, setKeyOrder] = useState(persist.loadVaultOrder());

  // Group editing
  const [editingGroupId, setEditingGroupId] = useState(null);
  const [editingGroupName, setEditingGroupName] = useState("");

  const add = () => {
    if (!handle.trim() || !value.trim()) return;
    v.store(handle.trim(), value.trim()); setKeys(v.list()); setHandle(""); setValue("");
  };
  const refreshKeys = () => { setKeys(v.list()); tick(n => n + 1); };
  const moveToTrash = (h) => {
    const captured = v.keys[h];
    v.remove(h);
    setKeys(v.list());
    setTrash(t => [{ handle: h, value: captured, removedAt: Date.now() }, ...t]);
    setConfirmDel(s => { const n = { ...s }; delete n[h]; return n; });
    setSelected(s => { const n = new Set(s); n.delete(h); return n; });
  };
  const restoreFromTrash = (h) => {
    setTrash(t => {
      const item = t.find(x => x.handle === h);
      if (item) { v.store(item.handle, item.value); setKeys(v.list()); }
      return t.filter(x => x.handle !== h);
    });
  };
  const remove = h => {
    const guard = settings.get("protection")?.doubleClickVaultDelete !== false;
    if (guard && !confirmDel[h]) {
      setConfirmDel(s => ({ ...s, [h]: true }));
      setTimeout(() => setConfirmDel(s => { const n = { ...s }; delete n[h]; return n; }), 4000);
      return;
    }
    moveToTrash(h);
  };
  // H10: do NOT clear trash on unmount any more — it now persists to disk
  // with a 30-day TTL. Old per-mount-clear effect removed.

  // Sort + group helpers. Sorted order = explicit keyOrder array first, then any
  // keys not in the array (newly-added) fall to the end in insertion order.
  const sortedKeys = (() => {
    const orderMap = new Map(keyOrder.map((k, i) => [k, i]));
    return [...keys].sort((a, b) => {
      const aIdx = orderMap.has(a) ? orderMap.get(a) : Infinity;
      const bIdx = orderMap.has(b) ? orderMap.get(b) : Infinity;
      return aIdx !== bIdx ? aIdx - bIdx : keys.indexOf(a) - keys.indexOf(b);
    });
  })();
  const topGroups = groups.filter(g => !g.parent);
  const getSubgroups = (parentId) => groups.filter(g => g.parent === parentId);
  const getKeysInGroup = (groupId) => sortedKeys.filter(k => keyMeta[k]?.group === groupId);
  const ungroupedKeys = sortedKeys.filter(k => !keyMeta[k]?.group || !groups.some(g => g.id === keyMeta[k]?.group));

  const reorderKey = (dragged, target, position) => {
    const base = sortedKeys.filter(k => k !== dragged);
    const targetIdx = base.indexOf(target);
    if (targetIdx < 0) return;
    base.splice(position === "before" ? targetIdx : targetIdx + 1, 0, dragged);
    setKeyOrder(base);
    persist.saveVaultOrder(base);
  };

  const createGroup = (name, parent) => {
    const g = { id: newId("grp"), name, parent: parent || null, collapsed: false };
    // Subgroups prepend (newest at top of parent); top-level groups append (preserve
    // user's existing ordering of root groups).
    updateGroups(parent ? [g, ...groups] : [...groups, g]);
    return g;
  };
  const deleteGroup = (id) => {
    const subIds = groups.filter(g => g.parent === id).map(g => g.id);
    const idsToRemove = new Set([id, ...subIds]);
    updateGroups(groups.filter(g => !idsToRemove.has(g.id)));
    updateMeta(m => { Object.keys(m).forEach(h => { if (idsToRemove.has(m[h]?.group)) m[h] = { ...m[h], group: null }; }); return m; });
  };
  const moveKeysToGroup = (handles, groupId) => {
    updateMeta(m => { handles.forEach(h => { m[h] = { ...(m[h] || {}), group: groupId || null }; }); return m; });
  };
  const quarantineKeys = (handles) => {
    updateMeta(m => { handles.forEach(h => { m[h] = { ...(m[h] || {}), quarantined: true }; }); return m; });
  };
  const unquarantineKey = (h) => {
    updateMeta(m => { if (m[h]) m[h] = { ...m[h], quarantined: false }; return m; });
  };
  const replaceKeys = (handles, newVal) => {
    handles.forEach(h => v.store(h, newVal));
    setKeys(v.list());
  };

  // Bulk actions
  // M12: warn before deleting keys that are referenced by an existing agent —
  // a silent bulk-delete used to orphan those agents (next chat would fail
  // with "no key found"). The warning lists the affected agent names so the
  // user can decide knowingly.
  const bulkDelete = () => {
    const sel = [...selected];
    const refToAgents = new Map();
    for (const h of sel) {
      const ref = `vault://keys/${h}`;
      const users = agents.filter(a => a.keyRef === ref);
      if (users.length) refToAgents.set(h, users);
    }
    if (refToAgents.size > 0) {
      const lines = [...refToAgents.entries()]
        .map(([h, list]) => `  • ${h} — used by ${list.map(a => a.name).join(", ")}`)
        .join("\n");
      const ok = window.confirm(
        `${refToAgents.size} of the ${sel.length} selected key(s) are bound to existing agent(s):\n\n${lines}\n\nDeleting will orphan those agents — they'll fail on the next chat until you reassign a key. Continue?`
      );
      if (!ok) { setBulkMenuOpen(false); return; }
    }
    sel.forEach(h => moveToTrash(h));
    setSelected(new Set());
    setBulkMenuOpen(false);
  };
  const bulkQuarantine = () => { quarantineKeys([...selected]); setSelected(new Set()); setBulkMenuOpen(false); };
  const bulkGroup = () => { setGroupPromptOpen(true); setBulkMenuOpen(false); };
  const bulkReplace = () => { setReplaceOpen(true); setReplaceValue(""); setBulkMenuOpen(false); };

  // Drag-drop: keys can be (a) moved between groups by dropping on a group container,
  // or (b) reordered by dropping on another key (insertion line above/below target).
  // WKWebView (Tauri on macOS) refuses to initiate a drag unless setData() runs,
  // so this is load-bearing even though the payload itself isn't read.
  const onKeyDragStart = (h) => (e) => {
    setDraggedKey(h);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", h); } catch {}
  };
  const onKeyDragEnd = () => { setDraggedKey(null); setDropTarget(null); setDragOverGroup(null); };
  const onGroupDragOver = (groupId) => (e) => { e.preventDefault(); setDragOverGroup(groupId); setDropTarget(null); };
  const onGroupDrop = (groupId) => (e) => {
    e.preventDefault();
    setDragOverGroup(null);
    if (draggedKey) { moveKeysToGroup([draggedKey], groupId); setDraggedKey(null); }
  };
  const onGroupDragLeave = () => setDragOverGroup(null);
  const onKeyDragOver = (h) => (e) => {
    if (!draggedKey || draggedKey === h) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const position = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    setDropTarget({ handle: h, position });
    setDragOverGroup(null);
  };
  const onKeyDrop = (h) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedKey || draggedKey === h) { onKeyDragEnd(); return; }
    const targetGroup = keyMeta[h]?.group || null;
    if ((keyMeta[draggedKey]?.group || null) !== targetGroup) moveKeysToGroup([draggedKey], targetGroup);
    reorderKey(draggedKey, h, dropTarget?.position || "after");
    onKeyDragEnd();
  };

  // Render a single key item
  const renderKey = (k) => {
    const ref = `vault://keys/${k}`;
    const users = agents.filter(a => a.keyRef === ref);
    const n = users.length;
    const cols = settings.get("colors") || {};
    const isQ = !!keyMeta[k]?.quarantined;
    const dotColor = isQ ? "#8a7c63"
      : n === 0 ? (cols.vaultUnused || "#bfb49a")
      : n === 1 ? (cols.vaultOne || "#5b8aa6")
      : n <= 3  ? (cols.vaultMany || "#c89c4a")
      : (cols.vaultOverloaded || "#c0461f");
    const isSel = selected.has(k);
    const tooltip = isQ ? "Quarantined — suspended from agent use" : n === 0 ? "Not in use" : `Used by ${n} agent${n>1?"s":""}: ${users.map(u=>u.name).join(", ")}`;
    const dropAbove = dropTarget?.handle === k && dropTarget?.position === "before";
    const dropBelow = dropTarget?.handle === k && dropTarget?.position === "after";
    return (
      <div key={k} style={{ ...styles.keyItem, opacity: isQ ? 0.55 : 1,
                            boxShadow: dropAbove ? `inset 0 3px 0 ${c.rust}` : dropBelow ? `inset 0 -3px 0 ${c.rust}` : "none",
                            cursor: draggedKey === k ? "grabbing" : "grab" }}
        draggable onDragStart={onKeyDragStart(k)} onDragEnd={onKeyDragEnd}
        onDragOver={onKeyDragOver(k)} onDrop={onKeyDrop(k)}>
        <span title="Drag to reorder or move between groups" style={{ cursor: "grab", color: "#a89a7e", flexShrink: 0, display: "flex" }}>
          <Icon name="grip" size={14} color="#a89a7e" />
        </span>
        <span title={tooltip} onClick={() => toggleSelect(k)}
          style={{ width: 18, height: 18, borderRadius: "50%", flexShrink: 0, cursor: "pointer",
                   display: "flex", alignItems: "center", justifyContent: "center",
                   border: isSel ? `2.5px solid ${dotColor}` : "2.5px solid transparent",
                   transition: "border 0.15s" }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%",
                         background: (n === 0 && !isQ) ? "transparent" : dotColor,
                         border: (n === 0 && !isQ) ? `1.5px solid ${dotColor}` : "none" }} />
        </span>
        <span style={{ ...styles.keyHandle, ...(isQ ? { textDecoration: "line-through", color: "#8a7c63" } : {}) }}>vault://keys/{k}</span>
        {isQ && <span style={{ fontFamily: fonts.mono, fontSize: 8.5, fontWeight: 700, letterSpacing: 0.5, color: "#a89a7e", background: "rgba(138,124,99,0.1)", padding: "1px 6px", borderRadius: 4 }}>QUARANTINED</span>}
        {isQ && <button onClick={() => unquarantineKey(k)} style={{ ...styles.toolBulkBtn, fontSize: 9 }}>Restore</button>}
        <span style={styles.keyMask}>••••••••</span>
        {confirmDel[k]
          ? <button onClick={() => remove(k)} style={{ ...styles.iconBtn, color: c.rust, fontSize: 10, fontFamily: fonts.mono, padding: "2px 8px", border: `1px solid ${c.rust}`, borderRadius: 5 }}>⚠ confirm</button>
          : <button onClick={() => remove(k)} style={styles.iconBtn} title="Delete key"><Icon name="trash" size={14} color={c.rust} /></button>}
      </div>
    );
  };

  // Render a group (with optional subgroups)
  const renderGroup = (g, depth = 0) => {
    const groupKeys = getKeysInGroup(g.id);
    const subs = depth === 0 ? getSubgroups(g.id) : [];
    const totalKeys = groupKeys.length + subs.reduce((s, sg) => s + getKeysInGroup(sg.id).length, 0);
    const isDragTarget = dragOverGroup === g.id;
    return (
      <div key={g.id} style={{ marginTop: depth === 0 ? 16 : 8, marginLeft: depth * 16, border: borderLight, borderRadius: 10, background: isDragTarget ? "rgba(192,70,31,0.04)" : c.paper2, transition: "background 0.15s" }}
        onDragOver={onGroupDragOver(g.id)} onDrop={onGroupDrop(g.id)} onDragLeave={onGroupDragLeave}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", cursor: "pointer", userSelect: "none" }}
          onClick={() => updateGroups(groups.map(x => x.id === g.id ? { ...x, collapsed: !x.collapsed } : x))}>
          <Icon name={g.collapsed ? "chevR" : "chevD"} size={11} color="#8a7c63" />
          {editingGroupId === g.id ? (
            <input value={editingGroupName} autoFocus
              onClick={e => e.stopPropagation()}
              onChange={e => setEditingGroupName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { updateGroups(groups.map(x => x.id === g.id ? { ...x, name: editingGroupName.trim() || g.name } : x)); setEditingGroupId(null); } if (e.key === "Escape") setEditingGroupId(null); }}
              onBlur={() => { updateGroups(groups.map(x => x.id === g.id ? { ...x, name: editingGroupName.trim() || g.name } : x)); setEditingGroupId(null); }}
              style={{ ...styles.field, padding: "3px 8px", fontSize: 12, fontWeight: 700, margin: 0, flex: 1 }} />
          ) : (
            <span style={{ fontFamily: fonts.display, fontSize: 14, fontWeight: 700, flex: 1 }}>{g.name}</span>
          )}
          <span style={{ fontFamily: fonts.mono, fontSize: 10, color: "#8a7c63" }}>{totalKeys} key{totalKeys !== 1 ? "s" : ""}</span>
          <button onClick={e => { e.stopPropagation(); setEditingGroupId(g.id); setEditingGroupName(g.name); }} style={styles.iconBtn} title="Rename"><Icon name="wand" size={11} color="#8a7c63" /></button>
          {depth === 0 && <button onClick={e => { e.stopPropagation(); const sub = createGroup("Subgroup", g.id); }} style={styles.iconBtn} title="Add subgroup"><Icon name="plus" size={11} color="#8a7c63" /></button>}
          <button onClick={e => { e.stopPropagation(); deleteGroup(g.id); }} style={styles.iconBtn} title="Delete group (keeps keys)"><Icon name="x" size={11} color={c.rust} /></button>
        </div>
        {!g.collapsed && (
          <div style={{ padding: "0 8px 8px" }}>
            {subs.map(sg => renderGroup(sg, 1))}
            <div style={styles.keyList}>
              {groupKeys.length === 0 && subs.length === 0 && <p style={{ ...styles.muted, fontSize: 11, padding: "4px 8px" }}>Drag keys here or use bulk actions</p>}
              {groupKeys.map(renderKey)}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader} data-tauri-drag-region>
        <h2 style={styles.panelTitle}><Icon name="key" size={22} /> Vault &amp; Keys</h2>
      </div>

      <UsageOverview agents={agents} vault={v} onKeysChanged={refreshKeys} />

      <div style={styles.vaultInfo}>
        Keys are stored in <strong>localStorage</strong> and persist across sessions. Reference them in agents as <code style={styles.code}>vault://keys/handle</code>.
      </div>
      <div style={styles.vaultAdd}>
        <input value={handle} onChange={e => setHandle(e.target.value)} style={{ ...styles.field, flex: 1, margin: 0 }} placeholder="Handle (e.g. anthropic)" />
        <input value={value}  onChange={e => setValue(e.target.value)}  style={{ ...styles.field, flex: 2, margin: 0 }} placeholder="API key value" type="password" />
        <button onClick={add} style={styles.primaryBtn}>Store</button>
      </div>

      {/* Bulk action bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0 12px", borderBottom: keys.length > 0 ? `1px dashed ${c.line}` : "none" }}>
        {keys.length > 0 && (
          <>
            <input ref={selectAllRef} type="checkbox" checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(keys))}
              style={{ width: 15, height: 15, accentColor: c.rust, cursor: "pointer" }} />
            <span style={{ fontFamily: fonts.mono, fontSize: 10, color: "#8a7c63" }}>
              {selected.size === 0 ? "Select all" : `${selected.size} selected`}
            </span>
            {selected.size > 0 && (
              <div ref={bulkRef} style={{ position: "relative", marginLeft: 4 }}>
                <button onClick={() => setBulkMenuOpen(o => !o)}
                  style={{ ...styles.toolBulkBtn, display: "flex", alignItems: "center", gap: 4 }}>
                  Actions <Icon name="chevD" size={8} color="#5a5244" />
                </button>
                {bulkMenuOpen && (
                  <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: c.paper, border: borderLight, borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 30, minWidth: 150, overflow: "hidden" }}>
                    {[
                      { label: "Group",      action: bulkGroup,      icon: "inbox" },
                      { label: "Delete",     action: bulkDelete,     icon: "trash" },
                      { label: "Quarantine", action: bulkQuarantine, icon: "stop" },
                      { label: "Replace",    action: bulkReplace,    icon: "refresh" },
                    ].map(({ label, action, icon }) => (
                      <button key={label} onClick={action}
                        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 14px", border: "none", background: "none", cursor: "pointer", fontFamily: fonts.mono, fontSize: 11, color: c.ink, textAlign: "left" }}
                        onMouseEnter={e => e.currentTarget.style.background = c.paper2}
                        onMouseLeave={e => e.currentTarget.style.background = "none"}>
                        <Icon name={icon} size={12} color={label === "Delete" ? c.rust : "#8a7c63"} /> {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Group prompt (inline) */}
      {groupPromptOpen && selected.size > 0 && (
        <div style={{ padding: "12px 14px", background: c.paper2, border: borderLight, borderRadius: 10, marginBottom: 12 }}>
          <div style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, color: "#8a7c63", marginBottom: 8, letterSpacing: 1, textTransform: "uppercase" }}>
            Move {selected.size} key{selected.size > 1 ? "s" : ""} to group
          </div>
          {topGroups.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {groups.map(g => (
                <button key={g.id} onClick={() => { moveKeysToGroup([...selected], g.id); setSelected(new Set()); setGroupPromptOpen(false); }}
                  style={{ ...styles.toolBulkBtn, ...(g.parent ? { marginLeft: 12, fontSize: 9 } : {}) }}>
                  {g.parent ? "↳ " : ""}{g.name}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)} placeholder="New group name"
              autoFocus onKeyDown={e => { if (e.key === "Enter" && newGroupName.trim()) { const g = createGroup(newGroupName.trim(), newGroupParent); moveKeysToGroup([...selected], g.id); setSelected(new Set()); setGroupPromptOpen(false); setNewGroupName(""); } }}
              style={{ ...styles.field, flex: 1, margin: 0, padding: "6px 10px", fontSize: 12 }} />
            {topGroups.length > 0 && (
              <select value={newGroupParent || ""} onChange={e => setNewGroupParent(e.target.value || null)}
                style={{ ...styles.field, width: 130, margin: 0, padding: "6px 10px", fontSize: 11 }}>
                <option value="">Top level</option>
                {topGroups.map(g => <option key={g.id} value={g.id}>↳ {g.name}</option>)}
              </select>
            )}
            <button onClick={() => {
              if (!newGroupName.trim()) return;
              const g = createGroup(newGroupName.trim(), newGroupParent);
              moveKeysToGroup([...selected], g.id);
              setSelected(new Set()); setGroupPromptOpen(false); setNewGroupName("");
            }} disabled={!newGroupName.trim()} style={{ ...styles.primaryBtn, padding: "6px 12px", opacity: newGroupName.trim() ? 1 : 0.4 }}>Create &amp; move</button>
            <button onClick={() => setGroupPromptOpen(false)} style={styles.toolBulkBtn}>Cancel</button>
          </div>
        </div>
      )}

      {/* Replace prompt (inline) */}
      {replaceOpen && selected.size > 0 && (
        <div style={{ padding: "12px 14px", background: c.paper2, border: borderLight, borderRadius: 10, marginBottom: 12 }}>
          <div style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, color: "#8a7c63", marginBottom: 8, letterSpacing: 1, textTransform: "uppercase" }}>
            Replace value for {selected.size} key{selected.size > 1 ? "s" : ""}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input value={replaceValue} onChange={e => setReplaceValue(e.target.value)} placeholder="New API key value" type="password" autoFocus
              onKeyDown={e => { if (e.key === "Enter" && replaceValue.trim()) { replaceKeys([...selected], replaceValue.trim()); setSelected(new Set()); setReplaceOpen(false); setReplaceValue(""); } }}
              style={{ ...styles.field, flex: 1, margin: 0, padding: "6px 10px", fontSize: 12 }} />
            <button onClick={() => { if (!replaceValue.trim()) return; replaceKeys([...selected], replaceValue.trim()); setSelected(new Set()); setReplaceOpen(false); setReplaceValue(""); }}
              disabled={!replaceValue.trim()} style={{ ...styles.primaryBtn, padding: "6px 12px", opacity: replaceValue.trim() ? 1 : 0.4 }}>Replace</button>
            <button onClick={() => setReplaceOpen(false)} style={styles.toolBulkBtn}>Cancel</button>
          </div>
        </div>
      )}

      {/* Grouped keys */}
      {topGroups.map(g => renderGroup(g))}

      {/* Ungrouped keys */}
      <div style={{ marginTop: topGroups.length > 0 ? 16 : 0 }}
        onDragOver={onGroupDragOver(null)} onDrop={onGroupDrop(null)} onDragLeave={onGroupDragLeave}>
        {topGroups.length > 0 && ungroupedKeys.length > 0 && (
          <div style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "#8a7c63", textTransform: "uppercase", marginBottom: 6, ...(dragOverGroup === null && draggedKey ? { color: c.rust } : {}) }}>
            Ungrouped
          </div>
        )}
        <div style={styles.keyList}>
          {keys.length === 0 && <p style={styles.muted}>No keys stored yet.</p>}
          {ungroupedKeys.map(renderKey)}
        </div>
      </div>

      {trash.length > 0 && (
        <div style={{ marginTop: 28, borderTop: `1px dashed ${c.line}`, paddingTop: 18 }}>
          <div onClick={() => setTrashOpen(o => !o)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 16px", cursor: "pointer", userSelect: "none", fontFamily: fonts.mono, fontSize: 11, color: "#8a7c63" }}>
            <Icon name={trashOpen ? "chevD" : "chevR"} size={11} color="#8a7c63" />
            <span style={{ fontWeight: 700 }}>RECENTLY DELETED ({trash.length})</span>
            <span style={{ marginLeft: "auto", fontSize: 10 }}>Kept for 30 days, then permanently removed</span>
          </div>
          {trashOpen && (
            <div style={{ ...styles.keyList, paddingTop: 4 }}>
              {trash.map(item => (
                <div key={item.handle} style={{ ...styles.keyItem, opacity: 0.55 }}>
                  <span style={{ ...styles.keyHandle, textDecoration: "line-through" }}>vault://keys/{item.handle}</span>
                  <button onClick={() => restoreFromTrash(item.handle)}
                    style={{ ...styles.toolBulkBtn, marginLeft: "auto" }}>Restore</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Lives inside SettingsView — uses an in-app agent (not a direct Anthropic call)
// so any provider configured in yumuHub works.
function ImproveSourceSection({ agents, runtimes }) {
  const [code, setCode]               = useState(OWN_SOURCE);  // pre-fill with the running source
  const [focus, setFocus]             = useState("general");
  const [customPrompt, setCustomPrompt] = useState("");
  const [agentId, setAgentId]         = useState(() => {
    const real = agents.find(a => a.provider !== "mock"); return (real || agents[0])?.id || "";
  });
  const [status, setStatus]           = useState("idle");
  const [improved, setImproved]       = useState(null);
  const [error, setError]             = useState(null);
  const [viewMode, setViewMode]       = useState("diff");
  const [copied, setCopied]           = useState(false);

  const focusPrompts = {
    general: "Improve the overall UI/UX, visual hierarchy, spacing, and component structure. Make it more polished.",
    visual:  "Enhance the visual design: typography, color use, spacing, hover/focus states, and micro-interactions.",
    ux:      "Improve usability: clearer affordances, better feedback, information hierarchy, and interaction patterns.",
    a11y:    "Improve accessibility: ARIA labels, keyboard navigation, focus indicators, screen-reader support, color contrast.",
    custom:  customPrompt,
  };

  const run = async () => {
    const prompt = focusPrompts[focus];
    if (!prompt?.trim()) { setError("Enter a custom prompt."); return; }
    if (!code.trim())    { setError("Paste the component source first."); return; }
    const rt = runtimes[agentId];
    if (!rt) { setError("Pick an agent to perform the edit."); return; }
    setStatus("loading"); setError(null); setImproved(null);
    try {
      // Use a transient chat so the request doesn't pollute persistent history.
      // noTools: this is a one-shot code transformation — no tool use needed.
      // systemPrompt override: bypasses universal prompt and the agent's normal persona.
      const reply = await rt.chat(`${prompt}\n\nFull component to improve:\n\n${code}`, {
        noTools: true,
        systemPrompt: "You are an expert React/UI developer. Return ONLY the complete improved source code — no markdown fences, no explanations, just raw JS/JSX.",
      });
      const text = (reply || "").trim()
        .replace(/^```(?:jsx?|javascript)?\n?/, "")
        .replace(/\n?```$/, "");
      setImproved(text); setStatus("done");
    } catch (e) { setError(e.message); setStatus("error"); }
  };

  const copy = () => { navigator.clipboard.writeText(improved); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const diff = improved ? computeDiff(code.split("\n"), improved.split("\n")) : [];
  const added = diff.filter(d => d.t === "+").length;
  const removed = diff.filter(d => d.t === "-").length;
  const changedDiff = diff.filter(d => d.t !== "=");
  const busy = status === "loading";

  return (
    <div style={{ marginTop: 28, paddingTop: 18, borderTop: `2px solid ${c.ink}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <h3 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700 }}><Icon name="wand" size={16} /> Improve source code</h3>
        <button onClick={run} disabled={busy || !code.trim() || !agentId}
          style={{ ...styles.primaryBtn, opacity: (busy || !code.trim() || !agentId) ? 0.45 : 1 }}>
          {busy ? "Asking agent…" : "Improve"}
        </button>
      </div>
      <div style={styles.vaultInfo}>
        Sends the source plus a focus prompt to one of your in-app agents (no direct Anthropic call). The agent's provider, model, and key handle the request.
      </div>
      <div style={styles.improveGrid}>
        <div>
          <label style={styles.fieldLabel}>Focus</label>
          <select value={focus} onChange={e => setFocus(e.target.value)} style={styles.field}>
            <option value="general">General polish</option>
            <option value="visual">Visual design</option>
            <option value="ux">UX &amp; usability</option>
            <option value="a11y">Accessibility</option>
            <option value="custom">Custom prompt</option>
          </select>
        </div>
        <div>
          <label style={styles.fieldLabel}>Agent</label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} style={styles.field}>
            {agents.length === 0
              ? <option value="">— No agents available —</option>
              : agents.map(a => <option key={a.id} value={a.id}>{a.name} · {a.provider}/{a.model}</option>)}
          </select>
        </div>
      </div>
      {focus === "custom" && (
        <textarea value={customPrompt} onChange={e => setCustomPrompt(e.target.value)}
          style={{ ...styles.field, minHeight: 64, resize: "vertical", marginBottom: 10 }}
          placeholder="Describe what you'd like the agent to improve…" />
      )}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
          <label style={{ ...styles.fieldLabel, marginTop: 0, marginBottom: 0 }}>Component Source</label>
          <span style={{ fontFamily: fonts.mono, fontSize: 9.5, color: "#8a7c63" }}>
            {code ? `${code.split("\n").length} lines` : "paste below"}
          </span>
        </div>
        <textarea value={code} onChange={e => setCode(e.target.value)}
          style={{ ...styles.field, minHeight: 150, resize: "vertical", fontFamily: fonts.mono, fontSize: 11 }}
          placeholder={"Paste your YumuHub.jsx contents here, or leave as auto-filled."} />
      </div>
      {error && <div style={styles.errorBanner}>⚠ {error}</div>}
      {improved && (
        <div>
          <div style={styles.diffToolbar}>
            <div style={{ display: "flex", gap: 14, fontFamily: fonts.mono, fontSize: 11 }}>
              <span style={{ color: c.moss }}>+{added} added</span>
              <span style={{ color: c.rust }}>−{removed} removed</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setViewMode(v => v === "diff" ? "full" : "diff")} style={styles.clearBtn}>
                {viewMode === "diff" ? "Full code" : "Diff view"}
              </button>
              <button onClick={copy} style={{ ...styles.primaryBtn, ...(copied ? { background: c.moss } : {}) }}>
                {copied ? "✓ Copied!" : "Copy improved"}
              </button>
            </div>
          </div>
          <div style={styles.diffContainer}>
            {viewMode === "diff" ? (
              changedDiff.length === 0
                ? <p style={{ ...styles.muted, padding: 16 }}>No changes detected.</p>
                : changedDiff.map((d, i) => (
                  <div key={i} style={{ ...styles.diffLine, background: d.t === "+" ? "rgba(74,90,58,0.1)" : "rgba(192,70,31,0.08)", borderLeft: `3px solid ${d.t === "+" ? c.moss : c.rust}` }}>
                    <span style={{ ...styles.diffPrefix, color: d.t === "+" ? c.moss : c.rust }}>{d.t === "+" ? "+" : "−"}</span>
                    <span style={styles.diffCode}>{d.l}</span>
                  </div>
                ))
            ) : <pre style={styles.codeBlock}>{improved}</pre>}
          </div>
        </div>
      )}
    </div>
  );
}

// Provider templates for ccr config wizard. z.ai and Anthropic model lists
// are pulled live from yumuHub's own providers.* arrays so they stay in sync
// with whatever you maintain there. OpenRouter and DeepSeek are hardcoded
// because yumuHub doesn't have providers for them.
const CCR_TEMPLATES = {
  zai: {
    name: "z.ai",
    keyMatch: /zai|zhipu|glm|bigmodel/i,
    api_base_url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    transformer: null,
    get models() {
      return normalizeModels(providers.zai?.models)
        .filter(m => ["reasoning", "language"].includes(m.category))
        .map(m => m.id);
    },
  },
  openrouter: {
    name: "openrouter",
    keyMatch: /openrouter|sk-or/i,
    api_base_url: "https://openrouter.ai/api/v1/chat/completions",
    transformer: { use: ["openrouter"] },
    models: [
      "anthropic/claude-opus-4", "anthropic/claude-sonnet-4", "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o", "openai/o1", "openai/o1-mini",
      "google/gemini-2.5-pro", "google/gemini-2.0-flash-exp",
      "deepseek/deepseek-chat", "deepseek/deepseek-r1",
      "meta-llama/llama-3.1-405b-instruct",
      "zhipuai/glm-4.5",
    ],
  },
  anthropic: {
    name: "anthropic",
    keyMatch: /anthropic|claude/i,
    api_base_url: "https://api.anthropic.com/v1/messages",
    transformer: { use: ["Anthropic"] },
    get models() {
      return normalizeModels(providers.anthropic?.models).map(m => m.id);
    },
  },
  deepseek: {
    name: "deepseek",
    keyMatch: /deepseek/i,
    api_base_url: "https://api.deepseek.com/chat/completions",
    transformer: { use: ["deepseek"] },
    models: ["deepseek-chat", "deepseek-coder", "deepseek-reasoner"],
  },
};
const CCR_TIERS = [
  { id: "default",     label: "default",     hint: "Main route — normal requests." },
  { id: "background",  label: "background",  hint: "Cheap/fast tasks — short prompts, low-stakes." },
  { id: "think",       label: "think",       hint: "Reasoning-heavy — pick a strong model." },
  { id: "longContext", label: "longContext", hint: "Large context — pick a long-window model." },
];

function CcrSection({ onChange, vault: v, agents = [] }) {
  const [url, setUrl] = useState(settings.get("ccrUrl") || "http://127.0.0.1:3456");
  const [status, setStatus] = useState(null);  // null | "testing" | { ok: bool, msg: string }
  const [saved, setSaved] = useState(false);

  const vaultKeys = (v?.list?.() || []);

  // Per-tier config: just provider + model. Keys are auto-picked at Apply
  // time from the vault — heuristic-matched first, falling back to any
  // available key. yumuHub cycles through eligible keys per provider so each
  // tier using the same provider gets a different key when possible (max
  // parallelism, no rate-limit contention).
  const initialCfg = settings.get("ccrConfig") || {};
  const buildDefaultTier = () => {
    const firstTpl = Object.keys(CCR_TEMPLATES)[0] || "zai";
    return { provider: firstTpl, model: CCR_TEMPLATES[firstTpl].models[0] || "" };
  };
  const [cfgTiers, setCfgTiers] = useState(() => {
    const saved = initialCfg.tiers || {};
    const seed = buildDefaultTier();
    const out = {};
    for (const t of CCR_TIERS) {
      const prev = saved[t.id];
      out[t.id] = prev ? { provider: prev.provider || seed.provider, model: prev.model || seed.model } : { ...seed };
    }
    return out;
  });
  const [wizBusy,   setWizBusy]   = useState(false);
  const [wizStatus, setWizStatus] = useState(null);  // null | { ok: bool, msg: string }

  const setTierField = (tierId, field, val) => {
    setCfgTiers(prev => {
      const next = { ...prev, [tierId]: { ...prev[tierId], [field]: val } };
      if (field === "provider") {
        const tpl = CCR_TEMPLATES[val];
        next[tierId].model = tpl?.models?.[0] || "";
      }
      return next;
    });
  };

  const save = () => {
    const clean = (url || "").trim().replace(/\/+$/, "") || "http://127.0.0.1:3456";
    settings.set({ ccrUrl: clean });
    setUrl(clean);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
    onChange?.();
  };

  const test = async () => {
    setStatus("testing");
    const base = (url || "").trim().replace(/\/+$/, "") || "http://127.0.0.1:3456";
    const ccrApiKey = settings.get("ccrApiKey");
    const testHeaders = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (ccrApiKey) testHeaders["Authorization"] = `Bearer ${ccrApiKey}`;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: testHeaders,
        body: JSON.stringify({ model: "default", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: ctrl.signal,
      });
      clearTimeout(timeout);
      setStatus({ ok: true, msg: `Reachable (HTTP ${res.status}). Daemon is running.` });
    } catch (e) {
      const msg = e.name === "AbortError" ? "Timed out after 4s — is the daemon running?"
                : /Failed to fetch|NetworkError|ECONNREFUSED|Load failed/.test(e.message || "") ? "Connection refused — daemon is not running at this URL."
                : `Error: ${e.message || e}`;
      setStatus({ ok: false, msg });
    }
  };

  const apply = async () => {
    setWizStatus(null);
    if (vaultKeys.length === 0) {
      setWizStatus({ ok: false, msg: "No vault keys found. Add at least one in Vault & Keys before configuring ccr." });
      return;
    }
    for (const t of CCR_TIERS) {
      const tier = cfgTiers[t.id];
      if (!tier?.provider) { setWizStatus({ ok: false, msg: `Tier "${t.label}": pick a provider.` }); return; }
      if (!tier?.model)    { setWizStatus({ ok: false, msg: `Tier "${t.label}": pick a model.` }); return; }
    }
    const inUseKeyRefs = new Set(
      agents.filter(a => !a.ephemeral && a.keyRef).map(a => a.keyRef)
    );
    const usedKeyByProvider = new Map();
    const pickKeyForProvider = (tplId) => {
      const tpl = CCR_TEMPLATES[tplId];
      const matched = vaultKeys.filter(h => tpl.keyMatch.test(h) && v?.resolve?.(`vault://keys/${h}`));
      const eligible = matched.length > 0
        ? matched
        : vaultKeys.filter(h => !!v?.resolve?.(`vault://keys/${h}`));
      if (eligible.length === 0) return null;
      const idle = eligible.filter(h => !inUseKeyRefs.has(`vault://keys/${h}`));
      const pool = idle.length > 0 ? idle : eligible;
      const idx = (usedKeyByProvider.get(tplId) || 0) % pool.length;
      usedKeyByProvider.set(tplId, idx + 1);
      return pool[idx];
    };
    const providerGroups = new Map();  // `${tplId}::${keyHandle}` → { tplId, keyRef, name, models:Set }
    const router = {};
    for (const t of CCR_TIERS) {
      const tier = cfgTiers[t.id];
      const tpl  = CCR_TEMPLATES[tier.provider];
      const keyHandle = pickKeyForProvider(tier.provider);
      if (!keyHandle) {
        setWizStatus({ ok: false, msg: `Tier "${t.label}": no usable vault key for provider "${tpl.name}". Add a key in Vault & Keys.` });
        return;
      }
      const groupKey = `${tier.provider}::${keyHandle}`;
      let entry = providerGroups.get(groupKey);
      if (!entry) {
        const tplUsesInOthers = [...providerGroups.values()].filter(e => e.tplId === tier.provider);
        const safeKey = keyHandle.replace(/[^a-zA-Z0-9_-]/g, "_");
        const name = tplUsesInOthers.length === 0 ? tpl.name : `${tpl.name}__${safeKey}`;
        entry = { tplId: tier.provider, keyRef: keyHandle, name, models: new Set() };
        providerGroups.set(groupKey, entry);
      }
      entry.models.add(tier.model);
      router[t.id] = `${entry.name},${tier.model}`;
    }
    const providersArr = [];
    for (const entry of providerGroups.values()) {
      const tpl = CCR_TEMPLATES[entry.tplId];
      // Pad each provider entry with a few template defaults so the menu
      // isn't empty in ccr's UI — but keep configured picks at the top.
      tpl.models.slice(0, 5).forEach(m => entry.models.add(m));
      const p = {
        name: entry.name,
        api_base_url: tpl.api_base_url,
        api_key: v.resolve(`vault://keys/${entry.keyRef}`),
        models: [...entry.models],
      };
      if (tpl.transformer) p.transformer = tpl.transformer;
      providersArr.push(p);
    }
    // Generate a stable APIKEY so ccr bypasses its CORS origin check. yumuHub
    // sends this on every request via the ccr provider. Persisted so reapplies
    // reuse the same value.
    let ccrApiKey = settings.get("ccrApiKey");
    if (!ccrApiKey) {
      const bytes = new Uint8Array(24);
      (globalThis.crypto || window.crypto).getRandomValues(bytes);
      ccrApiKey = "ccr_" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
      settings.set({ ccrApiKey });
    }
    const config = { APIKEY: ccrApiKey, HOST: "127.0.0.1", Providers: providersArr, Router: router };
    const json = JSON.stringify(config, null, 2);

    setWizBusy(true);
    settings.set({ ccrConfig: { tiers: cfgTiers } });
    try {
      // 1. Install ccr if it's not on PATH
      const installed = await invokeTauri("ccr_check_installed");
      if (!installed) {
        setWizStatus({ ok: true, msg: "Installing ccr (npm i -g @musistudio/claude-code-router)…" });
        await invokeTauri("ccr_install");
      }
      // 2. Write the config file
      setWizStatus({ ok: true, msg: "Writing config to ~/.claude-code-router/config.json…" });
      await invokeTauri("ccr_write_config", { json });
      // 3. Restart the daemon (stop is best-effort)
      setWizStatus({ ok: true, msg: "Restarting daemon…" });
      try { await invokeTauri("ccr_stop"); } catch {}
      await invokeTauri("ccr_start");
      // 4. Verify
      const base = (url || "").trim().replace(/\/+$/, "") || "http://127.0.0.1:3456";
      await new Promise(r => setTimeout(r, 800));  // give daemon a moment
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "Authorization": `Bearer ${ccrApiKey}` },
          body: JSON.stringify({ model: "default", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
          signal: ctrl.signal,
        });
        setWizStatus({ ok: true, msg: `Config applied. Daemon is reachable (HTTP ${res.status}). Pick "Claude Code Router (local)" as a provider on any agent.` });
      } catch {
        setWizStatus({ ok: true, msg: "Config written and daemon started, but the test request didn't reach it. Try clicking 'Test connection' in a moment." });
      }
      onChange?.();
    } catch (e) {
      setWizStatus({ ok: false, msg: String(e?.message || e) });
    } finally {
      setWizBusy(false);
    }
  };

  const stopDaemon = async () => {
    setWizBusy(true); setWizStatus(null);
    try {
      const out = await invokeTauri("ccr_stop");
      setWizStatus({ ok: true, msg: `Daemon stopped. ${out || ""}`.trim() });
    } catch (e) {
      setWizStatus({ ok: false, msg: String(e?.message || e) });
    } finally {
      setWizBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 28, paddingTop: 18, borderTop: `2px solid ${c.ink}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <h3 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700 }}>Claude Code Router</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={test} style={styles.clearBtn} disabled={status === "testing"}>
            {status === "testing" ? "Testing…" : "Test connection"}
          </button>
          <button onClick={save} style={{ ...styles.primaryBtn, ...(saved ? { background: c.moss } : {}) }}>
            {saved ? "✓ Saved" : "Save URL"}
          </button>
        </div>
      </div>
      <div style={styles.vaultInfo}>
        Local daemon that routes agent calls to whichever provider you pick below. Agents using the <em>Claude Code Router (local)</em> provider hit this URL. The wizard below will install ccr if missing, write the config file, and start the daemon — one click.
      </div>
      <div style={styles.settingsRow}>
        <div style={styles.settingsLabel}>
          <div style={styles.settingsLabelTitle}>Daemon URL</div>
          <div style={styles.settingsLabelHint}>Base URL only — yumuHub appends <code style={styles.code}>/v1/messages</code> automatically. Default: <code style={styles.code}>http://127.0.0.1:3456</code>.</div>
        </div>
        <div style={styles.settingsControl}>
          <input type="text" value={url} onChange={e => setUrl(e.target.value)}
            placeholder="http://127.0.0.1:3456"
            style={{ ...styles.settingsInput, width: 220, textAlign: "left", fontSize: 12 }} />
        </div>
      </div>
      {status && status !== "testing" && (
        <div style={{ ...styles.vaultInfo, color: status.ok ? c.moss : c.rust, marginTop: 6 }}>
          {status.ok ? "✓ " : "✗ "}{status.msg}
        </div>
      )}

      {/* ── Wizard ── */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px dashed ${c.line}` }}>
        <h4 style={{ fontFamily: fonts.display, fontSize: 15, fontWeight: 700, marginBottom: 6 }}>One-click configure</h4>
        <div style={styles.vaultInfo}>
          Pick a provider and model for each Claude Code routing tier. yumuHub automatically pulls API keys from your vault — different tiers using the same provider get different keys when possible (max parallelism). <strong>Apply</strong> installs ccr (if missing), writes <code style={styles.code}>~/.claude-code-router/config.json</code>, and restarts the daemon.
        </div>
        {CCR_TIERS.map(tier => {
          const t = cfgTiers[tier.id] || {};
          const tpl = CCR_TEMPLATES[t.provider];
          const models = tpl?.models || [];
          return (
            <div key={tier.id} style={{ ...styles.settingsRow, alignItems: "flex-start" }}>
              <div style={{ ...styles.settingsLabel, paddingTop: 6 }}>
                <div style={styles.settingsLabelTitle}>{tier.label}</div>
                <div style={styles.settingsLabelHint}>{tier.hint}</div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                <select value={t.provider || ""} onChange={e => setTierField(tier.id, "provider", e.target.value)}
                  title="Provider" style={{ ...styles.settingsInput, width: 280, textAlign: "left", fontSize: 12 }}>
                  {Object.entries(CCR_TEMPLATES).map(([id, x]) =>
                    <option key={id} value={id}>{x.name}</option>)}
                </select>
                <select value={t.model || ""} onChange={e => setTierField(tier.id, "model", e.target.value)}
                  title="Model" style={{ ...styles.settingsInput, width: 280, textAlign: "left", fontSize: 12 }}>
                  {models.length === 0 && <option value="">— no models —</option>}
                  {models.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
          );
        })}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button onClick={apply} disabled={wizBusy}
            style={{ ...styles.primaryBtn, opacity: wizBusy ? 0.6 : 1 }}>
            {wizBusy ? "Working…" : "Apply (install + write + start)"}
          </button>
          <button onClick={stopDaemon} disabled={wizBusy} style={styles.clearBtn}>
            Stop daemon
          </button>
        </div>
        {wizStatus && (
          <div style={{ ...styles.vaultInfo, color: wizStatus.ok ? c.moss : c.rust, marginTop: 8, whiteSpace: "pre-wrap" }}>
            {wizStatus.ok ? "✓ " : "✗ "}{wizStatus.msg}
          </div>
        )}
      </div>
    </div>
  );
}

function ModelSelectionSection({ onChange, vault: v }) {
  const [, force] = useState(0);
  useEffect(() => hiddenModels.onChange(() => force(n => n + 1)), []);
  const withKeys = providersWithKeys(v);
  // N3 follow-up: expose the z.ai endpoint selector. The "coding" endpoint
  // throttles unsupported tools (yumuHub isn't on z.ai's listed-tools
  // allowlist) to a ~60s stream cap; the "general" endpoint doesn't.
  const zaiEp = settings.get("zaiEndpoint") || "general";
  const setZaiEp = (next) => { settings.set({ zaiEndpoint: next }); force(n => n + 1); onChange?.(); };
  return (
    <div style={{ marginTop: 28, paddingTop: 18, borderTop: `2px solid ${c.ink}` }}>
      <h3 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Model selection</h3>
      <div style={styles.vaultInfo}>
        Choose which models appear in the Agent editor's Model dropdown. Providers without an API key are marked — their models won't work until you add a key in <strong>Vault &amp; Keys</strong>. Agents (like the Receptionist) can still use any model programmatically via <code style={styles.code}>configure_agent</code>.
      </div>
      <div style={{ ...styles.settingsRow, marginBottom: 12, padding: "10px 12px", background: c.paper2, borderRadius: 8 }}>
        <div style={styles.settingsLabel}>
          <div style={styles.settingsLabelTitle}>z.ai chat endpoint</div>
          <div style={styles.settingsLabelHint}>
            <strong>anthropic</strong> (default) — <code style={styles.code}>api.z.ai/api/anthropic/v1/messages</code>. Same URL Claude Code uses; inherits Coding Plan quota without the third-party throttle.<br/>
            <strong>coding</strong> — <code style={styles.code}>api.z.ai/api/coding/paas/v4</code> (OpenAI-format Coding Plan endpoint; unsupported SDKs hit a ~60s stream cap).<br/>
            <strong>general</strong> — <code style={styles.code}>api.z.ai/api/paas/v4</code> (OpenAI-format, bills against API balance — needs credits).
          </div>
        </div>
        <div style={styles.settingsControl}>
          <select value={zaiEp} onChange={e => setZaiEp(e.target.value)} style={styles.field}>
            <option value="anthropic">anthropic (Claude-compat, recommended)</option>
            <option value="coding">coding (Coding Plan OpenAI-format)</option>
            <option value="general">general (API balance)</option>
          </select>
        </div>
      </div>
      {Object.values(providers).filter(p => p.id !== "mock").map(p => (
        <ProviderModelGroup key={p.id} provider={p} onChange={onChange} hasKey={withKeys.has(p.id)} />
      ))}
    </div>
  );
}

function ProviderModelGroup({ provider, onChange, hasKey }) {
  const list = normalizeModels(provider.models);
  const [open, setOpen] = useState(false);
  const masterRef = useRef(null);
  if (!list.length) return null;

  const hidden    = hiddenModels.getFor(provider.id);
  const allHidden = list.every(m => hidden.has(m.id));
  const allShown  = list.every(m => !hidden.has(m.id));
  const visibleCount = list.length - list.filter(m => hidden.has(m.id)).length;
  const categories = [...new Set(list.map(m => m.category).filter(Boolean))];

  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = !allHidden && !allShown;
  }, [allHidden, allShown]);

  const toggleAll = () => {
    if (allHidden) list.forEach(m => { if (hidden.has(m.id)) hiddenModels.toggle(provider.id, m.id); });
    else           list.forEach(m => { if (!hidden.has(m.id)) hiddenModels.toggle(provider.id, m.id); });
    onChange?.();
  };

  return (
    <div style={{ ...styles.modelGroup, ...(hasKey ? {} : { opacity: 0.55 }) }}>
      <div style={styles.modelGroupHeader} onClick={() => setOpen(o => !o)}>
        <span style={{ fontSize: 11, width: 14, color: "#8a7c63" }}>{open ? "▾" : "▸"}</span>
        <input ref={masterRef} type="checkbox" checked={allShown}
          onChange={toggleAll} onClick={e => e.stopPropagation()}
          style={{ marginRight: 6, cursor: "pointer" }} title="Show / hide all" />
        <span style={styles.modelGroupName}>{provider.name}</span>
        {!hasKey && <span style={{ fontFamily: fonts.mono, fontSize: 9.5, color: c.rust, marginLeft: 6 }}>no key</span>}
        <span style={styles.modelGroupCount}>{visibleCount}/{list.length} visible</span>
      </div>
      {open && (
        <>
          {categories.length > 1 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "8px 14px 4px", borderBottom: `1px dashed ${c.line}` }}>
              {categories.map(cat => (
                <span key={cat} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: fonts.mono, fontSize: 9.5, color: "#8a7c63" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: MODEL_CATEGORY_COLORS[cat] || "#8a7c63", flexShrink: 0 }} />
                  {MODEL_CATEGORY_LABELS[cat] || cat}
                </span>
              ))}
            </div>
          )}
          <div style={styles.modelGrid}>
            {list.map(m => {
              const catColor = MODEL_CATEGORY_COLORS[m.category] || null;
              return (
                <label key={m.id} style={styles.modelItem}>
                  <input type="checkbox" checked={!hidden.has(m.id)}
                    onChange={() => { hiddenModels.toggle(provider.id, m.id); onChange?.(); }}
                    style={{ marginTop: 3, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {catColor && <span style={{ width: 6, height: 6, borderRadius: "50%", background: catColor, flexShrink: 0 }} />}
                      <span style={styles.modelItemLabel}>{m.label}</span>
                    </div>
                    {m.description && <div style={styles.modelItemDesc}>{m.description}</div>}
                  </div>
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Observability panel: per-agent latency / tokens / cost / error rate ───
function ObservabilitySection({ agents, onChange }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);
  const [scope, setScope] = useState("all");  // "all" | "<agentId>"
  useEffect(() => costStats.onChange(() => setTick(t => t + 1)), []);
  useEffect(() => actionLog.onChange(() => setTick(t => t + 1)), []);

  const fmtCost = (n) => n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
  const fmtNum  = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const fmtMs   = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;

  // Per-agent rollup
  const rows = agents.map(a => {
    const s = costStats.getFor(a.id);
    const avgLat = s.calls > 0 ? s.latencySum / s.calls : 0;
    const errRate = (s.calls + (s.errors || 0)) > 0 ? (s.errors || 0) / (s.calls + (s.errors || 0)) : 0;
    return { id: a.id, name: a.name, calls: s.calls, in: s.inTokens, out: s.outTokens, cost: s.cost, avgLat, errors: s.errors || 0, errRate, perModel: s.perModel || {} };
  }).sort((a, b) => b.calls - a.calls);

  const totals = rows.reduce((acc, r) => ({
    calls: acc.calls + r.calls, in: acc.in + r.in, out: acc.out + r.out,
    cost: acc.cost + r.cost, latencySum: acc.latencySum + r.avgLat * r.calls, errors: acc.errors + r.errors,
  }), { calls: 0, in: 0, out: 0, cost: 0, latencySum: 0, errors: 0 });
  const totalAvgLat = totals.calls > 0 ? totals.latencySum / totals.calls : 0;

  // Recent llm_call timeline (last 60)
  const llmCalls = actionLog.getAll().filter(e => e.kind === "llm_call").slice(-60);

  const handleReset = (agentId) => {
    if (!confirmReset) { setConfirmReset(agentId || "all"); setTimeout(() => setConfirmReset(false), 4000); return; }
    costStats.reset(agentId);
    setConfirmReset(false);
    onChange?.();
  };

  return (
    <div style={{ marginTop: 28, paddingTop: 18, borderTop: `2px solid ${c.ink}` }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", marginBottom: 4 }}>
        <Icon name={open ? "chevD" : "chevR"} size={12} color="#8a7c63" />
        <h3 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700 }}>Observability</h3>
        <span style={{ fontSize: 11, color: "#8a7c63", marginLeft: "auto" }}>
          {totals.calls} call{totals.calls === 1 ? "" : "s"} · {fmtCost(totals.cost)} · {totals.errors} error{totals.errors === 1 ? "" : "s"}
        </span>
      </div>
      {open && (
        <div style={{ padding: "0 12px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={styles.vaultInfo}>
            Per-call latency, token usage, and rough cost. Costs are ballpark estimates ({"<"}publisher rate per 1k input/output{">"}) — use your provider dashboard for billing. Mock provider doesn't record usage.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select value={scope} onChange={e => setScope(e.target.value)}
              style={{ ...styles.field, width: 200, fontSize: 12, padding: 6 }}>
              <option value="all">All agents (rollup)</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            {confirmReset && (confirmReset === (scope === "all" ? "all" : scope))
              ? <button onClick={() => handleReset(scope === "all" ? null : scope)}
                  style={{ ...styles.toolBulkBtn, borderColor: c.rust, color: c.rust }}>⚠ confirm reset</button>
              : <button onClick={() => handleReset(scope === "all" ? null : scope)}
                  style={styles.toolBulkBtn}>Reset {scope === "all" ? "all stats" : "this agent"}</button>
            }
          </div>

          {/* Per-agent table */}
          <div style={{ background: c.paper2, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 80px 80px 80px 80px 70px", fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: "#8a7c63", padding: "6px 10px", borderBottom: borderLight, textTransform: "uppercase" }}>
              <span>Agent</span><span style={{ textAlign: "right" }}>Calls</span><span style={{ textAlign: "right" }}>In tok</span><span style={{ textAlign: "right" }}>Out tok</span><span style={{ textAlign: "right" }}>Avg lat</span><span style={{ textAlign: "right" }}>Cost</span><span style={{ textAlign: "right" }}>Err %</span>
            </div>
            {rows.length === 0 && <div style={{ padding: 12, fontSize: 11, color: "#8a7c63" }}>No call data yet. Send a message to any agent to populate.</div>}
            {rows.filter(r => scope === "all" || r.id === scope).map(r => (
              <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1fr 60px 80px 80px 80px 80px 70px", fontFamily: fonts.mono, fontSize: 11, color: c.ink, padding: "6px 10px", borderBottom: borderLight, alignItems: "center" }}>
                <span style={{ fontFamily: fonts.body, fontSize: 12 }}>{r.name}</span>
                <span style={{ textAlign: "right" }}>{r.calls}</span>
                <span style={{ textAlign: "right" }}>{fmtNum(r.in)}</span>
                <span style={{ textAlign: "right" }}>{fmtNum(r.out)}</span>
                <span style={{ textAlign: "right" }}>{r.calls > 0 ? fmtMs(r.avgLat) : "—"}</span>
                <span style={{ textAlign: "right" }}>{fmtCost(r.cost)}</span>
                <span style={{ textAlign: "right", color: r.errRate > 0.1 ? c.rust : "#5a5244" }}>{r.calls > 0 ? `${Math.round(r.errRate * 100)}%` : "—"}</span>
              </div>
            ))}
            {rows.length > 0 && scope === "all" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 60px 80px 80px 80px 80px 70px", fontFamily: fonts.mono, fontSize: 11, padding: "6px 10px", background: c.paper, fontWeight: 700, alignItems: "center" }}>
                <span style={{ fontFamily: fonts.body, fontSize: 12 }}>Total</span>
                <span style={{ textAlign: "right" }}>{totals.calls}</span>
                <span style={{ textAlign: "right" }}>{fmtNum(totals.in)}</span>
                <span style={{ textAlign: "right" }}>{fmtNum(totals.out)}</span>
                <span style={{ textAlign: "right" }}>{totals.calls > 0 ? fmtMs(totalAvgLat) : "—"}</span>
                <span style={{ textAlign: "right" }}>{fmtCost(totals.cost)}</span>
                <span style={{ textAlign: "right" }}>—</span>
              </div>
            )}
          </div>

          {/* Per-model breakdown if scoped to a single agent */}
          {scope !== "all" && (() => {
            const r = rows.find(x => x.id === scope);
            const models = r ? Object.entries(r.perModel) : [];
            if (!models.length) return null;
            return (
              <div>
                <div style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: "#8a7c63", marginBottom: 4, textTransform: "uppercase" }}>Per model</div>
                <div style={{ background: c.paper2, borderRadius: 8, padding: 4 }}>
                  {models.map(([m, s]) => (
                    <div key={m} style={{ display: "flex", justifyContent: "space-between", padding: "4px 10px", fontFamily: fonts.mono, fontSize: 11 }}>
                      <span>{m}</span>
                      <span>{s.calls} call · {fmtNum(s.inTokens)}/{fmtNum(s.outTokens)} tok · {fmtCost(s.cost)}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Recent LLM call timeline */}
          {llmCalls.length > 0 && (
            <div>
              <div style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: "#8a7c63", marginBottom: 4, textTransform: "uppercase" }}>Recent calls (last {llmCalls.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 200, overflow: "auto", background: c.paper2, borderRadius: 8, padding: 6 }}>
                {llmCalls.slice().reverse().map((e, i) => {
                  const agentName = agents.find(a => a.id === e.from)?.name || e.from;
                  const b = e.body || {};
                  return (
                    <div key={i} style={{ display: "flex", gap: 8, fontFamily: fonts.mono, fontSize: 10.5, padding: "2px 6px", alignItems: "center" }}>
                      <span style={{ color: "#8a7c63", width: 60, flexShrink: 0 }}>{new Date(e.ts).toLocaleTimeString()}</span>
                      <span style={{ flex: 1, color: c.ink }}>{agentName} → {e.to}</span>
                      <span style={{ color: "#5a5244", width: 60, textAlign: "right" }}>{fmtMs(b.latencyMs || 0)}</span>
                      <span style={{ color: "#5a5244", width: 80, textAlign: "right" }}>{fmtNum(b.inTokens || 0)}/{fmtNum(b.outTokens || 0)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Guardrails: pre-send content filter + tool approval gates ───
function GuardrailsSection({ onChange, agents = [], runtimes = {} }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const cfg     = settings.get("contentFilter") || {};
  const apprCfg = settings.get("toolApprovals") || {};
  const bump = () => setTick(t => t + 1);
  const setFilterCfg = (patch) => { settings.set({ contentFilter: { ...cfg, ...patch } }); bump(); onChange?.(); };
  const setApprCfg   = (patch) => { settings.set({ toolApprovals: { ...apprCfg, ...patch } }); bump(); onChange?.(); };

  const addPattern = () => setFilterCfg({ patterns: [...(cfg.patterns || []), { id: newId("pat"), source: "", flags: "i", label: "Untitled", scope: "both" }] });
  const updatePattern = (id, patch) => setFilterCfg({ patterns: cfg.patterns.map(p => p.id === id ? { ...p, ...patch } : p) });
  const removePattern = (id) => setFilterCfg({ patterns: cfg.patterns.filter(p => p.id !== id) });

  // Get all tools from registered agents (via runtimes); fall back to a default list.
  const allTools = [...new Set(agents.flatMap(a => a.tools || []))].sort();
  const ruleFor = (name) => apprCfg.rules?.[name] || "auto_approve";
  const setRule = (name, rule) => setApprCfg({ rules: { ...(apprCfg.rules || {}), [name]: rule } });

  return (
    <div style={{ marginTop: 28, paddingTop: 18, borderTop: `2px solid ${c.ink}` }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", marginBottom: 4 }}>
        <Icon name={open ? "chevD" : "chevR"} size={12} color="#8a7c63" />
        <h3 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700 }}>Guardrails &amp; approval</h3>
        <span style={{ fontSize: 11, color: "#8a7c63", marginLeft: "auto" }}>
          {cfg.enabled ? `Filter ON · ${(cfg.patterns || []).length} pattern${(cfg.patterns || []).length === 1 ? "" : "s"}` : "Filter OFF"}
          {" · "}{apprCfg.enabled ? "Tool approval ON" : "Tool approval OFF"}
        </span>
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Content filter toggle + patterns */}
          <div style={styles.settingsRow}>
            <div style={styles.settingsLabel}>
              <div style={styles.settingsLabelTitle}>Pre-send content filter</div>
              <div style={styles.settingsLabelHint}>Run user messages through a list of deny patterns before they reach the model. Useful for blocking secrets, PII, or off-policy prompts. <strong>Block</strong> = refuse + log; <strong>Warn</strong> = log only (don't refuse).</div>
            </div>
            <div style={{ ...styles.settingsControl, gap: 10 }}>
              <input type="checkbox" checked={!!cfg.enabled} onChange={e => setFilterCfg({ enabled: e.target.checked })}
                style={{ width: 18, height: 18, accentColor: c.rust, cursor: "pointer" }} />
              <select value={cfg.blockMode || "block"} onChange={e => setFilterCfg({ blockMode: e.target.value })}
                style={{ ...styles.settingsInput, width: 90, textAlign: "left", fontSize: 12 }}>
                <option value="block">Block</option>
                <option value="warn">Warn</option>
              </select>
            </div>
          </div>
          {cfg.enabled && (
            <div style={{ padding: "8px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
              {(cfg.patterns || []).length === 0 && <div style={{ fontSize: 11, color: "#8a7c63", padding: 8 }}>No patterns yet. Add a regex to start filtering.</div>}
              {(cfg.patterns || []).map(p => (
                <div key={p.id} style={{ display: "flex", gap: 6, alignItems: "center", padding: 6, background: c.paper2, borderRadius: 6 }}>
                  <input value={p.label || ""} placeholder="Label" onChange={e => updatePattern(p.id, { label: e.target.value })}
                    style={{ ...styles.field, width: 120, fontSize: 11, padding: 4 }} />
                  <input value={p.source || ""} placeholder="regex source" onChange={e => updatePattern(p.id, { source: e.target.value })}
                    style={{ ...styles.field, flex: 1, fontSize: 11, padding: 4, fontFamily: fonts.mono }} />
                  <input value={p.flags || "i"} placeholder="flags" onChange={e => updatePattern(p.id, { flags: e.target.value })}
                    style={{ ...styles.field, width: 50, fontSize: 11, padding: 4, fontFamily: fonts.mono }} />
                  <select value={p.scope || "both"} onChange={e => updatePattern(p.id, { scope: e.target.value })}
                    style={{ ...styles.field, width: 90, fontSize: 11, padding: 4 }}>
                    <option value="user">User only</option>
                    <option value="assistant">Assistant</option>
                    <option value="both">Both</option>
                  </select>
                  <button onClick={() => removePattern(p.id)} title="Remove pattern"
                    style={{ ...styles.headerIconBtn, padding: 4 }}><Icon name="x" size={12} /></button>
                </div>
              ))}
              <button onClick={addPattern} style={{ ...styles.toolBulkBtn, alignSelf: "flex-start" }}>+ Add pattern</button>
            </div>
          )}

          {/* Tool approval gate */}
          <div style={styles.settingsRow}>
            <div style={styles.settingsLabel}>
              <div style={styles.settingsLabelTitle}>Tool execution approval</div>
              <div style={styles.settingsLabelHint}>When enabled, tools below with a non-auto rule prompt before running. <strong>Ask</strong> = always prompt; <strong>Session</strong> = ask once, remember for this session; <strong>Auto-deny</strong> = always refuse. Tools with "Auto-approve" never prompt.</div>
            </div>
            <div style={styles.settingsControl}>
              <input type="checkbox" checked={!!apprCfg.enabled} onChange={e => setApprCfg({ enabled: e.target.checked })}
                style={{ width: 18, height: 18, accentColor: c.rust, cursor: "pointer" }} />
              <span style={styles.settingsSuffix}>{apprCfg.enabled ? "ON" : "OFF"}</span>
            </div>
          </div>
          {apprCfg.enabled && (
            <div style={{ padding: "8px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
              {allTools.length === 0 && <div style={{ fontSize: 11, color: "#8a7c63", padding: 8 }}>No tools registered on any agent.</div>}
              {allTools.map(name => (
                <div key={name} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 6px" }}>
                  <span style={{ flex: 1, fontFamily: fonts.mono, fontSize: 12, color: c.ink }}>{name}</span>
                  <select value={ruleFor(name)} onChange={e => setRule(name, e.target.value)}
                    style={{ ...styles.field, width: 130, fontSize: 11, padding: 4 }}>
                    <option value="auto_approve">Auto-approve</option>
                    <option value="ask">Ask each time</option>
                    <option value="session">Ask once / session</option>
                    <option value="auto_deny">Auto-deny</option>
                  </select>
                </div>
              ))}
              <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                <button onClick={() => { approvalQueue.clearSession(); bump(); }}
                  style={styles.toolBulkBtn}>Clear session-approved cache</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Disk persistence: mirror chat messages to disk on idle ───
function DiskPersistenceSection({ onChange }) {
  const [tick, setTick] = useState(0);
  const cfg = settings.get("diskPersistence") || {};
  const bump = () => setTick(t => t + 1);
  // H11: when toggling OFF, cancel every pending flush so already-scheduled
  // writes don't fire after the user disabled the feature.
  const setCfg = (patch) => {
    if (patch.enabled === false && cfg.enabled) chatBackup.cancelAll();
    settings.set({ diskPersistence: { ...cfg, ...patch } }); bump(); onChange?.();
  };
  return (
    <div style={styles.settingsRow}>
      <div style={styles.settingsLabel}>
        <div style={styles.settingsLabelTitle}>Disk-backup chat messages</div>
        <div style={styles.settingsLabelHint}>Mirror chat history to <code style={styles.code}>~/yumuhub-workspace/chats/&lt;chatId&gt;.json</code> after a few seconds of idle. localStorage stays the source of truth; the disk file is a safety net that survives browser data clears.</div>
      </div>
      <div style={{ ...styles.settingsControl, gap: 8 }}>
        <input type="checkbox" checked={!!cfg.enabled} onChange={e => setCfg({ enabled: e.target.checked })}
          style={{ width: 18, height: 18, accentColor: c.rust, cursor: "pointer" }} />
        <input type="number" min={5} max={600} value={cfg.idleSec || 30}
          onChange={e => setCfg({ idleSec: Math.max(5, Math.min(600, Number(e.target.value) || 30)) })}
          style={{ ...styles.settingsInput, width: 64 }} />
        <span style={styles.settingsSuffix}>s idle</span>
      </div>
    </div>
  );
}

// ─── Eval harness: run a set of prompts against an agent and score the replies ───
function EvalHarnessSection({ agents, runtimes, onChange }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [activeSuite, setActiveSuite] = useState(null);
  const [running, setRunning] = useState(false);
  const cfg = settings.get("evalHarness") || { suites: {}, lastResults: {} };
  const suites = cfg.suites || {};
  const results = cfg.lastResults || {};
  const bump = () => setTick(t => t + 1);
  const setCfg = (patch) => { settings.set({ evalHarness: { ...cfg, ...patch } }); bump(); onChange?.(); };
  const updateSuite = (id, patch) => setCfg({ suites: { ...suites, [id]: { ...suites[id], ...patch } } });
  const removeSuite = (id) => {
    const { [id]: _drop, ...rest } = suites;
    const { [id]: _drop2, ...restR } = results;
    setCfg({ suites: rest, lastResults: restR });
    if (activeSuite === id) setActiveSuite(null);
  };
  const newSuite = () => {
    const id = newId("suite");
    setCfg({ suites: { ...suites, [id]: { id, name: "New suite", agentId: agents[0]?.id || null, cases: [] } } });
    setActiveSuite(id);
  };
  const addCase = (id) => updateSuite(id, { cases: [...(suites[id].cases || []), { id: newId("case"), prompt: "", expected: "", mode: "contains" }] });
  const updateCase = (suiteId, caseId, patch) => updateSuite(suiteId, { cases: suites[suiteId].cases.map(c => c.id === caseId ? { ...c, ...patch } : c) });
  const removeCase = (suiteId, caseId) => updateSuite(suiteId, { cases: suites[suiteId].cases.filter(c => c.id !== caseId) });
  const scoreOne = (got, expected, mode) => {
    const g = String(got || ""), e = String(expected || "");
    if (mode === "exact")    return g.trim() === e.trim();
    if (mode === "regex")    { try { return new RegExp(e, "i").test(g); } catch { return false; } }
    /* contains */            return g.toLowerCase().includes(e.toLowerCase());
  };
  const runSuite = async (id) => {
    const suite = suites[id];
    if (!suite || !suite.agentId) { alert("Pick an agent first."); return; }
    const rt = runtimes[suite.agentId];
    if (!rt) { alert(`No runtime for agent ${suite.agentId}.`); return; }
    setRunning(true);
    const perCase = [];
    for (const ca of (suite.cases || [])) {
      const t0 = Date.now();
      try {
        const got = await rt.chat(ca.prompt, { idleMs: 60000 });
        const pass = scoreOne(got, ca.expected, ca.mode || "contains");
        perCase.push({ id: ca.id, prompt: ca.prompt, got, expected: ca.expected, pass, latency: Date.now() - t0 });
      } catch (e) {
        perCase.push({ id: ca.id, prompt: ca.prompt, got: `Error: ${e.message || e}`, expected: ca.expected, pass: false, latency: Date.now() - t0 });
      }
    }
    setCfg({ lastResults: { ...results, [id]: { ts: Date.now(), perCase } } });
    setRunning(false);
  };

  const suiteIds = Object.keys(suites);
  const cur = activeSuite ? suites[activeSuite] : null;
  const curResult = activeSuite ? results[activeSuite] : null;
  const passCount = curResult ? curResult.perCase.filter(c => c.pass).length : 0;

  return (
    <div style={{ marginTop: 28, paddingTop: 18, borderTop: `2px solid ${c.ink}` }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", marginBottom: 4 }}>
        <Icon name={open ? "chevD" : "chevR"} size={12} color="#8a7c63" />
        <h3 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700 }}>Eval harness</h3>
        <span style={{ fontSize: 11, color: "#8a7c63", marginLeft: "auto" }}>{suiteIds.length} suite{suiteIds.length===1?"":"s"}</span>
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={styles.vaultInfo}>Run N prompts against an agent and check the replies. Modes: <strong>contains</strong> (case-insensitive substring), <strong>exact</strong> (trimmed), <strong>regex</strong> (case-insensitive).</div>
          <div style={{ display: "flex", gap: 8, padding: "0 16px", flexWrap: "wrap" }}>
            {suiteIds.map(id => (
              <button key={id} onClick={() => setActiveSuite(id)}
                style={{ ...styles.toolBulkBtn, ...(activeSuite === id ? { background: c.ink, color: c.paper, borderColor: c.ink } : {}) }}>{suites[id].name || "(untitled)"}</button>
            ))}
            <button onClick={newSuite} style={styles.toolBulkBtn}>+ New suite</button>
          </div>
          {cur && (
            <div style={{ padding: 12, margin: "0 16px", background: c.paper2, borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input value={cur.name || ""} onChange={e => updateSuite(cur.id, { name: e.target.value })}
                  style={{ ...styles.field, flex: 1, fontSize: 13, padding: 6, fontWeight: 700 }} />
                <select value={cur.agentId || ""} onChange={e => updateSuite(cur.id, { agentId: e.target.value })}
                  style={{ ...styles.field, width: 170, fontSize: 12, ...(cur.agentId && !agents.find(a => a.id === cur.agentId) ? { borderColor: c.rust, color: c.rust } : {}) }}>
                  <option value="">— pick agent —</option>
                  {/* L3: if the stored agentId no longer exists (agent deleted),
                      surface a disabled "(missing agent — pick another)" option
                      so the corruption is visible instead of silently falling
                      back to the placeholder. */}
                  {cur.agentId && !agents.find(a => a.id === cur.agentId) && (
                    <option value={cur.agentId} disabled>⚠ {cur.agentId} (missing agent — pick another)</option>
                  )}
                  {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button onClick={() => runSuite(cur.id)} disabled={running || !cur.agentId || !(cur.cases || []).length}
                  style={{ ...styles.primaryBtn, opacity: running ? 0.6 : 1 }}>{running ? "Running…" : `Run (${(cur.cases || []).length})`}</button>
                <button onClick={() => { if (confirm(`Delete suite "${cur.name}"?`)) removeSuite(cur.id); }}
                  style={{ ...styles.toolBulkBtn, color: c.rust, borderColor: c.rust }}>Delete suite</button>
              </div>
              {(cur.cases || []).map(ca => {
                const rc = curResult?.perCase.find(p => p.id === ca.id);
                return (
                  <div key={ca.id} style={{ display: "flex", flexDirection: "column", gap: 4, padding: 6, background: c.paper, borderRadius: 6, border: borderLight }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <select value={ca.mode || "contains"} onChange={e => updateCase(cur.id, ca.id, { mode: e.target.value })}
                        style={{ ...styles.field, width: 90, fontSize: 11, padding: 4 }}>
                        <option value="contains">contains</option>
                        <option value="exact">exact</option>
                        <option value="regex">regex</option>
                      </select>
                      {rc && <span style={{ fontSize: 11, color: rc.pass ? c.moss : c.rust, fontWeight: 700 }}>{rc.pass ? "PASS" : "FAIL"} · {rc.latency}ms</span>}
                      <button onClick={() => removeCase(cur.id, ca.id)} style={{ ...styles.headerIconBtn, marginLeft: "auto", padding: 4 }}><Icon name="x" size={11} /></button>
                    </div>
                    <textarea value={ca.prompt || ""} placeholder="Prompt sent to agent"
                      onChange={e => updateCase(cur.id, ca.id, { prompt: e.target.value })}
                      style={{ ...styles.field, fontSize: 11, fontFamily: fonts.mono, padding: 6, minHeight: 40, resize: "vertical" }} />
                    <textarea value={ca.expected || ""} placeholder="Expected (substring / regex / exact)"
                      onChange={e => updateCase(cur.id, ca.id, { expected: e.target.value })}
                      style={{ ...styles.field, fontSize: 11, fontFamily: fonts.mono, padding: 6, minHeight: 30, resize: "vertical" }} />
                    {rc && !rc.pass && (
                      <pre style={{ fontSize: 10.5, fontFamily: fonts.mono, color: "#5a5244", whiteSpace: "pre-wrap", margin: 0, maxHeight: 100, overflow: "auto" }}>got: {String(rc.got).slice(0, 400)}</pre>
                    )}
                  </div>
                );
              })}
              <button onClick={() => addCase(cur.id)} style={{ ...styles.toolBulkBtn, alignSelf: "flex-start" }}>+ Add case</button>
              {curResult && (
                <div style={{ marginTop: 4, fontSize: 11, color: "#5a5244" }}>
                  Last run: <strong>{passCount}/{curResult.perCase.length} passed</strong> · {new Date(curResult.ts).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One-click templates for well-known MCP servers (all run via `npx -y`, which
// auto-installs on first use — no global install needed). Adding a preset just
// pre-fills a server row; the user reviews it and clicks Start.
const MCP_PRESETS = [
  { id: "everything", label: "Everything (test)", command: "npx", argsText: "-y\n@modelcontextprotocol/server-everything", hint: "Reference server with sample tools — handy for a first connection." },
  { id: "memory", label: "Memory", command: "npx", argsText: "-y\n@modelcontextprotocol/server-memory", hint: "Persistent knowledge-graph memory." },
  { id: "thinking", label: "Sequential Thinking", command: "npx", argsText: "-y\n@modelcontextprotocol/server-sequential-thinking", hint: "Structured step-by-step reasoning tool." },
  { id: "filesystem", label: "Filesystem", command: "npx", argsText: "-y\n@modelcontextprotocol/server-filesystem\n/CHANGE/ME", hint: "Add the absolute path(s) to expose as final argument(s) before Start." },
];

// ─── MCP servers: connect external Model Context Protocol tool servers ───
// Each row spawns a stdio MCP server (via the Rust side), runs the handshake,
// and registers its tools as `mcp__<id>__<tool>`. Start/Stop is live control;
// the "auto-start on launch" checkbox is the persisted preference that
// startEnabledMcpServers() reads at boot.
function McpServersSection({ onChange }) {
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const [busyUid, setBusyUid] = useState(null);
  const bump = () => setTick(t => t + 1);
  const cfg = settings.get("mcpServers") || { servers: [] };
  const servers = cfg.servers || [];
  const setCfg = (patch) => { settings.set({ mcpServers: { ...cfg, ...patch } }); bump(); onChange?.(); };
  const updateServer = (uid, patch) => setCfg({ servers: servers.map(s => s._uid === uid ? { ...s, ...patch } : s) });

  const slugify = (val) => (val || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const uniqueSlug = (base) => {
    const taken = new Set(servers.map(s => s.id));
    let i = 1, slug = base;
    while (!slug || taken.has(slug)) slug = `${base || "server"}${i++}`;
    return slug;
  };
  const addServer = () => {
    setCfg({ servers: [...servers, { _uid: newId("mcp"), id: uniqueSlug("server"), label: "", command: "", argsText: "", envText: "", enabled: false }] });
    setOpen(true);
  };
  const addPreset = (p) => {
    setCfg({ servers: [...servers, { _uid: newId("mcp"), id: uniqueSlug(p.id), label: p.label, command: p.command, argsText: p.argsText, envText: "", enabled: false }] });
    setOpen(true);
  };
  const removeServer = async (s) => { await stopMcpServer(s.id); setCfg({ servers: servers.filter(x => x._uid !== s._uid) }); };

  const parseArgs = (t) => (t || "").split("\n").map(x => x.trim()).filter(Boolean);
  const parseEnv  = (t) => { const o = {}; for (const line of (t || "").split("\n")) { const i = line.indexOf("="); if (i > 0) { const k = line.slice(0, i).trim(); if (k) o[k] = line.slice(i + 1); } } return o; };
  const dupId   = (s) => servers.some(x => x._uid !== s._uid && x.id === s.id);
  const canStart = (s) => !!(s.id && (s.command || "").trim() && !dupId(s));

  const start = async (s) => {
    setBusyUid(s._uid);
    try { await startMcpServer({ id: s.id, command: (s.command || "").trim(), args: parseArgs(s.argsText), env: parseEnv(s.envText) }); }
    catch (e) { mcpStatus[s.id] = { running: false, toolCount: 0, error: String(e?.message || e), ts: Date.now() }; }
    setBusyUid(null); bump(); onChange?.();
  };
  const stop = async (s) => { setBusyUid(s._uid); await stopMcpServer(s.id); setBusyUid(null); bump(); onChange?.(); };

  const runningCount = servers.filter(s => mcpStatus[s.id]?.running).length;

  return (
    <div style={{ marginTop: 28, paddingTop: 18, borderTop: `2px solid ${c.ink}` }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", marginBottom: 4 }}>
        <Icon name={open ? "chevD" : "chevR"} size={12} color="#8a7c63" />
        <h3 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700 }}>MCP servers</h3>
        <span style={{ fontSize: 11, color: "#8a7c63", marginLeft: "auto" }}>{servers.length} server{servers.length === 1 ? "" : "s"}{runningCount ? ` · ${runningCount} running` : ""}</span>
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={styles.vaultInfo}>
            Connect external <strong>Model Context Protocol</strong> servers (stdio transport). Discovered tools register as <code style={styles.code}>mcp__&lt;id&gt;__&lt;tool&gt;</code> and can be granted to any agent in the Agents tab, just like built-in tools. Add a preset below or a custom server, then <strong>Start</strong>.
          </div>
          <div style={{ display: "flex", gap: 6, padding: "0 16px", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#8a7c63", fontFamily: fonts.mono }}>presets:</span>
            {MCP_PRESETS.map(p => (
              <button key={p.id} onClick={() => addPreset(p)} style={styles.toolBulkBtn} title={p.hint}>+ {p.label}</button>
            ))}
          </div>
          {servers.map(s => {
            const st = mcpStatus[s.id] || {};
            const busy = busyUid === s._uid;
            return (
              <div key={s._uid} style={{ padding: 12, margin: "0 16px", background: c.paper2, borderRadius: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input value={s.id} placeholder="id" onChange={e => updateServer(s._uid, { id: slugify(e.target.value) })}
                    style={{ ...styles.field, width: 120, fontSize: 12, padding: 6, fontFamily: fonts.mono, ...(dupId(s) ? { borderColor: c.rust, color: c.rust } : {}) }} />
                  <input value={s.label || ""} placeholder="label (optional)" onChange={e => updateServer(s._uid, { label: e.target.value })}
                    style={{ ...styles.field, flex: 1, fontSize: 12, padding: 6 }} />
                  {st.running
                    ? <button onClick={() => stop(s)} disabled={busy} style={{ ...styles.toolBulkBtn, color: c.rust, borderColor: c.rust, opacity: busy ? 0.6 : 1 }}>{busy ? "…" : "Stop"}</button>
                    : <button onClick={() => start(s)} disabled={busy || !canStart(s)} style={{ ...styles.primaryBtn, opacity: (busy || !canStart(s)) ? 0.5 : 1 }}>{busy ? "Starting…" : "Start"}</button>}
                  <button onClick={() => removeServer(s)} style={{ ...styles.headerIconBtn, padding: 4 }} title="Remove server"><Icon name="x" size={11} /></button>
                </div>
                <input value={s.command} placeholder="command (e.g. npx, node, python3, uvx)" onChange={e => updateServer(s._uid, { command: e.target.value })}
                  style={{ ...styles.field, fontSize: 12, padding: 6, fontFamily: fonts.mono }} />
                <textarea value={s.argsText} placeholder="arguments — one per line" onChange={e => updateServer(s._uid, { argsText: e.target.value })}
                  style={{ ...styles.field, fontSize: 11, fontFamily: fonts.mono, padding: 6, minHeight: 36, resize: "vertical" }} />
                <textarea value={s.envText} placeholder="environment — KEY=value, one per line (optional)" onChange={e => updateServer(s._uid, { envText: e.target.value })}
                  style={{ ...styles.field, fontSize: 11, fontFamily: fonts.mono, padding: 6, minHeight: 28, resize: "vertical" }} />
                <div style={{ fontSize: 11, fontFamily: fonts.mono, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {st.running && <span style={{ color: c.moss, fontWeight: 700 }}>● running · {st.toolCount} tool{st.toolCount === 1 ? "" : "s"}</span>}
                  {!st.running && !st.error && <span style={{ color: "#8a7c63" }}>○ stopped</span>}
                  {st.error && <span style={{ color: c.rust }}>⚠ {String(st.error).slice(0, 160)}</span>}
                  <label style={{ marginLeft: "auto", display: "flex", gap: 5, alignItems: "center", color: "#5a5244", cursor: "pointer" }} title="Spawn this server automatically when yumuHub launches">
                    <input type="checkbox" checked={!!s.enabled} onChange={e => updateServer(s._uid, { enabled: e.target.checked })} style={{ accentColor: c.rust, cursor: "pointer" }} />
                    auto-start on launch
                  </label>
                </div>
              </div>
            );
          })}
          <div style={{ padding: "0 16px" }}><button onClick={addServer} style={styles.toolBulkBtn}>+ Add MCP server</button></div>
        </div>
      )}
    </div>
  );
}

function SettingsView({ onChange, agents = [], runtimes = {}, vault: v, onDirtyChange }) {
  const [form, setForm] = useState({ ...settings.current });
  const [saved, setSaved] = useState(false);
  const [uniText, setUniText] = useState(universal.text);
  const [uniSaved, setUniSaved] = useState(false);
  const [uniErr, setUniErr] = useState(null);
  const [resetBackup, setResetBackup] = useState(null);  // last pre-reset snapshot, for undo
  const resetTimerRef = useRef(null);                    // H9: track the 8s clear timer
  const [protectionOpen, setProtectionOpen] = useState(false);

  // Dirty = numeric form values differ from persisted settings, OR the
  // universal-prompt textarea has unsaved edits. Color/protection writes
  // are live-persisted so don't count.
  // M13: previously only the numeric fields were tracked, so a user could
  // type a long edit in the universal-prompt textarea (which has its own
  // Save button) and lose it on nav-away without seeing NavConfirmModal.
  const numericKeys = ["idleSec", "maxTurns", "loopLimit", "pollSec"];
  const settingsDirty = numericKeys.some(k => Number(form[k]) !== Number(settings.current[k]))
                     || (uniText !== (universal.text || ""));
  useEffect(() => { onDirtyChange?.(settingsDirty); }, [settingsDirty, onDirtyChange]);
  useEffect(() => { universal.load().then(() => setUniText(universal.text)); }, []);
  const saveUni = async () => {
    setUniErr(null);
    try { await universal.save(uniText); setUniSaved(true); setTimeout(() => setUniSaved(false), 1600); onChange?.(); }
    catch (e) { setUniErr(e.message || String(e)); }
  };
  const revealUni = async () => { try { await universal.reveal(); } catch (e) { setUniErr(e.message || String(e)); } };
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const save = () => {
    const clean = {
      idleSec:   Math.max(10,  Math.min(3600, Number(form.idleSec)   || DEFAULT_SETTINGS.idleSec)),
      maxTurns:  Math.max(1,   Math.min(200,  Number(form.maxTurns)  || DEFAULT_SETTINGS.maxTurns)),
      loopLimit: Math.max(2,   Math.min(10,   Number(form.loopLimit) || DEFAULT_SETTINGS.loopLimit)),
      pollSec:   Math.max(1,   Math.min(60,   Number(form.pollSec)   || DEFAULT_SETTINGS.pollSec)),
    };
    // Merge — don't replace — so non-numeric fields (bluntMode, colors) survive a Save click.
    settings.set(clean); setForm(f => ({ ...f, ...clean })); setSaved(true);
    setTimeout(() => setSaved(false), 1600);
    onChange?.();
  };
  const reset = () => {
    // H9: if a previous reset is still in its 8s Undo window, the user's
    // REAL pre-reset values live in resetBackup — capturing settings.current
    // again would just snapshot the defaults, silently destroying the undo.
    // Guard: keep the existing backup; just re-arm the clear timer so the
    // banner stays visible for another full 8s.
    if (resetBackup) {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => { setResetBackup(null); resetTimerRef.current = null; }, 8000);
      // Still re-apply defaults (idempotent) so the user sees the form reset.
      settings.reset();
      setForm({ ...settings.current });
      onChange?.();
      return;
    }
    const backup = JSON.parse(JSON.stringify(settings.current));
    settings.reset();
    setForm({ ...settings.current });
    setResetBackup(backup);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => { setResetBackup(null); resetTimerRef.current = null; }, 8000);
    onChange?.();
  };
  const undoReset = () => {
    if (!resetBackup) return;
    settings.set(resetBackup);
    setForm({ ...settings.current });
    setResetBackup(null);
    if (resetTimerRef.current) { clearTimeout(resetTimerRef.current); resetTimerRef.current = null; }
    onChange?.();
  };
  const toggleProtection = (key) => {
    const cur = settings.get("protection") || {};
    const nextVal = !cur[key];
    settings.set({ protection: { ...cur, [key]: nextVal } });
    setForm(f => ({ ...f, protection: { ...(f.protection || {}), [key]: nextVal } }));
    onChange?.();
  };
  const clearDismissedNotices = () => { settings.set({ dismissedNotices: [] }); setForm(f => ({ ...f, dismissedNotices: [] })); onChange?.(); };

  const row = (label, key, min, max, suffix, hint) => (
    <div style={styles.settingsRow}>
      <div style={styles.settingsLabel}>
        <div style={styles.settingsLabelTitle}>{label}</div>
        <div style={styles.settingsLabelHint}>{hint}</div>
      </div>
      <div style={styles.settingsControl}>
        <input type="number" min={min} max={max} value={form[key]}
          onChange={e => set(key, e.target.value)} style={styles.settingsInput} />
        <span style={styles.settingsSuffix}>{suffix}</span>
      </div>
    </div>
  );

  return (
    <div style={styles.panel}>
      <div style={styles.panelHeader} data-tauri-drag-region>
        <h2 style={styles.panelTitle}><Icon name="settings" size={22} /> Settings</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={reset} style={styles.clearBtn}>Reset defaults</button>
          <button onClick={save} style={{ ...styles.primaryBtn, ...(saved ? { background: c.moss } : {}) }}>
            {saved ? "✓ Saved" : "Save"}
          </button>
        </div>
      </div>
      <div style={styles.vaultInfo}>
        Tunes the agent runtime. Changes apply to the <strong>next</strong> chat — in-flight calls keep their original values.
      </div>

      {resetBackup && (
        <div style={{ margin: "10px 16px", padding: "10px 14px", background: "rgba(74,90,58,0.08)", border: `1px solid ${c.moss}`, borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: c.moss, fontWeight: 700 }}>✓</span>
          <span style={{ fontSize: 12, color: "#5a5244" }}>Settings reset to defaults.</span>
          <button onClick={undoReset} style={{ ...styles.toolBulkBtn, marginLeft: "auto", borderColor: c.moss, color: c.moss }}>Undo</button>
        </div>
      )}
      {row("Idle timeout",  "idleSec",   10, 3600, "seconds", "Abort a chat if no token / tool / iteration activity for this long.")}
      {row("Max turns",     "maxTurns",  1,  200,  "iterations", "Cap on tool-call loops per chat. Higher = more autonomy, slower failures.")}
      {row("Loop threshold","loopLimit", 2,  10,   "repeats", "If the same tool call set repeats this many times, inject a [LOOP DETECTED] hint.")}
      {row("Inbox poll",    "pollSec",   1,  60,   "seconds", "How often to check ~/yumuhub-inbox.json. Lower = snappier, more CPU.")}

      <div style={styles.settingsRow}>
        <div style={styles.settingsLabel}>
          <div style={styles.settingsLabelTitle}>Blunt mode (global default)</div>
          <div style={styles.settingsLabelHint}>Strip social_context + politeness weights. No throat-clearing, no padding closings, no "as an AI" disclaimers. Per-agent setting in the Agent Editor overrides this — Media Studio is opted out, for example. Takes effect on the next chat turn.</div>
        </div>
        <div style={styles.settingsControl}>
          <input type="checkbox" checked={form.bluntMode !== false}
            onChange={e => {
              const v = e.target.checked;
              setForm(f => ({ ...f, bluntMode: v }));
              settings.set({ bluntMode: v });
              onChange?.();
            }}
            style={{ width: 18, height: 18, accentColor: c.rust, cursor: "pointer" }} />
          <span style={styles.settingsSuffix}>{form.bluntMode !== false ? "ON" : "OFF"}</span>
        </div>
      </div>

      <div style={styles.settingsRow}>
        <div style={styles.settingsLabel}>
          <div style={styles.settingsLabelTitle}>On ↻ Handoff</div>
          <div style={styles.settingsLabelHint}>What happens to the current chat when you click Handoff. <strong>Archive</strong> (default) preserves it under "Show archived". <strong>Delete</strong> removes it permanently. <strong>Keep in place</strong> rewrites history without creating a new chat.</div>
        </div>
        <div style={styles.settingsControl}>
          <select value={form.handoffMode || DEFAULT_SETTINGS.handoffMode}
            onChange={e => { const v = e.target.value; setForm(f => ({ ...f, handoffMode: v })); settings.set({ handoffMode: v }); onChange?.(); }}
            style={{ ...styles.settingsInput, width: 160, textAlign: "left", fontSize: 12 }}>
            <option value="archive">Archive (default)</option>
            <option value="delete">Delete</option>
            <option value="keep">Keep in place</option>
          </select>
        </div>
      </div>

      <div style={styles.settingsRow}>
        <div style={styles.settingsLabel}>
          <div style={styles.settingsLabelTitle}>Auto-purge archived chats</div>
          <div style={styles.settingsLabelHint}>Permanently delete archived chats older than N days. Tick "Never" to keep them forever.</div>
        </div>
        <div style={{ ...styles.settingsControl, gap: 10 }}>
          <input type="number" min={1} max={365}
            value={form.archivePurgeDays ?? ""}
            disabled={form.archivePurgeDays === null}
            onChange={e => {
              const v = Math.max(1, Math.min(365, Number(e.target.value) || DEFAULT_SETTINGS.archivePurgeDays));
              setForm(f => ({ ...f, archivePurgeDays: v }));
              settings.set({ archivePurgeDays: v });
              onChange?.();
            }}
            style={{ ...styles.settingsInput, width: 64 }} />
          <span style={styles.settingsSuffix}>days</span>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#5a5244", marginLeft: 10 }}>
            <input type="checkbox"
              checked={form.archivePurgeDays === null}
              onChange={e => {
                const v = e.target.checked ? null : DEFAULT_SETTINGS.archivePurgeDays;
                setForm(f => ({ ...f, archivePurgeDays: v }));
                settings.set({ archivePurgeDays: v });
                onChange?.();
              }}
              style={{ accentColor: c.rust }} />
            Never
          </label>
        </div>
      </div>

      {(() => {
        const colorRow = (title, hint, key, noDivider) => (
          <div style={{ ...styles.settingsRow, padding: "8px 0 8px 12px", ...(noDivider ? { borderBottom: "none", paddingBottom: 4 } : {}) }}>
            <div style={styles.settingsLabel}>
              <div style={{ ...styles.settingsLabelTitle, fontSize: 12.5 }}>{title}</div>
              <div style={styles.settingsLabelHint}>{hint}</div>
            </div>
            <div style={styles.settingsControl}>
              <input type="color" value={form.colors?.[key] || DEFAULT_SETTINGS.colors[key]}
                onChange={e => { const val = e.target.value; setForm(f => ({ ...f, colors: { ...(f.colors||{}), [key]: val } })); settings.set({ colors: { [key]: val } }); onChange?.(); }}
                style={{ width: 44, height: 28, border: borderLight, borderRadius: 6, padding: 2, cursor: "pointer", background: c.paper2 }} />
              <span style={styles.settingsSuffix}>{form.colors?.[key] || DEFAULT_SETTINGS.colors[key]}</span>
            </div>
          </div>
        );
        const subLabel = (text) => (
          <div style={{ marginTop: 10, marginBottom: 0, fontFamily: fonts.mono, fontSize: 9, fontWeight: 700, letterSpacing: 1, color: "#a89a7e", textTransform: "uppercase", paddingLeft: 12 }}>{text}</div>
        );
        return (
          <>
            <div style={{ marginTop: 18, marginBottom: 4, fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: "#8a7c63", textTransform: "uppercase" }}>Status indication</div>
            {subLabel("Notifications")}
            {colorRow("Unread chat", "Dot shown on a chat in the sidebar when the responder replied but you haven't opened the chat yet.", "unread")}
            {subLabel("Agent status")}
            {colorRow("Idle", "Agent ready to receive messages.", "agentIdle", true)}
            {colorRow("Busy", "Agent currently working on a reply.", "agentBusy")}
            {subLabel("Vault key load")}
            {colorRow("Unused (hollow dot)", "Key has no agents bound to it.", "vaultUnused", true)}
            {colorRow("1 agent", "Healthy — one agent on the key.", "vaultOne", true)}
            {colorRow("2–3 agents", "Rare — multiple agents share the key.", "vaultMany", true)}
            {colorRow("4+ agents (overloaded)", "Should never happen — too many agents on one key.", "vaultOverloaded")}
          </>
        );
      })()}

      <CcrSection onChange={onChange} vault={v} agents={agents} />

      <ModelSelectionSection onChange={onChange} vault={v} />

      <div style={{ marginTop: 28, paddingTop: 18, borderTop: `2px solid ${c.ink}` }}>
        <div onClick={() => setProtectionOpen(o => !o)}
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", marginBottom: 4 }}>
          <Icon name={protectionOpen ? "chevD" : "chevR"} size={12} color="#8a7c63" />
          <h3 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700 }}>Protection &amp; undo</h3>
          <span style={{ fontSize: 11, color: "#8a7c63", marginLeft: "auto" }}>Confirmations, soft-deletes, and undo behaviors</span>
        </div>
        {protectionOpen && (() => {
          const prot = form.protection || {};
          const toggleRow = (title, hint, key) => (
            <div style={styles.settingsRow}>
              <div style={styles.settingsLabel}>
                <div style={styles.settingsLabelTitle}>{title}</div>
                <div style={styles.settingsLabelHint}>{hint}</div>
              </div>
              <div style={styles.settingsControl}>
                <input type="checkbox" checked={!!prot[key]}
                  onChange={() => toggleProtection(key)}
                  style={{ width: 18, height: 18, accentColor: c.rust, cursor: "pointer" }} />
                <span style={styles.settingsSuffix}>{prot[key] ? "ON" : "OFF"}</span>
              </div>
            </div>
          );
          const dismissedCount = (form.dismissedNotices || []).length;
          return (
            <>
              {toggleRow("Double-click to delete vault keys", "Require a second click on the trash icon before a vault key is moved to the deletion drawer.", "doubleClickVaultDelete")}
              {toggleRow("Warn when leaving Settings with unsaved changes", "Show a prompt before navigating away if Settings has changes you haven't saved. (Notice respects 'never show again'.)", "exitWithoutSavingNotice")}
              {toggleRow("Double-click to clear Action Log", "Require a second click on the Action Log's trash icon before entries are moved to the archived bucket.", "doubleClickActionLogClear")}
              <div style={styles.settingsRow}>
                <div style={styles.settingsLabel}>
                  <div style={styles.settingsLabelTitle}>Dismissed notices</div>
                  <div style={styles.settingsLabelHint}>{dismissedCount} notice{dismissedCount===1?"":"s"} permanently hidden via "Never show again". Re-enable them all here.</div>
                </div>
                <div style={styles.settingsControl}>
                  <button onClick={clearDismissedNotices} disabled={dismissedCount === 0}
                    style={{ ...styles.toolBulkBtn, opacity: dismissedCount === 0 ? 0.4 : 1 }}>Re-show all dismissed notices</button>
                </div>
              </div>
            </>
          );
        })()}
      </div>

      <ObservabilitySection agents={agents} onChange={onChange} />

      <GuardrailsSection onChange={onChange} agents={agents} runtimes={runtimes} />

      <DiskPersistenceSection onChange={onChange} />

      <EvalHarnessSection agents={agents} runtimes={runtimes} onChange={onChange} />

      <McpServersSection onChange={onChange} />

      <div style={{ marginTop: 28, paddingTop: 18, borderTop: `2px solid ${c.ink}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <h3 style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: 700 }}>Universal system prompt</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={revealUni} style={styles.clearBtn} title="Open ~/yumuHub.md in Finder">Open in Finder</button>
            <button onClick={saveUni} style={{ ...styles.primaryBtn, ...(uniSaved ? { background: c.moss } : {}) }}>
              {uniSaved ? "✓ Saved" : "Save"}
            </button>
          </div>
        </div>
        <div style={styles.vaultInfo}>
          Prepended to <strong>every</strong> agent's system prompt (unless the call uses a fully-explicit override like Self-Diagnose). Stored at <code style={styles.code}>~/yumuHub.md</code> — editable from this textarea, the CLI, or any editor.
        </div>
        <textarea value={uniText} onChange={e => setUniText(e.target.value)}
          style={{ ...styles.field, minHeight: 220, resize: "vertical", fontFamily: fonts.mono, fontSize: 12 }}
          placeholder={"# Project context\\n- I'm working on yumuHub at ~/yumuhub\\n- The CODEMAP.md has a line-range index of the source\\n\\n# Conventions\\n- prefer small, surgical edits"} />
        {uniErr && <div style={styles.errorBanner}>⚠ {uniErr}</div>}
      </div>

      <ImproveSourceSection agents={agents} runtimes={runtimes} />
    </div>
  );
}

// ─── Error Boundary ───
class ViewBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) return (
      <div style={{ padding: 32, fontFamily: "monospace", fontSize: 13, color: "#c0461f" }}>
        <p><strong>Render error</strong> — click a session in the sidebar to recover.</p>
        <pre style={{ whiteSpace: "pre-wrap", marginTop: 8, color: "#5a5244" }}>{String(this.state.err)}</pre>
        <button onClick={() => this.setState({ err: null })} style={{ marginTop: 12, padding: "6px 14px", cursor: "pointer" }}>Retry</button>
      </div>
    );
    return this.props.children;
  }
}

// ─── APP ───
export default function YumuHub() {
  // One-shot migration of any legacy per-agent histories into the registry, then
  // pick an initial active chat (saved across sessions if possible).
  registry.migrateFromLegacy(DEFAULT_AGENTS);
  const _saved = persist.loadActive();
  const _initialChatId = (_saved.chatId && registry.getChat(_saved.chatId)?.id) || registry.chats[0]?.id || null;
  const [sidebarCollapsed, setSidebarCollapsed]   = useState(!!_saved.sidebarCollapsed);
  const [paletteOpen, setPaletteOpen]             = useState(false);
  // Holds the latest closures for global keyboard shortcuts, refreshed every
  // render just before the return. Lets the once-registered keydown listener
  // call current handlers without going stale (it has an empty dep array).
  const kbdRef = useRef({});

  const [state, dispatch] = useReducer(appReducer, {
    agents: DEFAULT_AGENTS,
    activeAgentId: DEFAULT_AGENTS[0].id,
    activeChatId: _initialChatId,
    view: "chat",
    runtimes: {},
    tick: 0,
  });

  const runtimesRef = useRef({});
  const agentsRef   = useRef(state.agents);

  useEffect(() => { agentsRef.current = state.agents; }, [state.agents]);

  // Wire pluginHost callbacks once
  useEffect(() => {
    pluginHost.setRuntimeRef(runtimesRef);
    pluginHost.setAgentListProvider(() => agentsRef.current);
    pluginHost.setSpawnCallback(async (childConfig) => {
      const rt = new AgentRuntime(childConfig, vault, bus, providers, pluginHost, registry);
      rt.onChange(() => dispatch({ type: "TICK" }));
      runtimesRef.current[childConfig.id] = rt;
      const newAgents = [...agentsRef.current, childConfig];
      agentsRef.current = newAgents;
      dispatch({ type: "SET_AGENTS", agents: newAgents });
      // Don't persist ephemeral children — they're throwaway sub-agents.
      persist.saveAgents(newAgents.filter(a => !a.ephemeral));
    });
    pluginHost.setRemoveCallback(async (agentId) => {
      const target = agentsRef.current.find(a => a.id === agentId);
      if (!target) return;
      const rt = runtimesRef.current[agentId];
      if (rt) { try { rt.destroy(); } catch {} delete runtimesRef.current[agentId]; }
      // No per-agent message store anymore — histories are per-chat (registry).
      const newAgents = agentsRef.current.filter(a => a.id !== agentId);
      agentsRef.current = newAgents;
      dispatch({ type: "SET_AGENTS", agents: newAgents });
      persist.saveAgents(newAgents.filter(a => !a.ephemeral));
    });
    pluginHost.setUpdateCallback(async (agentId, patch) => {
      const idx = agentsRef.current.findIndex(a => a.id === agentId);
      if (idx < 0) return;
      // Snapshot pre-change config for rollback (LLM-driven configure_agent call).
      agentVersions.snapshot(agentId, agentsRef.current[idx], "configure_agent");
      const updated = { ...agentsRef.current[idx], ...patch };
      const newAgents = [...agentsRef.current.slice(0, idx), updated, ...agentsRef.current.slice(idx + 1)];
      agentsRef.current = newAgents;
      // Mutate the live runtime's config in place so it picks up new tools/model
      // on the next turn without needing a destroy/recreate cycle.
      const rt = runtimesRef.current[agentId];
      if (rt) rt.config = updated;
      dispatch({ type: "SET_AGENTS", agents: newAgents });
      persist.saveAgents(newAgents.filter(a => !a.ephemeral));
    });
  }, []); // eslint-disable-line

  // Global keyboard shortcuts. Registered once; reads live handlers off kbdRef
  // so it never goes stale. ⌘K palette · ⌘N new chat · Esc close/stop.
  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen(o => !o);
      } else if (meta && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        kbdRef.current.newChat?.();
      } else if (e.key === "Escape") {
        // Palette owns Esc while open (it closes itself). Otherwise Esc
        // cancels the in-flight generation in the active chat, if any.
        if (kbdRef.current.paletteOpen) return;
        kbdRef.current.stopActive?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Subscribe to registry changes so the UI re-renders when chats/projects mutate
  useEffect(() => registry.onChange(() => dispatch({ type: "TICK" })), []);
  useEffect(() => actionLog.onChange(() => dispatch({ type: "TICK" })), []);

  // Load yumuHub.md from disk on launch (file is the source of truth — overrides any cached copy)
  useEffect(() => { universal.load().then(() => dispatch({ type: "TICK" })); }, []);

  // Start any enabled MCP servers on launch, then re-render so their tools
  // show up in the Tools view / agent editors.
  useEffect(() => { startEnabledMcpServers().then(() => dispatch({ type: "TICK" })); }, []);

  // Auto-purge archived chats older than archivePurgeDays. Run once on launch + hourly.
  useEffect(() => {
    const sweep = () => {
      const days = settings.get("archivePurgeDays");
      if (days == null) return;  // "Never"
      const removed = registry.purgeOldArchived(days);
      if (removed > 0 && state.activeChatId && !registry.getChat(state.activeChatId)) {
        dispatch({ type: "SET_ACTIVE_CHAT", id: registry.chats[0]?.id || null });
      }
    };
    sweep();
    const h = setInterval(sweep, 3600 * 1000);
    return () => clearInterval(h);
  }, []); // eslint-disable-line

  // H7: on launch, sweep the disk-mirror directory for orphan chat backups
  // (chats that were deleted while the per-event chat_backup_delete hook
  // didn't run — e.g. a previous version of the app, or a manual
  // localStorage clear). Best-effort, fire-and-forget.
  useEffect(() => {
    chatBackup.sweepOrphans(registry.chats.map(c => c.id));
  }, []); // eslint-disable-line

  // Persist activeChatId + sidebar-collapse state. Mark the chat as "seen"
  // so unread highlighting clears. No more loadChat() — runtimes hydrate
  // the chat's slot lazily on the first runtime.chat(..., chatId) call,
  // and ChatView reads via runtime.getHistory(chat.id).
  useEffect(() => {
    persist.saveActive({ chatId: state.activeChatId, sidebarCollapsed });
    const chat = state.activeChatId ? registry.getChat(state.activeChatId) : null;
    if (chat) registry.updateChat(chat.id, { lastSeen: Date.now() });
  }, [state.activeChatId, state.agents, sidebarCollapsed]);

  // Sync runtimes with agents
  useEffect(() => {
    const cur = runtimesRef.current;
    const ids  = new Set(state.agents.map(a => a.id));
    Object.keys(cur).forEach(id => { if (!ids.has(id)) { cur[id].destroy(); delete cur[id]; } });
    state.agents.forEach(a => {
      if (!cur[a.id]) {
        cur[a.id] = new AgentRuntime(a, vault, bus, providers, pluginHost, registry);
        cur[a.id].onChange(() => dispatch({ type: "TICK" }));
      } else {
        cur[a.id].config = a;
      }
    });
    dispatch({ type: "SET_RUNTIMES", runtimes: { ...cur } });
  }, [state.agents]);

  // Inbox poller — reads ~/yumuhub-inbox.json every 2s, routes messages into agents.
  // Per-agent serial queue so two incoming messages for the same agent don't race
  // against each other's history mutations. Replies are appended to ~/yumuhub-outbox.jsonl
  // for headless testing (one JSON line per reply).
  useEffect(() => {
    if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) return;
    let stopped = false;
    // Opt-in inbox diagnostics → ~/yumuhub-debug.log. Turn on in devtools:
    //   localStorage.setItem("yumuhub:debug", "1")  (then reload)
    const debugOn = (() => { try { return !!localStorage.getItem("yumuhub:debug"); } catch { return false; } })();
    const dbg = debugOn ? (s) => { invokeTauri("debug_log", { line: s }).catch(() => {}); } : () => {};
    dbg("[poller] starting");
    // Per-CHAT serial queue: messages for the same chat process sequentially.
    const queues = {};  // chatId -> Promise chain

    // Resolve {chat, runtime} from either a chat_id or an agent_id.
    // Creates a chat on demand if only an agent_id is given and the agent has none.
    const resolveTarget = (chatIdHint, agentIdHint) => {
      let chat = chatIdHint ? registry.getChat(chatIdHint) : null;
      if (!chat && agentIdHint) {
        chat = registry.chats
          .filter(c => !c.archived && c.responder === agentIdHint)
          .sort((a, b) => b.lastActivity - a.lastActivity)[0] || null;
        if (!chat) chat = registry.createChat({ title: "New chat (from inbox)", members: [agentIdHint], responder: agentIdHint });
      }
      const rt = chat?.responder ? runtimesRef.current[chat.responder] : null;
      return { chat, rt };
    };

    const enqueue = (chatIdHint, agentIdHint, content) => {
      const { chat, rt } = resolveTarget(chatIdHint, agentIdHint);
      const queueKey = chat?.id || `noop:${agentIdHint || "?"}:${Date.now()}`;
      dbg(`[enqueue] chat=${chat?.id} responder=${chat?.responder} rt=${!!rt}`);
      const writeOut = (reply, error) => invokeTauri("outbox_append", { line: JSON.stringify({
        chat_id: chat?.id || null, agent_id: chat?.responder || agentIdHint || null,
        ts: Date.now(), content, reply: reply ?? null, error: error ?? null,
      }) }).catch(e => dbg(`[outbox-err] ${e?.message||e}`));

      if (!chat || !rt) { writeOut(null, !chat ? "no chat could be resolved" : "chat has no responder agent"); return; }

      const prev = queues[queueKey] || Promise.resolve();
      const next = prev.then(async () => {
        actionLog.startHarness(chat.responder);
        let reply, error;
        try { reply = await rt.chat(content, { chatId: chat.id }); dbg(`[chat-done] ${chat.id} replyLen=${(reply||"").length}`); }
        catch (e) { error = e.message || String(e); dbg(`[chat-err] ${chat.id} ${error}`); }
        await writeOut(reply, error);
      });
      queues[queueKey] = next.catch((e) => { dbg(`[queue-poisoned] ${queueKey} ${e?.message||e}`); });
    };

    const tick = async () => {
      try {
        const raw = await invokeTauri("inbox_pop");
        if (raw && raw !== "[]") {
          dbg(`[inbox-pop] raw=${raw.slice(0,120)}`);
          const msgs = JSON.parse(raw);
          if (Array.isArray(msgs)) {
            for (const m of msgs) {
              const chatId  = m.chat_id  || m.chatId  || null;
              const agentId = m.agent_id || m.agentId || null;
              const content = m.content  || m.message || null;
              if ((!chatId && !agentId) || !content) { dbg(`[skip-msg] chat=${chatId} agent=${agentId} content=${!!content}`); continue; }
              enqueue(chatId, agentId, content);
            }
          }
        }
      } catch (e) {
        dbg(`[tick-err] ${e?.message||e}`);
      }
      if (!stopped) setTimeout(tick, Math.max(500, (settings.get("pollSec") || 2) * 1000));
    };
    tick();
    return () => { stopped = true; };
  }, []);

  const [editing, setEditing] = useState(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const editingRef = useRef(null);
  const editorDirtyRef = useRef(false);
  editingRef.current = editing;
  editorDirtyRef.current = editorDirty;
  const maybeCloseEditor = useCallback(() => {
    if (editingRef.current && !editorDirtyRef.current) {
      setEditing(null);
      setEditorDirty(false);
    }
  }, []);

  // Settings dirty-state guard: when user has unsaved Settings changes and the
  // exit-without-saving notice is enabled, intercept navigation with a confirm.
  const [settingsDirty, setSettingsDirty] = useState(false);
  const settingsDirtyRef = useRef(false);
  settingsDirtyRef.current = settingsDirty;
  const [navConfirm, setNavConfirm] = useState(null);  // { action: fn } | null
  const navGuard = useCallback((action) => {
    if (state.view !== "settings") { action(); return; }
    if (!settingsDirtyRef.current) { action(); return; }
    const prot = settings.get("protection") || {};
    if (!prot.exitWithoutSavingNotice) { action(); return; }
    if (noticeIsDismissed("exit-without-saving:settings")) { action(); return; }
    setNavConfirm({ action });
  }, [state.view]);

  const saveAgent = useCallback((form) => {
    // Snapshot the OLD config before overwriting so the user can roll back.
    const prev = state.agents.find(a => a.id === form.id);
    if (prev) agentVersions.snapshot(form.id, prev, "edit");
    const newAgents = prev
      ? state.agents.map(a => a.id === form.id ? form : a)
      : [...state.agents, form];
    dispatch({ type: "SET_AGENTS", agents: newAgents });
    persist.saveAgents(newAgents);
    setEditing(null);
    setEditorDirty(false);
    if (runtimesRef.current[form.id]) {
      runtimesRef.current[form.id].config = form;
      runtimesRef.current[form.id].notify();
    }
  }, [state.agents]);

  const deleteAgent = useCallback((id) => {
    const newAgents = state.agents.filter(a => a.id !== id);
    dispatch({ type: "SET_AGENTS", agents: newAgents });
    persist.saveAgents(newAgents);
    if (state.activeAgentId === id) dispatch({ type: "SET_ACTIVE", id: newAgents[0]?.id });
    setEditing(null);
    setEditorDirty(false);
  }, [state.agents, state.activeAgentId]);

  // Draft chat = view is "chat" but no registry entry exists yet. Becomes a
  // real chat (and a sidebar entry) only when the user actually sends a message.
  const [draftResponder, setDraftResponder] = useState(null);

  const activeAgent   = state.agents.find(a => a.id === state.activeAgentId);
  const activeChat    = state.activeChatId ? registry.getChat(state.activeChatId) : null;
  const responderRuntime = activeChat?.responder
    ? runtimesRef.current[activeChat.responder]
    : (draftResponder ? runtimesRef.current[draftResponder] : null);
  const selectChat    = (chatId) => navGuard(() => { maybeCloseEditor(); setDraftResponder(null); dispatch({ type: "SET_ACTIVE_CHAT", id: chatId }); });

  const startDraftChat = () => navGuard(() => {
    maybeCloseEditor();
    const responder = pickDefaultResponder(state.agents);
    // No need to clear anything on the runtime: ChatView reads per-chat
    // slots via runtime.getHistory(chat.id), and with no chat selected
    // the draft view renders empty regardless of other slots' state.
    setDraftResponder(responder);
    dispatch({ type: "SET_ACTIVE_CHAT", id: null });
    dispatch({ type: "SET_VIEW", view: "chat" });
  });
  // + Chat button: skip draft mode, create a real chat immediately and switch to it.
  const createNewChat = () => navGuard(() => {
    maybeCloseEditor();
    const responderId = pickDefaultResponder(state.agents);
    if (!responderId) return;
    const c = registry.createChat({ title: "New chat", members: [responderId], responder: responderId });
    setDraftResponder(null);
    dispatch({ type: "SET_ACTIVE_CHAT", id: c.id });
    dispatch({ type: "SET_VIEW", view: "chat" });
  });
  // Called from ChatView.send when promoting a draft to a real chat.
  const promoteDraft = (responderId) => {
    const r = responderId || draftResponder;
    const c = registry.createChat({ title: "New chat", members: r ? [r] : [], responder: r });
    setDraftResponder(null);
    dispatch({ type: "SET_ACTIVE_CHAT", id: c.id });
    return c;
  };

  // Sidebar click on an agent: jump to most-recent chat with that agent as responder,
  // or create one. Always switches to chat view.
  const selectAgent = (agentId) => {
    dispatch({ type: "SET_ACTIVE", id: agentId });
    dispatch({ type: "SET_VIEW", view: "chat" });
    const existing = registry.chats
      .filter(c => !c.archived && c.responder === agentId)
      .sort((a, b) => b.lastActivity - a.lastActivity)[0];
    if (existing) selectChat(existing.id);
    else {
      const c = registry.createChat({ title: "New chat", members: [agentId], responder: agentId });
      selectChat(c.id);
    }
  };

  // Refresh the live handlers the global keydown listener reads from.
  kbdRef.current = {
    newChat: createNewChat,
    paletteOpen,
    stopActive: () => {
      if (!activeChat || !responderRuntime) return;
      const s = responderRuntime.statusOf?.(activeChat.id) || "idle";
      if (s === "busy" || s.startsWith?.("tool:")) responderRuntime.abort(activeChat.id);
    },
  };

  return (
    <div style={styles.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700;9..144,900&family=Space+Mono:wght@400;700&family=Sora:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes blink { 0%,80%,100%{opacity:0} 40%{opacity:1} }
        input:focus, select:focus, textarea:focus { outline: none; border-color: #c0461f !important; }
        ::-webkit-scrollbar { width: 9px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #d4c6ad; border-radius: 3px; border-right: 3px solid transparent; background-clip: padding-box; }
        .msgActions { opacity: 0; transition: opacity 0.12s; }
        .msgRow:hover .msgActions, .msgRow:focus-within .msgActions { opacity: 1; }
        .msgActionBtn:hover, .mdCodeCopy:hover { border-color: #c0461f !important; color: #c0461f !important; }
        .msgSaveBtn:hover { filter: brightness(1.08); }
        .searchResultBtn:hover { background: rgba(192,70,31,0.06) !important; }
      `}</style>
      <Sidebar agents={state.agents} runtimes={runtimesRef.current}
        view={state.view}
        onViewChange={v => navGuard(() => { maybeCloseEditor(); dispatch({ type: "SET_VIEW", view: v }); })}
        onNewChatNav={startDraftChat}
        onNewSidebarChat={createNewChat}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(v => !v)}
        chats={registry.chats} projects={registry.projects}
        activeChatId={state.activeChatId} registry={registry}
        onOpenPalette={() => setPaletteOpen(true)}
        selectChat={selectChat} />
      <div style={styles.main}>
        <ViewBoundary key={`${state.view}:${state.activeChatId || "none"}`}>
        {editing ? (
          <AgentEditor agent={editing === "new" ? null : editing} onSave={saveAgent} onDelete={deleteAgent}
            onCancel={() => { setEditing(null); setEditorDirty(false); }} pluginHostRef={pluginHost}
            onDirtyChange={setEditorDirty}
            vault={vault} allAgents={state.agents} runtimes={runtimesRef.current} />
        ) : state.view === "chat"    ? <ChatView    chat={activeChat} runtime={responderRuntime} allAgents={state.agents} registry={registry}
                                                    draftResponder={draftResponder}
                                                    onPromoteDraft={promoteDraft}
                                                    onDraftResponderChange={setDraftResponder}
                                                    sidebarCollapsed={sidebarCollapsed}
                                                    onSelectChat={selectChat} />
          : state.view === "agents"  ? <AgentsView  agents={state.agents} onEdit={a => setEditing(a)} onNew={() => setEditing("new")} registry={registry} runtimes={runtimesRef.current} />
          : state.view === "tools"   ? <ToolsView   pluginHostRef={pluginHost} agents={state.agents} saveAgent={saveAgent} onAnyChange={() => dispatch({ type: "TICK" })} />
          : state.view === "bus"     ? <BusView     agents={state.agents} />
          : state.view === "vault"   ? <VaultView   vault={vault} agents={state.agents} />
          : state.view === "settings"? <SettingsView onChange={() => dispatch({ type: "TICK" })} agents={state.agents} runtimes={runtimesRef.current} vault={vault} onDirtyChange={setSettingsDirty} />
          : null}
        </ViewBoundary>
      </div>
      {navConfirm && (
        <NavConfirmModal
          onDiscard={() => { setSettingsDirty(false); const a = navConfirm.action; setNavConfirm(null); a(); }}
          onCancel={() => setNavConfirm(null)}
          onNeverShowAgain={() => { dismissNotice("exit-without-saving:settings"); }}
        />
      )}
      <ApprovalModal />
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          chats={registry.chats}
          agents={state.agents}
          activeChatId={state.activeChatId}
          onNewChat={createNewChat}
          onSelectChat={(id) => { selectChat(id); dispatch({ type: "SET_VIEW", view: "chat" }); }}
          onSelectAgent={selectAgent}
          onViewChange={(v) => navGuard(() => { maybeCloseEditor(); dispatch({ type: "SET_VIEW", view: v }); })}
        />
      )}
    </div>
  );
}

// Renders queued tool-approval requests as a modal. Auto-shows whenever approvalQueue has pending items.
function ApprovalModal() {
  const [, setTick] = useState(0);
  useEffect(() => approvalQueue.onChange(() => setTick(t => t + 1)), []);
  const pending = approvalQueue.list();
  if (!pending.length) return null;
  const req = pending[0];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(19,17,14,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}>
      <div style={{ background: c.paper, border: `1px solid ${c.line}`, borderRadius: 12, padding: 22, maxWidth: 520, boxShadow: "0 8px 32px rgba(19,17,14,0.3)" }}>
        <h3 style={{ fontFamily: fonts.display, fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Tool approval required</h3>
        <p style={{ fontSize: 12.5, color: "#5a5244", lineHeight: 1.5, marginBottom: 8 }}>
          <strong>{req.agentName}</strong> wants to run <code style={styles.code}>{req.toolName}</code>
          {req.chatTitle ? <> in chat <em>"{req.chatTitle}"</em></> : null}.
        </p>
        <pre style={{ fontSize: 11, fontFamily: fonts.mono, background: c.paper2, padding: 10, borderRadius: 6, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>
{JSON.stringify(req.input, null, 2)}
        </pre>
        {pending.length > 1 && <div style={{ marginTop: 8, fontSize: 11, color: "#8a7c63" }}>+{pending.length - 1} more pending</div>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button onClick={() => req.resolve("deny")} style={{ ...styles.clearBtn, borderColor: c.rust, color: c.rust }}>Deny</button>
          <button onClick={() => req.resolve("approve_session")} style={styles.clearBtn}>Approve (session)</button>
          <button onClick={() => req.resolve("approve")} style={styles.primaryBtn}>Approve once</button>
        </div>
      </div>
    </div>
  );
}

function NavConfirmModal({ onDiscard, onCancel, onNeverShowAgain }) {
  const [neverAgain, setNeverAgain] = useState(false);
  const discard = () => { if (neverAgain) onNeverShowAgain(); onDiscard(); };
  const cancel  = () => { if (neverAgain) onNeverShowAgain(); onCancel(); };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(19,17,14,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: c.paper, border: `1px solid ${c.line}`, borderRadius: 12, padding: 22, maxWidth: 420, boxShadow: "0 8px 32px rgba(19,17,14,0.3)" }}>
        <h3 style={{ fontFamily: fonts.display, fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Unsaved settings changes</h3>
        <p style={{ fontSize: 13, color: "#5a5244", lineHeight: 1.5, marginBottom: 16 }}>You have changes in Settings that haven't been saved. Leaving now will discard them.</p>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#5a5244", marginBottom: 14 }}>
          <input type="checkbox" checked={neverAgain} onChange={e => setNeverAgain(e.target.checked)} style={{ accentColor: c.rust }} />
          Never show this notice again (re-enable in Settings → Protection &amp; undo)
        </label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={cancel} style={styles.clearBtn}>Stay in Settings</button>
          <button onClick={discard} style={{ ...styles.primaryBtn, background: c.rust }}>Discard &amp; leave</button>
        </div>
      </div>
    </div>
  );
}

// ─── Command palette (⌘K) ───
// A keyboard-first fuzzy switcher over chats, agents, and navigation — the
// entry point you'd expect from ChatGPT / Claude Code / Linear / VS Code.
// Open with ⌘K (Ctrl+K), filter as you type, ↑↓ to move, ↵ to run, esc to close.
function CommandPalette({ onClose, chats, agents, activeChatId, onNewChat, onSelectChat, onSelectAgent, onViewChange }) {
  const [q, setQ]     = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef  = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Flat command list in default (no-query) priority order: actions, then
  // navigation, then agents, then chats (most-recently-active first).
  const cmds = [];
  cmds.push({ id: "act:new", kind: "Action", icon: "plus", label: "New chat", sub: "Start a fresh conversation", run: onNewChat });
  NAV_ITEMS.filter(n => n.id !== "chat").forEach(n =>
    cmds.push({ id: `nav:${n.id}`, kind: "Go to", icon: n.icon, label: n.label, sub: `Open the ${n.label} view`, run: () => onViewChange(n.id) }));
  agents.filter(a => !a.ephemeral).forEach(a =>
    cmds.push({ id: `agt:${a.id}`, kind: "Agent", icon: "bot", label: a.name, sub: `${a.provider} · ${a.model}`, run: () => onSelectAgent(a.id) }));
  chats.filter(ch => !ch.archived).sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)).forEach(ch => {
    const resp = agents.find(a => a.id === ch.responder);
    cmds.push({ id: `chat:${ch.id}`, kind: "Chat", icon: "chat", label: ch.title || "Untitled", sub: resp ? resp.name : "—", active: ch.id === activeChatId, run: () => onSelectChat(ch.id) });
  });

  const query = q.trim().toLowerCase();
  let results;
  if (!query) {
    const take = (k, n) => cmds.filter(x => x.kind === k).slice(0, n);
    results = [...cmds.filter(x => x.kind === "Action" || x.kind === "Go to"), ...take("Agent", 6), ...take("Chat", 8)];
  } else {
    // Substring match across label + subtitle; earlier matches rank higher,
    // shorter labels break ties (so an exact-ish hit beats a long incidental one).
    results = cmds
      .map(x => ({ x, i: `${x.label} ${x.sub || ""}`.toLowerCase().indexOf(query) }))
      .filter(r => r.i >= 0)
      .sort((a, b) => a.i - b.i || a.x.label.length - b.x.label.length)
      .map(r => r.x);
  }

  const clampSel = Math.min(sel, Math.max(0, results.length - 1));

  // Keep the highlighted row scrolled into view as you arrow through.
  useEffect(() => { listRef.current?.children[clampSel]?.scrollIntoView({ block: "nearest" }); }, [clampSel]);

  const exec = (cmd) => { if (!cmd) return; onClose(); cmd.run(); };

  const onKey = (e) => {
    if (e.key === "ArrowDown")    { e.preventDefault(); setSel(s => Math.min(s + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === "Enter")   { e.preventDefault(); exec(results[clampSel]); }
    else if (e.key === "Escape")  { e.preventDefault(); onClose(); }
  };

  return (
    <div style={styles.paletteOverlay} onMouseDown={onClose}>
      <div style={styles.paletteCard} onMouseDown={e => e.stopPropagation()}>
        <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
          placeholder="Search chats, agents, actions…" style={styles.paletteInput} />
        <div ref={listRef} style={styles.paletteList}>
          {results.length === 0 && <div style={styles.paletteEmpty}>No matches</div>}
          {results.map((cmd, i) => (
            <div key={cmd.id} onMouseEnter={() => setSel(i)} onMouseDown={e => { e.preventDefault(); exec(cmd); }}
              style={{ ...styles.paletteRow, ...(i === clampSel ? styles.paletteRowActive : {}) }}>
              <Icon name={cmd.icon} size={15} color={i === clampSel ? c.rust : "#8a7c63"} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.paletteRowLabel}>
                  {cmd.label}
                  {cmd.active && <span style={{ color: c.rust, fontSize: 9, marginLeft: 7, fontFamily: fonts.mono }}>● current</span>}
                </div>
                {cmd.sub && <div style={styles.paletteRowSub}>{cmd.sub}</div>}
              </div>
              <span style={styles.paletteKind}>{cmd.kind}</span>
            </div>
          ))}
        </div>
        <div style={styles.paletteFooter}>
          <span><kbd style={styles.kbd}>↑</kbd><kbd style={styles.kbd}>↓</kbd> navigate</span>
          <span><kbd style={styles.kbd}>↵</kbd> open</span>
          <span><kbd style={styles.kbd}>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

// ─── STYLES ───
const fonts = { display: "'Fraunces', serif", mono: "'Space Mono', monospace", body: "'Sora', sans-serif" };
const c = { ink: "#13110e", paper: "#f4efe6", paper2: "#ece4d6", rust: "#c0461f", rustDeep: "#962f10", moss: "#4a5a3a", gold: "#caa04a", sky: "#3d6b8a", line: "#d4c6ad" };
// Shared style fragments (extracted from the most-repeated patterns).
const borderLight  = `1px solid ${c.line}`;
const baseSmallBtn = { padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontFamily: fonts.mono, fontSize: 10, background: "none" };

const styles = {
  app:  { display: "flex", height: "100vh", background: c.paper, color: c.ink, fontFamily: fonts.body, fontSize: 14 },
  // Sidebar
  sidebar:      { width: 250, borderRight: borderLight, background: `linear-gradient(175deg, ${c.paper2}, ${c.paper})`, display: "flex", flexDirection: "column", overflow: "auto", flexShrink: 0 },
  brand:        { display: "flex", alignItems: "center", gap: 10, padding: "20px 18px 14px" },
  glyph:        { width: 32, height: 32, borderRadius: 8, background: c.ink, color: c.gold, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: fonts.mono, fontWeight: 700, fontSize: 13, boxShadow: `2px 2px 0 ${c.rust}`, flexShrink: 0 },
  brandName:    { fontFamily: fonts.display, fontSize: 20, fontWeight: 900, letterSpacing: "-0.02em", lineHeight: 1 },
  brandSub:     { fontFamily: fonts.mono, fontSize: 8.5, letterSpacing: "0.2em", color: c.rustDeep, marginTop: 2 },
  navSection:   { padding: "6px 12px" },
  navLabel:     { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: "0.16em", color: "#8a7c63", padding: "12px 8px 6px", borderTop: `1px dashed ${c.line}`, marginTop: 4 },
  navItem:      { display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "8px 10px", border: "none", background: "none", borderRadius: 7, cursor: "pointer", fontSize: 13, fontFamily: fonts.body, color: c.ink, transition: "0.15s", userSelect: "none" },
  navItemActive:{ background: c.ink, color: c.paper },
  addBtn:       { border: borderLight, background: "none", borderRadius: 5, padding: "2px 5px", cursor: "pointer", color: c.ink, display: "flex" },
  agentItem:    { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px", border: "none", background: "none", borderRadius: 7, cursor: "pointer", fontSize: 12.5, fontFamily: fonts.body, color: c.ink, transition: "0.15s" },
  agentItemActive: { background: c.ink, color: c.paper },
  statusDot:    { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
  agentName:    { flex: 1, textAlign: "left", fontWeight: 500 },
  agentProvider:{ fontFamily: fonts.mono, fontSize: 9, opacity: 0.5 },
  // Main
  main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  // Chat
  chatContainer:  { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" },
  chatHeader:     { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", borderBottom: borderLight, background: c.paper, flexShrink: 0 },
  chatHeaderLeft: { display: "flex", alignItems: "center", gap: 10 },
  chatAgentName:  { fontFamily: fonts.display, fontSize: 20, fontWeight: 700 },
  chatModel:      { fontFamily: fonts.mono, fontSize: 10, color: "#8a7c63", background: c.paper2, padding: "3px 8px", borderRadius: 12, border: borderLight },
  paletteOverlay: { position: "fixed", inset: 0, background: "rgba(19,17,14,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh", zIndex: 1200 },
  paletteCard:    { width: 580, maxWidth: "90vw", maxHeight: "70vh", display: "flex", flexDirection: "column", background: c.paper, border: `1px solid ${c.line}`, borderRadius: 14, boxShadow: "0 16px 48px rgba(19,17,14,0.32)", overflow: "hidden" },
  paletteInput:   { padding: "16px 18px", border: "none", borderBottom: borderLight, background: "none", fontFamily: fonts.body, fontSize: 15, color: c.ink },
  paletteList:    { overflowY: "auto", padding: 6, flex: 1 },
  paletteRow:     { display: "flex", alignItems: "center", gap: 11, padding: "9px 12px", borderRadius: 8, cursor: "pointer" },
  paletteRowActive:{ background: "rgba(192,70,31,0.08)" },
  paletteRowLabel:{ fontSize: 13.5, color: c.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  paletteRowSub:  { fontSize: 10.5, color: "#8a7c63", fontFamily: fonts.mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 1 },
  paletteKind:    { fontSize: 9, fontFamily: fonts.mono, color: "#8a7c63", background: c.paper2, padding: "2px 7px", borderRadius: 10, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.4 },
  paletteEmpty:   { padding: "24px 12px", textAlign: "center", color: "#8a7c63", fontSize: 12.5, fontFamily: fonts.mono },
  paletteFooter:  { display: "flex", gap: 16, padding: "9px 16px", borderTop: borderLight, fontSize: 10.5, color: "#8a7c63", fontFamily: fonts.mono, background: c.paper2 },
  kbd:            { display: "inline-block", minWidth: 16, padding: "1px 5px", marginRight: 3, border: borderLight, borderRadius: 4, background: c.paper, fontFamily: fonts.mono, fontSize: 10, textAlign: "center" },
  clearBtn:       { ...baseSmallBtn, border: borderLight, color: "#8a7c63" },
  stopBtn:        { ...baseSmallBtn, border: `1px solid ${c.rustDeep}`, background: c.rustDeep, color: c.paper, fontWeight: 700, letterSpacing: "0.04em" },
  streamCursor:   { display: "inline-block", color: c.rust, animation: "blink 1s infinite", marginLeft: 1 },
  chatMessages:   { flex: 1, overflow: "auto", padding: "24px 24px 0" },
  chatWelcome:    { textAlign: "center", padding: "60px 20px", color: "#8a7c63" },
  welcomeIcon:    { marginBottom: 16 },
  welcomeTitle:   { fontFamily: fonts.display, fontSize: 24, fontWeight: 700, color: c.ink, marginBottom: 8 },
  welcomeDesc:    { fontSize: 13, maxWidth: 400, margin: "0 auto 12px", lineHeight: 1.6 },
  welcomeHint:    { fontFamily: fonts.mono, fontSize: 11, opacity: 0.5, marginTop: 14 },
  message:        { marginBottom: 16, display: "flex" },
  messageUser:    { justifyContent: "flex-end" },
  messageAssistant: { justifyContent: "flex-start" },
  msgBubbleUser:  { background: c.ink, color: c.paper, padding: "12px 16px", borderRadius: "16px 16px 4px 16px", maxWidth: "70%", fontSize: 13.5, lineHeight: 1.6 },
  msgBubbleAssistant: { background: c.paper2, border: borderLight, padding: "12px 16px", borderRadius: "16px 16px 16px 4px", maxWidth: "72%", fontSize: 13.5, lineHeight: 1.6 },
  msgSender:      { fontFamily: fonts.mono, fontSize: 9.5, color: c.rust, letterSpacing: "0.1em", marginBottom: 4, textTransform: "uppercase" },
  msgText:        { whiteSpace: "pre-wrap", wordBreak: "break-word" },
  // Markdown rendering (assistant messages)
  msgMd:          { wordBreak: "break-word" },
  md:             { display: "flex", flexDirection: "column", gap: 8 },
  mdPara:         { margin: 0, lineHeight: 1.6 },
  mdHeading:      { fontFamily: fonts.display, fontWeight: 700, lineHeight: 1.3, margin: "2px 0", color: c.ink },
  mdList:         { margin: 0, paddingLeft: 22, display: "flex", flexDirection: "column", gap: 3 },
  mdLi:           { lineHeight: 1.55 },
  mdQuote:        { borderLeft: `3px solid ${c.rust}`, paddingLeft: 12, color: "#6b6150", fontStyle: "italic", margin: "2px 0" },
  mdHr:           { border: "none", borderTop: `1px solid ${c.line}`, margin: "4px 0" },
  mdLink:         { color: c.rust, textDecoration: "underline", wordBreak: "break-all" },
  mdInlineCode:   { fontFamily: fonts.mono, fontSize: "0.86em", background: "rgba(192,70,31,0.10)", color: c.rustDeep, padding: "1px 5px", borderRadius: 5 },
  mdCodeWrap:     { borderRadius: 8, overflow: "hidden", border: `1px solid ${c.line}`, margin: "2px 0" },
  mdCodeBar:      { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px 4px 12px", background: "#241f1a" },
  mdCodeLang:     { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: "0.1em", color: "#b6a98f", textTransform: "uppercase" },
  mdCodeCopy:     { fontFamily: fonts.mono, fontSize: 9.5, color: "#d8cdb6", background: "transparent", border: "1px solid #4a4239", borderRadius: 5, padding: "2px 9px", cursor: "pointer", letterSpacing: "0.04em", transition: "0.12s" },
  mdCodePre:      { background: c.ink, color: "#e8e0cf", padding: "10px 12px", fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0, overflow: "auto" },
  msgActions:     { display: "flex", gap: 6, marginTop: 8 },
  msgActionBtn:   { fontFamily: fonts.mono, fontSize: 9.5, color: "#8a7c63", background: "transparent", border: `1px solid ${c.line}`, borderRadius: 6, padding: "3px 9px", cursor: "pointer", letterSpacing: "0.04em", transition: "0.12s" },
  msgTime:        { fontFamily: fonts.mono, fontSize: 9.5, color: "#a89c83", alignSelf: "center", letterSpacing: "0.04em" },
  // Edit & resend (user messages)
  msgUserCol:     { display: "flex", flexDirection: "column", alignItems: "flex-end", maxWidth: "70%" },
  msgEditCol:     { display: "flex", flexDirection: "column", width: "70%" },
  msgEditArea:    { width: "100%", boxSizing: "border-box", fontFamily: fonts.body, fontSize: 13.5, lineHeight: 1.6, color: c.ink, background: c.paper2, border: `1px solid ${c.rust}`, borderRadius: 12, padding: "10px 14px", resize: "vertical" },
  msgEditBtns:    { display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 6 },
  msgEditSave:    { color: c.paper, background: c.rust, borderColor: c.rust },
  typing:         { display: "flex", gap: 5, padding: "6px 0", alignItems: "center" },
  typingDot:      { width: 7, height: 7, borderRadius: "50%", background: "#8a7c63", display: "inline-block", animation: "blink 1.2s infinite both" },
  toolStatusInline: { fontFamily: fonts.mono, fontSize: 11, color: c.rust, display: "flex", alignItems: "center", gap: 6, padding: "4px 0" },
  errorBanner:    { background: "rgba(192,70,31,0.1)", border: `1px solid ${c.rust}`, borderRadius: 8, padding: "10px 14px", fontSize: 12.5, color: c.rustDeep, marginBottom: 12, display: "flex", alignItems: "center", gap: 10 },
  errorRetryBtn:  { flexShrink: 0, fontFamily: fonts.mono, fontSize: 10, color: c.paper, background: c.rust, border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", letterSpacing: "0.04em" },
  chatInput:      { padding: "16px 24px", borderTop: borderLight, display: "flex", gap: 10, background: c.paper, flexShrink: 0, alignItems: "center" },
  attachBtn:      { width: 36, height: 36, borderRadius: 10, border: borderLight, background: c.paper2, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  attachmentBar:  { display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 24px 0", background: c.paper, borderTop: borderLight },
  attachmentChip: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 8px 5px 10px", background: "rgba(192,70,31,0.06)", border: "1px solid rgba(192,70,31,0.25)", borderRadius: 14, fontFamily: fonts.mono, fontSize: 10.5 },
  attachmentName: { color: c.ink, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  attachmentSize: { color: "#8a7c63", fontSize: 9.5 },
  attachmentX:    { border: "none", background: "none", color: c.rust, cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1 },
  textInput:      { flex: 1, padding: "12px 16px", border: borderLight, borderRadius: 12, fontSize: 14, fontFamily: fonts.body, background: c.paper2, color: c.ink, resize: "none", overflow: "hidden", lineHeight: "1.4" },
  sendBtn:        { width: 44, height: 44, borderRadius: 12, border: "none", background: c.rust, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "0.15s" },
  // ToolCallCard
  toolCard:        { background: "rgba(192,70,31,0.05)", border: "1px solid rgba(192,70,31,0.18)", borderRadius: 8, marginTop: 8, overflow: "hidden" },
  toolCardTop:     { display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", cursor: "pointer" },
  toolCardName:    { fontFamily: fonts.mono, fontSize: 11, fontWeight: 700, color: c.rust, letterSpacing: "0.04em", flex: 1 },
  toolCardBadgePending: { fontFamily: fonts.mono, fontSize: 9, color: c.gold, marginLeft: "auto" },
  toolCardBadgeDone:    { fontFamily: fonts.mono, fontSize: 9, color: c.moss, marginLeft: "auto" },
  toolCardChev:    { color: "#8a7c63", fontSize: 10, marginLeft: 4 },
  toolCardBody:    { padding: "0 10px 10px" },
  toolCardSection: { marginTop: 6 },
  toolCardLabel:   { fontFamily: fonts.mono, fontSize: 8.5, letterSpacing: "0.14em", color: "#8a7c63", marginBottom: 3, textTransform: "uppercase" },
  toolCardCode:    { background: c.ink, color: "#e8e0cf", borderRadius: 6, padding: "8px 10px", fontFamily: fonts.mono, fontSize: 10.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, maxHeight: 180, overflow: "auto" },
  // Empty
  emptyState: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#8a7c63", gap: 12, fontSize: 14 },
  // Panel
  panel:       { flex: 1, overflow: "auto", padding: "0 24px 24px" },
  panelHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 24, paddingBottom: 16, marginBottom: 8, borderBottom: `2px solid ${c.ink}`, position: "sticky", top: 0, zIndex: 10, background: c.paper },
  panelTitle:  { fontFamily: fonts.display, fontSize: 26, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 },
  primaryBtn:  { display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", border: "none", background: c.rust, color: c.paper, borderRadius: 8, cursor: "pointer", fontFamily: fonts.mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.04em" },
  // Agent grid
  agentGrid:       { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 },
  agentCard:       { background: c.paper2, border: borderLight, borderRadius: 14, padding: 20, cursor: "pointer", transition: "0.2s" },
  agentCardHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 },
  agentCardName:   { fontFamily: fonts.display, fontSize: 18, fontWeight: 600 },
  agentCardId:     { fontFamily: fonts.mono, fontSize: 9, color: "#8a7c63" },
  agentCardMeta:   { display: "flex", gap: 6, marginBottom: 10 },
  chip:            { fontFamily: fonts.mono, fontSize: 10, padding: "3px 8px", background: c.paper, border: borderLight, borderRadius: 16 },
  agentCardPrompt: { fontSize: 12.5, color: "#5a5244", lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" },
  toolList:  { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10 },
  toolChip:  { fontFamily: fonts.mono, fontSize: 9, padding: "2px 7px", background: "rgba(192,70,31,0.08)", border: "1px solid rgba(192,70,31,0.2)", borderRadius: 10, color: c.rustDeep },
  // Editor
  editorPanel:   { flex: 1, overflow: "auto", display: "flex", flexDirection: "column" },
  editorHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderBottom: borderLight },
  editorTitle:   { fontFamily: fonts.display, fontSize: 22, fontWeight: 700 },
  editorBody:    { padding: 24, maxWidth: 580 },
  fieldLabel:    { fontFamily: fonts.mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: c.rustDeep, display: "block", marginBottom: 6, marginTop: 16 },
  field:         { display: "block", width: "100%", padding: "10px 14px", border: borderLight, borderRadius: 8, fontSize: 13.5, fontFamily: fonts.body, background: c.paper2, color: c.ink },
  modelHint:     { fontSize: 11.5, color: "#6b6353", marginTop: 6, fontStyle: "italic", paddingLeft: 4 },
  // Hidden-models settings (collapsible provider groups, multi-column model grid)
  modelGroup:      { marginTop: 14, border: borderLight, borderRadius: 8, background: c.paper2, overflow: "hidden" },
  modelGroupHeader:{ display: "flex", alignItems: "center", gap: 6, padding: "10px 14px", cursor: "pointer", background: `linear-gradient(180deg, ${c.paper2}, rgba(212,198,173,0.4))`, userSelect: "none" },
  modelGroupName:  { fontFamily: fonts.display, fontSize: 14, fontWeight: 700, flex: 1, color: c.ink },
  modelGroupCount: { fontFamily: fonts.mono, fontSize: 10.5, color: "#8a7c63", letterSpacing: "0.04em" },
  modelGrid:       { padding: "10px 14px 14px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 6, background: c.paper },
  modelItem:       { display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", padding: "6px 8px", borderRadius: 5, border: `1px solid transparent`, transition: "0.1s" },
  modelItemLabel:  { fontFamily: fonts.mono, fontSize: 12, fontWeight: 600, color: c.ink },
  modelItemDesc:   { fontSize: 11, color: "#6b6353", marginTop: 2, lineHeight: 1.4 },
  editorActions: { display: "flex", gap: 10, marginTop: 28, alignItems: "center" },
  deleteBtn:     { display: "flex", alignItems: "center", gap: 5, padding: "8px 14px", border: `1px solid ${c.rust}`, background: "none", borderRadius: 8, cursor: "pointer", color: c.rust, fontSize: 12, fontFamily: fonts.body },
  cancelBtn:     { padding: "8px 16px", border: borderLight, background: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: fonts.body, color: c.ink },
  saveBtn:       { padding: "8px 20px", border: "none", background: c.rust, color: c.paper, borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: fonts.body, fontWeight: 600 },
  iconBtn:       { border: "none", background: "none", cursor: "pointer", padding: 4, display: "flex", color: c.ink },
  // Tool selection in editor
  keyPickerEmpty: { padding: "10px 14px", border: `1px dashed ${c.line}`, borderRadius: 8, fontSize: 12.5, color: "#8a7c63", background: c.paper2 },
  keyMeta:        { display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontFamily: fonts.mono, fontSize: 10.5 },
  keyMetaState:   { color: "#8a7c63" },
  keyMetaCoUse:   { color: "#a89a7e", fontStyle: "italic" },
  toolSelectList:       { display: "flex", flexDirection: "column", gap: 5, maxHeight: 230, overflow: "auto", border: borderLight, borderRadius: 8, padding: 8, background: c.paper },
  toolSelectItem:       { display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 10px", borderRadius: 7, cursor: "pointer" },
  toolSelectItemActive: { background: "rgba(192,70,31,0.06)" },
  toolSelectName:       { fontFamily: fonts.mono, fontSize: 10.5, fontWeight: 700, color: c.rustDeep, minWidth: 110, marginTop: 1 },
  toolSelectDesc:       { fontSize: 11.5, color: "#5a5244", lineHeight: 1.4 },
  toolBulkBtn:          { fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, letterSpacing: 0.5, padding: "4px 10px", border: borderLight, borderRadius: 6, background: c.paper, color: "#5a5244", cursor: "pointer" },
  toolGroupHeader:      { display: "flex", alignItems: "center", gap: 8, padding: "8px 6px", background: c.paper, borderBottom: borderLight },
  toolGroupName:        { fontFamily: fonts.mono, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: c.rustDeep, textTransform: "uppercase" },
  toolGroupCount:       { fontFamily: fonts.mono, fontSize: 10, color: "#8a7c63", marginLeft: 4 },
  // Bus
  busCompose: { background: c.paper2, border: borderLight, borderRadius: 12, padding: 16, marginBottom: 20 },
  busRow:     { display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" },
  busLabel:   { fontFamily: fonts.mono, fontSize: 9.5, color: "#8a7c63", letterSpacing: "0.1em" },
  busSelect:  { padding: "6px 10px", border: borderLight, borderRadius: 6, fontSize: 12, fontFamily: fonts.body, background: c.paper, color: c.ink },
  busLog:     { display: "flex", flexDirection: "column", gap: 8 },
  busMsg:     { background: c.paper2, border: borderLight, borderRadius: 10, padding: "12px 16px" },
  busMsgHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  busMsgFrom:   { fontFamily: fonts.mono, fontSize: 11, fontWeight: 700, color: c.sky },
  busMsgArrow:  { color: c.gold, fontSize: 13 },
  busMsgTo:     { fontFamily: fonts.mono, fontSize: 11, fontWeight: 700, color: c.moss },
  busMsgMode:   { fontFamily: fonts.mono, fontSize: 9, padding: "2px 6px", background: c.ink, color: c.gold, borderRadius: 4 },
  busMsgTime:   { fontFamily: fonts.mono, fontSize: 9, color: "#8a7c63", marginLeft: "auto" },
  busMsgBody:   { fontFamily: fonts.mono, fontSize: 11, color: "#5a5244", wordBreak: "break-all" },
  // Aquarium
  aquariumMeta:       { fontFamily: fonts.mono, fontSize: 9, color: "#8a7c63" },
  actionLogBody:      { flex: 1, overflowY: "auto", padding: "8px 14px", display: "flex", flexDirection: "column", gap: 2, fontFamily: fonts.mono, fontSize: 11, background: c.paper2, borderRadius: 10, border: borderLight, minHeight: 200 },
  actionLogEntry:     { display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 6, padding: "4px 0", borderBottom: `1px solid rgba(90,82,68,0.08)` },
  actionLogTs:        { fontSize: 9, color: "#8a7c63", minWidth: 62, flexShrink: 0 },
  actionLogKind:      { fontWeight: 700, fontSize: 9.5, minWidth: 70, flexShrink: 0 },
  actionLogPayload:   { fontFamily: fonts.mono, fontSize: 10, color: "#5a5244", whiteSpace: "pre-wrap", wordBreak: "break-all", width: "100%", margin: 0, padding: "2px 0 0 70px", background: "none" },
  // Vault
  vaultInfo: { fontSize: 13, color: "#5a5244", marginBottom: 18, lineHeight: 1.6, background: `linear-gradient(120deg, rgba(192,70,31,0.05), rgba(202,160,74,0.04))`, border: borderLight, borderLeft: `3px solid ${c.rust}`, borderRadius: "0 10px 10px 0", padding: "14px 18px" },
  code:      { fontFamily: fonts.mono, fontSize: 11.5, background: c.paper2, padding: "2px 6px", borderRadius: 4, border: borderLight },
  vaultAdd:  { display: "flex", gap: 8, marginBottom: 20, alignItems: "center", flexWrap: "wrap" },
  keyList:   { display: "flex", flexDirection: "column", gap: 8 },
  keyItem:   { display: "flex", alignItems: "center", gap: 12, background: c.paper2, border: borderLight, borderRadius: 10, padding: "10px 16px" },
  keyHandle: { fontFamily: fonts.mono, fontSize: 11.5, fontWeight: 700, flex: 1 },
  keyMask:   { fontFamily: fonts.mono, fontSize: 12, color: "#8a7c63" },
  muted:     { color: "#8a7c63", fontSize: 13 },
  // Improve UI
  improveGrid:  { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 12 },
  improveHint:  { fontSize: 13, color: "#5a5244", background: `linear-gradient(120deg, rgba(202,160,74,0.07), rgba(192,70,31,0.03))`, border: borderLight, borderLeft: `3px solid ${c.gold}`, borderRadius: "0 8px 8px 0", padding: "12px 16px", marginBottom: 12, lineHeight: 1.5 },
  diffToolbar:  { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 10, borderBottom: borderLight },
  diffContainer:{ border: borderLight, borderRadius: 10, overflow: "auto", maxHeight: 480, background: c.paper },
  diffLine:     { display: "flex", alignItems: "flex-start", padding: "2px 14px 2px 0" },
  diffPrefix:   { flexShrink: 0, width: 32, textAlign: "center", fontFamily: fonts.mono, fontSize: 11, fontWeight: 700, lineHeight: "1.6", userSelect: "none" },
  diffCode:     { flex: 1, fontFamily: fonts.mono, fontSize: 11, lineHeight: "1.6", whiteSpace: "pre-wrap", wordBreak: "break-all" },
  codeBlock:    { background: c.ink, color: "#e8e0cf", borderRadius: 10, padding: "18px 20px", overflow: "auto", fontFamily: fonts.mono, fontSize: 11, lineHeight: 1.65, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 480 },
  // Settings
  settingsRow:        { display: "flex", alignItems: "center", gap: 16, padding: "14px 0", borderBottom: `1px dashed ${c.line}` },
  settingsLabel:      { flex: 1, minWidth: 0 },
  settingsLabelTitle: { fontFamily: fonts.body, fontSize: 13.5, fontWeight: 600, color: c.ink, marginBottom: 2 },
  settingsLabelHint:  { fontFamily: fonts.body, fontSize: 11.5, color: "#8a7c63", lineHeight: 1.4 },
  settingsControl:    { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  settingsInput:      { width: 90, padding: "8px 10px", border: borderLight, borderRadius: 7, fontSize: 13, fontFamily: fonts.mono, background: c.paper2, color: c.ink, textAlign: "right" },
  settingsSuffix:     { fontFamily: fonts.mono, fontSize: 10.5, color: "#8a7c63", minWidth: 72 },
  // Handoff bubble
  handoffBubble: { background: "rgba(202,160,74,0.08)", border: `1px dashed ${c.gold}`, borderRadius: 12, padding: "12px 16px", margin: "0 0 16px", fontSize: 12.5, lineHeight: 1.55, color: "#5a5244" },
  handoffLabel:  { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: "0.14em", color: c.gold, marginBottom: 6, textTransform: "uppercase", fontWeight: 700 },
  // Drag region (Tauri overlay title bar)
  dragRegion:    { WebkitAppRegion: "drag", appRegion: "drag" },  // CSS-side hint (Tauri primarily uses data-tauri-drag-region attr)
  // ── Chat list embedded in sidebar (replaces standalone middle panel) ──
  sidebarChatSection: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, borderTop: `1px dashed ${c.line}`, marginTop: 4 },
  sidebarChatHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px 4px" },
  sidebarMiniBtn:     { padding: "3px 7px", border: borderLight, background: c.paper2, borderRadius: 5, cursor: "pointer", fontFamily: fonts.mono, fontSize: 10, color: c.ink, lineHeight: 1 },
  sidebarMiniBtnPrimary: { padding: "3px 8px", border: "none", background: c.rust, color: c.paper, borderRadius: 5, cursor: "pointer", fontFamily: fonts.mono, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.04em", lineHeight: 1 },
  sidebarChatBody:    { flex: 1, overflow: "auto", padding: "4px 6px 6px" },
  chatListEmpty:      { padding: "16px 12px", color: "#8a7c63", fontSize: 11, lineHeight: 1.5 },
  // Conversation search
  sidebarSearchWrap:  { display: "flex", alignItems: "center", gap: 6, margin: "0 10px 6px", padding: "4px 8px", background: c.paper2, border: borderLight, borderRadius: 8 },
  sidebarSearchInput: { flex: 1, minWidth: 0, border: "none", background: "transparent", fontFamily: fonts.body, fontSize: 12, color: c.ink, padding: "2px 0" },
  sidebarSearchClear: { border: "none", background: "transparent", cursor: "pointer", display: "flex", padding: 0, flexShrink: 0 },
  sidebarKbdHint:     { flexShrink: 0, border: borderLight, background: c.paper, borderRadius: 4, padding: "1px 5px", fontFamily: fonts.mono, fontSize: 9.5, color: "#8a7c63", cursor: "pointer", letterSpacing: "0.02em" },
  searchCount:        { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: "0.12em", color: "#8a7c63", textTransform: "uppercase", padding: "2px 10px 6px" },
  searchResult:       { display: "block", width: "100%", textAlign: "left", background: "transparent", border: "none", borderRadius: 8, padding: "7px 10px", cursor: "pointer", marginBottom: 2 },
  searchResultActive: { background: "rgba(192,70,31,0.08)" },
  searchResultTop:    { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  searchResultTitle:  { fontSize: 12.5, fontWeight: 600, color: c.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  searchResultTime:   { fontFamily: fonts.mono, fontSize: 9.5, color: "#a99986", flexShrink: 0 },
  searchResultSnippet:{ fontSize: 11, color: "#6b6150", lineHeight: 1.4, marginTop: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
  searchMark:         { background: "rgba(216,168,40,0.45)", color: c.ink, borderRadius: 2, padding: "0 1px" },
  ungroupedLabel:   { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: "0.16em", color: "#8a7c63", padding: "8px 10px 4px" },
  archivedToggle:   { padding: "10px 14px", border: "none", borderTop: `1px dashed ${c.line}`, background: "transparent", cursor: "pointer", fontFamily: fonts.mono, fontSize: 10, color: "#8a7c63", textAlign: "left" },
  // Chat row
  chatRow:          { display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", borderRadius: 7, cursor: "pointer", marginBottom: 2, userSelect: "none" },
  chatRowActive:    { background: c.ink, color: c.paper },
  chatRowMain:      { flex: 1, minWidth: 0 },
  chatRowTitle:     { fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  chatRowTitleInput:{ width: "100%", padding: "2px 4px", border: `1px solid ${c.rust}`, borderRadius: 4, fontSize: 13, fontFamily: fonts.body, background: c.paper2, color: c.ink },
  chatRowMeta:      { display: "flex", justifyContent: "space-between", marginTop: 2, fontFamily: fonts.mono, fontSize: 9.5, opacity: 0.7 },
  chatRowAgent:     { color: "inherit" },
  chatRowAgentNone: { color: c.rust, fontStyle: "italic" },
  chatRowTime:      { color: "inherit" },
  chatRowMenuBtn:   { width: 22, height: 22, border: "none", background: "transparent", cursor: "pointer", borderRadius: 4, color: "inherit", fontSize: 16, lineHeight: 1, opacity: 0.6 },
  // Project folder
  projectHeader:    { display: "flex", alignItems: "center", gap: 4, padding: "8px 8px", cursor: "pointer", borderRadius: 6, marginTop: 4, userSelect: "none" },
  projectName:      { flex: 1, fontFamily: fonts.body, fontWeight: 600, fontSize: 12.5, color: c.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  projectNameInput: { flex: 1, padding: "2px 4px", border: `1px solid ${c.rust}`, borderRadius: 4, fontSize: 12.5, fontFamily: fonts.body, background: c.paper2, color: c.ink },
  projectCount:     { fontFamily: fonts.mono, fontSize: 9.5, color: "#8a7c63", padding: "1px 6px", background: c.paper2, borderRadius: 8 },
  projectMenuBtn:   { width: 22, height: 22, border: "none", background: "transparent", cursor: "pointer", borderRadius: 4, color: c.ink, fontSize: 16, lineHeight: 1, opacity: 0.6 },
  projectChats:     { paddingLeft: 18 },
  projectEmpty:     { padding: "6px 10px", color: "#bfb49a", fontSize: 11, fontStyle: "italic" },
  // Row menu (popover)
  rowMenu:          { position: "absolute", top: "100%", right: 0, marginTop: 4, background: c.paper, border: borderLight, borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,0.12)", padding: 4, minWidth: 180, zIndex: 50 },
  rowMenuItem:      { display: "block", width: "100%", padding: "7px 10px", border: "none", background: "transparent", textAlign: "left", cursor: "pointer", borderRadius: 5, fontSize: 12, color: c.ink, fontFamily: fonts.body },
  rowMenuItemDanger:{ color: c.rust },
  // Chat header extras
  chatTitleInput:   { padding: "4px 8px", border: `1px solid ${c.rust}`, borderRadius: 6, fontSize: 18, fontFamily: fonts.display, fontWeight: 700, background: c.paper2, color: c.ink, minWidth: 200 },
  chatTitleBtn:     { border: "none", background: "transparent", padding: "2px 6px", fontFamily: fonts.display, fontSize: 18, fontWeight: 700, color: c.ink, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360, textAlign: "left" },
  responderPicker:  { padding: "4px 8px", border: borderLight, borderRadius: 6, fontSize: 11, fontFamily: fonts.mono, background: c.paper2, color: c.ink, maxWidth: 220 },
  headerIconBtn:    { width: 30, height: 28, padding: 0, border: borderLight, background: c.paper2, borderRadius: 6, cursor: "pointer", fontSize: 14, lineHeight: 1, color: c.ink, display: "flex", alignItems: "center", justifyContent: "center" },
  // ── Collapse / collapsed panels ──
  collapseBtn:       { width: 26, height: 26, border: borderLight, background: c.paper, cursor: "pointer", borderRadius: 6, color: "#8a7c63", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" },
  collapseExpandBtn: { width: "100%", padding: "12px 0", border: "none", background: c.paper2, cursor: "pointer", color: "#8a7c63", borderBottom: borderLight, display: "flex", alignItems: "center", justifyContent: "center" },
  sidebarCollapsed:  { width: 44, borderRight: borderLight, background: `linear-gradient(175deg, ${c.paper2}, ${c.paper})`, display: "flex", flexDirection: "column", flexShrink: 0 },
  collapsedNavBtn:   { width: 32, height: 32, border: `1px solid transparent`, background: "transparent", borderRadius: 6, cursor: "pointer", color: c.ink, display: "flex", alignItems: "center", justifyContent: "center" },
  collapsedNavBtnActive: { background: c.ink, color: c.paper },
  chatListCollapsed: { width: 36, borderRight: borderLight, background: c.paper, display: "flex", flexDirection: "column", flexShrink: 0 },
  chatListCollapsedLabel: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 0" },
  jumpToLatest: { position: "absolute", bottom: 100, left: "50%", transform: "translateX(-50%)", padding: "8px 16px", border: borderLight, background: c.ink, color: c.paper, borderRadius: 20, cursor: "pointer", fontFamily: "'Space Mono', monospace", fontSize: 11, boxShadow: "0 4px 16px rgba(0,0,0,0.18)", zIndex: 5 },
  // ── Mini-chat inside Agents card ──
  agentCardEditBtn: { width: 24, height: 24, border: borderLight, background: c.paper, borderRadius: 5, cursor: "pointer", fontSize: 12, color: "#8a7c63", display: "flex", alignItems: "center", justifyContent: "center" },
  miniChat:        { marginTop: 12, paddingTop: 10, borderTop: `1px dashed ${c.line}` },
  miniPreview:     { maxHeight: 90, overflow: "auto", marginBottom: 8, padding: "6px 8px", background: c.paper, border: borderLight, borderRadius: 7, display: "flex", flexDirection: "column", gap: 4 },
  miniMsgUser:     { fontSize: 11, lineHeight: 1.4, color: c.ink },
  miniMsgAst:      { fontSize: 11, lineHeight: 1.4, color: "#5a5244" },
  miniRole:        { fontFamily: fonts.mono, fontSize: 9, color: c.rust, marginRight: 6, letterSpacing: "0.05em" },
  miniText:        { whiteSpace: "pre-wrap", wordBreak: "break-word" },
  miniInputRow:    { display: "flex", gap: 6 },
  miniInput:       { flex: 1, padding: "7px 10px", border: borderLight, borderRadius: 7, fontSize: 12, fontFamily: fonts.body, background: c.paper, color: c.ink },
  miniSendBtn:     { width: 30, height: 30, padding: 0, border: "none", background: c.rust, borderRadius: 7, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  // ── Tools redesign ──
  toolCategory:       { marginBottom: 16, border: borderLight, borderRadius: 10, background: c.paper2, overflow: "hidden" },
  toolCategoryHeader: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", cursor: "pointer", background: c.paper, borderBottom: borderLight },
  toolCategoryName:   { flex: 1, fontFamily: fonts.mono, fontSize: 10.5, letterSpacing: "0.18em", color: c.rustDeep, fontWeight: 700 },
  toolCategoryCount:  { fontFamily: fonts.mono, fontSize: 10, color: "#8a7c63", padding: "2px 7px", background: c.paper2, border: borderLight, borderRadius: 10 },
  toolRow:            { padding: "10px 14px", borderTop: `1px dashed ${c.line}` },
  toolRowMain:        { display: "flex", alignItems: "flex-start", gap: 10 },
  toolRowName:        { fontFamily: fonts.mono, fontSize: 12, fontWeight: 700, color: c.rust, marginBottom: 2 },
  toolRowDesc:        { fontSize: 12, color: "#5a5244", lineHeight: 1.45 },
  toolRowExpand:      { width: 24, height: 24, border: borderLight, background: c.paper, borderRadius: 5, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  toolRowAgents:      { marginTop: 10, padding: "10px 12px", background: c.paper, border: borderLight, borderRadius: 8 },
  toolRowAgentsLabel: { fontFamily: fonts.mono, fontSize: 9.5, letterSpacing: "0.14em", color: "#8a7c63", marginBottom: 6, textTransform: "uppercase" },
  toolRowAgentItem:   { display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", fontSize: 12, color: c.ink, cursor: "pointer", borderRadius: 5 },
};
