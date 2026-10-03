// webai-hands 扩展 service worker
// M1：点图标 → ping 本地 host → pong 回来徽标变 ✓（通桥验收）。
// M2：内容脚本经长连接 Port 递来 exec → 转 Native Messaging 给 host →
//     host 的 result / progress 沿原路回内容脚本。图标徽标即状态：
//     … 执行中、✓ 就绪/完成、✕ 断开。
// M4 预备：pong 里的 hostname 缓存进 chrome.storage.local，
//          供内容脚本读取，做 §6.7 hostname 路由。

const HOST = "com.webai.hands";
const HOSTNAME_KEY = "mh_local_hostname";
let nativePort = null;
const pending = new Map(); // exec id -> 页面 Port
const fileBuf = new Map(); // read_file id -> 累积的 file_chunk

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
      // §6.7：缓存本机 hostname，供内容脚本做路由判断
      if (msg.hostname) {
        try {
          const obj = {};
          obj[HOSTNAME_KEY] = msg.hostname;
          chrome.storage.local.set(obj);
        } catch (e) {}
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
        var pg = pending.get(msg.id);
        fileBuf.delete(msg.id);
        pending.delete(msg.id);
        if (pg) {
          try {
            pg.postMessage({ type: "file", id: msg.id, name: buf.name,
                             mime: buf.mime, size: buf.size,
                             b64: buf.chunks.join("") });
          } catch (e) {}
        }
      }
      return;
    }
    if (msg.type === "result" || msg.type === "error" || msg.type === "progress") {
      const page = pending.get(msg.id);
      if (msg.type !== "progress" && page) pending.delete(msg.id);
      if (page) {
        try {
          page.postMessage(msg);
        } catch (e) {
          /* 页面已关，丢掉即可 */
        }
      }
      if (msg.type === "result") setBadge("✓", "#2e7d32");
      if (msg.type === "error") setBadge("✕", "#c62828");
    }
  });
  nativePort.onDisconnect.addListener(() => {
    console.log("[webai-hands] native port disconnected:", chrome.runtime.lastError);
    nativePort = null;
    setBadge("✕", "#c62828");
    for (const [id, page] of pending) {
      try {
        page.postMessage({ type: "error", id, error: "本地 host 连接已断开" });
      } catch (e) {}
    }
    pending.clear();
    fileBuf.clear();
  });
  // §6.7 前置条件：建连即 ping，pong 带回 hostname 并缓存到 storage。
  // 不能依赖用户点图标 —— manifest 配了 default_popup，onClicked 不会触发；
  // popup 的"测通桥"走自己的直连端口，pong 不经过这里。
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
  pagePort.onMessage.addListener((msg) => {
    if (msg && msg.type === "exec" && msg.id && msg.cmd) {
      try {
        pending.set(msg.id, pagePort);
        setBadge("…", "#616161");
        ensureNativePort().postMessage({
          type: "exec",
          id: msg.id,
          cmd: msg.cmd,
          shell: msg.shell || undefined,
          timeout: msg.timeout || undefined,
        });
      } catch (e) {
        pending.delete(msg.id);
        try {
          pagePort.postMessage({
            type: "error",
            id: msg.id,
            error: "发往本地 host 失败：" + e.message,
          });
        } catch (err) {}
        setBadge("✕", "#c62828");
      }
    } else if (msg && msg.type === "read_file" && msg.id && msg.path) {
      try {
        pending.set(msg.id, pagePort);
        setBadge("…", "#616161");
        ensureNativePort().postMessage({
          type: "read_file", id: msg.id, path: msg.path,
        });
      } catch (e) {
        pending.delete(msg.id);
        try {
          pagePort.postMessage({ type: "error", id: msg.id,
            error: "read_file 发往 host 失败：" + e.message });
        } catch (err) {}
        setBadge("✕", "#c62828");
      }
    }
  });
  pagePort.onDisconnect.addListener(() => {
    for (const [id, p] of pending) if (p === pagePort) pending.delete(id);
  });
});