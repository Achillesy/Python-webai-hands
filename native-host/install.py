#!/usr/bin/env python3
# webai-hands local host installer (run once per machine; re-run after
# `git pull` to refresh the host).
#
# Does three things:
# 1. Copies the host program into ~/.webai-hands/ (log/ and skill/
#    subdirectories are created; a machine.json from the legacy
#    ~/.config/webai-hands/ location is migrated so the machine
#    identity is preserved).
# 2. Copies the AI operator guides (AI-GUIDE.md / AI-BLENDER.md, from the
#    repo root) into ~/.webai-hands/ so store users without a checkout
#    have them locally; refreshed on every reinstall.
# 3. Registers com.webai.hands.json with Chrome: HKCU registry on
#    Windows, Chrome's NativeMessagingHosts dir on macOS. The manifest
#    points at the installed copy, never at the repo.
#
# Two extension IDs are allowlisted: the dev build (pinned by the key
# in extension/manifest.json) and the Chrome Web Store build.

import json
import os
import shutil
import sys

HOST_NAME = "com.webai.hands"
EXTENSION_IDS = [
    "aaemlgedddakpgkfoakfmkdiiheplgnl",  # dev build (unpacked)
    "pboakanoekehbongkmaeianbkebpfahl",  # Chrome Web Store build
]
STORE_URL = "https://chromewebstore.google.com/detail/pboakanoekehbongkmaeianbkebpfahl"
try:
    HERE = os.path.dirname(os.path.abspath(__file__))
except NameError:
    # __file__ is undefined when run via exec() from a string or piped
    # through stdin (the documented one-line installs). That always means
    # standalone mode: fetch the host files from the network.
    HERE = None
INSTALL_DIR = os.path.expanduser("~/.webai-hands")
HOST_FILES = ["host.py", "host.sh", "host.bat", "ctx_summary.py",
              "skill/mcp_exec.py"]  # Blender MCP socket client (fixed path below)
# AI operator guides live at the repo root, not under native-host/.
DOC_FILES = ["AI-GUIDE.md", "AI-BLENDER.md"]
# Where to fetch the host program when install.py is downloaded standalone
# (one-line install). Pinned to main; change to a tag if you need a fixed version.
# GitHub is tried first, then the Gitee mirror (for users in China where
# GitHub raw is slow or blocked).
HOST_BASE_URL = "https://raw.githubusercontent.com/Achillesy/Python-webai-hands/main/native-host"
HOST_MIRROR_URL = "https://gitee.com/achillesy/Python-webai-hands/raw/main/native-host"
LEGACY_MACHINE_ID = os.path.join(
    os.path.expanduser("~"), ".config", "webai-hands", "machine.json")

SKILL_README = """\
# skill/

Drop reusable `.py` helper scripts here. The AI calls them through the
host's exec at a fixed path, e.g.:

    python3 ~/.webai-hands/skill/my_helper.py --args...

Conventions:
- Keep each script self-contained (stdlib only if possible).
- Print machine-readable output (JSON lines preferred).
- Never read secrets; the host already refuses sensitive paths.
"""


def host_launcher():
    if sys.platform == "win32":
        return os.path.join(INSTALL_DIR, "host.bat")
    return os.path.join(INSTALL_DIR, "host.sh")


def _download(url, dst, timeout=20):
    import urllib.request
    with urllib.request.urlopen(url, timeout=timeout) as resp, open(dst, "wb") as f:
        shutil.copyfileobj(resp, f)


def _working_base():
    """Return the first reachable host-file base (GitHub, then Gitee mirror)."""
    import urllib.request
    probe = "/host.bat"  # smallest file, fast probe
    for base in (HOST_BASE_URL, HOST_MIRROR_URL):
        try:
            with urllib.request.urlopen(base + probe, timeout=8) as r:
                r.read(1)
            return base
        except Exception:
            continue
    return None


def _net_base_or_raise():
    base = _working_base()
    if base is None:
        raise RuntimeError("Cannot reach GitHub or Gitee. Check your network/proxy.")
    return base


def _download_one(name, base, mirrors):
    """Download one file into INSTALL_DIR, trying base then mirrors."""
    dst = os.path.join(INSTALL_DIR, name)
    for b in [base] + mirrors:
        url = "%s/%s" % (b, name)
        try:
            print("Downloading %s" % url)
            _download(url, dst)
            return
        except Exception as e:
            print("  failed (%s), trying next mirror..." % e)
    raise RuntimeError("Failed to download %s from GitHub and Gitee" % name)


def fetch_files():
    # Two modes:
    # - Source mode: host files sit next to install.py (git checkout) -> copy.
    # - Standalone mode: install.py was downloaded alone (one-line install)
    #   -> fetch the host files from GitHub, falling back to the Gitee mirror.
    net_base = None
    if HERE and all(os.path.exists(os.path.join(HERE, n)) for n in HOST_FILES):
        for name in HOST_FILES:
            shutil.copy2(os.path.join(HERE, name), os.path.join(INSTALL_DIR, name))
        print("Copied host files from %s" % HERE)
    else:
        net_base = _net_base_or_raise()
        print("Using host file source: %s" % net_base)
        mirrors = [b for b in (HOST_BASE_URL, HOST_MIRROR_URL) if b != net_base]
        for name in HOST_FILES:
            _download_one(name, net_base, mirrors)
        print("Downloaded host files.")
    # AI operator guides (AI-GUIDE.md / AI-BLENDER.md): they live at the repo
    # root, not under native-host/. Store users have no checkout, so ship them
    # into the install dir where users can find them to upload into AI chats.
    # Unlike machine.json they are refreshed on every reinstall.
    repo_root = os.path.dirname(HERE) if HERE else None
    if repo_root and all(os.path.exists(os.path.join(repo_root, n)) for n in DOC_FILES):
        for name in DOC_FILES:
            shutil.copy2(os.path.join(repo_root, name), os.path.join(INSTALL_DIR, name))
        print("Copied AI guides from %s" % repo_root)
    else:
        # standalone: reuse the already-probed working mirror, but at the repo
        # root instead of native-host/.
        if net_base is None:
            net_base = _net_base_or_raise()
        suffix = "/native-host"
        doc_base = net_base[:-len(suffix)] if net_base.endswith(suffix) else net_base
        doc_mirrors = [
            b[:-len(suffix)] if b.endswith(suffix) else b
            for b in (HOST_BASE_URL, HOST_MIRROR_URL) if b != net_base
        ]
        for name in DOC_FILES:
            _download_one(name, doc_base, doc_mirrors)
        print("Downloaded AI guides.")


def install_files():
    os.makedirs(os.path.join(INSTALL_DIR, "log"), exist_ok=True)
    os.makedirs(os.path.join(INSTALL_DIR, "skill"), exist_ok=True)
    fetch_files()
    readme = os.path.join(INSTALL_DIR, "skill", "README.md")
    if not os.path.exists(readme):
        with open(readme, "w", encoding="utf-8") as f:
            f.write(SKILL_README)
    # Migrate machine identity from the legacy location (first run only).
    new_id = os.path.join(INSTALL_DIR, "machine.json")
    if not os.path.exists(new_id) and os.path.exists(LEGACY_MACHINE_ID):
        shutil.copy2(LEGACY_MACHINE_ID, new_id)
        print("Migrated machine identity from %s" % LEGACY_MACHINE_ID)
    if sys.platform != "win32":
        os.chmod(os.path.join(INSTALL_DIR, "host.sh"), 0o755)


def write_manifest(target_path):
    manifest = {
        "name": HOST_NAME,
        "description": "webai-hands local host",
        "path": host_launcher(),
        "type": "stdio",
        "allowed_origins": ["chrome-extension://%s/" % eid for eid in EXTENSION_IDS],
    }
    with open(target_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return target_path


def main():
    install_files()
    print("Installed host program to %s" % INSTALL_DIR)

    if sys.platform == "win32":
        manifest_path = write_manifest(os.path.join(INSTALL_DIR, HOST_NAME + ".json"))
        import winreg

        key_path = "Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(key, None, 0, winreg.REG_SZ, manifest_path)
        print("Registered host: HKCU\\%s" % key_path)
    elif sys.platform == "darwin":
        target_dir = os.path.expanduser(
            "~/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        )
        os.makedirs(target_dir, exist_ok=True)
        manifest_path = write_manifest(os.path.join(target_dir, HOST_NAME + ".json"))
        print("Wrote host manifest: %s" % manifest_path)
    else:
        print("Unsupported platform: %s (Windows and macOS only)" % sys.platform)
        return 1

    print("Host manifest: %s" % manifest_path)
    print("Allowlisted extension IDs: %s" % ", ".join(EXTENSION_IDS))
    print(
        "Next: install the extension from the Chrome Web Store:\n"
        "  %s\n"
        "Then click the webai-hands toolbar icon — a \u2713 badge means the bridge is up."
        % STORE_URL
    )
    print(
        "AI guides installed to %s\n"
        "  New task? Upload AI-GUIDE.md to your AI chat to begin (see README)."
        % INSTALL_DIR
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
