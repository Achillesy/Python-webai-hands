# webai-hands

[English](README.md)

> 给 Web AI 一双手：在聊天页面里说话，你的电脑动手干活。

## 这是什么

打开**免费的**网页 AI（Muse、DeepSeek），用这个扩展让它操作你的电脑。

网页 AI 不再只是一个对话框——你提问、它回答，然后你自己动手搬运。
现在它有了双手：你说要做什么，它替你做完。

和别的需要装到电脑上的 AI 伙伴不同，网页 AI 不需要买 API。
你不是雇了个帮手，你是给免费的 AI 老师安上了一双干活的手。

**一句话**：Web AI 的大脑 + 你电脑的双手 = 免费智能体。

## 快速开始

**1. 安装扩展**

从 Chrome 应用商店安装 **webai-hands**（免费，自动更新）：

[从 Chrome 应用商店安装](https://chromewebstore.google.com/detail/pboakanoekehbongkmaeianbkebpfahl)

**2. 安装本机小程序——一行命令**

复制你系统对应的那一行，粘贴到终端里，回车。
它会把一个小程序装到 `~/.webai-hands/`，并在 Chrome 里登记。
不需要管理员权限。

macOS / Linux：
```bash
curl -fsSL https://raw.githubusercontent.com/Achillesy/Python-webai-hands/main/native-host/install.py | python3
```

Windows（PowerShell）：
```powershell
py -3 -c "import urllib.request; exec(urllib.request.urlopen('https://raw.githubusercontent.com/Achillesy/Python-webai-hands/main/native-host/install.py').read())"
```

**3. 测试桥，复制本机 ID**

点 Chrome 工具栏上的 **webai-hands** 图标，再点 **Test Bridge**（测试桥）。
- 显示 "Connected …" → 桥通了。
- 点 **Copy UUID**（复制 UUID）——你发的每条命令都要带上这个 ID，这样命令才会发到*你的*电脑。

**4. 发送第一条命令**

打开 [muse.ai](https://muse.ai)（免费），新开一个对话，粘贴下面这个代码块
（把 `PASTE-YOUR-UUID-HERE` 换成你刚复制的 UUID）：

```muse-exec
{"muse":"exec","v":2,"id":"ls-001","host":"PASTE-YOUR-UUID-HERE","cmd":"ls ~"}
```

你的电脑会列出用户目录，目录发回对话里。
之后直接说话就行：

> "把我 Downloads 里最大的 10 个文件列出来。"

每个命令块都需要 `"v":2`、唯一的 `"id"`，和你的 `"host"` UUID。

**5. 卸载——干净移除**

不回传数据，不驻留后台。一行命令删掉本机小程序、它在 Chrome 里的登记、日志和数据：

macOS / Linux：
```bash
curl -fsSL https://raw.githubusercontent.com/Achillesy/Python-webai-hands/main/native-host/uninstall.py | python3 - --yes
```

Windows（PowerShell）：
```powershell
py -3 -c "import urllib.request,sys; sys.argv=['u','--yes']; exec(urllib.request.urlopen('https://raw.githubusercontent.com/Achillesy/Python-webai-hands/main/native-host/uninstall.py').read())"
```

会删掉这些：
- Chrome 里的 native-messaging 登记
- `~/.webai-hands/`——程序、日志、skill、机器 ID

然后可以在 `chrome://extensions` 里删掉扩展。不留残留。

## 日常使用

AI 需要把手册放在上下文里。给哪一份，看站点：

| 站点 | 怎么把手册交给 AI |
|---|---|
| **DeepSeek**（没有长期记忆） | 每做一件新事 → 新开对话 → 上传 `AI-GUIDE.md`。每个新对话都要再传一次。 |
| **Muse**（有长期记忆） | 上传一次 `AI-GUIDE.md` 就记住了——或者贴 GitHub 链接，让它自己读项目。 |

给 AI 哪一份：

- 日常操作 → `AI-GUIDE.md`
- 操作 Blender → `AI-BLENDER.md`

## 能做什么

终端里能敲的命令，现在聊天就能让 AI 替你敲：

- 整理文件、搜磁盘、批量改照片名
- Git：status、pull、commit、push——不用碰命令行
- 操作 Blender：建模、挪东西、渲染
- 把文件（PDF、代码、图片）作为真正的聊天附件发给 AI

## 给开发者

项目很小：一个 Chrome MV3 扩展 + 一个 Python host。加一个新站点
= 一个适配器文件（约 30–60 行）+ `manifest.json` 里加一行
（看 `extension/adapters/` 里的例子）。

## 安全

- 本机程序**不监听任何网络端口**，只跟本扩展说话（校验扩展 ID）
- 不接收、不保存、不代输密码；需要管理员权限的操作会弹系统对话框，**由你亲手点**
- AI 跑破坏性命令前，必须先把命令给你看、等你同意

## 赞助

webai-hands 完全免费。如果它帮你省了时间，欢迎请作者喝杯咖啡：

- [Ko-fi](https://ko-fi.com/achillesy)
- [PayPal](https://paypal.me/achillesnewman)

国内用户也可扫码赞助：

| 微信 | 支付宝 |
|---|---|
| ![](sponsor/wechat.jpg) | ![](sponsor/alipay.jpg) |

赞助完全自愿，不影响任何功能。

## 许可

免费使用（仅限非商业用途）。版权 © 2026 Achillesy。禁止商用、
禁止转卖。见 [LICENSE](LICENSE)。
