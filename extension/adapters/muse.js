// webai-hands adapter: muse.ai
// DOM logic ported from the Tampermonkey probe v0.1.2 and verified.
// muse.ai code blocks are <pre><code>...</code></pre>,
// keep only the innermost <code> so one block isn't double-counted via outer containers.

(function () {
  'use strict';
  var reg = (window.__museHandsAdapters = window.__museHandsAdapters || {});

  reg['muse.ai'] = {
    name: 'muse',

    // NOTE: isStopButton not implemented (aborts the whole chain when the user
    // hits stop/interrupt, see content.js). Reason: no verified DOM signature
    // for muse.ai's stop button yet; won't copy deepseek adapter's text regex
    // blindly and risk false positives. Implement after real-site verification.
    // (content.js silently skips when this method is absent; other features unaffected.)

    findBlocks: function () {
      var els = Array.prototype.slice.call(
        document.querySelectorAll('pre code, code, [class*="code"]')
      );
      // keep only innermost elements; avoid double-counting via outer containers
      return els.filter(function (el) {
        return !els.some(function (other) {
          return other !== el && el.contains(other);
        });
      });
    },


    // Muse attachment limits (verified 2026-10-02):
    // - input[type=file] has no accept attribute; no known type restrictions;
    // - verified: txt / zip / rar / exe / 7z; 10MB file uploaded successfully;
    // - host-side per-file cap 25MB (see native-host/host.py).
    // No type pre-check here; let the site report its own errors.
    uploadFile: function (file) {
      // file: {name, mime, bytes(Uint8Array)}
      var inputs = document.querySelectorAll('input[type=file]');
      if (!inputs.length) return { ok: false, why: 'page has no input[type=file]' };
      var input = inputs[0];
      var blob, f;
      try {
        blob = new Blob([file.bytes], { type: file.mime || 'application/octet-stream' });
        f = new File([blob], file.name, { type: file.mime || 'application/octet-stream' });
      } catch (e) {
        return { ok: false, why: 'failed to construct File: ' + e.message };
      }
      var dt = new DataTransfer();
      dt.items.add(f);
      try {
        input.files = dt.files;
      } catch (e) {
        return { ok: false, why: 'failed to write input.files: ' + e.message };
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    },

    fillResult: function (text) {
      var ta = document.querySelector('textarea[data-hatch-composer]') ||
               document.querySelector('textarea');
      if (ta) {
        var cur = ta.value || '';
        var next = cur ? cur.replace(/\s+$/, '') + '\n' + text : text;
        var setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, next);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      var ce = document.querySelector(
        '[contenteditable="true"], div[role="textbox"]');
      if (ce) {
        ce.focus();
        var ok = false;
        try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
        if (!ok) {
          ce.textContent = (ce.textContent || '') + text;
          ce.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
      return false;
    },

    clickSend: function () {
      var sels = [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]',
        'button[aria-label*="发送"]',
        'button[type="submit"]'
      ];
      for (var i = 0; i < sels.length; i++) {
        var btns = document.querySelectorAll(sels[i]);
        for (var j = btns.length - 1; j >= 0; j--) {
          var b = btns[j];
          if (b && !b.disabled && b.offsetParent !== null) {
            b.click();
            return true;
          }
        }
      }
      return false;
    }
  };
})();