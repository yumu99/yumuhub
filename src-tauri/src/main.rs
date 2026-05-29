#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};

fn workspace_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join("yumuhub-workspace"))
}

fn sandbox_root() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("yumuhub-beta"))
}

fn live_root() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("yumuhub"))
}

// N2: lexically resolve a path against a base, collapsing `..` and `.`
// without touching the filesystem. Used so that traversal attempts to
// nonexistent paths (../../../etc/passwd, where the chained .. lands in
// a directory that doesn't exist on disk) get the SAME "escapes sandbox"
// error as traversal attempts that resolve to existing-but-out-of-bounds
// paths. Without this, you'd see "Cannot resolve parent … No such file"
// for nonexistent targets and "Path escapes sandbox" for existing ones —
// confusing diagnostics that obscure the real reason.
fn lexical_resolve(base: &Path, rel: &str) -> PathBuf {
    use std::path::Component;
    let mut stack: Vec<std::ffi::OsString> = Vec::new();
    for c in base.components() {
        if let Component::Normal(s) = c { stack.push(s.to_os_string()); }
    }
    for c in Path::new(rel).components() {
        match c {
            Component::ParentDir => { stack.pop(); }
            Component::Normal(s) => stack.push(s.to_os_string()),
            _ => {}  // skip CurDir, RootDir, Prefix
        }
    }
    let mut p = PathBuf::from("/");
    for s in stack { p.push(s); }
    p
}

fn resolve_in_sandbox(rel: &str) -> Result<PathBuf, String> {
    let sandbox = sandbox_root()?;
    if !sandbox.exists() {
        return Err(format!(
            "Sandbox not initialized. Call clone_sandbox first to populate {}",
            sandbox.display()
        ));
    }
    // N1: callers naturally pass "." / "" / "/" to mean "list the sandbox
    // root", but the parent-canonicalize check below trips on those because
    // sandbox.join("/") becomes "/" (path::join replaces on absolute input)
    // and sandbox.parent() escapes the sandbox boundary. Short-circuit
    // those forms to the sandbox root itself; they cannot escape because
    // we hand back a constant.
    let trimmed = rel.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == "/" || trimmed == "./" {
        return sandbox.canonicalize()
            .map_err(|e| format!("Cannot canonicalize sandbox: {}", e));
    }
    // Reject any absolute path: the user must address files inside the
    // sandbox relatively. Without this guard, `sandbox.join("/etc/passwd")`
    // would produce `/etc/passwd` (and immediately fail the starts_with
    // check, but the error message is more useful this way).
    if trimmed.starts_with('/') {
        return Err(format!("Path must be relative to the sandbox root, got absolute: {}", trimmed));
    }
    // N2: lexical pre-check — collapse `..`/`.` against the (canonical)
    // sandbox and verify the result still starts with the sandbox root.
    // This catches traversal whether the target exists on disk or not and
    // gives every escape attempt the same "Path escapes sandbox" message.
    let sandbox_canon = sandbox
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize sandbox: {}", e))?;
    let lex = lexical_resolve(&sandbox_canon, trimmed);
    if !lex.starts_with(&sandbox_canon) {
        return Err(format!("Path escapes sandbox: {}", sandbox.join(trimmed).display()));
    }
    let joined = sandbox.join(trimmed);
    let parent = joined.parent().unwrap_or(Path::new("/"));
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("Cannot resolve parent of {}: {}", joined.display(), e))?;
    if !parent_canon.starts_with(&sandbox_canon) {
        return Err(format!("Path escapes sandbox: {}", joined.display()));
    }
    let file_name = joined
        .file_name()
        .ok_or_else(|| "Invalid path: no file component".to_string())?;
    Ok(parent_canon.join(file_name))
}

#[tauri::command]
fn beta_read(path: String) -> Result<String, String> {
    let target = resolve_in_sandbox(&path)?;
    fs::read_to_string(&target).map_err(|e| format!("read {}: {}", target.display(), e))
}

#[tauri::command]
fn beta_write(path: String, contents: String) -> Result<String, String> {
    use std::io::Write;
    let target = resolve_in_sandbox(&path)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    // H8: previously this was non-atomic (fs::copy → fs::write) AND used
    // a single fixed .bak slot — a second write would clobber the only
    // safety net, and a process kill between copy and write would leave
    // the target truncated. Now:
    //   1. Rotate existing .bak → .bak.1 → .bak.2 (keep last 3 generations)
    //   2. Copy current target to .bak
    //   3. Write new contents to a sibling .tmp file
    //   4. fsync the tmp
    //   5. fs::rename(.tmp → target)  — atomic on POSIX
    if target.exists() {
        let ext = target
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();
        let mk_bak = |suffix: &str| {
            target.with_extension(if ext.is_empty() {
                format!("bak{}", suffix)
            } else {
                format!("{}.bak{}", ext, suffix)
            })
        };
        // Rotate .bak.1 → .bak.2, .bak → .bak.1 (silently ignore missing)
        let _ = fs::rename(mk_bak(".1"), mk_bak(".2"));
        let _ = fs::rename(mk_bak(""), mk_bak(".1"));
        // Copy current contents into the new .bak slot
        fs::copy(&target, mk_bak(""))
            .map_err(|e| format!("backup {}: {}", mk_bak("").display(), e))?;
    }
    let tmp = target.with_extension(format!(
        "{}.yh-tmp",
        target.extension().and_then(|e| e.to_str()).unwrap_or("")
    ));
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| format!("create tmp {}: {}", tmp.display(), e))?;
        f.write_all(contents.as_bytes())
            .map_err(|e| format!("write tmp {}: {}", tmp.display(), e))?;
        f.sync_all()
            .map_err(|e| format!("fsync tmp {}: {}", tmp.display(), e))?;
    }
    fs::rename(&tmp, &target)
        .map_err(|e| format!("atomic rename {} -> {}: {}", tmp.display(), target.display(), e))?;
    Ok(format!(
        "Wrote {} bytes to {} (atomic, rotating .bak kept for the last 3 versions)",
        contents.len(),
        target.display()
    ))
}

#[tauri::command]
fn beta_list(path: String) -> Result<Vec<String>, String> {
    let target = resolve_in_sandbox(&path)?;
    let entries = fs::read_dir(&target)
        .map_err(|e| format!("read_dir {}: {}", target.display(), e))?;
    let mut out: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = if entry.path().is_dir() { "/" } else { "" };
        out.push(format!("{}{}", name, kind));
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn beta_status() -> Result<String, String> {
    let sandbox = sandbox_root()?;
    let live = live_root()?;
    Ok(format!(
        "sandbox: {} (exists: {})\nlive:    {} (exists: {})",
        sandbox.display(),
        sandbox.exists(),
        live.display(),
        live.exists()
    ))
}

fn copy_dir_excluding(src: &Path, dst: &Path, excludes: &[&str]) -> Result<usize, String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {}", dst.display(), e))?;
    let mut count = 0usize;
    let entries = fs::read_dir(src).map_err(|e| format!("read_dir {}: {}", src.display(), e))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if excludes.iter().any(|e| *e == name_str.as_ref()) {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        if src_path.is_dir() {
            count += copy_dir_excluding(&src_path, &dst_path, excludes)?;
        } else {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("copy {} -> {}: {}", src_path.display(), dst_path.display(), e))?;
            count += 1;
        }
    }
    Ok(count)
}

#[tauri::command]
fn clone_sandbox() -> Result<String, String> {
    let live = live_root()?;
    let sandbox = sandbox_root()?;
    if !live.exists() {
        return Err(format!("Live source not found at {}", live.display()));
    }
    let excludes = ["node_modules", "target", "dist", ".git", ".DS_Store"];
    let count = copy_dir_excluding(&live, &sandbox, &excludes)?;
    Ok(format!(
        "Cloned {} files from {} to {} (excluded {:?})",
        count,
        live.display(),
        sandbox.display(),
        excludes
    ))
}

fn inbox_path() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("yumuhub-inbox.json"))
}

// M5: previously inbox_pop read then deleted — a writer that appended a
// second message between the read and the remove would have that message
// silently lost. Rename-then-read is atomic on POSIX: once the rename
// succeeds, any new writer creates a fresh inbox file at the original
// path that's untouched by this pop. We use a per-call unique suffix so
// concurrent inbox_pop callers don't race each other either.
#[tauri::command]
fn inbox_pop() -> Result<String, String> {
    let path = inbox_path()?;
    if !path.exists() {
        return Ok("[]".to_string());
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staged = path.with_extension(format!("json.popping.{}", ts));
    // If the rename fails (e.g. file disappeared between exists() and
    // rename() — another pop won the race), report empty and move on.
    if fs::rename(&path, &staged).is_err() {
        return Ok("[]".to_string());
    }
    let contents = fs::read_to_string(&staged)
        .map_err(|e| format!("read inbox {}: {}", staged.display(), e))?;
    let _ = fs::remove_file(&staged);
    Ok(contents)
}

fn outbox_path() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("yumuhub-outbox.jsonl"))
}

// M5: outbox previously appended raw lines with no sequence info, so an
// external reader couldn't tell if intermediate replies were lost (e.g. a
// process crash mid-write, or external tampering). We now inject a `seq`
// field (monotonically increasing per file) and a `wseq_ts` field (epoch
// ms of the write) BEFORE persisting. Doesn't break older readers — they
// just see two extra JSON keys.
static OUTBOX_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[tauri::command]
fn outbox_append(line: String) -> Result<(), String> {
    use std::io::Write;
    let path = outbox_path()?;
    // Lazily seed OUTBOX_SEQ from the existing file's line count so seq
    // continues monotonically across app restarts.
    if OUTBOX_SEQ.load(std::sync::atomic::Ordering::Relaxed) == 0 {
        if let Ok(existing) = fs::read_to_string(&path) {
            let n = existing.lines().filter(|l| !l.trim().is_empty()).count() as u64;
            OUTBOX_SEQ.store(n, std::sync::atomic::Ordering::Relaxed);
        }
    }
    let seq = OUTBOX_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let trimmed = line.trim_end_matches('\n').trim();
    // Inject seq + wseq_ts as the FIRST two fields if the payload is JSON
    // object; otherwise leave the line unchanged (gracefully accept legacy
    // callers writing raw strings).
    let augmented = if trimmed.starts_with('{') && trimmed.ends_with('}') && trimmed.len() >= 2 {
        let inner = &trimmed[1..trimmed.len() - 1];
        if inner.is_empty() {
            format!("{{\"seq\":{},\"wseq_ts\":{}}}", seq, ts)
        } else {
            format!("{{\"seq\":{},\"wseq_ts\":{},{}}}", seq, ts, inner)
        }
    } else {
        trimmed.to_string()
    };
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open outbox {}: {}", path.display(), e))?;
    writeln!(f, "{}", augmented).map_err(|e| format!("write outbox: {}", e))?;
    Ok(())
}

fn debug_path() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("yumuhub-debug.log"))
}

// ── Universal prompt (yumuHub.md) ──
fn universal_path() -> Result<PathBuf, String> {
    Ok(workspace_root()?.join("yumuHub.md"))
}

// L1: universal prompt is injected verbatim into every system prompt on
// every API call. With no size cap, a multi-MB file (perhaps written by
// some external tool) would multiply input-token cost by a large factor
// silently. Cap at 16 KB at the read boundary and truncate with a
// notice so the user sees that their file is being clipped.
const UNIVERSAL_MAX_BYTES: usize = 16 * 1024;

#[tauri::command]
fn read_universal() -> Result<String, String> {
    let path = universal_path()?;
    if !path.exists() { return Ok(String::new()); }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    if raw.len() <= UNIVERSAL_MAX_BYTES { return Ok(raw); }
    // Truncate cleanly at a UTF-8 boundary
    let mut cut = UNIVERSAL_MAX_BYTES;
    while cut > 0 && !raw.is_char_boundary(cut) { cut -= 1; }
    Ok(format!(
        "{}\n\n[…truncated to {} bytes — full file is {} bytes. Edit ~/yumuhub-workspace/yumuHub.md to shorten or split.]",
        &raw[..cut], cut, raw.len()
    ))
}

#[tauri::command]
fn write_universal(contents: String) -> Result<String, String> {
    let path = universal_path()?;
    if contents.len() > UNIVERSAL_MAX_BYTES * 4 {
        return Err(format!(
            "Refused to write {} bytes — the universal prompt is injected into every API call and bigger than {} KB is almost certainly a mistake. Hard limit: {} KB.",
            contents.len(), UNIVERSAL_MAX_BYTES / 1024, (UNIVERSAL_MAX_BYTES * 4) / 1024
        ));
    }
    fs::write(&path, &contents).map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn reveal_universal() -> Result<String, String> {
    let path = universal_path()?;
    if !path.exists() {
        // Create empty file so Finder has something to highlight
        fs::write(&path, "").map_err(|e| format!("create {}: {}", path.display(), e))?;
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("open -R: {}", e))?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // H5: macOS `open` resolves any URL scheme — file://, custom-protocol
    // URLs that launch helper apps, vscode://, etc. Combined with any
    // content-injection vector (malicious yumuHub.md, attacker-controlled
    // outbox line rendered as a clickable link, tool result), this becomes
    // an arbitrary protocol-handler launcher. Allow only http/https here.
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(format!("Refused to open URL with disallowed scheme. Only https:// and http:// are permitted. Got: {}", url));
    }
    // Reject embedded control chars / newlines that could fool a downstream
    // shell helper or be used to smuggle args.
    if url.chars().any(|c| c.is_control()) {
        return Err("Refused to open URL containing control characters.".to_string());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("open url: {}", e))?;
    Ok(())
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// Brave Search API doesn't support CORS preflight (returns 405 on OPTIONS),
// so the webview's fetch can't reach it. We proxy through Rust instead.
// Returns `{"status": <int>, "body": <string>}` JSON so the JS side can
// branch on HTTP status without re-parsing curl's output.
#[tauri::command]
fn brave_search(query: String, count: u32, key: String) -> Result<String, String> {
    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}&count={}",
        urlencode(&query),
        count.min(20).max(1)
    );
    let output = std::process::Command::new("curl")
        .args([
            "-sS",
            "-w", "\n__HTTP_STATUS__%{http_code}",
            "-H", "Accept: application/json",
            "-H", &format!("X-Subscription-Token: {}", key),
            &url,
        ])
        .output()
        .map_err(|e| format!("curl failed to launch: {}", e))?;
    if !output.status.success() {
        return Err(format!("curl exited non-zero: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let (body, status) = match raw.rfind("\n__HTTP_STATUS__") {
        Some(idx) => {
            let status_str = raw[idx + "\n__HTTP_STATUS__".len()..].trim().to_string();
            let status_n: u32 = status_str.parse().unwrap_or(0);
            (raw[..idx].to_string(), status_n)
        }
        None => (raw, 0),
    };
    let mut escaped = String::with_capacity(body.len() + 16);
    escaped.push('"');
    for ch in body.chars() {
        match ch {
            '"'  => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if (c as u32) < 0x20 => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    escaped.push('"');
    Ok(format!("{{\"status\":{},\"body\":{}}}", status, escaped))
}

// z.ai's anthropic-compat endpoint at https://api.z.ai/api/anthropic
// works perfectly via curl but WebKit's fetch implementation in Tauri
// throws "Load failed" on it (~7s into the request). The other z.ai
// endpoints (coding, general) work from WebKit fine — it's something
// specific to this path. To get the unthrottled Coding Plan benefits
// without rewriting the streaming UX entirely, we proxy through curl
// here. Non-streaming for now (the response lands all at once, but
// is small enough for typical chat responses).
//
// Returns `{"status": <int>, "body": <string>}` matching brave_search's
// shape, so the JS adapter can parse the SSE response uniformly.
#[tauri::command]
fn zai_anthropic_proxy(api_key: String, body: String) -> Result<String, String> {
    let url = "https://api.z.ai/api/anthropic/v1/messages";
    let auth = format!("Authorization: Bearer {}", api_key);
    let output = std::process::Command::new("curl")
        .args([
            "-sS",
            "--max-time", "600",  // 10 min hard cap; z.ai's documented limit is 50 min
            "-w", "\n__HTTP_STATUS__%{http_code}",
            "-X", "POST",
            "-H", "Content-Type: application/json",
            "-H", &auth,
            "-H", "anthropic-version: 2023-06-01",
            "-d", &body,
            url,
        ])
        .output()
        .map_err(|e| format!("curl failed to launch: {}", e))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(format!("curl exited non-zero: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let raw = String::from_utf8_lossy(&output.stdout).to_string();
    let (body_str, status) = match raw.rfind("\n__HTTP_STATUS__") {
        Some(idx) => {
            let status_str = raw[idx + "\n__HTTP_STATUS__".len()..].trim().to_string();
            let status_n: u32 = status_str.parse().unwrap_or(0);
            (raw[..idx].to_string(), status_n)
        }
        None => (raw, 0),
    };
    let mut escaped = String::with_capacity(body_str.len() + 16);
    escaped.push('"');
    for ch in body_str.chars() {
        match ch {
            '"'  => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            c if (c as u32) < 0x20 => escaped.push_str(&format!("\\u{:04x}", c as u32)),
            c => escaped.push(c),
        }
    }
    escaped.push('"');
    Ok(format!("{{\"status\":{},\"body\":{}}}", status, escaped))
}

// ── Claude Code Router (ccr) integration ──
fn ccr_config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join(".claude-code-router").join("config.json"))
}

// Run a shell command through the user's login zsh so it picks up their
// PATH (npm global bin, homebrew, nvm, etc.). Tauri apps on macOS don't
// inherit the terminal's PATH otherwise.
fn run_login_shell(cmd: &str) -> Result<(bool, String, String), String> {
    let output = std::process::Command::new("/bin/zsh")
        .args(["-l", "-c", cmd])
        .output()
        .map_err(|e| format!("Failed to spawn zsh: {}", e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Ok((output.status.success(), stdout, stderr))
}

#[tauri::command]
fn ccr_write_config(json: String) -> Result<String, String> {
    let path = ccr_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    if path.exists() {
        let bak = path.with_extension("json.bak");
        let _ = fs::copy(&path, &bak);
    }
    fs::write(&path, &json).map_err(|e| format!("write {}: {}", path.display(), e))?;
    // M7: the CCR config holds every upstream provider's plaintext API key.
    // Default umask gives 0644 (world-readable on a multi-user host). Force
    // 0600 (owner-only) so other accounts can't snarf the keys.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(format!("Wrote {} bytes to {} (mode 0600)", json.len(), path.display()))
}

#[tauri::command]
fn ccr_check_installed() -> Result<bool, String> {
    let (ok, _, _) = run_login_shell("command -v ccr >/dev/null 2>&1")?;
    Ok(ok)
}

#[tauri::command]
fn ccr_install() -> Result<String, String> {
    // First try without admin privileges.
    let (ok, stdout, stderr) = run_login_shell("npm i -g @musistudio/claude-code-router 2>&1")?;
    if ok {
        return Ok(format!("Installed:\n{}", stdout));
    }
    let combined = format!("{}\n{}", stdout, stderr);
    let is_perm_error = combined.contains("EACCES")
        || combined.contains("permission denied")
        || combined.contains("EPERM");
    if !is_perm_error {
        return Err(format!(
            "Install failed.\nstdout:\n{}\nstderr:\n{}",
            stdout, stderr
        ));
    }
    // Permission error — retry via osascript so macOS shows a native password
    // prompt. Need npm's absolute path because the admin shell has minimal PATH.
    let (which_ok, which_out, _) = run_login_shell("which npm 2>/dev/null")?;
    let npm_path = which_out.trim().to_string();
    if !which_ok || npm_path.is_empty() {
        return Err(format!(
            "Install failed (permission denied), and yumuHub couldn't locate npm to retry with admin privileges. Run this in a terminal yourself:\n\n  sudo npm i -g @musistudio/claude-code-router\n\nOriginal error:\n{}",
            stdout
        ));
    }
    // H6: previously this path was vulnerable to a malicious npm earlier in
    // PATH whose absolute path contained backquotes, $(…), or newlines —
    // those characters would have been re-interpreted by `do shell script`
    // and executed as root. Validate the path with a strict allow-list
    // BEFORE building the AppleScript. Accept only absolute paths made of
    // [A-Za-z0-9_/.-]. Reject anything else and bail out cleanly with
    // copy-paste instructions for manual install.
    let valid_npm_path = npm_path.starts_with('/')
        && npm_path.chars().all(|c| c.is_ascii_alphanumeric() || c == '/' || c == '_' || c == '.' || c == '-');
    if !valid_npm_path {
        return Err(format!(
            "Refused to escalate: the resolved npm path contains unsafe characters ({:?}). For safety, install manually:\n\n  sudo npm i -g @musistudio/claude-code-router\n\nIf this is your real npm, please file a bug.",
            npm_path
        ));
    }
    // The path is now strictly [A-Za-z0-9_/.-] so AppleScript escaping is a
    // no-op, but keep the explicit escapes as defence in depth.
    let escaped = npm_path.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "do shell script \"{} i -g @musistudio/claude-code-router 2>&1\" with administrator privileges",
        escaped
    );
    let output = std::process::Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("Failed to spawn osascript: {}", e))?;
    if output.status.success() {
        return Ok(format!(
            "Installed with admin privileges:\n{}",
            String::from_utf8_lossy(&output.stdout)
        ));
    }
    let err_str = String::from_utf8_lossy(&output.stderr);
    if err_str.contains("User canceled") || err_str.contains("(-128)") {
        Err("Admin install cancelled at the password prompt. Click Apply again to retry, or run `sudo npm i -g @musistudio/claude-code-router` in a terminal.".to_string())
    } else {
        Err(format!(
            "Admin install failed:\n{}\n\nFallback: run `sudo npm i -g @musistudio/claude-code-router` in a terminal.",
            err_str
        ))
    }
}

#[tauri::command]
fn ccr_start() -> Result<String, String> {
    // `ccr start` daemonizes itself, so a synchronous shell call is fine.
    let (ok, stdout, stderr) = run_login_shell("ccr start 2>&1")?;
    if ok || stdout.contains("already") || stderr.contains("already") {
        Ok(format!("Started:\n{}", stdout))
    } else {
        Err(format!("Start failed.\nstdout:\n{}\nstderr:\n{}", stdout, stderr))
    }
}

#[tauri::command]
fn ccr_stop() -> Result<String, String> {
    let (_, stdout, stderr) = run_login_shell("ccr stop 2>&1")?;
    // ccr stop returns non-zero if not running — treat that as success.
    Ok(format!("{}{}", stdout, if stderr.is_empty() { String::new() } else { format!("\n{}", stderr) }))
}

// ── Chat backup (mirror of localStorage messages on idle) ──
fn chats_dir() -> Result<PathBuf, String> {
    let dir = workspace_root()?.join("chats");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn safe_chat_id(chat_id: &str) -> Result<String, String> {
    if chat_id.is_empty() || chat_id.len() > 96 {
        return Err("Invalid chatId length".to_string());
    }
    for ch in chat_id.chars() {
        if !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-' {
            return Err(format!("Invalid character in chatId: {:?}", ch));
        }
    }
    Ok(chat_id.to_string())
}

#[tauri::command]
fn chat_backup_write(chat_id: String, json: String) -> Result<String, String> {
    let id = safe_chat_id(&chat_id)?;
    let path = chats_dir()?.join(format!("{}.json", id));
    fs::write(&path, &json).map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn chat_backup_read(chat_id: String) -> Result<String, String> {
    let id = safe_chat_id(&chat_id)?;
    let path = chats_dir()?.join(format!("{}.json", id));
    if !path.exists() { return Ok(String::new()); }
    fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))
}

#[tauri::command]
fn chat_backup_list() -> Result<Vec<String>, String> {
    let dir = chats_dir()?;
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if let Some(id) = name.strip_suffix(".json") { out.push(id.to_string()); }
            }
        }
    }
    out.sort();
    Ok(out)
}

// H7: previously deleted/archived chats stayed on disk forever — a user
// who deleted a chat (maybe pasted an API key into a message) would still
// have a verbatim JSON file in the workspace. The frontend now calls this
// on every deleteChat + purgeOldArchived + (on startup) a sweep against
// the live chats list to unlink orphans.
#[tauri::command]
fn chat_backup_delete(chat_id: String) -> Result<(), String> {
    let safe = safe_chat_id(&chat_id)?;
    let path = chats_dir()?.join(format!("{}.json", safe));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("delete {}: {}", path.display(), e))?;
    }
    Ok(())
}

// C2: previously this was an unauthenticated, unbounded, unsanitized
// disk sink — any code path that reached invokeTauri("debug_log", ...)
// could fill the user's disk forever and leak any key/secret pattern
// passed through. We now:
//   - cap each line at 4 KB
//   - strip control characters (newlines, carriage returns, etc.) so
//     a single call can't fake-multi-line the log
//   - redact obvious secret patterns (sk-..., Bearer ..., AKIA..., etc.)
//   - rotate the file at 1 MB to a single .1 backup (so total on-disk
//     footprint is bounded at ~2 MB)
fn redact_secrets(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Try to match a secret-looking token starting at i.
        let rest = &s[i..];
        let matched: Option<usize> = if rest.starts_with("sk-") || rest.starts_with("sk_") {
            Some(token_len(&bytes[i..]))
        } else if rest.to_ascii_lowercase().starts_with("bearer ") {
            // skip the literal "Bearer " then the token
            let prefix = 7;
            let tok = token_len(&bytes[i + prefix..]);
            if tok > 8 { Some(prefix + tok) } else { None }
        } else if rest.starts_with("AKIA") || rest.starts_with("ASIA") {
            Some(token_len(&bytes[i..]))
        } else if rest.starts_with("ccr_") {
            let tok = token_len(&bytes[i..]);
            if tok >= 20 { Some(tok) } else { None }
        } else {
            None
        };
        if let Some(len) = matched {
            if len >= 12 {
                let head = &s[i..i + 6.min(len)];
                out.push_str(head);
                out.push_str("…[REDACTED]");
                i += len;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn token_len(bytes: &[u8]) -> usize {
    let mut n = 0;
    while n < bytes.len() {
        let b = bytes[n];
        let is_tok = b.is_ascii_alphanumeric()
            || b == b'-' || b == b'_' || b == b'.' || b == b'/';
        if !is_tok { break; }
        n += 1;
    }
    n
}

const DEBUG_LOG_MAX_BYTES: u64 = 1_048_576; // 1 MB
const DEBUG_LOG_LINE_CAP: usize = 4096;

#[tauri::command]
fn debug_log(line: String) -> Result<(), String> {
    use std::io::Write;
    let path = debug_path()?;
    // Rotate at 1 MB to a single .1 backup (renaming is atomic on POSIX).
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > DEBUG_LOG_MAX_BYTES {
            let rotated = path.with_extension("log.1");
            let _ = fs::rename(&path, &rotated);
        }
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open debug log: {}", e))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // Strip control chars (incl. \n \r \t) to keep one logical line per call.
    let clean: String = line
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .collect();
    let truncated = if clean.len() > DEBUG_LOG_LINE_CAP {
        format!("{}…[truncated {} bytes]", &clean[..DEBUG_LOG_LINE_CAP], clean.len() - DEBUG_LOG_LINE_CAP)
    } else {
        clean
    };
    let safe = redact_secrets(&truncated);
    writeln!(f, "{} {}", ts, safe).map_err(|e| format!("write debug: {}", e))?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            beta_read,
            beta_write,
            beta_list,
            beta_status,
            clone_sandbox,
            inbox_pop,
            outbox_append,
            debug_log,
            read_universal,
            write_universal,
            reveal_universal,
            open_url,
            brave_search,
            zai_anthropic_proxy,
            ccr_write_config,
            ccr_check_installed,
            ccr_install,
            ccr_start,
            ccr_stop,
            chat_backup_write,
            chat_backup_read,
            chat_backup_list,
            chat_backup_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
