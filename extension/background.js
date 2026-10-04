// webai-hands 扩展 service worker
// M1：点图标 → ping 本地 host → pong 回来徽标变 ✓（通桥验收）。
// M2：内容脚本经长连接 Port 递来 exec → 转 Native Messaging 给 host →
//     host 的 result / progress 沿原路回内容脚本。图标徽标即状态：
//     … 执行中、✓ 就绪/完成、✕ 断开。
// M4：pong 里的 machine_id（UUID）缓存进 chrome.storage.local，
//     供内容脚本读取，做严格点名路由。hostname 只保留做人类可读标签。
const MACHINE_KEY = "mh_machine_id";

const HOST = "com.webai.hands";
const HOSTNAME_KEY = "mh_local_hostname";
const PLATFORM_KEY = "mh_platform";
let nativePort = null;
const pending = new Map(); // exec id -> {port, session, gen}
const fileBuf = new Map(); // read_file id -> 累积的 file_chunk
const pingTests = new Map(); // ping_test id -> {timer, sendResponse}（办法二：popup 测通桥）

// ---------- Layer 1 调度器 ----------
// host 全局顺序执行；background 做内存 FIFO，一次只发一个给 host。
// session：内容脚本每页加载生成；gen：代数，点停止即 +1，旧代全部过期。
// 跨 session 遇忙给 5 秒宽限，仍忙则拒绝（不进 host 队列）；同 session 突发无限排队。
const portGen = new Map();  // pagePort -> 当前代数（默认 0）
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

// 从队首取可发的项：过期代跳过；一次只发一个
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
    dropSchedItem(item);  // 转发前取消宽限计时
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
        error: "发往本地 host 失败：" + e.message });
    } catch (err) {}
    setBadge("✕", "#c62828");
    pump();
  }
}

function enqueue(port, kind, msg) {
  const g = (typeof msg.gen === "number") ? msg.gen : curGenOf(port);
  if (g < curGenOf(port)) return;  // 过期代，直接忽略
  const item = { port, kind, msg,
                 session: msg.session || "", gen: g, graceTimer: null };
  // 5 秒宽限：跨 session 且 host 正忙时才计时；同 session 突发无限排队；
  // read_file 不进宽限策略（只排队）。
  if (kind === "exec" && hostBusy && running && item.session !== running.session) {
    item.graceTimer = setTimeout(() => {
      item.graceTimer = null;
      const idx = schedQueue.indexOf(item);
      if (idx < 0) return;  // 已转发或已作废
      schedQueue.splice(idx, 1);
      const secs = running ? Math.round((Date.now() - running.startTime) / 1000) : 0;
      const rcmd = running ? String(running.cmd).slice(0, 200) : "";
      try {
        item.port.postMessage({ type: "busy", id: item.msg.id,
          session: item.session, gen: item.gen,
          running_cmd: rcmd, running_for_s: secs,
          rejected_cmd: String(item.msg.cmd || "").slice(0, 200) });
      } catch (e) {}
      console.log("[webai-hands] 5 秒宽限已过，拒绝跨 session 命令 " + item.msg.id);
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
      // M4 严格点名：缓存本机 machine_id（UUID），供内容脚本做路由判断；
      // hostname 只保留做人类可读标签。
      try {
        const obj = {};
        if (msg.hostname) obj[HOSTNAME_KEY] = msg.hostname;
        if (msg.machine_id) {
          obj[MACHINE_KEY] = msg.machine_id;
          console.log("[webai-hands] pong 已缓存 machine_id=" + msg.machine_id);
        }
        if (msg.platform) obj[PLATFORM_KEY] = msg.platform;
        if (Object.keys(obj).length) chrome.storage.local.set(obj);
      } catch (e) {}
      // 办法二：popup"测通桥"的 pong 按 id 在这里认领（pingtest- 前缀）。
      // 测的是命令真正走的链路 —— 此前 popup 直连自己的端口，"已连接"可能是假绿
      // （2026-10-04 真站教训：popup 显示已连接，background 端口一次都没建过）。
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
        fileBuf.set(msg.id, buf);
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
          console.log("[webai-hands] 丢弃过期代文件 id=" + msg.id);
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
            /* 页面已关，丢掉即可 */
          }
        } else {
          console.log("[webai-hands] 丢弃过期代 " + msg.type + " id=" + msg.id +
                      " 代=" + entry.gen + " 当前=" + curGenOf(page));
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
                                 error: "本地 host 连接已断开" });
      } catch (e) {}
    }
    pending.clear();
    fileBuf.clear();
    // 办法二：host 断开时，未完成的测通桥也立即报错，不让它等到 10 秒超时
    for (const [pid, pt] of pingTests) {
      clearTimeout(pt.timer);
      try { pt.sendResponse({ ok: false, error: "本地 host 连接已断开" }); } catch (e) {}
    }
    pingTests.clear();
    // 排队未发的也一并报错，不静默吞掉
    while (schedQueue.length) {
      const it = schedQueue.shift();
      dropSchedItem(it);
      try {
        it.port.postMessage({ type: "error", id: it.msg.id, gen: it.gen,
          error: "本地 host 连接已断开（排队中）" });
      } catch (e) {}
    }
  });
  // §6.7 前置条件：建连即 ping，pong 带回 hostname 并缓存到 storage。
  // 不能依赖用户点图标 —— manifest 配了 default_popup，onClicked 不会触发。
  // 办法二：popup"测通桥"也不再直连，统一走这里的端口（测真链路）。
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
  // M4：内容脚本建连即建 native 端口并 ping（ensureNativePort 内部发 __init__ ping），
  // pong 带回 machine_id/hostname/platform 缓存到 storage。
  // 不能等到首个命令才建连 —— 否则 machine_id 在首个命令到来前永远拿不到，
  // 严格点名下所有块都会被暂缓（2026-10-04 真站实测发现此 bug）。
  try { ensureNativePort(); } catch (e) {}
  pagePort.onMessage.addListener((msg) => {
    if (msg && msg.type === "exec" && msg.id && msg.cmd) {
      enqueue(pagePort, "exec", msg);
    } else if (msg && msg.type === "read_file" && msg.id && msg.path) {
      enqueue(pagePort, "read_file", msg);
    } else if (msg && msg.type === "stop") {
      // 用户点了停止：代数推进，本会话旧代排队项全部作废
      const g = (typeof msg.gen === "number") ? msg.gen : curGenOf(pagePort) + 1;
      portGen.set(pagePort, g);
      for (let i = schedQueue.length - 1; i >= 0; i--) {
        const it = schedQueue[i];
        if (it.port === pagePort && it.gen < g) {
          schedQueue.splice(i, 1);
          dropSchedItem(it);
        }
      }
      console.log("[webai-hands] 收到 stop：session=" + (msg.session || "") + " 代=" + g);
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
// ---------- 办法二：popup"测通桥"走 background 的 native 端口 ----------
// popup 发 {type:"ping_test"}，这里经 ensureNativePort() 发 ping，pong 按 id
// 认领后回给 popup。测的是命令真正走的链路，不是平行通道。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "ping_test") return false;
  var pid = "pingtest-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  var timer = setTimeout(function () {
    pingTests.delete(pid);
    try { sendResponse({ ok: false, error: "host 无回音（10 秒超时）" }); } catch (e) {}
  }, 10000);
  try {
    pingTests.set(pid, { timer: timer, sendResponse: sendResponse });
    ensureNativePort().postMessage({ type: "ping", id: pid });
  } catch (e) {
    pingTests.delete(pid);
    clearTimeout(timer);
    try { sendResponse({ ok: false, error: "连接 host 失败：" + e.message }); } catch (ee) {}
  }
  return true; // 异步回包，保持消息通道
});
