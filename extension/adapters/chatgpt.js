// webai-hands 适配器：chatgpt.com
// DOM 依据：2026-10-03 经浏览器实测采集（登录态，Achilles Newman 免费版）。
// - 代码块：外层 <pre class="overflow-visible! px-0!"> 内是 CodeMirror 只读视图
//   <pre class="cm-content q9tKkq_readonly m-0"><code>。用 pre.cm-content 定位
//   （cm-content 是 CodeMirror 稳定类名，q9tKkq_readonly 之类的哈希后缀会变，
//   不要用它做选择器）。注意：代码运行输出也是同结构 pre，靠 JSON 门禁过滤。
// - 输入框：ProseMirror div[contenteditable]，id="prompt-textarea"。
//   注意：另有一个 display:none 的备用 textarea（name="prompt-textarea"，
//   class="wcDTda_fallbackTextarea"）aria-label 与之一样，
//   必须用 div#prompt-textarea 精确定位，绝不能按 aria-label 找。
// - 发送按钮：button[aria-label="发送提示词"]（输入文字后才出现）。
// - 停止按钮：button[aria-label="停止回答"]（回答生成过程中出现）。
// - 文件 input：作曲区静态有 5 个。通用文件入口是 input#upload-files
//   （无 accept 属性、不禁用，静态就在 DOM 里）；其余是图片/视频/相机专用
//   （accept="image/*" 等，多为 disabled），不用。

(function () {
  'use strict';
  var reg = (window.__museHandsAdapters = window.__museHandsAdapters || {});

  reg['chatgpt.com'] = {
    name: 'chatgpt',

    findBlocks: function () {
      // 每个围栏代码块对应一个 pre.cm-content（CodeMirror 只读视图），
      // 不用外层 pre 避免重复计入；运行输出的同结构 pre 靠 JSON 门禁过滤。
      return Array.prototype.slice.call(
        document.querySelectorAll('pre.cm-content'));
    },

    findInput: function () {
      // 必须是 div#prompt-textarea；页面上还有个 display:none 的备用 textarea
      // 同名，querySelector('div#prompt-textarea') 天然排除它。
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
      // 兜底：直接写 textContent
      try {
        ed.textContent = (hasText ? (ed.textContent + '\n') : '') + text;
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      } catch (e) {
        return false;
      }
    },

    clickSend: function () {
      var sels = [
        'button[aria-label="发送提示词"]',
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

    // ChatGPT 附件限制（2026-10-03 实测，免费版）：
    // - 通用文件入口 input#upload-files：无 accept 属性（文件选择器层面不限类型）、
    //   multiple、静态就在 DOM 里。这里不做类型预检。
    // - 免费版有上传额度：额度用完时站点直接拒收（页面提示"文件、图像和数据分析
    //   不可用"），与文件类型无关；注入后若站点拒收，错误由页面提示。
    // - zip 是否被接受：因探测时额度未恢复，未能验证，待额度重置后重测。
    uploadFile: function (file) {
      // file: {name, mime, bytes(Uint8Array)}
      var input = document.querySelector('input#upload-files[type=file]');
      if (!input) return { ok: false, why: '页面无 input#upload-files' };
      if (input.disabled) {
        return { ok: false, why: '文件上传入口被禁用（可能是免费版上传额度用完）' };
      }
      var blob, f;
      try {
        blob = new Blob([file.bytes], { type: file.mime || 'application/octet-stream' });
        f = new File([blob], file.name, { type: file.mime || 'application/octet-stream' });
      } catch (e) {
        return { ok: false, why: '构造 File 失败：' + e.message };
      }
      var dt = new DataTransfer();
      dt.items.add(f);
      try {
        input.files = dt.files;
      } catch (e) {
        return { ok: false, why: '写入 input.files 失败：' + e.message };
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    },
  };
})();
