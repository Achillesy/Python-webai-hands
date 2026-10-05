#!/usr/bin/env python3
# webai-hands local host uninstaller.
#
# Removes:
# 1. The Chrome Native Messaging registration (HKCU registry on Windows,
#    the NativeMessagingHosts json on macOS).
# 2. ~/.webai-hands/ (host program, logs, skills, machine identity).
# 3. The legacy ~/.config/webai-hands/ identity file, if still present.
#
# Pass --yes to skip the confirmation prompt.

import os
import shutil
import sys

HOST_NAME = "com.webai.hands"
INSTALL_DIR = os.path.expanduser("~/.webai-hands")
LEGACY_DIR = os.path.join(os.path.expanduser("~"), ".config", "webai-hands")


def unregister():
    if sys.platform == "win32":
        import winreg

        key_path = "Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
            print("Removed registry key: HKCU\\%s" % key_path)
        except FileNotFoundError:
            print("Registry key not present, skipping.")
    elif sys.platform == "darwin":
        manifest = os.path.expanduser(
            "~/Library/Application Support/Google/Chrome/NativeMessagingHosts/%s.json"
            % HOST_NAME
        )
        if os.path.exists(manifest):
            os.remove(manifest)
            print("Removed host manifest: %s" % manifest)
        else:
            print("Host manifest not present, skipping.")
    else:
        print("Unsupported platform: %s (Windows and macOS only)" % sys.platform)
        return 1
    return 0


def remove_dirs():
    for path in (INSTALL_DIR, LEGACY_DIR):
        if os.path.isdir(path):
            shutil.rmtree(path)
            print("Removed directory: %s" % path)
        else:
            print("Directory not present, skipping: %s" % path)


def main():
    print("This will unregister the webai-hands native host and delete:")
    print("  - the Chrome Native Messaging registration for %s" % HOST_NAME)
    print("  - %s" % INSTALL_DIR)
    print("  - %s (legacy)" % LEGACY_DIR)
    if "--yes" not in sys.argv:
        try:
            answer = input("Continue? [y/N] ").strip().lower()
        except EOFError:
            # stdin is a pipe (e.g. curl ... | python3): no one can answer.
            print("Aborted (no terminal input; re-run with --yes to skip this prompt).")
            return 0
        if answer not in ("y", "yes"):
            print("Aborted.")
            return 0
    rc = unregister()
    remove_dirs()
    print("Done. The store extension can stay installed or be removed from")
    print("chrome://extensions — it will simply have no host to talk to.")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
