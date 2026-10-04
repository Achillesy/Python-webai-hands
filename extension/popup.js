// webai-hands 扩展面板（popup）
// 两个控件：测通桥（直连本地 host 敲一记 ping）、自动发送开关。

var statusEl = document.getElementById('status');
var autoEl = document.getElementById('autosend');

chrome.storage.local.get(['mh_auto_send'], function (res) {
  autoEl.checked = !!(res && res.mh_auto_send);
});
autoEl.addEventListener('change', function () {
  var obj = {};
  obj.mh_auto_send = autoEl.checked;
  chrome.storage.local.set(obj);
});

document.getElementById('ping').addEventListener('click', function () {
  statusEl.textContent = '连接中…';
  var port;
  try {
    port = chrome.runtime.connectNative('com.webai.hands');
  } catch (e) {
    statusEl.textContent = '连接失败：' + e.message;
    return;
  }
  var done = false;
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    statusEl.textContent = '无回音（host 没起来？）';
    try { port.disconnect(); } catch (e) {}
  }, 4000);
  port.onMessage.addListener(function (msg) {
    if (msg && msg.type === 'pong' && !done) {
      done = true;
      clearTimeout(timer);
      statusEl.textContent = '已连接 ' + (msg.hostname || '');
      try { port.disconnect(); } catch (e) {}
    }
  });
  port.onDisconnect.addListener(function () {
    if (done) return;
    done = true;
    clearTimeout(timer);
    var err = chrome.runtime.lastError;
    statusEl.textContent = '连接失败：' + (err ? err.message : '未知');
  });
  try {
    port.postMessage({ type: 'ping', id: 'popup-' + Date.now() });
  } catch (e) {
    clearTimeout(timer);
    statusEl.textContent = '发送失败：' + e.message;
  }
});

// ---------- 本机标识（M4 严格点名） ----------
// 显示 hostname（人类标签）+ machine_id（UUID，点名用），一键复制 UUID。
var midEl = document.getElementById('mid');
try {
  chrome.storage.local.get(['mh_local_hostname', 'mh_machine_id'], function (res) {
    var hn = (res && res.mh_local_hostname) || '?';
    var mid = (res && res.mh_machine_id) || null;
    midEl.textContent = mid ? (hn + ' / ' + mid.slice(0, 8) + '…') : '未知（先点"测通桥"）';
    midEl.title = mid || '';
  });
} catch (e) { midEl.textContent = '未知'; }
document.getElementById('copymid').addEventListener('click', function () {
  try {
    chrome.storage.local.get(['mh_machine_id'], function (res) {
      var mid = res && res.mh_machine_id;
      if (!mid) { midEl.textContent = '未知（先点"测通桥"）'; return; }
      function done(ok) { midEl.textContent = ok ? '已复制' : '复制失败'; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(mid).then(function () { done(true); }, function () { done(false); });
      } else {
        var ta = document.createElement('textarea');
        ta.value = mid;
        document.body.appendChild(ta);
        ta.select();
        try { done(document.execCommand('copy')); } catch (e) { done(false); }
        document.body.removeChild(ta);
      }
    });
  } catch (e) {}
});
