# webai-hands：设计文档

> 本文记录架构设计与技术决策。命令块协议、适配器架构、安全边界的设计理由都在这里。
> 操作指引见 README.md，AI 调试指引见 AI-EVOLUTION.md。

## 6. 正式版定稿：浏览器传输路线（2026-10-01 拍板）

> 本节为 2026-10-01 晚用户拍板定下的正式版方向，前文 §1–§5（终端
> 中间人路线）转为旧案存档，不再作为 v1 的实施路线。定稿依据是同日
> 油猴探针三项实测通过（抓取稳定、填回可用，见纪要 21:36 条）。

### 6.1 架构（四件套）

1. **Chrome 扩展（MV3）**：跑在 muse.ai 聊天页里的内容脚本沿用探针
   已验证的哨兵抓取逻辑（命令块靠代码块首行 JSON
   `{"muse":"exec",...}` 认块）；service worker 通过 Native
   Messaging 与本地程序通话；执行结果由内容脚本填回输入框。
   油猴接不了 Native Messaging，故页面侧正式升级为正经扩展，
   探针脚本退役存档。
2. **Native Messaging 通道**：Chrome 官方的 stdio 桥（4 字节小端
   长度前缀 + UTF-8 JSON），host 名 `com.webai.hands`；不监听任何
   网络端口。扩展 ID 有两个：开发版由 manifest 中写死的 `key` 决定
   （全程固定），商店版由 Chrome Web Store 分配；本地程序的
   `allowed_origins` 两个都认（见 native-host/install.py 的 EXTENSION_IDS）。
3. **本地 host（Python）**：收到命令后在第一台机器（Windows）上走
   PowerShell 执行（`-NoProfile -NonInteractive`），回执含
   stdout/stderr/exit_code/耗时；提权与密码只经系统 UAC，host 不
   接收、不保存任何密码。
4. **日志**：按 hostname 落盘（接 §3.2 第 5 条的记录方针），
   M4 落地。

### 6.2 四项裁决（2026-10-01 22:07 用户「按推荐来」）

1. 结果填回输入框后**先填不发**，用户瞄一眼再发；自动发送做成
   开关留到 M3 再议。
2. 状态指示用**扩展图标徽标**，不进页面、不占页面位置（硬约束：
   不得遮挡输入框，见纪要 21:36 条）。
3. 第一台落地机器为 **Windows**（当前机，探针实测地），Mac 第二台。
4. 命令执行前**不逐条本地确认**，兜底为：host 只认白名单扩展 ID、
   扩展总开关急停、对话里喊停；高风险命令类别的特殊处理留 M4 细议。

### 6.3 继承与退役

- **继承**（自终端路线设计）：hostname 分机 JSON 日志、对话喊停 +
  本地急停、等待闸（停点由本地记录，语义在 M4 按新链路细化）、
  密码不入账。
- **退役**：VPS 任务队列一跳（`/tasks/*` 不再是执行链路的一环）、
  独立终端窗口、终端中间人（pty）与轮询。

### 6.4 分期计划

- **M1 通桥**：本地 host + 注册安装脚本 + 骨架扩展；验收=点扩展图标，
  徽标亮起表示 Chrome 已拉起 host 并收到回音。
- **M2 端到端**：探针抓取逻辑移植进内容脚本，命令块→host 执行→
  结果填回输入框全程打通。
- **M3 结果定型**：结果文本格式、超长输出截断/分段、自动发送开关。
- **M4 加固**：白名单与急停细则、hostname 日志、等待闸、安装包。
- **M5 验收**：测试案例 001 真修（自动删 VS Code 里 miniforge 残留
  的 /K 参数，见纪要 21:55 条）。

### 6.5 分发方针（结论）

开发期用 Chrome 开发者模式加载解压目录；长期多机分发两条候选路：
上架 Chrome Web Store（含搜不到、凭链接安装的 unlisted），或自托
管 CRX + 更新清单走系统策略强制安装。扩展 ID 已在 M1 固定，换渠
道不返工；本地 host 每台机器仍须各装一次（任何路线都免不了，只装
一次）。终选等 M4 前后结合商店额度（见纪要 22:07 条）再定。

### 6.6 开发约定：venv 与 git 代理（2026-10-01 22:51）

- **venv**：项目根目录建 `.venv`（每台机器各建各的，不进 git）；
  host 启动器优先用 `.venv` 的解释器、没有才退系统 Python。当前
  host 只用标准库，venv 先空着，第一个第三方库进来时同时落
  requirements.txt。
- **git 代理**：各机器 git 全局配 `http.proxy`/`https.proxy` 指向
  本机 v2rayN 入口 `http://127.0.0.1:10808`（昨天 macOS 上定的
  办法），免得每次 pull 先手动 set_proxy。

### 6.7 多机路由：machine_id（UUID）严格点名（2026-10-04 定稿，取代早期 hostname 方案）

**场景**：多台机器可能同时开着 Chrome（muse.ai 页面），每台都装扩展＋host；
muse.ai 消息跨设备同步 → 同一个 muse-exec 块会被多台同时抓到。若都执行：
同一 id 重复执行（副作用翻倍）、多台都填结果、自动发送则发两条。必须有一个确定性的“谁执行”规则。

**为什么不用 hostname**：hostname 可重名、可被改动，不能做身份标识（Windows 默认名、
Mac 的 .local 名都不可靠），多机场景会误抓。

**定稿方案（M4，已落地）**：块首行 JSON 必须带 host，值为目标机器的 machine_id（uuid4）；
扩展只执行 host 与本机 UUID 完全相等的块，v2 门禁同时生效。

- machine_id：host 首次运行生成 uuid4，持久化到 ~/.config/webai-hands/machine.json；
  扩展握手时取得并缓存于 chrome.storage.local（MACHINE_KEY），面板可复制，__diag__ 也返回。
- 点名：host 必须精确等于本机 UUID；host 为 * 是显式广播（慎用）；只有 __diag__ 块本身可免 host。
- host 缺失：扩展不执行，自动回一条提醒（nag）告知本机 UUID，请换新 id 重发。fail-closed。
- machine_id 未就绪：门控返回 defer，暂缓不标记，就绪后自动重扫执行。
- 可见性：扩展认领匹配的块后 badge 变色／显示“执”，让他知道哪台接单了。
- 云端决定 host 的信号（优先级）：① 用户明确指定（“在 Mac 上跑”）；② 他发消息的设备；
  ③ web 端模糊时问他最近在哪台，不确定就问一句；④ 结果头回显 host=… 供核验。
- 历史：本节早期（2026-10-02）提过 hostname 显式路由 + v1，已被 M4 UUID 严格点名取代。

### 6.8 sudo 特权边界：osascript 管理员弹窗（2026-10-02 用户拍板）

- 备选有三：A 免密 sudo 名单（sudoers.d + root 专属固定脚本）、
  B 维持亲手跑、C osascript 管理员权限弹窗。**用户选 C**。
- 选中理由（原话要点）：无人值守时弹窗就卡住，sudo 必须经过
  人同意，避免 AI 搞破坏；此方案跑通后可能接入其它在线 AI，
  所以权限必须控制在人手里。
- 机制：`osascript -e 'do shell script "..." with administrator
  privileges'`。host 无终端也能弹系统标准密码框；密码只进
  Apple 的框，host 不接收、不保存、不代输（硬约束不变）。
  他不在机器前 → 弹窗一直等着（配合等待闸：先通知对话侧，
  再半小时标停挂起），fail-safe。
- 诚实边界（云端注记）：
  1. C 卡的是**提权**，不是所有命令——非 sudo 命令桥本来就能
     直接跑，通用命令安全仍靠 hostname 路由 fail-closed、
     扩展 ID 白名单、急停开关（M4）。
  2. 每次 sudo 都弹窗；若日后出现"无人值守也要跑的固定提权
     脚本"，可与 A 叠加：A 管极小固定名单，C 管其余一切。
     两者不互斥。
  3. 对话预告不变：下达提权命令前，云端先在对话里把确切命令
     摆出来，弹窗是同意，预告是知情。
- 首个演练场：图标墙 Spotlight Exclusions 写入 + killall mds
 （m1-iconwall 系列块）。

### 6.9 可观测性：diag 自检（2026-10-02 用户提议，采纳为 M4 设计意向）

- 动机：用户说"没反应"时，不应要求用户贴日志，云端应自主诊断。
- 协议加 `{"muse":"diag"}` 消息：host 返回 log 尾巴、最近 exec id
  列表、平台/hostname。自检 skill（triage runbook）："没反应"→
  先下 diag 块→看断点在哪一段→再定下一步。
- 边界：diag 与 exec 走同一条前向路（页面→扩展→host）；前向断时
  diag 同样消失。独立信号另做：popup ping、徽标状态（M4）。

## 7. 发布策略（2026-10-02 拍板）

首发只声明已验证的站点，用户装扩展时权限透明、审核快。

- 首批：muse.ai、chat.deepseek.com（两个均已验证）
- 后续：根据用户需求决定是否加第三个站点
- 加新站点 = 改 manifest 的 matches + host_permissions + 加一个适配器文件 + 重发版
- 用户两条路：直接用调试好的扩展；或从 GitHub 取源码自己调
- 根据用户反馈，哪个 WebAI 有需求就加哪个

扩展 ID 问题：开发者模式加载用 manifest 里的 key 固定 ID；
上架 Chrome Web Store 后商店会分配新 ID。install.py 的
allowed_origins 须同时列两个 ID，否则商店用户跑不通。

不采用「运行时动态申请权限」（方案 B）和「远端拉适配器配置」（方案 C）：
前者每站点都要用户点一次授权，后者触 MV3 禁止远端代码的红线。
本项目的选择是显式、简单、可预期。

