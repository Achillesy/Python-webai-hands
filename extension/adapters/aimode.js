// webai-hands adapter: Google AI Mode (www.google.com)
//
// DOM basis: captured via logged-in VM browser on 2026-10-04.
// - hostname is www.google.com with whole-site matching, hence the isActive() page-level gate:
//   only active on pages showing the AI Mode input (textarea[aria-label="尽情提问"]),
//   plain Google search pages stay off. SPA client-side routing is covered by content.js lazy checks.
// - Code blocks: gray rounded container (top language label + code area + bottom "请谨慎使用此代码。" + copy button).
//   hard anchor is the copy button button[aria-label="将代码文本复制到剪贴板。"] (data-sfc-cp is a valueless attribute);
//   inline code lacks this button, so they're distinguishable. pre/code tag names couldn't isolate (tooling limit), so findBlocks
//   walks up from the copy button to find the container, using "content self-verification":
//   takes the nearest ancestor whose text holds a valid block JSON line (8 levels max); robust against structural changes.
// - blockText: the container's first line is a language label ("python"/"bash", possibly aria-hidden); taking innerText
//   directly would make parseBlock try the label as JSON and discard it; here we jump to the first line starting with {.
// - Input: textarea[aria-label="尽情提问"], maxlength=8192.
// - Send button: button[aria-label="发送"][data-xid="input-plate-send-button"],
//   only rendered when the input is non-empty (fill-then-send; trySend's 300-500ms delay is enough for it to render).
// - Stop button: not captured (missed the streaming window); not implemented for now; content.js silently skips (same as muse.js).
// - File upload: entry button[aria-label="添加文件和工具"] → click opens role=menu,
//   the "添加文件" input[type=file] (accept="", hidden, multiple) nested inside a menuitem,
//   rendered only after opening the menu; async Promise flow (content.js bridges via Promise.resolve).
//   note: the "添加图片" input's accept is limited to image types; this adapter only takes "添加文件" with accept="".
//   empty accept means no type pre-check; whether Google's backend truly accepts all file types is unverified (send never clicked).
// - SPA: sending a message triggers full-page navigation (content script re-runs); "新话题" is client-side routing.
// - Limitation: only matches www.google.com (verified value); country domains (google.com.hk etc.) not covered.
(function () {
  'use strict';

  var COPY_BTN = 'button[aria-label="将代码文本复制到剪贴板。"]';
  var INPUT_SEL = 'textarea[aria-label="尽情提问"]';
  var SEND_SEL = 'button[aria-label="发送"][data-xid="input-plate-send-button"]';
  var UPLOAD_ENTRY_SEL = 'button[aria-label="添加文件和工具"]';

  // rough check whether a text line is one of our blocks (exec/probe/attach).
  function looksLikeBlock(line) {
    line = (line || '').trim();
    if (line.charAt(0) !== '{') return false;
    try {
      var o = JSON.parse(line);
      return !!(o && o.id && (o.muse === 'exec' || o.muse === 'probe' || o.muse === 'attach'));
    } catch (e) {
      return false;
    }
  }

  // anchor on the copy button, walk up to the code-block container: nearest ancestor whose text holds a valid block JSON line.
  function containerFor(btn) {
    var el = btn.parentElement, depth = 0;
    while (el && depth < 8) {
      var t = el.innerText || el.textContent || '';
      var lines = t.split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (looksLikeBlock(lines[i])) return el;
      }
      el = el.parentElement;
      depth++;
    }
    return null;
  }

  window.__museHandsAdapters = window.__museHandsAdapters || {};
  window.__museHandsAdapters['www.google.com'] = {
    name: 'Google AI Mode',

    // page-level gate: only active on AI Mode pages (those with its input box).
    isActive: function () {
      return !!document.querySelector(INPUT_SEL);
    },

    findBlocks: function () {
      var btns = document.querySelectorAll(COPY_BTN);
      var out = [];
      for (var i = 0; i < btns.length; i++) {
        var c = containerFor(btns[i]);
        if (c && out.indexOf(c) === -1) out.push(c);
      }
      // keep only the innermost; avoid double-counting nested matches (consistent with other adapters).
      return out.filter(function (el) {
        return !out.some(function (other) { return other !== el && el.contains(other); });
      });
    },

    // container's first line is a language label; jump to the first JSON line before handing to parseBlock.
    blockText: function (el) {
      var t = el.innerText || el.textContent || '';
      var lines = t.split('\n');
      for (var i = 0; i < lines.length; i++) {
        if (looksLikeBlock(lines[i])) return lines.slice(i).join('\n');
      }
      return t;
    },

    fillResult: function (text) {
      var ta = document.querySelector(INPUT_SEL);
      if (!ta) return false;
      ta.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      var cur = ta.value || '';
      var next = cur ? cur.replace(/\s+$/, '') + '\n' + text : text;
      try {
        setter.call(ta, next);
      } catch (e) {
        ta.value = next;
      }
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },

    clickSend: function () {
      var btn = document.querySelector(SEND_SEL);
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    },

    // async: open upload menu → wait for the "添加文件" input to render → inject.
    uploadFile: function (file) {
      return new Promise(function (resolve) {
        function done(ok, why) { resolve({ ok: ok, why: why }); }

        var entry = document.querySelector(UPLOAD_ENTRY_SEL);
        if (!entry) { done(false, 'page has no upload entry button'); return; }
        entry.click();

        // the "添加文件" input: empty accept (the "添加图片" one starts with image/ — not this one).
        function findFileInput() {
          var inputs = document.querySelectorAll('input[type=file]');
          for (var i = 0; i < inputs.length; i++) {
            var acc = (inputs[i].getAttribute('accept') || '').toLowerCase();
            if (acc.indexOf('image/') !== 0) return inputs[i];
          }
          return null;
        }

        function inject(input) {
          var f;
          try {
            var blob = new Blob([file.bytes], { type: file.mime || 'application/octet-stream' });
            f = new File([blob], file.name, { type: file.mime || 'application/octet-stream' });
          } catch (e) { done(false, 'failed to construct File: ' + e.message); return; }
          try {
            var dt = new DataTransfer();
            dt.items.add(f);
            input.files = dt.files;
          } catch (e) { done(false, 'failed to write input.files: ' + e.message); return; }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          done(true);
        }

        var waited = 0;
        var timer = setInterval(function () {
          waited += 200;
          var input = null;
          try { input = findFileInput(); } catch (e) { input = null; }
          if (input) {
            clearInterval(timer);
            inject(input);
          } else if (waited >= 5000) {
            clearInterval(timer);
            done(false, 'file input not found 5s after upload menu opened');
          }
        }, 200);
      });
    }
  };
})();
