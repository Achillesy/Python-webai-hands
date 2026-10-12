# webai-hands 上手指南

> 给人看的：只负责把 bridge 建起来（5 分钟）。
> 建好之后，日常让 AI 干活看 `AI-GUIDE.md`，玩 Blender 看 `AI-BLENDER.md`，
> 都在你的安装目录：`{{INSTALL_DIR}}`。

## 这是什么

webai-hands 让网页版 AI（DeepSeek、Claude 等）在你的电脑上执行命令。
你和 AI 聊天，AI 写命令块，Chrome 扩展抓到它，交给本机小程序执行，
结果回填到对话里。免 API Key。

## 第一步：装 Chrome 扩展

打开下面链接安装（点"添加至 Chrome"）：

https://chromewebstore.google.com/detail/pboakanoekehbongkmaeianbkebpfahl

## 第二步：装本机程序

macOS / Linux：打开终端（Mac 按 ⌘+空格搜"终端"），运行：

    curl -fsSL https://raw.githubusercontent.com/Achillesy/Python-webai-hands/main/native-host/install.py | python3

Windows：用 PowerShell 运行 README 里的对应命令。

## 第三步：验证桥通了

1. 看 Chrome 工具栏的 webai-hands 图标：出现 ✓ 徽章就是通了。
2. 点开图标，把 **本机 UUID** 复制下来，告诉你的 AI。
3. 让 AI 发下面这块测试（包进 `muse-exec` 围栏，`<你的UUID>` 换成第 2 步的，
   `id` 每次用新的，`"v":2` 不能少，不带不执行）：

        {"muse":"exec","id":"hello-1","v":2,"host":"<你的UUID>","cmd":"echo hello"}

4. 对话里回填了 `hello`，桥就通了。以后直接跟 AI 说话就行。

## 接下来

- 让 AI 干活：把 `{{INSTALL_DIR}}/AI-GUIDE.md` 上传给 AI，这是教 AI 写命令块的完整指南。
- Blender 出图：`{{INSTALL_DIR}}/AI-BLENDER.md`。
- 找不到安装目录？Mac：Finder → 前往 → 前往文件夹 → 粘贴 `{{INSTALL_DIR}}`；
  Windows：把路径粘贴到资源管理器地址栏。

## 排错

- 图标是 ✕：重跑一遍第二步的安装命令。
- 发了块没反应：检查 `"v":2` 带了没，`id` 是不是用过，`host` 对不对。
- 还不行：看 `{{INSTALL_DIR}}/log/host.log` 最后几行，或重装。
