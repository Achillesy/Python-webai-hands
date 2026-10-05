// webai-hands adapter: gemini.google.com
// DOM basis: captured via real browser on 2026-10-03.
// - Code blocks: <code-block> … <pre><code data-test-id="code-content"> (data-test-id is stable,
//   Angular's ng-tns-* class suffixes change; don't use them as selectors).
// - Input: Quill editor div[contenteditable="true"][role="textbox"], no textarea.
// - Send button: button[aria-label="发送"] (icon-only button, renders only with text).
// - Stop button: button[aria-label="停止回答"], contains mat-icon[data-mat-icon-name="stop"].
// - File input: absent from the static page, rendered dynamically on upload; uploadFile looks it up at call time.

(function () {
  'use strict';
  var reg = (window.__museHandsAdapters = window.__museHandsAdapters || {});

  reg['gemini.google.com'] = {
    name: 'gemini',

    findBlocks: function () {
      // each fenced code block maps to one code[data-test-id="code-content"],
      // skip pre to avoid double-counting via outer containers.
      return Array.prototype.slice.call(
        document.querySelectorAll('code[data-test-id="code-content"]')
      );
    },

    // Gemini attachment limits (verified 2026-10-03, logged in):
    // - file input is normally absent from the DOM; rendered only after opening the
    //   "上传和工具" menu (2 document uploads + 1 image upload), so open the menu here,
    //   wait for the input, then inject; hence this function returns a Promise
    //   (content.js bridges sync/async via Promise.resolve).
    // - Document upload inputs have an explicit accept whitelist (~150 extensions:
    //   documents/data/code/spreadsheets, incl. .zip; image upload is accept="image/*").
    //   Pre-check against the input's own accept, read live from the page — never hard-coded.
    // - Verified: txt / zip both accepted as attachments (only reached the pending-send
    //   stage; send never clicked, server behavior unknown).
    uploadFile: function (file) {
      // file: {name, mime, bytes(Uint8Array)}
      return new Promise(function (resolve) {
        function done(ok, why) { resolve({ ok: ok, why: why }); }

        function findDocInput() {
          var inputs = document.querySelectorAll('input[type=file]');
          for (var i = 0; i < inputs.length; i++) {
            var acc = (inputs[i].getAttribute('accept') || '').toLowerCase();
            // document upload input's accept is long and includes .zip; image upload is image/*
            if (acc && acc.indexOf('image/*') !== 0 && acc.indexOf('.zip') !== -1) {
              return inputs[i];
            }
          }
          return null;
        }

        function acceptOk(input, name) {
          var acc = (input.getAttribute('accept') || '').toLowerCase();
          var m = /\.([a-z0-9]+)$/i.exec(name || '');
          var ext = m ? m[1].toLowerCase() : '';
          if (!ext) return true; // no extension: don't block; let the site decide
          var parts = acc.split(',');
          for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (p.charAt(0) === '.' && p.slice(1) === ext) return true;
          }
          return false;
        }

        function closeMenu() {
          try {
            document.dispatchEvent(new KeyboardEvent('keydown',
              { key: 'Escape', code: 'Escape', bubbles: true }));
          } catch (e) {}
        }

        function inject(input) {
          if (!acceptOk(input, file.name)) {
            done(false, 'Gemini rejects this file type (' + file.name +
              '); only documents/data/code/spreadsheets and images are supported');
            return;
          }
          var blob, f;
          try {
            blob = new Blob([file.bytes], { type: file.mime || 'application/octet-stream' });
            f = new File([blob], file.name, { type: file.mime || 'application/octet-stream' });
          } catch (e) {
            done(false, 'failed to construct File: ' + e.message);
            return;
          }
          var dt = new DataTransfer();
          dt.items.add(f);
          try {
            input.files = dt.files;
          } catch (e) {
            done(false, 'failed to write input.files: ' + e.message);
            return;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          closeMenu();
          done(true);
        }

        var input = findDocInput();
        if (input) { inject(input); return; }
        // input not rendered yet: open the "上传和工具" menu and wait for it
        var menuBtn = document.querySelector(
          'button[aria-label="上传和工具"], button[aria-label="上传"]');
        if (!menuBtn) { done(false, 'upload menu button not found'); return; }
        menuBtn.click();
        var tries = 0;
        var timer = setInterval(function () {
          tries++;
          var inp = findDocInput();
          if (inp) { clearInterval(timer); inject(inp); }
          else if (tries >= 20) {
            clearInterval(timer);
            done(false, 'still no file input after upload menu opened');
          }
        }, 150);
      });
    },

    fillResult: function (text) {
      var ce = document.querySelector(
        'div[contenteditable="true"][role="textbox"], div[contenteditable="true"]');
      if (!ce) return false;
      ce.focus();
      var ok = false;
      try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
      if (!ok) {
        // Quill placeholder is <p><br></p>; if execCommand fails, append text directly and fire input.
        ce.textContent = (ce.textContent || '') + text;
        ce.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    },

    isStopButton: function (el) {
      if (!el) return false;
      var label = (el.getAttribute && el.getAttribute('aria-label')) || '';
      var txt = (el.textContent || '').trim();
      if (/stop|停止|中断|中止/i.test(label + ' ' + txt)) return true;
      try {
        if (el.querySelector &&
            el.querySelector('mat-icon[data-mat-icon-name="stop"]')) return true;
      } catch (e) {}
      return false;
    },

    clickSend: function () {
      var sels = [
        'button[aria-label="发送"]',
        'button[aria-label="Send"]'
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
