// webai-hands 扩展面板（popup）
// 两个控件：测通桥（经 background 的 native 端口敲一记 ping，测的是真链路）、自动发送开关。

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
  var done = false;
  // background 侧 10 秒超时；这里 15 秒兜底，让 background 的结构化报错先赢
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    statusEl.textContent = '无回音（后台 15 秒无响应）';
  }, 15000);
  function finish(text) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    statusEl.textContent = text;
  }
  try {
    // 办法二：不直连 native host，问 background 要一次真链路 ping
    chrome.runtime.sendMessage({ type: 'ping_test' }, function (res) {
      if (chrome.runtime.lastError) {
        finish('连接失败：' + chrome.runtime.lastError.message);
        return;
      }
      if (res && res.ok) finish('已连接 ' + (res.hostname || ''));
      else finish('连接失败：' + ((res && res.error) || '未知'));
    });
  } catch (e) {
    finish('发送失败：' + e.message);
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
