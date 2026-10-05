// webai-hands extension popup
// Two controls: Test Bridge (a real ping through background's native port)
// and the auto-send toggle.

// Extension version in the title (dynamic from manifest, never stale).
try {
  document.getElementById('ver').textContent =
    'v' + chrome.runtime.getManifest().version;
} catch (e) {}

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
  statusEl.textContent = 'Connecting…';
  var done = false;
  // background side times out at 10s; this 15s fallback lets background's structured error win
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    statusEl.textContent = 'No reply (background silent for 15s)';
  }, 15000);
  function finish(text) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    statusEl.textContent = text;
  }
  try {
    // approach 2: don't connect the native host directly; ask background for one real-link ping
    chrome.runtime.sendMessage({ type: 'ping_test' }, function (res) {
      if (chrome.runtime.lastError) {
        finish('Connection failed: ' + chrome.runtime.lastError.message);
        return;
      }
      if (res && res.ok) finish('Connected ' + (res.hostname || ''));
      else finish('Connection failed: ' + ((res && res.error) || 'unknown'));
    });
  } catch (e) {
    finish('Send failed: ' + e.message);
  }
});

// ---------- Machine identity (M4 strict addressing) ----------
// Shows hostname (human label) + machine_id (UUID, for addressing), one-click copy.
var midEl = document.getElementById('mid');
try {
  chrome.storage.local.get(['mh_local_hostname', 'mh_machine_id'], function (res) {
    var hn = (res && res.mh_local_hostname) || '?';
    var mid = (res && res.mh_machine_id) || null;
    midEl.textContent = mid ? (hn + ' / ' + mid.slice(0, 8) + '…') : 'unknown (click "Test Bridge" first)';
    midEl.title = mid || '';
  });
} catch (e) { midEl.textContent = 'unknown'; }
document.getElementById('copymid').addEventListener('click', function () {
  try {
    chrome.storage.local.get(['mh_machine_id'], function (res) {
      var mid = res && res.mh_machine_id;
      if (!mid) { midEl.textContent = 'unknown (click "Test Bridge" first)'; return; }
      function done(ok) { midEl.textContent = ok ? 'Copied' : 'Copy failed'; }
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
