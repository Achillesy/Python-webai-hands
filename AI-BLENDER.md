# AI-BLENDER.md — 用 webai-hands 驱动 Blender（给 AI 助手）

> 用户想在 Blender 里建模、挪东西、渲染时读这份。前提：webai-hands
> 已装好、桥已通（安装见 README.md）。

## 0. 原理

Blender 装了官方 Blender Lab MCP 插件后，会在 localhost:9876 上监听一个
socket，协议是 null 字节分隔的 JSON：

    {"type":"execute","code":"<python代码>","strict_json":true}

不需要 MCP 客户端 App，也不需要独立 server 进程——直连 socket 就行。

## 1. 前置条件

1. Blender 装了官方 Blender Lab MCP 插件（Extension id `mcp`）。
2. Blender 里打开 "Allow Online Access"——否则插件自启动 timer 不注册，
   9876 没人监听。**开了之后要重启 Blender 才生效。**

**如果 9876 没有监听、且用户确认没装过插件 → 停下，让用户去装官方
Blender Lab MCP 插件（Extension id `mcp`）。不要试图自己写一个 socket
服务端或替代控制器塞进 Blender——那是用户的动作，不是你的。** 引导用户：

1. 在 Blender 的 Extensions 面板里搜索并安装 Extension id `mcp`
   （官方 Blender Lab MCP 插件）。
2. 勾选 "Allow Online Access"。
3. **重启 Blender**。
4. 回来重测 9876 是否有人监听。

插件装好之前，别往下走 §2 的发命令步骤。

## 2. 怎么发命令

把 Python 代码写进一个文件，再用仓库里的客户端发：

    py -3 examples/blender/mcp_exec.py D:\tmp\do.py        （Windows）
    python3 examples/blender/mcp_exec.py /tmp/do.py        （macOS）

典型做法：先发 muse-exec 块把 Python 代码写到临时文件，再发一块调
mcp_exec.py 执行它。两步分开，出错好定位。

## 3. 已验证能力（2026-10-02）

- 新建方体、移动、缩放（用户亲眼看着立方体出现）

## 4. 坑

- **优先用 data API**（bpy.data / bmesh）而不是 bpy.ops——socket 执行
  不一定有视口上下文，bpy.ops 可能报 context 错误。
- **别选默认场景里已有的东西**（默认场景自带一个 Cube）——要么先删默认物体。
- 9876 没监听 → 多半是 "Allow Online Access" 没开，或开了没重启 Blender。

## 5. 安全边界

这等于在用户 Blender 里执行任意代码。

- 先只读侦察（列物体、看属性），再动手改。
- 删除、覆盖文件或大改场景前，先把完整代码给用户看，等他同意。
- 清空场景、覆盖 .blend 这类破坏性操作，尤其要确认。
