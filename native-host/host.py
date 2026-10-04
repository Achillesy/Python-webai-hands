#!/usr/bin/env python3
# webai-hands 本地 host（Chrome Native Messaging）
#
# Chrome 通过 stdio 把它拉起：扩展发来的消息是 4 字节小端长度前缀
# + UTF-8 JSON，host 同格式回。host 不监听任何网络端口。
#
# 安全约定：host 只被白名单扩展 ID 唤起（见 install.py 的
# allowed_origins）；密码与提权不经过这里——需要提权时由命令本身
# 触发系统 UAC，host 不接收、不保存任何口令。

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

LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "host.log")
DEFAULT_TIMEOUT = 120  # 秒；M1 先给保守值，截断/超时策略 M3 定型
HISTORY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "exec_history.json")
HISTORY_LIMIT = 500  # 最多保留最近 500 条 id 的执行记录
MAX_FILE_SIZE = 25 * 1024 * 1024  # 单文件上限 25MB
CHUNK_B64 = 500 * 1024  # 每块 base64 字符数（原始 ~375KB，留足 1MB 消息余量）
FILE_DENY = (
    "/.ssh/", "/.aws/", "/.gnupg/", "/.config/gcloud/",
    "id_rsa", "id_ed25519", "id_ecdsa", ".pem", ".key", ".p12",
    "/.env", "credentials", "keychain", "cookies", "login data",
    "/etc/shadow", "/etc/sudoers", ".netrc", ".pgpass",
)
# 机器唯一标识：hostname 可重名、可被改动，不能做身份标识；
# machine_id 是 uuid4，与人类命名解耦，host 首次运行时生成并持久化。
MACHINE_ID_PATH = os.path.join(os.path.expanduser("~"), ".config", "webai-hands", "machine.json")


def log(line):
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + line + "\n")
    except OSError:
        pass


def load_history():
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def save_history(hist):
    try:
        items = sorted(hist.items(), key=lambda kv: kv[1].get("ts", 0), reverse=True)[:HISTORY_LIMIT]
        with open(HISTORY_PATH, "w", encoding="utf-8") as f:
            json.dump(dict(items), f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def get_machine_id():
    # 机器唯一标识：host 首次运行时生成 uuid4 并持久化到本机文件。
    # 身份跟机器走，不跟浏览器 profile 走（重装扩展不改变机器身份）。
    # 删文件重装 = 身份轮换，旧块的 host 点名自然失效，属预期行为。
    try:
        with open(MACHINE_ID_PATH, "r", encoding="utf-8") as f:
            mid = json.load(f).get("machine_id")
        if mid:
            return mid
    except (OSError, ValueError, AttributeError):
        pass
    mid = str(uuid.uuid4())
    try:
        os.makedirs(os.path.dirname(MACHINE_ID_PATH), exist_ok=True)
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
        cached = dict(HISTORY[rid])
        cached["type"] = "result"
        cached["duplicate"] = True
        return cached
    cmd = msg.get("cmd", "")
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
        shell_argv(cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE
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
            # 约每 20 秒报一次活，防止上层长连接被当闲置掐断
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
    log("exec id=%s exit=%s ms=%s cmd=%r" % (msg.get("id"), exit_code, duration_ms, cmd[:200]))
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
    HISTORY[rid] = dict(res)
    save_history(HISTORY)
    return res


def run_read_file(msg):
    """读本机文件，base64 分块回传。安全拒绝名单 + 大小上限。"""
    rid = msg.get("id")
    path = msg.get("path", "")
    if not path:
        return {"type": "error", "id": rid, "error": "缺少 path"}
    try:
        real = os.path.realpath(os.path.expanduser(path))
    except Exception as e:
        return {"type": "error", "id": rid, "error": "路径解析失败: %r" % (e,)}
    if not os.path.isfile(real):
        return {"type": "error", "id": rid, "error": "文件不存在: %s" % real}
    low = real.lower()
    for pat in FILE_DENY:
        if pat in low:
            log("read_file DENY id=%s path=%r pattern=%s" % (rid, real, pat))
            return {"type": "error", "id": rid, "error": "拒绝读取敏感路径"}
    try:
        size = os.path.getsize(real)
    except OSError as e:
        return {"type": "error", "id": rid, "error": "无法读取大小: %r" % (e,)}
    if size > MAX_FILE_SIZE:
        return {"type": "error", "id": rid,
                "error": "文件过大 %d 字节（上限 %d）" % (size, MAX_FILE_SIZE)}
    try:
        with open(real, "rb") as f:
            raw = f.read()
    except OSError as e:
        return {"type": "error", "id": rid, "error": "读取失败: %r" % (e,)}
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
        recent_list = [{"id": k, "ok": v.get("ok"), "ts": v.get("ts")} for k, v in recent]
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
        except Exception as e:  # 单条消息出错不能把 host 带走
            log("handle error: %r" % (e,))
            try:
                send_message({"type": "error", "id": msg.get("id"), "error": str(e)})
            except Exception:
                break
    log("host exit")


if __name__ == "__main__":
    main()
