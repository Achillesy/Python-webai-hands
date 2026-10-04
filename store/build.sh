#!/bin/bash
# Build a Chrome Web Store-ready zip from extension/.
# - Strips the dev-only "key" field (dev keeps its pinned ID for the
#   native-host allowlist; the store item keeps its own ID).
# - Drops adapter files not wired in the manifest (inactive adapters stay
#   in the repo, out of the submission package).
# - Does NOT touch the repo's extension/.
# Usage: bash store/build.sh   (run from repo root)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/extension"
VER="$(python3 -c "import json;print(json.load(open('$SRC/manifest.json'))['version'])")"
TMP="$(mktemp -d)"
OUT="$ROOT/store/webai-hands-store-$VER.zip"

rm -rf "$TMP/build"
mkdir -p "$TMP/build"
cp -r "$SRC/." "$TMP/build/"

# Strip dev key -> store assigns a new extension ID on first upload.
python3 - "$TMP/build/manifest.json" <<'EOF'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m.pop("key", None)
json.dump(m, open(p, "w"), indent=2, ensure_ascii=False)
open(p, "a").write("\n")
print("store manifest: key stripped, version", m["version"])
EOF

# Drop adapter files not wired in the manifest (inactive adapters stay in
# the repo, out of the submission package). Derived from the manifest so
# re-enabling a site later needs no script change.
python3 - "$TMP/build" <<'EOF'
import json, os, sys
stage = os.path.join(sys.argv[1], 'manifest.json')
m = json.load(open(stage))
wired = set()
for cs in m.get('content_scripts', []):
    wired.update(cs.get('js', []))
adapters_dir = os.path.join(sys.argv[1], 'adapters')
for f in sorted(os.listdir(adapters_dir)):
    rel = 'adapters/' + f
    if rel not in wired:
        os.remove(os.path.join(adapters_dir, f))
        print('excluded inactive adapter: %s' % rel)
for rel in sorted(wired):
    p = os.path.join(sys.argv[1], rel)
    if not os.path.isfile(p):
        sys.exit('ERROR: manifest references missing file: %s' % rel)
print('manifest check OK: %d wired files present' % len(wired))
EOF

# Drop dev leftovers just in case.
find "$TMP/build" -name '*.bak' -delete

rm -f "$OUT"
(cd "$TMP/build" && zip -qr "$OUT" .)
rm -rf "$TMP"
echo "built: $OUT"
echo "NOTE: upload this zip to the existing store item (ID pboakanoekehbongkmaeianbkebpfahl)."
