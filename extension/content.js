// webai-hands 内容脚本（核心层，与站点无关）
//
// 架构：核心层 + 适配器层（每站点一份）。
// 适配器通过 window.__museHandsAdapters[hostname] 注册；
// 核心层按 location.hostname 选一个，调用它的：
//   findBlocks()  → 返回候选元素数组
//   fillResult()  → 填回输入框，返回 bool
//   clickSend()   → 点发送，返回 bool
// 新加一个 Web AI = 新加 adapters/xxx.js + 在 manifest 里注册，
// 核心层零改动。
//
// 规矩：抓到块递给本地 host 真执行；结果只填回、不自动发送
//（除非用户在扩展面板里亲手开了自动发送）；已执行的 id 写
// chrome.storage.local，刷新页面不重演历史命令。

(function () {
'use strict';

var STABLE_MS = 1000;
var VERSION = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : "?";
var MAX_RESULT = 6000;
var KEEP_HEAD = 2000;
var KEEP_TAIL = 3500;
var STORE_KEY = 'mh_processed_ids';
var AUTO_KEY = 'mh_auto_send';
var HOSTNAME_KEY = 'mh_local_hostname';
var MACHINE_KEY = 'mh_machine_id';
var PLATFORM_KEY = 'mh_platform';

// ---------- 选适配器 ----------
var adapters = window.__museHandsAdapters || {};
var adapter = adapters[location.hostname] || null;
if (!adapter) {
  console.log('[webai-hands] 当前站点无适配器：' + location.hostname + '，内容脚本不启用');
  return;
}
// 适配器可声明 isActive() 做页面级开关（www.google.com 只有 AI Mode 页生效，
// 普通搜索页不启用）。SPA 客户端路由不重跑 content script，故此处不直接 return，
// 由 scan() 每次惰性检查；页面变化后自动生效/失效。
function adapterActive() {
  try { return !adapter.isActive || adapter.isActive(); }
  catch (e) { return false; }
}
if (adapterActive()) {
  console.log('[webai-hands] 适配器已选中：' + adapter.name + '（' + location.hostname + '）');
} else {
  console.log('[webai-hands] 适配器已选中：' + adapter.name + '，但当前页面不适用，等待页面变化');
}
// 适配器可声明 blockText(el) 自定义块文本提取（默认 el.innerText）。
// Google AI Mode 的代码块容器首行是语言标签，需跳到 JSON 行。
function blockTextOf(el) {
  try {
    if (adapter.blockText) return adapter.blockText(el) || '';
  } catch (e) {}
  return el.innerText || el.textContent || '';
}

// ---------- 状态 ----------
var processed = {};
var inFlight = {};
var cmdById = {};
var firstSeenAt = {};
var stableTimers = {};
var ready = false;
var pagePort = null;
var localHostname = null;
var localMachineId = null;  // M4 严格点名：本机 UUID（host 生成并持久化）
var localPlatform = null;
var incompleteAt = {};
var pendingResults = [];
var flushTimer = null;
var flushHardDeadline = 0;
var incompleteWarned = {};
var attachMeta = {};
var baselineIds = {};
var ctxChars = 0;
var ctxWarned = false;
var PLACEHOLDER_IDS = { "唯一id": 1, "任意唯一id": 1, "your-id": 1, "example": 1, "示例": 1, "xxx": 1 };

var WARMUP_MIN_MS = 2000;
var WARMUP_QUIET_MS = 3000;
var WARMUP_MAX_MS = 12000;
var warmupStart = Date.now();
var warmupDone = false;
var warmupQuietTimer = null;
var userAborted = false;
var selfActing = false;

// ---------- 会话与代数（Layer 1 调度 / 优雅停止） ----------
// SESSION：本页面一次加载的逻辑会话 id；gen：代数，点停止即 +1，旧代全部过期。
var SESSION = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
var gen = 0;

// 预热结束条件（任一满足即结束）：
//  1. DOM 静默 WARMUP_QUIET_MS（且距启动已过 WARMUP_MIN_MS）；
//  2. 兜底：启动 WARMUP_MAX_MS 后第一次 scan 时强制结束。
// 注意静默检测必须用独立 timer：scan 只在 mutation 后 300ms 跑，
// 在 inWarmup 里永远观测不到"3 秒静默"。
function pokeWarmup() {
  if (warmupDone) return;
  if (warmupQuietTimer) clearTimeout(warmupQuietTimer);
  warmupQuietTimer = setTimeout(function () {
    if (!warmupDone && Date.now() - warmupStart >= WARMUP_MIN_MS) {
      warmupDone = true;
      warmupQuietTimer = null;
      console.log('[webai-hands] 预热结束（静默），此后出现的块才会执行');
    }
  }, WARMUP_QUIET_MS);
}

function inWarmup() {
  if (warmupDone) return false;
  if (Date.now() - warmupStart >= WARMUP_MAX_MS) {
    warmupDone = true;
    if (warmupQuietTimer) { clearTimeout(warmupQuietTimer); warmupQuietTimer = null; }
    console.log('[webai-hands] 预热结束（超时），此后出现的块才会执行');
    return false;
  }
  return true;
}

function abortChain(reason) {
  if (userAborted) return;
  userAborted = true;
  console.log('[webai-hands] 链中止：' + reason);
  var nTimers = Object.keys(stableTimers).length;
  var nFlight = Object.keys(inFlight).length;
  Object.keys(stableTimers).forEach(function (k) { clearTimeout(stableTimers[k]); delete stableTimers[k]; });
  Object.keys(inFlight).forEach(function (id) { delete inFlight[id]; });
  Object.keys(cmdById).forEach(function (id) { delete cmdById[id]; });
  Object.keys(attachMeta).forEach(function (id) { delete attachMeta[id]; });
  // 中止前已见过（含正在稳定等待、尚无正文的块）一律吞掉：
  // 之后链重新武装时它们不再复活，只有真正的新块才会执行。
  Object.keys(firstSeenAt).forEach(function (id) { markProcessed(id); });
  firstSeenAt = {};
  Object.keys(incompleteAt).forEach(function (id) { delete incompleteAt[id]; });
  Object.keys(incompleteWarned).forEach(function (id) { delete incompleteWarned[id]; });
  pendingResults = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushHardDeadline = 0;
  // 代数 +1：旧代命令/结果全部过期；通知 background 丢弃本会话排队项
  gen++;
  nagTotalThisGen = 0;  // 新一代重置 nag 熔断计数
  try { getPort().postMessage({ type: 'stop', session: SESSION, gen: gen }); } catch (e) {}
  // 有实际作废才代发通知：纯文本停止（无命令在跑）不打扰
  if (nTimers + nFlight > 0) sendCancelNotice(gen, nTimers, nFlight);
}

// 停止后代发一条用户消息（真发送）：既给用户可见确认，也让 AI 停手不再发新块。
// 不走 mh_auto_send 开关 —— 用户亲手点的停止，通知必发；发送失败退化为只填不发。
function sendCancelNotice(curGen, nTimers, nFlight) {
  var text = '⏹ [webai-hands 代发] 用户点击了停止按钮：第 ' + curGen + ' 代命令已全部作废' +
    '（取消 ' + nTimers + ' 个待发，' + nFlight + ' 个执行中结果不再回填）。' +
    '请暂停当前任务，等候用户下一步指令，不要发送新的命令块。';
  var ok = false;
  try { ok = adapter.fillResult(text); } catch (e) { ok = false; }
  if (ok) {
    console.log('[webai-hands] 停止通知已填回，500ms 后发送');
    setTimeout(trySend, 500);
  } else {
    console.log('[webai-hands] 停止通知填回失败，仅记录不打扰');
  }
}

// 只填不发（忙拒绝等通知用，不触发自动发送）
function fillOnly(text) {
  var ok = false;
  try { ok = adapter.fillResult(text); } catch (e) { ok = false; }
  if (!ok) console.log('[webai-hands] 通知填回失败：', String(text).slice(0, 200));
}

// ---------- 哨兵解析 ----------
function parseBlock(text) {
  var nl = text.indexOf('\n');
  var first = nl === -1 ? text : text.slice(0, nl);
  var head;
  try { head = JSON.parse(first); } catch (e) { return null; }
  if (!head || !head.id) return null;
  if (head.muse !== 'exec' && head.muse !== 'probe' && head.muse !== 'attach') return null;
  if (!(typeof head.v === 'number' && head.v >= 2)) return null;
  var cmdFromHead = (typeof head.cmd === 'string') ? head.cmd : null;
  var cmdFromBody = (nl === -1 ? '' : text.slice(nl + 1)).trim();
  return {
    kind: head.muse,
    id: String(head.id),
    host: head.host || null,
    shell: head.shell || null,
    timeout: head.timeout || null,
    sel: (typeof head.sel === 'string') ? head.sel : null,
    path: (typeof head.path === 'string') ? head.path : null,
    text: (typeof head.text === 'string') ? head.text : null,
    send: !!head.send,
    cmd: cmdFromHead !== null ? cmdFromHead : cmdFromBody
  };
}

function fingerprint(text) {
  var h = 0;
  for (var i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
  return text.length + ':' + h;
}

// ---------- 去重 ----------
function loadProcessed(done) {
  try {
    chrome.storage.local.get([STORE_KEY, HOSTNAME_KEY, MACHINE_KEY, PLATFORM_KEY], function (res) {
      var ids = (res && res[STORE_KEY]) || [];
      ids.forEach(function (id) { processed[id] = true; });
      if (res && res[HOSTNAME_KEY]) {
        localHostname = res[HOSTNAME_KEY];
        console.log('[webai-hands] 本机 hostname（缓存）：' + localHostname);
      }
      if (res && res[MACHINE_KEY]) {
        localMachineId = res[MACHINE_KEY];
        console.log('[webai-hands] 本机 machine_id（缓存）：' + localMachineId);
      }
      if (res && res[PLATFORM_KEY]) localPlatform = res[PLATFORM_KEY];
      if (!localMachineId) {
        // M4 严格点名前置条件：建连触发后台 ping host，延迟重试读取。
        // getPort() 会走到 background onConnect → ensureNativePort → ping → pong → 缓存。
        try { getPort(); } catch (e) {}
        retryMachineIdentity(0);
      }
      ready = true;
      if (done) done();
    });
  } catch (e) {
    ready = true;
    if (done) done();
  }
}

// 机器身份（machine_id）拿不到就重试几次（2s / 5s / 10s）。
// 严格点名要求 machine_id 就绪才执行块；拿不到时块暂缓（不标记 processed），
// 不沿用 hostname 时代的 fail-open。
function retryMachineIdentity(n) {
  var waits = [2000, 5000, 10000];
  if (n >= waits.length) {
    console.log('[webai-hands] 未拿到本机 machine_id：host 可能未安装或未启动，严格点名下块将暂缓执行');
    return;
  }
  setTimeout(function () {
    if (localMachineId) return;
    try {
      chrome.storage.local.get([HOSTNAME_KEY, MACHINE_KEY, PLATFORM_KEY], function (res) {
        if (res && res[HOSTNAME_KEY] && !localHostname) {
          localHostname = res[HOSTNAME_KEY];
          console.log('[webai-hands] 本机 hostname（延迟拿到）：' + localHostname);
        }
        if (res && res[MACHINE_KEY] && !localMachineId) {
          localMachineId = res[MACHINE_KEY];
          console.log('[webai-hands] 本机 machine_id（延迟拿到）：' + localMachineId);
        }
        if (res && res[PLATFORM_KEY] && !localPlatform) localPlatform = res[PLATFORM_KEY];
        if (!localMachineId) retryMachineIdentity(n + 1);
      });
    } catch (e) { retryMachineIdentity(n + 1); }
  }, waits[n]);
}

function markProcessed(id) {
  processed[id] = true;
  try {
    var obj = {};
    obj[STORE_KEY] = Object.keys(processed).slice(-300);
    chrome.storage.local.set(obj);
  } catch (e) {}
}

// ---------- 与 background 的长连接 ----------
function flushResults() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushHardDeadline = 0;
  if (!pendingResults.length) return;
  var text = pendingResults.join('\n\n---\n\n');
  pendingResults = [];
  fillBack(text);
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  var pending = Object.keys(inFlight).length;
  var now = Date.now();
  if (!flushHardDeadline) flushHardDeadline = now + 8000;
  var wait;
  if (pending > 0) {
    wait = Math.max(200, flushHardDeadline - now);
  } else {
    wait = 500;
  }
  flushTimer = setTimeout(flushResults, wait);
}

// ---------- 扩展上下文失效 ----------
// 扩展被重新加载/更新后，未刷新的旧标签页里的 content script 再调
// chrome.runtime.* 会抛 "Extension context invalidated"，且无法自愈，
// 必须刷新页面。这里提前识别，给出可操作的中文指引，而不是英文原错。
var contextDead = false;
function isInvalidatedError(e) {
  return !!e && /extension context invalid/i.test(e.message || '');
}
// context 失效指引只提醒一次（同页多块/重复定时器不刷屏）；刷新页面后重置。
var deadWarned = false;
function warnContextDead() {
  if (deadWarned) return;
  deadWarned = true;
  fillBack('扩展已重新加载，请刷新本页面后重试');
}

function getPort() {
  if (pagePort) return pagePort;
  if (contextDead) throw new Error('扩展已重新加载，请刷新本页面后重试');
  try {
    pagePort = chrome.runtime.connect({ name: 'webai-hands' });
  } catch (e) {
    if (isInvalidatedError(e)) {
      contextDead = true;
      console.error('[webai-hands] 扩展上下文已失效：扩展被重新加载/更新，请刷新本页面后重试');
      throw new Error('扩展已重新加载，请刷新本页面后重试');
    }
    throw e;
  }
  pagePort.onMessage.addListener(function (msg) {
    if (!msg) return;
    // 代数门控：过期代的消息（晚到的结果/错误/文件/忙拒绝）一律丢弃，治"穿透填回"
    if (msg.gen !== undefined && msg.gen !== gen) {
      console.log('[webai-hands] 丢弃过期代消息：' + msg.type + ' id=' + (msg.id || '-') +
                  ' 代=' + msg.gen + ' 当前=' + gen);
      return;
    }
    if (msg.type === 'file') {
      onFileArrived(msg);
    } else if (msg.type === 'result') {
      delete inFlight[msg.id];
      var text = formatResult(msg);
      delete cmdById[msg.id];
      pendingResults.push(text);
      scheduleFlush();
    } else if (msg.type === 'error' && msg.id) {
      delete inFlight[msg.id];
      delete cmdById[msg.id];
      pendingResults.push('' + (msg.error || '未知错误'));
      scheduleFlush();
    } else if (msg.type === 'busy' && msg.id) {
      // 5 秒宽限拒绝：只填不发，告诉用户正在跑什么、被拒的是什么
      delete inFlight[msg.id];
      delete cmdById[msg.id];
      fillOnly('⏳ 本机正忙：`' + String(msg.running_cmd || '').slice(0, 120) +
               '` 已运行 ' + (msg.running_for_s || 0) + 's；' +
               '你的命令 `' + String(msg.rejected_cmd || '').slice(0, 120) +
               '` 未执行（5 秒宽限已过）。可稍后手动重发。');
    }
    // progress 心跳帧只是保活长连接，不打扰页面
  });
  pagePort.onDisconnect.addListener(function () {
    pagePort = null;
    Object.keys(inFlight).forEach(function (id) {
      fillBack('与扩展后台的连接断开，结果未知。');
    });
    inFlight = {};
  });
  return pagePort;
}

// ---------- M4 严格点名（UUID） ----------
// host 字段只认 machine_id（UUID）；hostname 只做人类可读标签，不参与匹配。
// hostname 可重名、可被改动，不能做身份标识。
function hostMatches(want) {
  return !!localMachineId && want === localMachineId;
}

// 严格点名门控（exec/probe/attach 三路统一）：
//   'pass'   放行；'defer' 暂缓（machine_id 未就绪，不标记 processed）；
//   'ignore' 已处理（点名他机 / 熔断）；'nag' 缺 host，走自愈提醒。
function checkHostGate(block) {
  if (!localMachineId) {
    console.log('[webai-hands] machine_id 未就绪，块 ' + block.id + ' 暂缓');
    return 'defer';
  }
  // bootstrap 豁免：__diag__ 是 AI 拿到 machine_id 的唯一通道，自己不能要求 host。
  // 注意 diag 走 exec 块（host.py run_exec 特判），不限 kind。
  if ((block.cmd || '').trim() === '__diag__') return 'pass';
  if (block.host === '*') return 'pass';  // 显式广播
  if (block.host && hostMatches(block.host)) return 'pass';  // 点名本机
  if (block.host) {
    console.log('[webai-hands] 块 ' + block.id + ' 目标机器 ' + block.host + ' 与本机不符，静默忽略');
    markProcessed(block.id);
    return 'ignore';
  }
  return 'nag';  // 没写 host：走 nag 自愈流程
}

var nagCountById = {};
var nagTotalThisGen = 0;
var NAG_PER_BLOCK = 1;  // 单块最多提醒 1 次
var NAG_GLOBAL_CAP = 5; // 每 tab 每代全局封顶，超了只写 console（防 AI 装傻刷屏）

// 缺 host 自愈提醒：把本机 UUID 拍到 AI 脸上，请它换新 id 重发。
// 强发（bypass mh_auto_send，与停止通知同级）——这是协议纠错消息，AI 必须看到。
// 纯文本，不含 muse-exec 块，不会自触发；selfActing 由 trySend 负责。
function nagMissingHost(block) {
  var n = nagCountById[block.id] || 0;
  if (n >= NAG_PER_BLOCK || nagTotalThisGen >= NAG_GLOBAL_CAP) {
    if (nagTotalThisGen >= NAG_GLOBAL_CAP) {
      console.log('[webai-hands] nag 熔断：块 ' + block.id + ' 缺 host，已达提醒上限，不再打扰');
    }
    markProcessed(block.id);
    return;
  }
  nagCountById[block.id] = n + 1;
  nagTotalThisGen++;
  var msg =
    '⚠️ [webai-hands] 收到一条没有目标机器 UUID 的命令（id=' + block.id + '），未执行。\n' +
    '本机 UUID：' + localMachineId + '\n' +
    '主机名：' + (localHostname || '?') + '，系统：' + (localPlatform || '?') + '\n' +
    '请重发该命令：换一个新 id，并在 JSON 首行加上 "host":"' + localMachineId + '"。\n' +
    '（`__diag__` 可免 host，`"host":"*"` 为广播，慎用。）';
  console.log('[webai-hands] nag 缺 host：块 ' + block.id + '（第 ' + (n + 1) + ' 次）');
  var ok = false;
  try { ok = adapter.fillResult(msg); } catch (e) {
    console.error('[webai-hands] nag 填回失败：', e);
  }
  if (ok) setTimeout(trySend, 300);
  else console.log('[webai-hands] nag 未能填回输入框，仅记日志');
  markProcessed(block.id);
}

// ---------- 执行 ----------
function execBlock(block) {
  // 关键：残缺块（DeepSeek 里 <code> 只有首行 JSON、cmd 为空）
  // 不标记 processed，等完整元素（<pre>）出现再执行。
  if (!block.cmd) {
    incompleteAt[block.id] = Date.now();
    if (!incompleteWarned[block.id]) {
      incompleteWarned[block.id] = true;
      console.log('[webai-hands] 块 ' + block.id + ' 尚无命令正文，等待完整元素');
    }
    return;
  }
  inFlight[block.id] = true;
  cmdById[block.id] = block.cmd;
  console.log('[webai-hands] 执行 ' + block.id + '：', block.cmd.slice(0, 120));
  try {
    getPort().postMessage({
      type: 'exec',
      id: block.id,
      session: SESSION,
      gen: gen,
      cmd: block.cmd,
      shell: block.shell,
      timeout: block.timeout
    });
    // 发出去才落账：postMessage 抛异常说明根本没发出去，此时不记 processed，
    // 用户刷新页面后同一块可重发，不丢命令（旧代码先落账会导致刷新后被跳过）。
    markProcessed(block.id);
  } catch (e) {
    delete inFlight[block.id];
    delete cmdById[block.id];
    if (contextDead) warnContextDead();
    else fillBack('发往扩展后台失败：' + e.message);
  }
}

// ---------- 结果格式（M3 定型） ----------
function clip(s) {
  if (s == null) return '';
  s = String(s);
  if (s.length <= MAX_RESULT) return s;
  return s.slice(0, KEEP_HEAD) + '\n\n…（中略）…\n\n' + s.slice(s.length - KEEP_TAIL);
}

// ---------- attach：向 host 要文件，交给适配器上传 ----------
function b64ToBytes(b64) {
  var bin = atob(b64);
  var len = bin.length;
  var arr = new Uint8Array(len);
  for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function attachBlock(block) {
  if (!block.path) { fillBack('[attach ' + block.id + '] 缺少 path'); return; }
  if (!adapter || typeof adapter.uploadFile !== 'function') {
    fillBack('[attach ' + block.id + '] 当前站点适配器不支持上传');
    return;
  }
  inFlight[block.id] = true;
  cmdById[block.id] = 'attach: ' + block.path;
  attachMeta[block.id] = { text: block.text || null, send: !!block.send };
  console.log('[webai-hands] attach ' + block.id + ' 请求文件 ' + block.path);
  try {
    getPort().postMessage({ type: 'read_file', id: block.id, path: block.path,
                            session: SESSION, gen: gen });
    markProcessed(block.id);  // 发出去才落账（同 execBlock）：发送失败不记，刷新后可重发
  } catch (e) {
    delete inFlight[block.id]; delete attachMeta[block.id];
    if (contextDead) warnContextDead();
    else fillBack('[attach ' + block.id + '] 请求文件失败：' + e.message);
  }
}

function onFileArrived(msg) {
  var meta = attachMeta[msg.id] || {};
  delete attachMeta[msg.id];
  delete inFlight[msg.id];
  var bytes;
  try { bytes = b64ToBytes(msg.b64); }
  catch (e) { fillBack('[attach ' + msg.id + '] base64 解码失败：' + e.message); return; }
  console.log('[webai-hands] 文件已到 ' + msg.name + ' ' + bytes.length + ' 字节');
  var res;
  try {
    res = adapter.uploadFile({ name: msg.name, mime: msg.mime, bytes: bytes });
  } catch (e) {
    fillBack('[attach ' + msg.id + '] 适配器上传抛异常：' + e.message);
    return;
  }
  // uploadFile 可同步返回 {ok, why}，也可返回 Promise（gemini 需先点开上传菜单
  // 等 input 渲染）。Promise.resolve 兼容两种。
  Promise.resolve(res).then(function (r) {
    if (!r || !r.ok) {
      fillBack('[attach ' + msg.id + '] 上传失败：' + ((r && r.why) || '未知'));
      return;
    }
    fillBack('[attach ' + msg.id + '] 已注入文件 ' + msg.name + '（' + bytes.length + ' 字节）');
    if (meta.text) {
      try { adapter.fillResult(meta.text); } catch (e) {}
    }
    if (meta.send) setTimeout(trySend, 500);
  }, function (e) {
    fillBack('[attach ' + msg.id + '] 适配器上传抛异常：' + (e && e.message || e));
  });
}


// ---------- DOM 探针（只读，本地处理，不经过 host） ----------
function probeBlock(block) {
  markProcessed(block.id);
  if (!block.sel) { fillBack('[probe ' + block.id + '] 缺少 sel 字段'); return; }
  var nodes;
  try { nodes = document.querySelectorAll(block.sel); }
  catch (e) { fillBack('[probe ' + block.id + '] 选择器语法错误：' + e.message); return; }
  var lines = ['[probe ' + block.id + '] sel=' + block.sel + '  命中 ' + nodes.length + ' 个'];
  nodes.forEach(function (n, i) {
    if (i >= 10) { return; }
    var rect = n.getBoundingClientRect();
    var cs = getComputedStyle(n);
    var vis = cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    var par = n.parentElement;
    lines.push('[' + i + '] <' + n.tagName.toLowerCase() + '>');
    lines.push('    type=' + (n.type || '-') + '  name=' + (n.name || '-') +
               '  accept=' + (n.accept || '-') + '  multiple=' + !!n.multiple);
    lines.push('    visible=' + vis + '  size=' + Math.round(rect.width) + 'x' + Math.round(rect.height) +
               '  class=' + (typeof n.className === 'string' ? n.className.slice(0, 80) : '-'));
    lines.push('    parent=<' + (par ? par.tagName.toLowerCase() : '-') + '> aria=' +
               (par && par.getAttribute ? (par.getAttribute('aria-label') || '-') : '-'));
    lines.push('    html=' + (n.outerHTML || '').slice(0, 200).replace(/\s+/g, ' '));
  });
  if (nodes.length > 10) lines.push('  …(只显示前 10 个)');
  fillBack(lines.join('\n'));
}


function formatDiag(res) {
  var lines = [];
  lines.push('webai-hands diag  id=' + res.id);
  lines.push('host: ' + (res.hostname || '?') + '  platform: ' + (res.platform || '?') + '  pid: ' + (res.pid || '?'));
  lines.push('history: ' + res.history_size + '/' + res.history_limit);
  if (res.recent && res.recent.length) {
    lines.push('recent:');
    res.recent.forEach(function (r) {
      var t = r.ts ? new Date(r.ts * 1000).toTimeString().slice(0, 8) : '--:--:--';
      lines.push('  ' + (r.id || '?') + '  ' + (r.ok ? 'ok' : 'fail') + '  ' + t);
    });
  }
  if (res.log_tail) {
    lines.push('log_tail:');
    lines.push(res.log_tail.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}


function formatResult(res) {
  if (res.history_size !== undefined && res.log_tail !== undefined) {
    return formatDiag(res);
  }
  var secs = ((res.duration_ms || 0) / 1000).toFixed(1);
  var lines = [];
  lines.push('webai-hands 结果 id=' + res.id + ' exit=' + res.exit_code +
             ' ' + secs + 's host=' + (res.hostname || '?'));
  var cmd = cmdById[res.id];
  if (cmd) {
    var first = cmd.split('\n')[0];
    var n = cmd.split('\n').length;
    var extra = n > 1 ? '（共 ' + n + ' 行）' : '';
    lines.push('cmd: ' + (first.length > 120 ? first.slice(0, 120) + '…' : first) + extra);
  }
  if (res.error) lines.push('err: ' + res.error);
  if (res.stdout) lines.push(res.stdout.replace(/\s+$/, ''));
  if (res.stderr) {
    lines.push('');
    lines.push('stderr:');
    lines.push(clip(res.stderr.replace(/\s+$/, '')));
  }
  return lines.join('\n');
}

// ---------- 填回（交给适配器） ----------
function fillBack(text) {
  ctxChars += (text ? text.length : 0);
  if (!ctxWarned && ctxChars > 150000) {
    ctxWarned = true;
    text = text + '\n\n[webai-hands] 上下文将满（已回填 ' + ctxChars + ' 字符）。建议新开对话，先发 __ctx_summary__ 存档。';
  }
  var ok = false;
  try { ok = adapter.fillResult(text); } catch (e) {
    console.error('[webai-hands] adapter.fillResult 抛异常：', e);
    ok = false;
  }
  if (ok) {
    console.log('[webai-hands] 结果已填回输入框');
    maybeAutoSend();
  } else {
    console.log('[webai-hands] 适配器未找到输入框，结果只能进日志：', text.slice(0, 200));
  }
}

function maybeAutoSend() {
  try {
    chrome.storage.local.get([AUTO_KEY], function (res) {
      if (res && res[AUTO_KEY]) {
        // 发送按钮是输入内容后渲染的；大文本插入时框架可能慢半拍，最多重试 4 次
        var n = 0;
        (function attempt() {
          if (doClickSend()) { console.log('[webai-hands] 已自动发送'); return; }
          if (++n < 4) setTimeout(attempt, 400);
          else console.log('[webai-hands] 自动发送：多次未找到发送按钮，保持只填不发');
        })();
      }
    });
  } catch (e) {}
}

function doClickSend() {
  var ok = false;
  selfActing = true;
  try { ok = adapter.clickSend(); } catch (e) {
    console.error('[webai-hands] adapter.clickSend 抛异常：', e);
    ok = false;
  } finally { selfActing = false; }
  return !!ok;
}

function trySend() {
  if (doClickSend()) console.log('[webai-hands] 已自动发送');
  else console.log('[webai-hands] 未找到发送按钮，保持只填不发');
}

// ---------- 扫描 ----------
function scan() {
  if (!ready) return;
  if (contextDead) return;  // 扩展已重载：旧 context 做任何事都是徒劳，等用户刷新
  if (!adapterActive()) return;  // 页面级开关（如 google.com 非 AI Mode 页）
  var els;
  try { els = adapter.findBlocks(); } catch (e) {
    console.error('[webai-hands] adapter.findBlocks 抛异常：', e);
    return;
  }
  if (!els || !els.length) return;
  els.forEach(function (el) {
    var text = blockTextOf(el);
    var block = parseBlock(text);
    if (!block || processed[block.id] || inFlight[block.id]) return;
    if (inWarmup() || baselineIds[block.id] || PLACEHOLDER_IDS[block.id]) {
      if (!baselineIds[block.id]) {
        baselineIds[block.id] = true;
        console.log('[webai-hands] 预热吸收历史块 ' + block.id);
      }
      markProcessed(block.id);
      return;
    }
    if (block.kind !== 'probe' && block.kind !== 'attach' && !block.cmd && incompleteAt[block.id] && Date.now() - incompleteAt[block.id] < 5000) return;
    if (userAborted) {
      // 中止后出现的新块 = 用户还在继续对话：重新武装，后续块正常执行。
      // 中止前已见过的块已在 abortChain 里标记 processed，不会复活。
      userAborted = false;
      console.log('[webai-hands] 中止后出现新块 ' + block.id + '，链已重新武装');
    }
    if (!firstSeenAt[block.id]) {
      firstSeenAt[block.id] = Date.now();
      console.log('[webai-hands] 标记块 ' + block.id + ' 出现了');
    }
    var fp = block.id + '|' + fingerprint(text);
    var genAtSchedule = gen;
    clearTimeout(stableTimers[fp]);
    stableTimers[fp] = setTimeout(function () {
      delete stableTimers[fp];
      if (genAtSchedule !== gen) return;  // 已被新一代作废，不转发
      if (userAborted || processed[block.id] || inFlight[block.id]) return;
      var again = parseBlock(blockTextOf(el));
      if (!again) return;
      // M4 严格点名门控（exec/probe/attach 三路统一）
      var gate = checkHostGate(again);
      if (gate === 'defer') return;              // machine_id 未就绪：暂缓，不标记
      if (gate === 'ignore') return;             // 点名他机 / 熔断：已标记 processed
      if (gate === 'nag') { nagMissingHost(again); return; }
      console.log('[webai-hands] 标记块 ' + block.id + ' 已稳定，开始执行');
      if (again.kind === 'probe') probeBlock(again);
      else if (again.kind === 'attach') attachBlock(again);
      else execBlock(again);
    }, STABLE_MS);
  });
}

document.addEventListener('click', function (e) {
  if (selfActing) return;
  var t = e.target;
  var btn = t && t.closest ? t.closest('button, [role="button"]') : null;
  if (!btn) return;
  if (!adapter.isStopButton || !adapter.isStopButton(btn)) return;
  abortChain('用户点了停止/中断按钮');
}, true);

var scanTimer = null;
new MutationObserver(function () {
  pokeWarmup();
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, 300);
}).observe(document.documentElement, {
  childList: true, subtree: true, characterData: true
});

loadProcessed(function () {
  pokeWarmup();
  scan();
  console.log('[webai-hands] 内容脚本已启动 v' + VERSION + '：需 v>=2 的块才执行，结果默认只填回不发送。');
});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes[MACHINE_KEY]) return;
  var nv = changes[MACHINE_KEY].newValue;
  if (!nv || localMachineId) return;
  localMachineId = nv;
  try { scan(); } catch (e) {}
});
})();