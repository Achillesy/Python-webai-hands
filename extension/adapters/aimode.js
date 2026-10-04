// webai-hands 适配器：Google AI Mode（www.google.com）
//
// DOM 依据：2026-10-04 经 VM 浏览器登录态实测采集。
// - hostname 为 www.google.com，整站匹配，故加 isActive() 页面级开关：
//   只有出现 AI Mode 输入框（textarea[aria-label="尽情提问"]）的页面才生效，
//   普通 Google 搜索页不启用。SPA 客户端路由由 content.js 惰性检查兜底。
// - 代码块：灰色圆角容器（顶部语言标签 + 代码区 + 底部"请谨慎使用此代码。"+复制按钮）。
//   硬锚点为复制按钮 button[aria-label="将代码文本复制到剪贴板。"]（data-sfc-cp 为空值属性）；
//   行内代码无此按钮，可区分。pre/code 的标签名未能隔离（工具限制），故 findBlocks
//   以复制按钮为锚向上找容器，用"内容自验证"定位：取离按钮最近的、其文本中含合法块
//   JSON 行的祖先（8 层封顶），结构变化也不怕。
// - blockText：容器首行是语言标签（"python"/"bash"，可能 aria-hidden），直接取 innerText
//   会让 parseBlock 把语言标签当 JSON 解析而丢弃；此处跳到第一个以 { 开头的行。
// - 输入框：textarea[aria-label="尽情提问"]，maxlength=8192。
// - 发送按钮：button[aria-label="发送"][data-xid="input-plate-send-button"]，
//   仅输入框非空时渲染（先填后发，trySend 有 300-500ms 延迟，足够渲染）。
// - 停止按钮：未捕获（流式窗口错过），暂不实现；content.js 会静默跳过（同 muse.js）。
// - 文件上传：入口 button[aria-label="添加文件和工具"] → 点开展开 role=menu，
//   "添加文件" 的 input[type=file]（accept=""，hidden，multiple）嵌在 menuitem 内，
//   点开菜单后才渲染；走异步 Promise（content.js 用 Promise.resolve 兼容）。
//   注意："添加图片" 的 input accept 限图片类型，本适配器只取 accept="" 的"添加文件"。
//   accept 为空意味着无类型预检；Google 后端是否真收各类文件未经实测（未点发送）。
// - SPA：发送消息触发整页导航（content 重跑）；"新话题"为客户端路由。
// - 限制：仅匹配 www.google.com（实测值）；各国别域名（google.com.hk 等）未覆盖。
(function () {
  'use strict';

  var COPY_BTN = 'button[aria-label="将代码文本复制到剪贴板。"]';
  var INPUT_SEL = 'textarea[aria-label="尽情提问"]';
  var SEND_SEL = 'button[aria-label="发送"][data-xid="input-plate-send-button"]';
  var UPLOAD_ENTRY_SEL = 'button[aria-label="添加文件和工具"]';

  // 粗判一行文本是否为我们的块（exec/probe/attach 任一）。
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

  // 以复制按钮为锚，向上找代码块容器：离按钮最近的、文本中含合法块 JSON 行的祖先。
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

    // 页面级开关：只有 AI Mode 页（含其输入框）才生效。
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
      // 只留最里层，避免嵌套重复计入（与其他适配器一致）。
      return out.filter(function (el) {
        return !out.some(function (other) { return other !== el && el.contains(other); });
      });
    },

    // 容器首行是语言标签，跳到第一个 JSON 行再交给 parseBlock。
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

    // 异步：点开上传菜单 → 等"添加文件"的 input 渲染 → 注入。
    uploadFile: function (file) {
      return new Promise(function (resolve) {
        function done(ok, why) { resolve({ ok: ok, why: why }); }

        var entry = document.querySelector(UPLOAD_ENTRY_SEL);
        if (!entry) { done(false, '页面无上传入口按钮'); return; }
        entry.click();

        // "添加文件" 的 input：accept 为空（"添加图片" 的 accept 以 image/ 开头，不要）。
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
          } catch (e) { done(false, '构造 File 失败：' + e.message); return; }
          try {
            var dt = new DataTransfer();
            dt.items.add(f);
            input.files = dt.files;
          } catch (e) { done(false, '写入 input.files 失败：' + e.message); return; }
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
            done(false, '上传菜单打开后 5s 未找到文件 input');
          }
        }, 200);
      });
    }
  };
})();
