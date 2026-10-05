# Chrome Web Store submission checklist

## Ready (in the repo)

- [x] `store/webai-hands-store-0.4.0.zip` — release package (`bash store/build.sh` rebuilds it;
      dev `key` stripped; first store upload assigns a new extension ID)
- [x] Icons 16/48/128 (`extension/icons/`, referenced from the manifest)
- [x] Store descriptions `store/listing-en.txt` / `store/listing-zh.txt`
- [x] LICENSE (noncommercial), privacy notes (see below)

## To do by hand in the developer dashboard

1. **Screenshots** (required, at least 1; 3–5 recommended):
   - 1280×800 or 640×400
   - Suggested content: 1. send a command block in a DeepSeek chat → result filled back; 2. attach file upload;
     3. the extension popup panel; 4. Blender being driven
   - Capture while actually operating it in Chrome on your M1 (a developer-mode loaded build is fine)
2. **Small promo tile** (optional but recommended): 440×280
3. Go to the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) →
   new item → upload zip → fill in the description (paste from `listing-*.txt`) → pick a category
   (suggest Productivity) → language: English (default) + Chinese
4. **Privacy questionnaire**: answer as follows
   - Collects user data: no (the extension itself collects, transmits, and stores no user data)
   - `nativeMessaging` permission purpose: communicate with the open-source host program the user installed on their own machine,
     executing commands the user explicitly gave in chat; traffic stays on local stdio, no network ports
   - Remote code: no (all extension code is inside the package; the host is an open-source program the user installs by hand)
5. Submit for review (new items usually take a few hours to a few days)

## After going live (required, otherwise the host can't connect)

1. Note down the **new extension ID** assigned by the store.
2. Update the allowlist/template in `native-host/install.py` (and the Windows bat),
   adding the new ID (or replacing the dev ID).
3. Tell users in the release notes: after installing the store version, **re-run install** (the host must recognize the new ID).
4. Keep the dev build (`aaemlgedddakpgkfoakfmkdiiheplgnl`) for developers' own use;
   the two IDs don't interfere with each other.

## Privacy notes (for the dashboard questionnaire / store page)

> The webai-hands extension itself collects, transmits, and stores no user data; no ads,
> no tracking. The `nativeMessaging` permission is only used to communicate with the open-source
> host program the user installed by hand on their own machine (Chrome's official Native Messaging, local stdio, no network ports),
> executing commands the user explicitly gave in an AI chat. File uploads require the AI to ask for them in the chat;
> sensitive paths (SSH keys, browser cookies, .env, etc.) are always refused; single-file cap 25MB.
