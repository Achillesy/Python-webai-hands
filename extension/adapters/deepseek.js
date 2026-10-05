// webai-hands adapter: chat.deepseek.com
(function () {
  'use strict';
  var reg = (window.__museHandsAdapters = window.__museHandsAdapters || {});

  reg['chat.deepseek.com'] = {
    name: 'deepseek',

    findBlocks: function () {
      return Array.prototype.slice.call(
        document.querySelectorAll('pre, pre code, code')
      );
    },


    // DeepSeek attachment limits (verified 2026-10-02, enforced by the web frontend):
    // - No archives: zip / rar / 7z / tar / gz / bz2 / xz / tgz etc. —
    //   the frontend rejects them outright. Block here and tell the user to
    //   extract first, so the file isn't rejected after landing in the input
    //   while the bridge wrongly reports success.
    // - Other types follow input[type=file]'s accept (txt verified to upload).
    uploadFile: function (file) {
      // file: {name, mime, bytes(Uint8Array)}
      var name = file.name || '';
      var m = /\.([a-z0-9]+)$/i.exec(name);
      var ext = m ? m[1].toLowerCase() : '';
      var ARCHIVE_EXTS = {
        'zip': 1, 'rar': 1, '7z': 1, 'tar': 1, 'gz': 1,
        'bz2': 1, 'xz': 1, 'tgz': 1, 'tbz2': 1, 'txz': 1, 'cab': 1
      };
      if (ARCHIVE_EXTS[ext]) {
        return { ok: false, why: 'DeepSeek rejects archives (' + name + '); please extract and send the inner files' };
      }
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
      var ta = document.querySelector('textarea');
      if (!ta) return false;
      var cur = ta.value || '';
      var next = cur ? cur.replace(/\s+$/, '') + '\n' + text : text;
      var setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, next);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },

    isStopButton: function (el) {
      if (!el) return false;
      var label = (el.getAttribute && el.getAttribute('aria-label')) || '';
      var txt = (el.textContent || '').trim();
      return /stop|abort|停止|中断|中止/i.test(label + ' ' + txt);
    },

    clickSend: function () {
      var sels = [
        'button[aria-label*="发送"]',
        'button[aria-label*="Send"]',
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
      var ta = document.querySelector('textarea');
      if (!ta) return false;
      try {
        ta.focus();
        var ev = function (t) {
          return new KeyboardEvent(t, {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true, composed: true
          });
        };
        ta.dispatchEvent(ev('keydown'));
        ta.dispatchEvent(ev('keypress'));
        ta.dispatchEvent(ev('keyup'));
        return true;
      } catch (e) {
        return false;
      }
    }
  };
})();
