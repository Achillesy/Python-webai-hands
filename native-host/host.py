#!/usr/bin/env python3
# webai-hands local host (Chrome Native Messaging)
#
# Chrome spawns it over stdio: incoming messages are a 4-byte little-endian
# length prefix + UTF-8 JSON, and replies use the same format. The host
# never listens on any network port.
#
# Security: only allowlisted extension IDs can wake it (see install.py's
# allowed_origins). Passwords and privilege escalation never pass through
# here — when elevation is needed, the command itself triggers the OS
# UAC prompt; the host neither receives nor stores any credentials.
#
# Layout: the host lives in ~/.webai-hands/ (installed by install.py).
# Runtime state goes under log/, reusable scripts under skill/.
# All paths below are relative to this file, so the host works wherever
# it is installed from.

import base64
import json
import mimetypes
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid
import ctx_summary

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(BASE_DIR, "log")
LOG_PATH = os.path.join(LOG_DIR, "host.log")
DEFAULT_TIMEOUT = 120  # seconds; conservative for now
HOST_CWD = os.path.expanduser("~")  # fixed cwd: predictable, idempotent
HISTORY_PATH = os.path.join(LOG_DIR, "exec_history.json")
HISTORY_LIMIT = 500  # keep execution records for the most recent 500 ids
HISTORY_MAX_BYTES = 1 * 1024 * 1024  # total file size cap 1MB (second safety net beyond the count limit)
STDOUT_HEAD_LEN = 500  # keep only the first 500 chars of output per entry (ctx_summary uses the first 80)
# Slimming note (2026-10-04): HISTORY is a key table for idempotent
# dedup, not an audit archive. Storing full stdout once bloated it to
# 22MB; now only metadata + output summary are kept. Full output is
# already filled back into the page — the page is the record. UUIDs are
# not stored (the log lives on this machine, so the machine is implied).
MAX_FILE_SIZE = 25 * 1024 * 1024  # single-file cap 25MB
MAX_CMD_BYTES = 512 * 1024  # single-command cap 512KB (Chrome native message hard limit is 1MB; keep margin; matches the extension side)
CHUNK_B64 = 500 * 1024  # base64 chars per chunk (raw ~375KB; keep margin under the 1MB message limit)
FILE_DENY = (
    "/.ssh/", "/.aws/", "/.gnupg/", "/.config/gcloud/",
    "id_rsa", "id_ed25519", "id_ecdsa", ".pem", ".key", ".p12",
    "/.env", "credentials", "keychain", "cookies", "login data",
    "/etc/shadow", "/etc/sudoers", ".netrc", ".pgpass",
)
# Machine identity: hostnames can collide and be renamed, so they can't
# identify a machine. machine_id is a uuid4, decoupled from human naming.
# The host generates it on first run and persists it. Identity follows the
# machine, not the browser profile (reinstalling the extension keeps it).
# Deleting the file rotates the identity — old blocks addressed to the
# previous id naturally stop matching, which is the expected behavior.
MACHINE_ID_PATH = os.path.join(BASE_DIR, "machine.json")
# Pre-~/.webai-hands location; kept as a read fallback so upgrading
# doesn't rotate the identity. install.py migrates it on reinstall.
LEGACY_MACHINE_ID_PATH = os.path.join(
    os.path.expanduser("~"), ".config", "webai-hands", "machine.json")


def log(line):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + line + "\n")
    except OSError:
        pass


def slim_entry(key, v):
    """Slim one history entry down to metadata + output summary (all idempotent dedup needs)."""
    v = v if isinstance(v, dict) else {}
    return {
        "id": v.get("id", key),
        "ok": v.get("ok"),
        "exit_code": v.get("exit_code"),
        "duration_ms": v.get("duration_ms", 0),
        "ts": v.get("ts", 0),
        "session": v.get("session", ""),
        "cmd": str(v.get("cmd", ""))[:200],
        # tolerate the old full-stdout field; take the first 500 chars
        "stdout_head": str(v.get("stdout_head") or v.get("stdout") or "")[:STDOUT_HEAD_LEN],
    }


def load_history():
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    # migration: old versions stored full stdout; slim on load
    try:
        return {k: slim_entry(k, v) for k, v in raw.items()}
    except (AttributeError, TypeError):
        return {}


def save_history(hist):
    try:
        items = sorted(hist.items(), key=lambda kv: kv[1].get("ts", 0), reverse=True)
        items = items[:HISTORY_LIMIT]
        blob = json.dumps(dict(items), ensure_ascii=False, indent=2)
        # total size cap: rarely hit after slimming; drop oldest first when hit
        while len(blob.encode("utf-8")) > HISTORY_MAX_BYTES and len(items) > 1:
            items = items[:-1]
            blob = json.dumps(dict(items), ensure_ascii=False, indent=2)
        with open(HISTORY_PATH, "w", encoding="utf-8") as f:
            f.write(blob)
    except OSError:
        pass


def get_machine_id():
    # Machine identity: generated once as uuid4, persisted to a local file.
    # Identity follows the machine, not the browser profile.
    for path in (MACHINE_ID_PATH, LEGACY_MACHINE_ID_PATH):
        try:
            with open(path, "r", encoding="utf-8") as f:
                mid = json.load(f).get("machine_id")
            if mid:
                return mid
        except (OSError, ValueError, AttributeError):
            pass
    mid = str(uuid.uuid4())
    try:
        with open(MACHINE_ID_PATH, "w", encoding="utf-8") as f:
            json.dump({"machine_id": mid}, f)
        os.chmod(MACHINE_ID_PATH, 0o600)
    except OSError:
        pass
    return mid


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        return None
    (length,) = struct.unpack("<I", raw_len)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def decode_output(raw):
    if not raw:
        return ""
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def shell_argv(cmd):
    if sys.platform == "win32":
        return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", cmd]
    if os.path.exists("/bin/zsh"):
        return ["/bin/zsh", "-lc", cmd]
    return ["/bin/bash", "-lc", cmd]


def run_exec(msg):
    rid = msg.get("id")
    if rid in HISTORY:
        log("duplicate id=%s, returning cached" % rid)
        h = HISTORY[rid]
        # dedup hit: honestly report "this is cached"; output is summary only (full output was filled back into the page at the time)
        return {
            "type": "result",
            "id": rid,
            "hostname": socket.gethostname(),
            "machine_id": MACHINE_ID,
            "ok": h.get("ok"),
            "exit_code": h.get("exit_code"),
            "stdout": (h.get("stdout_head") or "") + "\n…(dedup hit: this id was already executed; only the output summary is kept)",
            "stderr": "",
            "duration_ms": h.get("duration_ms", 0),
            "duplicate": True,
            "ts": h.get("ts", 0),
        }
    cmd = msg.get("cmd", "")
    # defense in depth: the extension already rejects oversized blocks; block again here (unusual path of talking to the host directly)
    if len(cmd.encode("utf-8", "ignore")) > MAX_CMD_BYTES:
        log("exec id=%s oversize cmd, rejected" % rid)
        return {
            "type": "error",
            "id": rid,
            "error": "Command too large (512KB per-command limit); rejected. Split it into smaller chunks, or send large files via the attach channel.",
        }
    if cmd.strip() == "__diag__":
        return run_diag(msg)
    if cmd.strip() == "__ctx_summary__":
        return ctx_summary.run(msg, HISTORY)
    try:
        timeout = int(msg.get("timeout") or DEFAULT_TIMEOUT)
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT
    rid = msg.get("id")
    started = time.time()
    error = None
    proc = subprocess.Popen(
        shell_argv(cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    cwd=HOST_CWD,
    )
    box = {}

    def wait():
        try:
            box["out"], box["err"] = proc.communicate()
        except Exception:
            box["out"], box["err"] = b"", b""

    t = threading.Thread(target=wait, daemon=True)
    t.start()
    while t.is_alive():
        remaining = timeout - (time.time() - started)
        if remaining <= 0:
            proc.kill()
            t.join(5)
            error = "timeout after %ss" % timeout
            break
        t.join(min(20, remaining))
        if t.is_alive():
            # heartbeat roughly every 20s so the upper long-lived connection isn't killed as idle
            send_message(
                {
                    "type": "progress",
                    "id": rid,
                    "elapsed_ms": int((time.time() - started) * 1000),
                }
            )
    exit_code = proc.returncode if proc.returncode is not None else -1
    stdout = decode_output(box.get("out"))
    stderr = decode_output(box.get("err"))
    duration_ms = int((time.time() - started) * 1000)
    log("exec id=%s session=%s exit=%s ms=%s cmd=%r" % (
        msg.get("id"), msg.get("session") or "-", exit_code, duration_ms, cmd[:200]))
    res = {
        "type": "result",
        "id": msg.get("id"),
        "hostname": socket.gethostname(),
        "machine_id": MACHINE_ID,
        "ok": exit_code == 0 and error is None,
        "exit_code": exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "duration_ms": duration_ms,
    }
    if error:
        res["error"] = error
    res["ts"] = int(time.time())
    # slimmed store: metadata + output summary + session only (no UUID; the machine is implied)
    HISTORY[rid] = {
        "id": rid,
        "ok": res["ok"],
        "exit_code": exit_code,
        "duration_ms": duration_ms,
        "ts": res["ts"],
        "session": msg.get("session") or "",
        "cmd": cmd[:200],
        "stdout_head": stdout[:STDOUT_HEAD_LEN],
    }
    save_history(HISTORY)
    return res


def run_read_file(msg):
    """Read a local file, return it base64-encoded in chunks. Deny-list + size cap."""
    rid = msg.get("id")
    path = msg.get("path", "")
    if not path:
        return {"type": "error", "id": rid, "error": "missing path"}
    try:
        real = os.path.realpath(os.path.expanduser(path))
    except Exception as e:
        return {"type": "error", "id": rid, "error": "path resolution failed: %r" % (e,)}
    if not os.path.isfile(real):
        return {"type": "error", "id": rid, "error": "file not found: %s" % real}
    low = real.lower()
    for pat in FILE_DENY:
        if pat in low:
            log("read_file DENY id=%s path=%r pattern=%s" % (rid, real, pat))
            return {"type": "error", "id": rid, "error": "refusing to read sensitive path"}
    try:
        size = os.path.getsize(real)
    except OSError as e:
        return {"type": "error", "id": rid, "error": "cannot read size: %r" % (e,)}
    if size > MAX_FILE_SIZE:
        return {"type": "error", "id": rid,
                "error": "file too large: %d bytes (cap %d)" % (size, MAX_FILE_SIZE)}
    try:
        with open(real, "rb") as f:
            raw = f.read()
    except OSError as e:
        return {"type": "error", "id": rid, "error": "read failed: %r" % (e,)}
    b64 = base64.b64encode(raw).decode("ascii")
    name = os.path.basename(real)
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    chunks = [b64[i:i + CHUNK_B64] for i in range(0, len(b64), CHUNK_B64)] or [""]
    total = len(chunks)
    out = []
    for i, ch in enumerate(chunks):
        out.append({
            "type": "file_chunk",
            "id": rid,
            "name": name,
            "mime": mime,
            "size": size,
            "index": i,
            "total": total,
            "data": ch,
        })
    log("read_file id=%s path=%r size=%d chunks=%d mime=%s" % (rid, real, size, total, mime))
    return out


def run_diag(msg):
    try:
        tail = []
        if os.path.exists(LOG_PATH):
            with open(LOG_PATH, encoding="utf-8", errors="replace") as f:
                tail = f.readlines()[-20:]
        recent = sorted(HISTORY.items(), key=lambda kv: kv[1].get("ts", 0), reverse=True)[:10]
        recent_list = [{"id": k, "ok": v.get("ok"), "ts": v.get("ts"),
                        "session": v.get("session", "")} for k, v in recent]
        return {
            "type": "result",
            "id": msg.get("id"),
            "hostname": socket.gethostname(),
            "platform": sys.platform,
            "machine_id": MACHINE_ID,
            "pid": os.getpid(),
            "history_size": len(HISTORY),
            "history_limit": HISTORY_LIMIT,
            "recent": recent_list,
            "log_tail": "".join(tail),
            "ok": True,
            "exit_code": 0,
            "duration_ms": 0,
        }
    except Exception as e:
        return {"type": "error", "id": msg.get("id"), "error": "diag failed: %r" % (e,)}


def handle(msg):
    t = msg.get("type")
    if t == "ping":
        return {
            "type": "pong",
            "id": msg.get("id"),
            "hostname": socket.gethostname(),
            "platform": sys.platform,
            "machine_id": MACHINE_ID,
        }
    if t == "exec":
        return run_exec(msg)
    if t == "diag":
        return run_diag(msg)
    if t == "read_file":
        return run_read_file(msg)
    return {"type": "error", "id": msg.get("id"), "error": "unknown type: %r" % (t,)}


HISTORY = {}
MACHINE_ID = None


def main():
    global HISTORY, MACHINE_ID
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
    except OSError:
        pass
    HISTORY = load_history()
    MACHINE_ID = get_machine_id()
    log("host started platform=%s hostname=%s machine_id=%s history=%d" % (
        sys.platform, socket.gethostname(), MACHINE_ID, len(HISTORY)))
    while True:
        msg = read_message()
        if msg is None:
            break
        try:
            res = handle(msg)
            if isinstance(res, list):
                for item in res:
                    send_message(item)
            else:
                send_message(res)
        except Exception as e:  # one bad message must not take the host down
            log("handle error: %r" % (e,))
            try:
                send_message({"type": "error", "id": msg.get("id"), "error": str(e)})
            except Exception:
                break
    log("host exit")


if __name__ == "__main__":
    main()
