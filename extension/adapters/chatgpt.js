// webai-hands adapter: chatgpt.com
// DOM basis: captured via real browser on 2026-10-03 (logged in, Achilles Newman free tier).
// - Code blocks: outer <pre class="overflow-visible! px-0!"> wraps a CodeMirror read-only view
//   <pre class="cm-content q9tKkq_readonly m-0"><code>. Locate via pre.cm-content
//   (cm-content is CodeMirror's stable class name; hashed suffixes like q9tKkq_readonly change,
//   don't use those as selectors). Note: code-run output uses the same pre structure; filtered by the JSON gate.
// - Input: ProseMirror div[contenteditable], id="prompt-textarea".
//   note: there is also a display:none fallback textarea (name="prompt-textarea",
//   class="wcDTda_fallbackTextarea") with the same aria-label,
//   so pin it down with div#prompt-textarea; never search by aria-label.
// - Send button: button[aria-label="发送提示词"] (appears only after typing).
// - Stop button: button[aria-label="停止回答"] (appears while generating).
// - File input: 5 static ones in the composer. The generic file entry is input#upload-files
//   (no accept attribute, not disabled, statically in the DOM); the rest are image/video/camera-specific
//   (accept="image/*" etc., mostly disabled) — skip those.

(function () {
  'use strict';
  var reg = (window.__museHandsAdapters = window.__museHandsAdapters || {});

  reg['chatgpt.com'] = {
    name: 'chatgpt',

    findBlocks: function () {
      // each fenced code block maps to one pre.cm-content (CodeMirror read-only view),
      // skip the outer pre to avoid double-counting; same-structure pres from run output are filtered by the JSON gate.
      return Array.prototype.slice.call(
        document.querySelectorAll('pre.cm-content'));
    },

    findInput: function () {
      // must be div#prompt-textarea; the page also has a display:none fallback textarea
      // with the same name; querySelector('div#prompt-textarea') naturally excludes it.
      var ed = document.querySelector('div#prompt-textarea[contenteditable="true"]');
      if (ed && ed.offsetParent !== null) return ed;
      return null;
    },

    fillResult: function (text) {
      var ed = this.findInput();
      if (!ed) return false;
      try { ed.focus(); } catch (e) {} var hasText = !!(ed.textContent || '').trim();
      // ProseMirror: empty -> select-all to activate input pipeline; has draft -> collapse caret to end and append (never wipe user input)
      try {
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(ed); if (hasText) range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        var ins = hasText ? ('\n' + text) : text; if (document.execCommand('insertText', false, ins)) {
          ed.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
      } catch (e) {}
      // fallback: write textContent directly
      try {
        ed.textContent = (hasText ? (ed.textContent + '\n') : '') + text;
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch (e) {
        return false;
      }
    },

    clickSend: function () {
      // 2026-10-04 VM verified: data-testid="send-button" is most stable; aria-label="发送提示词" still works;
      // id="composer-submit-button" as backup. The button only renders when the input is non-empty (empty shows the voice button).
      var sels = [
        '[data-testid="send-button"]',
        'button[aria-label="发送提示词"]',
        '#composer-submit-button',
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
    },

    isStopButton: function (btn) {
      if (!btn || !btn.getAttribute) return false;
      return btn.getAttribute('aria-label') === '停止回答';
    },

    // ChatGPT attachment limits (verified 2026-10-03, free tier):
    // - Generic file entry input#upload-files: no accept attribute (no type limit
    //   at the file-picker level), multiple, statically in the DOM. No type pre-check here.
    // - Free tier has an upload quota: when exhausted the site rejects outright
    //   (page shows "文件、图像和数据分析不可用"), regardless of file type;
    //   if the site rejects after injection, the page surfaces the error.
    // - Whether zip is accepted: unverified (quota hadn't reset during probing); retest after reset.
    uploadFile: function (file) {
      // file: {name, mime, bytes(Uint8Array)}
      var input = document.querySelector('input#upload-files[type=file]');
      if (!input) return { ok: false, why: 'page has no input#upload-files' };
      if (input.disabled) {
        return { ok: false, why: 'file upload entry is disabled (free-tier upload quota may be exhausted)' };
      }
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
  };
})();
