#!/bin/sh
# webai-hands host launcher (macOS / Linux).
# Prefers the interpreter from the install dir's .venv, falls back to system python3.
DIR=$(dirname "$0")
if [ -x "$DIR/.venv/bin/python" ]; then
  exec "$DIR/.venv/bin/python" "$DIR/host.py" "$@"
fi
exec python3 "$DIR/host.py" "$@"
