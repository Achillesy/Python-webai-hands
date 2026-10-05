# Contributing to webai-hands

Thanks for helping out. This project is small on purpose — please keep it that way.

## Ground rules

- **One thing at a time.** Small, focused PRs beat big rewrites.
- **No new dependencies** in `native-host/` without discussion. The host must stay
  a single-file-ish Python script with stdlib only.
- **Security first.** The host runs shell commands on the user's machine. Any PR
  touching `host.py`, the native-messaging boundary, or file access must explain
  its security implications. When in doubt, fail closed.
- **Test on a real page.** Adapter changes must be verified live on the target
  site before merge — "code-identical to X" is not verification.

## Dev setup

1. Clone the repo.
2. Load the unpacked extension: `chrome://extensions` → Developer mode →
   Load unpacked → select `extension/`.
3. Install the host: `python3 native-host/install.py` (macOS/Linux) or run
   `native-host/install_windows.bat` (Windows).
4. Click the extension icon → "Ping" → shows `connected: <hostname>`.

After changing extension code: **reload the extension** in `chrome://extensions`
(page refresh alone is not enough — the service worker keeps the old code).
After changing `host.py`: reload the extension so it respawns the host.

## Adding a new site adapter

1. Read `docs/archive/AI-EVOLUTION.md` — it's the adapter author's guide.
2. Copy `extension/adapters/muse.js` (~100 lines) as a starting point.
3. Implement the adapter interface: block detection, `fillResult`, `trySend`,
   and `uploadFile` (see `docs/archive/AI-EVOLUTION.md` for the contract).
4. Register the site in `extension/manifest.json` (`content_scripts[].matches`
   and `host_permissions`).
5. Use the `probe` block (`AI-GUIDE.md` §11) to inspect the site's DOM
   (input box, send button, `input[type=file]`) before writing selectors.
6. Verify live: exec round-trip, result fill-back, auto-send, and an `attach`
   upload end-to-end.

## Block protocol

AI assistants talk to the bridge with fenced code blocks (`AI-GUIDE.md`):

- `{"muse":"exec", ...}` — run a shell command on the host
- `{"muse":"probe", ...}` — read-only DOM inspection (page-local, never hits host)
- `{"muse":"attach", ...}` — upload a local file as a chat attachment

Keep the protocol backward compatible. New block kinds need a section in
`AI-GUIDE.md` and a security review.

## Release (Chrome Web Store)

See `store/` for the build script and listing materials. In short:

1. `bash store/build.sh` → produces a store-ready zip (strips the dev `key`
   so the store assigns a fresh extension ID).
2. Upload in the Chrome Web Store developer dashboard.
3. After the store assigns the ID, update the host manifest allowlist
   (`native-host/install.py` templates) and tell users to re-run install.

## License

By contributing you agree your changes go under the repo's `LICENSE`
(free for non-commercial use; no commercial use or resale).

