# webai-hands

[Chinese](README_zh.md)

> Give web AI a pair of hands: type in a chat page, your computer does the work.

## What is this?

Open a **free** web AI (Muse, DeepSeek) and let this extension control
your computer.

The web AI is no longer just a chat box — you ask, it answers, and you do
the running around yourself. Now it has hands: tell it what to do, and it
does it for you.

Unlike AI companions you install on your machine, the web AI needs no API
key. You are not hiring an assistant — you are giving a free AI teacher a
pair of working hands.

**In one line**: web AI's brain + your computer's hands = a free agent.

## Quick start

**1. Install the extension**

Get **webai-hands** from the Chrome Web Store (free, updates automatically):

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/pboakanoekehbongkmaeianbkebpfahl)

**2. Install the local helper — one command**

Copy the line for your system, paste it into a terminal, press Enter.
It installs a small helper into `~/.webai-hands/` and registers it with Chrome.
No admin rights needed.

macOS / Linux:
```bash
curl -fsSL https://raw.githubusercontent.com/Achillesy/Python-webai-hands/main/native-host/install.py | python3
```

Windows (PowerShell):
```powershell
py -3 -c "import urllib.request; exec(urllib.request.urlopen('https://raw.githubusercontent.com/Achillesy/Python-webai-hands/main/native-host/install.py').read())"
```

**3. Test the bridge, copy your machine ID**

Click the **webai-hands** icon in the Chrome toolbar, then **Test Bridge**.
- "Connected …" → the bridge is up.
- Click **Copy UUID** — every command you send must carry this ID so it reaches *your* computer.

**4. Send your first command**

Open [muse.ai](https://muse.ai) (free), start a chat, and paste this block
(replace `PASTE-YOUR-UUID-HERE` with the UUID you just copied):

```muse-exec
{"muse":"exec","v":2,"id":"ls-001","host":"PASTE-YOUR-UUID-HERE","cmd":"ls ~"}
```

Your computer lists your home directory, and the result appears in the chat.
From now on, just talk:

> "List the 10 biggest files in my Downloads folder."

Every command block needs `"v":2`, a unique `"id"`, and your `"host"` UUID.

**5. Uninstall — clean removal**

Nothing phones home, nothing stays resident. One command removes the helper,
its Chrome registration, logs, and data:

macOS / Linux:
```bash
curl -fsSL https://raw.githubusercontent.com/Achillesy/Python-webai-hands/main/native-host/uninstall.py | python3 - --yes
```

Windows (PowerShell):
```powershell
py -3 -c "import urllib.request,sys; sys.argv=['u','--yes']; exec(urllib.request.urlopen('https://raw.githubusercontent.com/Achillesy/Python-webai-hands/main/native-host/uninstall.py').read())"
```

What gets deleted:
- the Chrome native-messaging registration
- `~/.webai-hands/` — program, logs, skills, machine identity

Then optionally remove the extension at `chrome://extensions`. No leftovers.

## Using it every day

The AI needs its manual in context. Which file depends on the site:

| Site | How to give the AI its manual |
|---|---|
| **DeepSeek** (no long-term memory) | New task → new chat → upload `AI-GUIDE.md`. Every fresh chat needs the file again. |
| **Muse** (long-term memory) | Upload `AI-GUIDE.md` once and it remembers — or paste the GitHub link and let it read the project itself. |

Which file to give the AI:

- Everyday use → `AI-GUIDE.md`
- Drive Blender → `AI-BLENDER.md`

## What can it do?

Anything you can do in a terminal:

- Organize files, search your disk, batch-rename photos
- Git: status, pull, commit, push — without the command line
- Drive Blender: create objects, move things, render
- Send files (PDFs, code, images) to the AI as real chat attachments

## For developers

Small project: a Chrome MV3 extension plus a Python host. Adding a new
website = one adapter file (~30–60 lines) + one line in `manifest.json`
(see `extension/adapters/` for examples).

## Security

- The local program opens **no network ports**; it talks only to this extension (ID-checked)
- It never sees your passwords; anything needing admin rights pops a system dialog for **you** to approve
- The AI must show you a destructive command and get your OK first

## Support

webai-hands is free. If it saves you time, buy me a coffee:

- [Ko-fi](https://ko-fi.com/achillesy)
- [PayPal](https://paypal.me/achillesnewman)

China users can scan:

| WeChat | Alipay |
|---|---|
| ![](sponsor/wechat.jpg) | ![](sponsor/alipay.jpg) |

Support is voluntary and changes nothing about the software.

## License

Free for non-commercial use. Copyright © 2026 Achillesy. Commercial use
or resale is not allowed. See [LICENSE](LICENSE).
