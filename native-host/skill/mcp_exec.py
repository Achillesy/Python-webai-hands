#!/usr/bin/env python3
"""Direct socket client for the official Blender MCP add-on (Blender Lab).

The add-on listens on localhost:9876 and speaks null-delimited JSON:
    {"type": "execute", "code": "<python>", "strict_json": true}

Usage:
    python3 mcp_exec.py <code-file.py>

No MCP client app or MCP server process needed -- this talks straight to
the socket bridge inside Blender. Requires the add-on's "Auto Start" (or a
manual start from its preferences) and Blender's "Allow Online Access";
without online access the autostart timer never registers and nothing
listens on 9876.
"""
import socket
import json
import sys


def main() -> None:
    code = open(sys.argv[1], encoding="utf-8").read()
    req = json.dumps({"type": "execute", "code": code, "strict_json": True})
    s = socket.create_connection(("localhost", 9876), timeout=15)
    s.sendall(req.encode("utf-8") + b"\x00")
    data = b""
    while not data.endswith(b"\x00"):
        chunk = s.recv(65536)
        if not chunk:
            break
        data += chunk
    print(data[:-1].decode("utf-8"))


if __name__ == "__main__":
    main()
