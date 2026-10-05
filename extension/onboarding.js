// webai-hands onboarding page logic.
// Stays in setup state until the host answers; no dismiss button.

var statusEl = document.getElementById('status');
var hintEl = document.getElementById('status-hint');
var successEl = document.getElementById('success');

document.querySelectorAll('[data-copy]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var text = document.getElementById(btn.getAttribute('data-copy')).textContent;
    function done(ok) { btn.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else { done(false); }
  });
});

function setStatus(state, text, hint) {
  statusEl.textContent = text;
  statusEl.className = state;
  hintEl.textContent = hint || '';
}

function testConnection() {
  setStatus('', 'Checking…', '');
  successEl.style.display = 'none';
  try {
    chrome.runtime.sendMessage({ type: 'ping_test' }, function (res) {
      if (chrome.runtime.lastError) {
        setStatus('bad', 'Not connected', 'Could not reach the extension background: ' + chrome.runtime.lastError.message);
        return;
      }
      if (res && res.ok) {
        var mid = res.machine_id || '';
        setStatus('ok', 'Connected — ' + (res.hostname || 'this computer'), '');
        document.getElementById('uuid').textContent = mid;
        document.getElementById('example').textContent =
          '{"muse":"exec","v":2,"id":"ls-001","host":"' + mid + '","cmd":"ls ~"}';
        successEl.style.display = 'block';
      } else {
        setStatus('bad', 'Helper not detected', 'Install it with the command above, then click Test Connection again. (' + ((res && res.error) || 'unknown error') + ')');
      }
    });
  } catch (e) {
    setStatus('bad', 'Not connected', String(e && e.message || e));
  }
}

document.getElementById('test').addEventListener('click', testConnection);
document.getElementById('copy-uuid').addEventListener('click', function () {
  var btn = this;
  var text = document.getElementById('uuid').textContent;
  function done(ok) { btn.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(function () { btn.textContent = 'Copy UUID'; }, 1500); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
  } else { done(false); }
});

// Auto-check on open: reinstalls or already-set-up machines skip the setup state.
testConnection();
