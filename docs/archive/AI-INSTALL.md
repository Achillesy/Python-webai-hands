# AI-INSTALL.md — 安装、验证与排错手册（给 AI 助手）

> 配套 AI-GUIDE.md。用户第一次安装、或"测通桥"失败、或发命令块没反应时，
> 读这份。装好之后的日常交互，看 AI-GUIDE.md。

## 0. 什么时候读这份

- 用户第一次 setup，还没确认装好
- "测通桥"失败，或扩展图标徽标显示 ✕
- 发命令块没回音、报错、或页面提示"发往扩展后台失败"
- 换了电脑 / 重装 Chrome / 仓库改名或搬家

装好了、桥通了，回到 AI-GUIDE.md。

## 1. 首次安装

需要：Chrome（或 Chromium 系浏览器）+ Python 3。

**装扩展（人手动做）：**
从 Chrome Web Store 安装（自动更新）：
https://chromewebstore.google.com/detail/pboakanoekehbongkmaeianbkebpfahl
工具栏出现 webai-hands 图标。

**装本机 host（人手动做，一次）：**
- Windows：双击 native-host\install_windows.bat
  或 PowerShell 里 `cd native-host; py -3 install.py`
- macOS：终端跑 `python3 native-host/install.py`

install.py 把 host 程序复制到 `~/.webai-hands/`，再生成 host 清单并登记到 Chrome（Windows 写 HKCU 注册表，macOS 放 Chrome 的 NativeMessagingHosts 目录）。

**本机目录结构（`~/.webai-hands/`）：**
- `host.py` / `host.sh` / `host.bat` / `ctx_summary.py` — host 程序（install.py 复制过来）
- `log/` — `host.log`、`exec_history.json`（运行时状态）
- `skill/` — 可复用的 `.py` 小脚本，AI 通过 exec 按固定路径调用
- `machine.json` — 本机 UUID（首次运行生成；老版本在 `~/.config/webai-hands/` 的会自动迁移）

**更新 host：** `git pull` 后重跑一遍 install.py（复制新文件并重新登记）。扩展走商店自动更新，不用管。

**卸载：** `python3 native-host/uninstall.py`（清注册表/清单 + 删 `~/.webai-hands/`）。

## 2. 验证：测通桥

点工具栏 webai-hands 图标 → 点「测通桥」。

- 显示「已连接 <机器名>」→ 桥通了，可以用。
- 显示连接失败 → 看 §5 排错。
- 徽标：✓ 就绪、… 执行中、✕ 断开。

## 2.5 确认扩展生效没

改了扩展、重载之后，怎么看生效没？看 chrome://extensions 卡片上的版本号。
改扩展必须 bump manifest.json 的 version；重载后卡片显示新版本号 = 生效。

## 3. 两种链路，别混淆

测通桥走 popup -> host；发命令块走 页面 content -> background -> host。
两者独立。测通桥过了不代表发块就通，反之亦然。排错先分清断在哪条。

## 4. 三种“没反应”

**模式 1：发块后完全没回音**
让用户点扩展图标 → 测通桥。
- 显示已连接：扩展↔host 通，问题在“页面→扩展”，多半是适配器没匹配到块，或页面没刷新（见 §5）。
- 显示失败：host 没装好，去 §5。

**模式 2：Console 有 [webai-hands] 日志但没结果**
看是“适配器已选中”还是“尚无命令正文”。前者正常，后者说明块被渲染成残缺副本。

**模式 3：想自主诊断**
发诊断块：{"muse":"exec","id":"diag-001","cmd":"__diag__"}
host 回报 hostname、machine_id（本机 UUID，点名用）、platform、pid、最近执行记录、host.log 尾巴。据此判断断在哪段。注意：__diag__ 是唯一可免 host 的块（bootstrap）；之后所有块都必须带 "host":"<machine_id>"。

## 5. 断桥 / 发送失败排错（Windows 实测）

### 5.1 测通桥失败
先列注册表，对照扩展实际连的 host 名：

    Get-ChildItem "HKCU:\Software\Google\Chrome\NativeMessagingHosts" | Where-Object Name -match "hands" | ForEach-Object { "{0} -> {1}" -f $_.PSChildName, (Get-ItemProperty $_.PSPath)."(default)" }

再对照 extension/popup.js 里的 connectNative('com.webai.hands')。四者必须一致：扩展字符串、注册表子键名、清单文件名、清单内 name 字段。

### 5.2 测通桥过了，但发块报“发往扩展后台失败”
根因：安装/重载扩展后，chat 页面没刷新。旧 content script 上下文失效，sendMessage 必失败。
解法：F5 刷新 chat 页面。

### 5.3 改了扩展代码后
chrome://extensions 点重载 → 再刷新所有已打开的 chat 页面。两步缺一不可。

### 5.4 host 升级 / 重装后桥不通
host 程序在 `~/.webai-hands/`，与仓库解耦。`git pull` 后必须重跑 install.py（复制新文件并重新登记），否则 Chrome 可能还在调旧 host。
排查：先确认 `~/.webai-hands/host.py` 的修改时间是不是最新的；再看 §5.1 注册表/清单指的路径是否指向 `~/.webai-hands/`。

### 5.5 卸载后重装
`python3 native-host/uninstall.py` 会删掉 `~/.webai-hands/`（含 machine.json，本机身份轮换）。重装后发 `__diag__` 拿新的 machine_id，旧块里点的名自然失效，属预期行为。

### 5.6 PowerShell 把 git push 的正常输出误报为错误

现象：git push 报红色 NativeCommandError，但实际推送成功（远端引用已更新）。

根因：git 把进度写到 stderr，PowerShell 对原生命令的 stderr 一律包成 error record，exit code 为 0 也显示红字。

判读：看实际内容（x..y main -> main 即成功），别被红字吓到。或加 2>&1 合并流。
