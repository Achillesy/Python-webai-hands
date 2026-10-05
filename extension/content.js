// webai-hands content script (core layer, site-agnostic)
//
// Architecture: core layer + adapter layer (one per site).
// Adapters register via window.__museHandsAdapters[hostname];
// the core picks one by location.hostname and calls its:
//   findBlocks()  → returns candidate element array
//   fillResult()  → fills the input box, returns bool
//   clickSend()   → clicks send, returns bool
// Adding a new Web AI = new adapters/xxx.js + register in manifest;
// zero core changes.
//
// Rules: caught blocks go to the local host for real execution; results are
// only filled back, never auto-sent (unless the user manually enabled auto-send
// in the extension panel); executed ids are written to chrome.storage.local so
// refreshing the page never replays history commands.

(function () {
'use strict';

var STABLE_MS = 1000;
var VERSION = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : "?";
var MAX_RESULT = 6000;
var MAX_CMD_BYTES = 512 * 1024; // per-block command cap: Chrome native messaging hard limit is 1MB per message; keep margin (host-side file chunks use 500KB likewise)
var KEEP_HEAD = 2000;
var KEEP_TAIL = 3500;
var STORE_KEY = 'mh_processed_ids';
var AUTO_KEY = 'mh_auto_send';
var HOSTNAME_KEY = 'mh_local_hostname';
var MACHINE_KEY = 'mh_machine_id';
var PLATFORM_KEY = 'mh_platform';

// ---------- pick adapter ----------
var adapters = window.__museHandsAdapters || {};
var adapter = adapters[location.hostname] || null;
if (!adapter) {
  console.log('[webai-hands] no adapter for this site: ' + location.hostname + '; content script disabled');
  return;
}
// Adapters may declare isActive() as a page-level gate (www.google.com: only AI Mode
// pages active, plain search pages off). SPA client-side routing doesn't re-run the
// content script, so don't return directly here; scan() lazily checks each time and
// auto-enables/disables as the page changes.
function adapterActive() {
  try { return !adapter.isActive || adapter.isActive(); }
  catch (e) { return false; }
}
if (adapterActive()) {
  console.log('[webai-hands] adapter selected: ' + adapter.name + ' (' + location.hostname + ')');
} else {
  console.log('[webai-hands] adapter selected: ' + adapter.name + ', but not applicable to this page; waiting for page change');
}
// Adapters may declare blockText(el) for custom block text extraction (default el.innerText).
// Google AI Mode's code-block container starts with a language label line; must jump to the JSON line.
function blockTextOf(el) {
  try {
    if (adapter.blockText) return adapter.blockText(el) || '';
  } catch (e) {}
  return el.innerText || el.textContent || '';
}

// ---------- state ----------
var processed = {};
var inFlight = {};
var cmdById = {};
var firstSeenAt = {};
var stableTimers = {};
var ready = false;
var pagePort = null;
var localHostname = null;
var localMachineId = null;  // M4 strict addressing: local UUID (generated and persisted by host)
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

// ---------- session & generation (Layer 1 scheduling / graceful stop) ----------
// SESSION: logical session id for one page load; gen: generation, +1 on stop, old generations all expire.
var SESSION = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
var gen = 0;

// Warmup end conditions (either ends it):
//  1. DOM quiet for WARMUP_QUIET_MS (and at least WARMUP_MIN_MS since start);
//  2. Fallback: force-end on the first scan after WARMUP_MAX_MS since start.
// Note: quiet detection needs its own timer — scan only runs 300ms after a mutation,
// so "3s of quiet" can never be observed inside inWarmup.
function pokeWarmup() {
  if (warmupDone) return;
  if (warmupQuietTimer) clearTimeout(warmupQuietTimer);
  warmupQuietTimer = setTimeout(function () {
    if (!warmupDone && Date.now() - warmupStart >= WARMUP_MIN_MS) {
      warmupDone = true;
      warmupQuietTimer = null;
      console.log('[webai-hands] warmup ended (quiet); only blocks appearing after this will execute');
    }
  }, WARMUP_QUIET_MS);
}

function inWarmup() {
  if (warmupDone) return false;
  if (Date.now() - warmupStart >= WARMUP_MAX_MS) {
    warmupDone = true;
    if (warmupQuietTimer) { clearTimeout(warmupQuietTimer); warmupQuietTimer = null; }
    console.log('[webai-hands] warmup ended (timeout); only blocks appearing after this will execute');
    return false;
  }
  return true;
}

function abortChain(reason) {
  if (userAborted) return;
  userAborted = true;
  console.log('[webai-hands] chain aborted: ' + reason);
  var nTimers = Object.keys(stableTimers).length;
  var nFlight = Object.keys(inFlight).length;
  Object.keys(stableTimers).forEach(function (k) { clearTimeout(stableTimers[k]); delete stableTimers[k]; });
  Object.keys(inFlight).forEach(function (id) { delete inFlight[id]; });
  Object.keys(cmdById).forEach(function (id) { delete cmdById[id]; });
  Object.keys(attachMeta).forEach(function (id) { delete attachMeta[id]; });
  // Blocks seen before the abort (incl. ones waiting for stability or still without body)
  // are all swallowed: they won't resurrect when the chain re-arms; only truly new blocks execute.
  Object.keys(firstSeenAt).forEach(function (id) { markProcessed(id); });
  firstSeenAt = {};
  Object.keys(incompleteAt).forEach(function (id) { delete incompleteAt[id]; });
  Object.keys(incompleteWarned).forEach(function (id) { delete incompleteWarned[id]; });
  pendingResults = [];
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushHardDeadline = 0;
  // generation +1: old-generation commands/results all expire; tell background to drop this session's queued items
  gen++;
  nagTotalThisGen = 0;  // new generation resets the nag circuit-breaker counter
  try { getPort().postMessage({ type: 'stop', session: SESSION, gen: gen }); } catch (e) {}
  // only relay a notice if something was actually voided: a plain-text stop (nothing running) doesn't disturb
  if (nTimers + nFlight > 0) sendCancelNotice(gen, nTimers, nFlight);
}

// After a stop, relay one user message (really sent): gives the user visible confirmation
// and tells the AI to stop sending new blocks. Bypasses the mh_auto_send switch —
// the user clicked stop by hand, so the notice must go out; on send failure, degrade to fill-only.
function sendCancelNotice(curGen, nTimers, nFlight) {
  var text = '⏹ [webai-hands] user clicked the stop button (auto-sent): all generation ' + curGen + ' commands are void' +
    ' (' + nTimers + ' pending cancelled, ' + nFlight + ' in-flight results will not be filled back).' +
    'Please pause the current task, wait for the next user instruction, and do not send new command blocks.';
  var ok = false;
  try { ok = adapter.fillResult(text); } catch (e) { ok = false; }
  if (ok) {
    console.log('[webai-hands] stop notice filled back, sending in 500ms');
    setTimeout(trySend, 500);
  } else {
    console.log('[webai-hands] stop notice fill-back failed; logging only, not disturbing');
  }
}

// fill-only (for busy-rejection etc. notices; never triggers auto-send)
function fillOnly(text) {
  var ok = false;
  try { ok = adapter.fillResult(text); } catch (e) { ok = false; }
  if (!ok) console.log('[webai-hands] notice fill-back failed: ', String(text).slice(0, 200));
}

// ---------- sentinel parsing ----------
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

// ---------- dedup ----------
function loadProcessed(done) {
  try {
    chrome.storage.local.get([STORE_KEY, HOSTNAME_KEY, MACHINE_KEY, PLATFORM_KEY], function (res) {
      var ids = (res && res[STORE_KEY]) || [];
      ids.forEach(function (id) { processed[id] = true; });
      if (res && res[HOSTNAME_KEY]) {
        localHostname = res[HOSTNAME_KEY];
        console.log('[webai-hands] local hostname (cached): ' + localHostname);
      }
      if (res && res[MACHINE_KEY]) {
        localMachineId = res[MACHINE_KEY];
        console.log('[webai-hands] local machine_id (cached): ' + localMachineId);
      }
      if (res && res[PLATFORM_KEY]) localPlatform = res[PLATFORM_KEY];
      if (!localMachineId) {
        // M4 strict-addressing precondition: connecting triggers a background ping to host; read with delayed retries.
        // getPort() goes through background onConnect → ensureNativePort → ping → pong → cache.
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

// Retry a few times (2s / 5s / 10s) if machine_id is unavailable.
// Strict addressing requires machine_id ready before executing blocks; if unavailable,
// blocks are deferred (not marked processed) — no fail-open like the hostname era.
function retryMachineIdentity(n) {
  var waits = [2000, 5000, 10000];
  if (n >= waits.length) {
    console.log('[webai-hands] local machine_id unavailable: host may not be installed or started; blocks will be deferred under strict addressing');
    return;
  }
  setTimeout(function () {
    if (localMachineId) return;
    try {
      chrome.storage.local.get([HOSTNAME_KEY, MACHINE_KEY, PLATFORM_KEY], function (res) {
        if (res && res[HOSTNAME_KEY] && !localHostname) {
          localHostname = res[HOSTNAME_KEY];
          console.log('[webai-hands] local hostname (obtained late): ' + localHostname);
        }
        if (res && res[MACHINE_KEY] && !localMachineId) {
          localMachineId = res[MACHINE_KEY];
          console.log('[webai-hands] local machine_id (obtained late): ' + localMachineId);
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

// ---------- long-lived connection to background ----------
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

// ---------- extension context invalidated ----------
// After the extension is reloaded/updated, content scripts in unrefreshed old tabs
// throw "Extension context invalidated" on chrome.runtime.* calls, with no self-healing;
// the page must be refreshed. Detect it early and give actionable guidance
// instead of the cryptic original error.
var contextDead = false;
function isInvalidatedError(e) {
  return !!e && /extension context invalid/i.test(e.message || '');
}
// show the context-dead guidance only once (no spam from multiple blocks/repeat timers on the same page); resets after refresh.
var deadWarned = false;
function warnContextDead() {
  if (deadWarned) return;
  deadWarned = true;
  fillBack('Extension reloaded — please refresh this page and retry');
}

function getPort() {
  if (pagePort) return pagePort;
  if (contextDead) throw new Error('Extension reloaded — please refresh this page and retry');
  try {
    pagePort = chrome.runtime.connect({ name: 'webai-hands' });
  } catch (e) {
    if (isInvalidatedError(e)) {
      contextDead = true;
      console.error('[webai-hands] extension context invalidated: extension was reloaded/updated; please refresh this page and retry');
      throw new Error('Extension reloaded — please refresh this page and retry');
    }
    throw e;
  }
  pagePort.onMessage.addListener(function (msg) {
    if (!msg) return;
    // generation gate: drop all expired-generation messages (late results/errors/files/busy-rejections); cures "fill-back piercing"
    if (msg.gen !== undefined && msg.gen !== gen) {
      console.log('[webai-hands] dropping expired-generation message: ' + msg.type + ' id=' + (msg.id || '-') +
                  ' gen=' + msg.gen + ' current=' + gen);
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
      pendingResults.push('' + (msg.error || 'unknown error'));
      scheduleFlush();
    } else if (msg.type === 'busy' && msg.id) {
      // 5s grace rejection: fill-only; tell the user what's running and what was rejected
      delete inFlight[msg.id];
      delete cmdById[msg.id];
      fillOnly('⏳ Local host is busy: `' + String(msg.running_cmd || '').slice(0, 120) +
               '` has been running for ' + (msg.running_for_s || 0) + 's; ' +
               'your command `' + String(msg.rejected_cmd || '').slice(0, 120) +
               '` was not executed (5s grace elapsed). You can manually resend it later.');
    }
    // progress heartbeat frames just keep the long-lived connection alive; don't disturb the page
  });
  pagePort.onDisconnect.addListener(function () {
    pagePort = null;
    Object.keys(inFlight).forEach(function (id) {
      fillBack('Connection to the extension background lost; result unknown.');
    });
    inFlight = {};
  });
  return pagePort;
}

// ---------- M4 strict addressing (UUID) ----------
// the host field only accepts machine_id (UUID); hostname is just a human-readable label, not used for matching.
// hostnames can collide or be changed; they can't serve as identity.
function hostMatches(want) {
  return !!localMachineId && want === localMachineId;
}

// Strict-addressing gate (unified for exec/probe/attach):
//   'pass'   allow; 'defer' defer (machine_id not ready, don't mark processed);
//   'ignore' handled (addressed to another machine / circuit-broken); 'nag' missing host, go self-heal.
function checkHostGate(block) {
  if (!localMachineId) {
    console.log('[webai-hands] machine_id not ready; block ' + block.id + ' deferred');
    return 'defer';
  }
  // bootstrap exemption: __diag__ is the AI's only channel to obtain machine_id; it can't require host itself.
  // note: diag travels as an exec block (special-cased in host.py run_exec), kind-agnostic.
  if ((block.cmd || '').trim() === '__diag__') return 'pass';
  if (block.host === '*') return 'pass';  // explicit broadcast
  if (block.host && hostMatches(block.host)) return 'pass';  // addressed to this machine
  if (block.host) {
    console.log('[webai-hands] block ' + block.id + ' targets ' + block.host + ', mismatch with this machine; silently ignoring');
    markProcessed(block.id);
    return 'ignore';
  }
  return 'nag';  // no host written: go through the nag self-heal flow
}

var nagCountById = {};
var nagTotalThisGen = 0;
var NAG_PER_BLOCK = 1;  // max 1 nag per block
var NAG_GLOBAL_CAP = 5; // global cap per tab per generation; beyond that, console only (prevents the AI from feigning ignorance to spam)

// Missing-host self-heal nag: slap the local UUID in front of the AI and ask it to resend with a new id.
// Force-send (bypasses mh_auto_send, same level as the stop notice) — this is a protocol-correction
// message the AI must see. Plain text, no muse-exec block, won't self-trigger; selfActing handled by trySend.
function nagMissingHost(block) {
  var n = nagCountById[block.id] || 0;
  if (n >= NAG_PER_BLOCK || nagTotalThisGen >= NAG_GLOBAL_CAP) {
    if (nagTotalThisGen >= NAG_GLOBAL_CAP) {
      console.log('[webai-hands] nag circuit-broken: block ' + block.id + ' missing host, nag cap reached; will not disturb further');
    }
    markProcessed(block.id);
    return;
  }
  nagCountById[block.id] = n + 1;
  nagTotalThisGen++;
  var msg =
    '⚠️ [webai-hands] received a command without a target machine UUID (id=' + block.id + '), not executed.\n' +
    'Local UUID: ' + localMachineId + '\n' +
    'Hostname: ' + (localHostname || '?') + ', platform: ' + (localPlatform || '?') + '\n' +
    'Please resend the command: use a new id and add "host":"' + localMachineId + '" to the JSON first line.\n' +
    '(`__diag__` is exempt from host; `"host":"*"` broadcasts — use with care.)';
  console.log('[webai-hands] nag missing host: block ' + block.id + ' (time ' + (n + 1) + ')');
  var ok = false;
  try { ok = adapter.fillResult(msg); } catch (e) {
    console.error('[webai-hands] nag fill-back failed: ', e);
  }
  if (ok) setTimeout(trySend, 300);
  else console.log('[webai-hands] nag could not be filled into the input box; logging only');
  markProcessed(block.id);
}

// ---------- execute ----------
function execBlock(block) {
  // key: incomplete blocks (in DeepSeek, <code> may hold only the first JSON line with empty cmd)
  // are NOT marked processed; wait for the complete element (<pre>) before executing.
  if (!block.cmd) {
    incompleteAt[block.id] = Date.now();
    if (!incompleteWarned[block.id]) {
      incompleteWarned[block.id] = true;
      console.log('[webai-hands] block ' + block.id + ' has no command body yet; waiting for the complete element');
    }
    return;
  }
  // Per-block command cap: over-limit blocks are rejected outright with guidance filled back;
  // never forwarded, never retried (otherwise it would blow up at the 1MB native-message hard cap with a vague error).
  // Must markProcessed, or the next scan of the same block would fill back repeatedly.
  if (block.cmd.length > MAX_CMD_BYTES) {
    console.log('[webai-hands] block ' + block.id + ' command too large (' + block.cmd.length + ' chars); rejected');
    markProcessed(block.id);
    fillBack('[exec ' + block.id + '] command too large (~' + Math.round(block.cmd.length / 1024) +
      'KB, per-block cap 512KB); rejected, not executed. ' +
      'Split into smaller blocks and run separately (e.g. chunked >> appends to a file), or ask the user to send the big file as an attachment and use the attach channel. Resend with a new id.');
    return;
  }
  inFlight[block.id] = true;
  cmdById[block.id] = block.cmd;
  console.log('[webai-hands] executing ' + block.id + ': ', block.cmd.slice(0, 120));
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
    // only book it once sent: a postMessage throw means it never went out — don't mark
    // processed then, so the same block can be resent after refresh without losing the command
    // (the old code booked first, causing post-refresh skips).
    markProcessed(block.id);
  } catch (e) {
    delete inFlight[block.id];
    delete cmdById[block.id];
    if (contextDead) warnContextDead();
    else fillBack('failed to send to extension background: ' + e.message);
  }
}

// ---------- result format (M3 finalized) ----------
function clip(s) {
  if (s == null) return '';
  s = String(s);
  if (s.length <= MAX_RESULT) return s;
  return s.slice(0, KEEP_HEAD) + '\n\n…(omitted)…\n\n' + s.slice(s.length - KEEP_TAIL);
}

// ---------- attach: fetch file from host, hand to adapter for upload ----------
function b64ToBytes(b64) {
  var bin = atob(b64);
  var len = bin.length;
  var arr = new Uint8Array(len);
  for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function attachBlock(block) {
  if (!block.path) { fillBack('[attach ' + block.id + '] missing path'); return; }
  if (!adapter || typeof adapter.uploadFile !== 'function') {
    fillBack('[attach ' + block.id + '] adapter for current site does not support upload');
    return;
  }
  inFlight[block.id] = true;
  cmdById[block.id] = 'attach: ' + block.path;
  attachMeta[block.id] = { text: block.text || null, send: !!block.send };
  console.log('[webai-hands] attach ' + block.id + ' requesting file ' + block.path);
  try {
    getPort().postMessage({ type: 'read_file', id: block.id, path: block.path,
                            session: SESSION, gen: gen });
    markProcessed(block.id);  // book only once sent (same as execBlock): don't mark on send failure; resendable after refresh
  } catch (e) {
    delete inFlight[block.id]; delete attachMeta[block.id];
    if (contextDead) warnContextDead();
    else fillBack('[attach ' + block.id + '] file request failed: ' + e.message);
  }
}

function onFileArrived(msg) {
  var meta = attachMeta[msg.id] || {};
  delete attachMeta[msg.id];
  delete inFlight[msg.id];
  var bytes;
  try { bytes = b64ToBytes(msg.b64); }
  catch (e) { fillBack('[attach ' + msg.id + '] base64 decode failed: ' + e.message); return; }
  console.log('[webai-hands] file arrived ' + msg.name + ' ' + bytes.length + ' bytes');
  var res;
  try {
    res = adapter.uploadFile({ name: msg.name, mime: msg.mime, bytes: bytes });
  } catch (e) {
    fillBack('[attach ' + msg.id + '] adapter upload threw: ' + e.message);
    return;
  }
  // uploadFile may return {ok, why} synchronously or a Promise (gemini needs the upload menu
  // opened first, then waits for the input to render). Promise.resolve covers both.
  Promise.resolve(res).then(function (r) {
    if (!r || !r.ok) {
      fillBack('[attach ' + msg.id + '] upload failed: ' + ((r && r.why) || 'unknown'));
      return;
    }
    fillBack('[attach ' + msg.id + '] file injected ' + msg.name + ' (' + bytes.length + ' bytes)');
    if (meta.text) {
      try { adapter.fillResult(meta.text); } catch (e) {}
    }
    if (meta.send) setTimeout(trySend, 500);
  }, function (e) {
    fillBack('[attach ' + msg.id + '] adapter upload threw: ' + (e && e.message || e));
  });
}


// ---------- DOM probe (read-only, handled locally, never touches host) ----------
function probeBlock(block) {
  markProcessed(block.id);
  if (!block.sel) { fillBack('[probe ' + block.id + '] missing sel field'); return; }
  var nodes;
  try { nodes = document.querySelectorAll(block.sel); }
  catch (e) { fillBack('[probe ' + block.id + '] selector syntax error: ' + e.message); return; }
  var lines = ['[probe ' + block.id + '] sel=' + block.sel + '  matched ' + nodes.length];
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
  if (nodes.length > 10) lines.push('  …(showing first 10 only)');
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
  lines.push('webai-hands result id=' + res.id + ' exit=' + res.exit_code +
             ' ' + secs + 's host=' + (res.hostname || '?'));
  var cmd = cmdById[res.id];
  if (cmd) {
    var first = cmd.split('\n')[0];
    var n = cmd.split('\n').length;
    var extra = n > 1 ? ' (' + n + ' lines total)' : '';
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

// ---------- fill-back (handed to adapter) ----------
function fillBack(text) {
  ctxChars += (text ? text.length : 0);
  if (!ctxWarned && ctxChars > 150000) {
    ctxWarned = true;
    text = text + '\n\n[webai-hands] context nearly full (' + ctxChars + ' chars filled back). Suggest starting a new chat; send __ctx_summary__ first to archive.';
  }
  var ok = false;
  try { ok = adapter.fillResult(text); } catch (e) {
    console.error('[webai-hands] adapter.fillResult threw: ', e);
    ok = false;
  }
  if (ok) {
    console.log('[webai-hands] result filled back into input box');
    maybeAutoSend();
  } else {
    console.log('[webai-hands] adapter found no input box; result goes to log only: ', text.slice(0, 200));
  }
}

function maybeAutoSend() {
  try {
    chrome.storage.local.get([AUTO_KEY], function (res) {
      if (res && res[AUTO_KEY]) {
        // the send button renders after input appears; frameworks may lag on big inserts — retry up to 4 times
        var n = 0;
        (function attempt() {
          if (doClickSend()) { console.log('[webai-hands] auto-sent'); return; }
          if (++n < 4) setTimeout(attempt, 400);
          else console.log('[webai-hands] auto-send: send button never found after retries; staying fill-only');
        })();
      }
    });
  } catch (e) {}
}

function doClickSend() {
  var ok = false;
  selfActing = true;
  try { ok = adapter.clickSend(); } catch (e) {
    console.error('[webai-hands] adapter.clickSend threw: ', e);
    ok = false;
  } finally { selfActing = false; }
  return !!ok;
}

function trySend() {
  if (doClickSend()) console.log('[webai-hands] auto-sent');
  else console.log('[webai-hands] send button not found; staying fill-only');
}

// ---------- scan ----------
function scan() {
  if (!ready) return;
  if (contextDead) return;  // extension reloaded: the old context can't do anything useful; wait for user refresh
  if (!adapterActive()) return;  // page-level switch (e.g. google.com non-AI-Mode pages)
  var els;
  try { els = adapter.findBlocks(); } catch (e) {
    console.error('[webai-hands] adapter.findBlocks threw: ', e);
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
        console.log('[webai-hands] warmup absorbed history block ' + block.id);
      }
      markProcessed(block.id);
      return;
    }
    if (block.kind !== 'probe' && block.kind !== 'attach' && !block.cmd && incompleteAt[block.id] && Date.now() - incompleteAt[block.id] < 5000) return;
    if (userAborted) {
      // a new block after abort = user kept chatting: re-arm; later blocks execute normally.
      // blocks seen before the abort were marked processed in abortChain and won't resurrect.
      userAborted = false;
      console.log('[webai-hands] new block after abort ' + block.id + '; chain re-armed');
    }
    if (!firstSeenAt[block.id]) {
      firstSeenAt[block.id] = Date.now();
      console.log('[webai-hands] block ' + block.id + ' seen');
    }
    var fp = block.id + '|' + fingerprint(text);
    var genAtSchedule = gen;
    clearTimeout(stableTimers[fp]);
    stableTimers[fp] = setTimeout(function () {
      delete stableTimers[fp];
      if (genAtSchedule !== gen) return;  // voided by a newer generation; don't forward
      if (userAborted || processed[block.id] || inFlight[block.id]) return;
      var again = parseBlock(blockTextOf(el));
      if (!again) return;
      // M4 strict-addressing gate (unified for exec/probe/attach)
      var gate = checkHostGate(again);
      if (gate === 'defer') return;              // machine_id not ready: defer, don't mark
      if (gate === 'ignore') return;             // addressed elsewhere / circuit-broken: already marked processed
      if (gate === 'nag') { nagMissingHost(again); return; }
      console.log('[webai-hands] block ' + block.id + ' stable, executing');
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
  abortChain('user clicked the stop/interrupt button');
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
  console.log('[webai-hands] content script started v' + VERSION + ': only v>=2 blocks execute; results are fill-only by default.');
});
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes[MACHINE_KEY]) return;
  var nv = changes[MACHINE_KEY].newValue;
  if (!nv || localMachineId) return;
  localMachineId = nv;
  try { scan(); } catch (e) {}
});
})();