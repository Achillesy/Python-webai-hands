// webai-hands extension service worker
// M1: click icon → ping local host → pong returns, badge flips to ✓ (bridge acceptance).
// M2: content script delivers exec via long-lived Port → forwarded to host via Native Messaging →
//     host's result / progress return to the content script the same way. Icon badge = status:
//     … running, ✓ ready/done, ✕ disconnected.
// M4: machine_id (UUID) from pong is cached into chrome.storage.local,
//     for the content script to read for strict-addressing routing. hostname kept only as a human-readable label.
const MACHINE_KEY = "mh_machine_id";

const HOST = "com.webai.hands";
const HOSTNAME_KEY = "mh_local_hostname";
const PLATFORM_KEY = "mh_platform";
let nativePort = null;
const pending = new Map(); // exec id -> {port, session, gen}
const fileBuf = new Map(); // read_file id -> accumulated file_chunks
let fileBufTimer = null; // P1-1: single-shot timeout guard for incomplete fileBuf
const pingTests = new Map(); // ping_test id -> {timer, sendResponse} (approach 2: popup bridge test)

// ---------- Layer 1 scheduler ----------
// host executes globally in order; background keeps an in-memory FIFO, one at a time to host.
// session: generated per page load by the content script; gen: generation, +1 on stop, old generations all expire.
// cross-session when busy gets a 5s grace; still busy → reject (never enters host queue); same-session bursts queue unbounded.
const portGen = new Map();  // pagePort -> current generation (default 0)
const schedQueue = [];      // [{port, kind, msg, session, gen, graceTimer}]
let hostBusy = false;
let running = null;         // {id, port, session, gen, cmd, startTime}
const GRACE_MS = 5000;

function curGenOf(port) {
  const g = portGen.get(port);
  return (typeof g === "number") ? g : 0;
}

function dropSchedItem(item) {
  if (item.graceTimer) { clearTimeout(item.graceTimer); item.graceTimer = null; }
}

// take the next sendable item from the head: skip expired generations; one at a time
function pump() {
  if (hostBusy) return;
  while (schedQueue.length) {
    const item = schedQueue[0];
    if (item.gen < curGenOf(item.port)) {
      schedQueue.shift();
      dropSchedItem(item);
      continue;
    }
    schedQueue.shift();
    dropSchedItem(item);  // cancel grace timer before forwarding
    forwardToHost(item);
    return;
  }
}

function forwardToHost(item) {
  hostBusy = true;
  const desc = item.kind === "exec"
    ? String(item.msg.cmd || "")
    : ("read_file:" + item.msg.path);
  running = { id: item.msg.id, port: item.port, session: item.session,
              gen: item.gen, cmd: desc, startTime: Date.now() };
  pending.set(item.msg.id, { port: item.port, session: item.session, gen: item.gen });
  setBadge("…", "#616161");
  try {
    if (item.kind === "exec") {
      ensureNativePort().postMessage({
        type: "exec",
        id: item.msg.id,
        cmd: item.msg.cmd,
        shell: item.msg.shell || undefined,
        timeout: item.msg.timeout || undefined,
        session: item.session,
        gen: item.gen,
      });
    } else {
      ensureNativePort().postMessage({
        type: "read_file", id: item.msg.id, path: item.msg.path,
        session: item.session, gen: item.gen,
      });
    }
  } catch (e) {
    hostBusy = false;
    running = null;
    pending.delete(item.msg.id);
    try {
      item.port.postMessage({ type: "error", id: item.msg.id, gen: item.gen,
        error: "failed to send to local host: " + e.message });
    } catch (err) {}
    setBadge("✕", "#c62828");
    pump();
  }
}

function enqueue(port, kind, msg) {
  const g = (typeof msg.gen === "number") ? msg.gen : curGenOf(port);
  if (g < curGenOf(port)) return;  // expired generation, ignore
  const item = { port, kind, msg,
                 session: msg.session || "", gen: g, graceTimer: null };
  // 5s grace: only timed for cross-session while host is busy; same-session bursts queue unbounded;
  // read_file skips the grace policy (queues only).
  if (kind === "exec" && hostBusy && running && item.session !== running.session) {
    item.graceTimer = setTimeout(() => {
      item.graceTimer = null;
      const idx = schedQueue.indexOf(item);
      if (idx < 0) return;  // already forwarded or voided
      schedQueue.splice(idx, 1);
      const secs = running ? Math.round((Date.now() - running.startTime) / 1000) : 0;
      const rcmd = running ? String(running.cmd).slice(0, 200) : "";
      try {
        item.port.postMessage({ type: "busy", id: item.msg.id,
          session: item.session, gen: item.gen,
          running_cmd: rcmd, running_for_s: secs,
          rejected_cmd: String(item.msg.cmd || "").slice(0, 200) });
      } catch (e) {}
      console.log("[webai-hands] 5s grace elapsed, rejecting cross-session command " + item.msg.id);
    }, GRACE_MS);
  }
  schedQueue.push(item);
  pump();
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function ensureNativePort() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST);
  nativePort.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "pong") {
      setBadge("✓", "#2e7d32");
      // M4 strict addressing: cache local machine_id (UUID) for the content script's routing decisions;
      // hostname kept only as a human-readable label.
      try {
        const obj = {};
        if (msg.hostname) obj[HOSTNAME_KEY] = msg.hostname;
        if (msg.machine_id) {
          obj[MACHINE_KEY] = msg.machine_id;
          console.log("[webai-hands] pong cached machine_id=" + msg.machine_id);
        }
        if (msg.platform) obj[PLATFORM_KEY] = msg.platform;
        if (Object.keys(obj).length) chrome.storage.local.set(obj);
      } catch (e) {}
      // approach 2: popup "test bridge" pongs are claimed here by id (pingtest- prefix).
      // this tests the link commands really travel — previously popup connected its own port, so "connected" could be a false green
      // (2026-10-04 live-site lesson: popup showed connected while background never built a port).
      var pt = pingTests.get(msg.id);
      if (pt) {
        pingTests.delete(msg.id);
        clearTimeout(pt.timer);
        try { pt.sendResponse({ ok: true, hostname: msg.hostname,
          machine_id: msg.machine_id, platform: msg.platform }); } catch (e) {}
      }
      return;
    }
    if (msg.type === "file_chunk") {
      var buf = fileBuf.get(msg.id);
      if (!buf) {
        buf = { name: msg.name, mime: msg.mime, size: msg.size,
                total: msg.total, chunks: [] };
        fileBuf.set(msg.id, buf); if (fileBufTimer) clearTimeout(fileBufTimer); fileBufTimer = setTimeout(function(){ for (var fid of fileBuf.keys()) { var e3 = pending.get(fid); if (e3 && e3.port) { try { e3.port.postMessage({type:"error",id:fid,gen:e3.gen,error:"file timeout 30s"}); } catch (ee) {} } pending.delete(fid); } fileBuf.clear(); hostBusy = false; running = null; setBadge("X","#c62828"); pump(); }, 30000);
      }
      buf.chunks[msg.index] = msg.data;
      var got = 0;
      for (var k = 0; k < buf.chunks.length; k++) if (buf.chunks[k] != null) got++;
      if (got === buf.total) {
        const entry = pending.get(msg.id);
        const pg = entry && entry.port;
        fileBuf.delete(msg.id);
        pending.delete(msg.id);
        hostBusy = false;
        running = null;
        if (pg && entry.gen === curGenOf(pg)) {
          try {
            pg.postMessage({ type: "file", id: msg.id, gen: entry.gen, name: buf.name,
                             mime: buf.mime, size: buf.size,
                             b64: buf.chunks.join("") });
          } catch (e) {}
        } else if (pg) {
          console.log("[webai-hands] dropping expired-generation file id=" + msg.id);
        }
        pump();
      }
      return;
    }
    if (msg.type === "result" || msg.type === "error" || msg.type === "progress") {
      const entry = pending.get(msg.id);
      const page = entry && entry.port;
      if (msg.type !== "progress") {
        pending.delete(msg.id);
        hostBusy = false;
        running = null;
      }
      if (page) {
        if (entry.gen === curGenOf(page)) {
          try {
            page.postMessage(Object.assign({}, msg, { gen: entry.gen }));
          } catch (e) {
            /* page closed, just drop it */
          }
        } else {
          console.log("[webai-hands] dropping expired generation " + msg.type + " id=" + msg.id +
                      " gen=" + entry.gen + " current=" + curGenOf(page));
        }
      }
      if (msg.type === "result") setBadge("✓", "#2e7d32");
      if (msg.type === "error") setBadge("✕", "#c62828");
      if (msg.type !== "progress") pump();
    }
  });
  nativePort.onDisconnect.addListener(() => {
    console.log("[webai-hands] native port disconnected:", chrome.runtime.lastError);
    nativePort = null;
    hostBusy = false;
    running = null;
    setBadge("✕", "#c62828");
    for (const [id, entry] of pending) {
      try {
        entry.port.postMessage({ type: "error", id, gen: entry.gen,
                                 error: "local host disconnected" });
      } catch (e) {}
    }
    pending.clear();
    fileBuf.clear();
    // approach 2: when host disconnects, pending bridge tests error out immediately instead of waiting for the 10s timeout
    for (const [pid, pt] of pingTests) {
      clearTimeout(pt.timer);
      try { pt.sendResponse({ ok: false, error: "local host disconnected" }); } catch (e) {}
    }
    pingTests.clear();
    // queued-but-unsent items error out too; never silently swallowed
    while (schedQueue.length) {
      const it = schedQueue.shift();
      dropSchedItem(it);
      try {
        it.port.postMessage({ type: "error", id: it.msg.id, gen: it.gen,
          error: "local host disconnected (queued)" });
      } catch (e) {}
    }
  });
  // §6.7 precondition: ping on connect; pong returns hostname, cached to storage.
  // can't rely on the user clicking the icon — manifest sets default_popup, so onClicked never fires.
  // approach 2: popup "test bridge" no longer connects directly; everything goes through this port (tests the real link).
  try { nativePort.postMessage({ type: "ping", id: "__init__" + Date.now() }); } catch (e) {}
  return nativePort;
}

chrome.action.onClicked.addListener(() => {
  setBadge("…", "#616161");
  try {
    ensureNativePort().postMessage({ type: "ping", id: "m1-" + Date.now() });
  } catch (e) {
    console.error("[webai-hands] connectNative failed:", e);
    setBadge("✕", "#c62828");
  }
});

chrome.runtime.onConnect.addListener((pagePort) => {
  if (pagePort.name !== "webai-hands") return;
  // M4: content script builds the native port and pings on connect (ensureNativePort sends an __init__ ping internally),
  // pong returns machine_id/hostname/platform, cached to storage.
  // must not wait for the first command to connect — otherwise machine_id is never available before it arrives,
  // and every block would be deferred under strict addressing (bug found in 2026-10-04 live-site testing).
  try { ensureNativePort(); } catch (e) {}
  pagePort.onMessage.addListener((msg) => {
    if (msg && msg.type === "exec" && msg.id && msg.cmd) {
      enqueue(pagePort, "exec", msg);
    } else if (msg && msg.type === "read_file" && msg.id && msg.path) {
      enqueue(pagePort, "read_file", msg);
    } else if (msg && msg.type === "stop") {
      // user hit stop: generation advances, all queued items of old generations in this session are voided
      const g = (typeof msg.gen === "number") ? msg.gen : curGenOf(pagePort) + 1;
      portGen.set(pagePort, g);
      for (let i = schedQueue.length - 1; i >= 0; i--) {
        const it = schedQueue[i];
        if (it.port === pagePort && it.gen < g) {
          schedQueue.splice(i, 1);
          dropSchedItem(it);
        }
      }
      console.log("[webai-hands] received stop: session=" + (msg.session || "") + " gen=" + g);
    }
  });
  pagePort.onDisconnect.addListener(() => {
    for (const [id, entry] of pending) if (entry.port === pagePort) pending.delete(id);
    for (let i = schedQueue.length - 1; i >= 0; i--) {
      if (schedQueue[i].port === pagePort) {
        dropSchedItem(schedQueue[i]);
        schedQueue.splice(i, 1);
      }
    }
    portGen.delete(pagePort);
  });
});
// ---------- approach 2: popup "test bridge" goes through background's native port ----------
// popup sends {type:"ping_test"}; here ensureNativePort() sends the ping, pong is claimed by id
// and returned to popup. Tests the link commands really travel, not a parallel channel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "ping_test") return false;
  var pid = "pingtest-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  var timer = setTimeout(function () {
    pingTests.delete(pid);
    try { sendResponse({ ok: false, error: "host silent (10s timeout)" }); } catch (e) {}
  }, 10000);
  try {
    pingTests.set(pid, { timer: timer, sendResponse: sendResponse });
    ensureNativePort().postMessage({ type: "ping", id: pid });
  } catch (e) {
    pingTests.delete(pid);
    clearTimeout(timer);
    try { sendResponse({ ok: false, error: "failed to reach host: " + e.message }); } catch (ee) {}
  }
  return true; // async response; keep the message channel open
});

// ---------- Onboarding: open setup page after install ----------
// The extension is useless without the local host; the setup page stays
// in setup state until the host answers (no one-time dismiss).
chrome.runtime.onInstalled.addListener(function (details) {
  if (details && details.reason === "install") {
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
    } catch (e) {}
  }
});
