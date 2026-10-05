# AI-DEVTOOLS.md — 调试网页：为什么不用 CDP

> 想在页面里查元素、调选择器时读这份。结论先行：别走 chrome-devtools-mcp，用 DOM 探针。

## 1. 结论

chrome-devtools-mcp（CDP 路线）在 webai-hands 的 host 通道上打不通。
调试页面一律用 AI-GUIDE 里的 DOM 探针（只读、零依赖、已验证）。

## 2. 为什么走不通（2026-10-02 实测）

Chrome 154 的 chrome://inspect 能开调试服务，监听 127.0.0.1:9222。
但那是新协议：

- 标准 CDP 端点 /json/version 等全 404
- 直接 WebSocket 探 → 403 Connection rejected
- --autoConnect 要读 DevToolsActivePort，被 macOS TCC 挡住
- --browserUrl 也失败（拿不到 /json/version）

唯一可能的解法是给 Chrome 完全磁盘访问权限，安全敏感，未采纳。

## 3. 替代方案：DOM 探针

发 probe 块，content.js 在页面本地执行，只读，不点击不改页面：

    {"host":"本机UUID","muse":"probe","id":"p-001","sel":"input[type=file]"}

sel 是 CSS 选择器。命中元素会列出 tag/type/name/accept/可见性/尺寸/class/父元素/HTML 片段。最多前 10 个。
