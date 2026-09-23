# DSH Desktop

[English](README.md) | 中文

一个面向 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** 的 Windows 桌面应用：
一个窗口，里面就是你自己的 DSH 界面 —— 没有浏览器外壳、没有终端、不需要手动启动服务器。

它是一个**外壳，而不是第二个 harness**。harness 以子进程方式运行在**你自己的 Node** 上，并从你
自己的 `web` 配置文件启动，所以你已有的余额徽标、工具、设置与会话都原样可用。什么都不复制，
本应用也不会改写 `%USERPROFILE%\.dsh` 下的任何东西。

## 它能做什么

**对 harness**

- 以 `--profile web --port 0 --no-open` 启动它，等待它打印就绪行，再把得到的回环地址加载进原生窗口。
- **绝不碰你自己正在运行的 `dsh web`。** 端口由操作系统分配，所以不可能撞车；而它唯一会终止的
  进程是它自己的子进程 —— 依据记录下来的完整描述（可执行文件、父进程、argv、启动时间）识别，
  而不是靠进程名。
- 掌管那个子进程的一生：启动它、崩溃时重启它（一分钟内三次，之后停止并说明原因），退出时连带
  清掉整棵进程树。
- 记住窗口的大小、位置与最大化状态，并在记忆中的位置已不在任何显示器上时自动修正。

**周边**

- 托盘图标与应用菜单；外部链接交给你的真实浏览器打开；工作区有文件夹选择器；可选「关闭到托盘」。
- **全中文界面**与语言开关。外壳自己的界面 —— 菜单、托盘、设置窗口、harness 启动前的页面、
  各类对话框，以及 harness 失败时的提示 —— 都已翻译，由 `语言`（`自动` / `中文` / `English`）
  决定。`自动` 跟随系统语言，**窗口里的 GUI 同样如此**，因为 `auto` 刻意不去覆盖 Chromium 自己的
  区域设置。命令行用 `--language <id>` 效果相同。
- **设置窗口**（`文件 → 设置…`），实时显示解析到的 Node、harness 与日志路径，并逐字段校验。
  清空某个字段表示「这一项不动」而不是「恢复默认」—— 表单分不清「你清空的框」和「它从没填过的框」，
  所以要还原就用**恢复默认值**（D-15）。
- **全局快捷键**（默认 `Control+Alt+D`）与**任务栏跳转列表**，列出你打开过的工作区，让一个项目
  只差一次右键。
- **诊断支持包**（`帮助 → 导出诊断…`）—— 版本、解析出的路径、窗口与配置状态、日志尾部，且已删除
  令牌。
- 命令行：`--version`、`--help`、`--settings`、`--language <auto|zh|en>`，以及一个作为工作区的
  文件夹参数。

**隐私**

- 日志与设置存放在 `%APPDATA%\DSH Desktop`。用于认证窗口的启动令牌只使用一次，并且在每个日志与
  状态文件中都被抹掉 —— 包括诊断支持包否则会带上那些更宽的写法。
- 除了它自己启动的那个回环地址之外，不与任何东西通信。

## 安装（便携版）

```powershell
git clone https://github.com/ABccgh/dsh-desktop D:\dsh-desktop
cd D:\dsh-desktop
npm install          # 安装 Electron 并抓取它的二进制
npm run icon         # build/icon.png + build/icon.ico，取自已安装的 DSH 图标
npm run pack         # dist\DSH Desktop\DSH Desktop.exe
npm run shortcut     # 开始菜单 + 桌面快捷方式
```

然后双击 **DSH Desktop**。产物是一个可以随意搬走的文件夹；快捷方式是唯一写在它外面的东西，
搬走之后重跑一次 `npm run shortcut` 即可修复。

把快捷方式固定到某个项目：

```powershell
pwsh -NoProfile -File bin/shortcut.ps1 -Name 'DSH Desktop - Atlas' -Workspace D:\atlas
```

环境要求：Windows 10/11，以及 **PATH 上有 Node.js** —— 本项目是针对 26.8.1 构建与实测的，而且
harness 运行在那份 Node 上，不是 Electron 内置的那个（见 `docs/agent-notes/DECISIONS.md` D-1）。

## 开发

```powershell
npm start                        # 从源码运行
npm test                         # 101 个测试，只覆盖纯模块，约 0.4 秒
npm run smoke                    # 针对打包产物的验收阶梯（20 项检查）
npm run surface                  # 装着的 DSH 还是当初验证过的那一面吗？
npm start -- "D:\some\project"   # 以该文件夹为工作区启动
npm start -- --settings          # 启动时打开设置窗口
npm start -- --language en       # 仅本次运行强制指定语言
```

`npm run smoke` 驱动打包产物，需要先 `npm run pack`；`npm run smoke:dev` 对 `electron .` 跑同一套
阶梯。两者都是真启动真程序，约一分钟：阶梯里包含**第二次**以 `--language en` 启动，用来证明显式
语言确实覆盖系统语言；它还会断言它启动的 harness 就是**当前安装的那个 DSH 版本** —— 于是一次全绿
绑定的是一个版本，而不是「某个 harness」。

`npm run surface` 回答升级带来的那个问题。外壳不 pin 任何 DSH 版本（它顺着 junction 跟随安装），
所以新的 DSH 会自己到来；会移动的是外壳脚下那块地：就绪行、argv、端口 schema、认证 cookie 前缀。
这条命令把它们与 `docs/agent-notes/dsh-surface.json`（记录着上次读过并实测过的那些字节）逐字节比较。
报出 `CHANGED` 是**去读一遍的触发条件**，不是「契约坏了」的判决。

设 `DSH_DESKTOP_DIAG=1` 会让启动过程探测并记录每一层网络能否到达 harness。窗口加载不出来时，
这是第一个该看的地方。

## 目录结构

| 路径 | 放什么 |
| --- | --- |
| `src/` | 外壳本体：Electron 主进程、子进程监督器、纯模块、两个页面 |
| `src/i18n.mjs` | 外壳会显示的所有文案（中英两份），以及语言解析器 |
| `bin/` | `pack.mjs`（便携打包）、`smoke.mjs`（验收）、`dsh-surface.mjs`（外壳与 DSH 的耦合面）、`shortcut.ps1`（系统集成） |
| `tools/make-icon.mjs` | SVG → PNG → ICO，并核对载荷大小与声明一致 |
| `test/` | `node --test`；凡是能做成纯函数的模块都做成纯的，好让它不碰磁盘就能测 |
| `docs/agent-notes/` | 设计背后的实测记录：runbook、chronicle、decisions、board，以及 `npm run surface` 用来比较的 `dsh-surface.json` |

## 设计，一段话

Electron 只是外壳。harness 以子进程方式跑在**系统 Node** 上，因为 harness 装了进程级熔断 ——
`installFailLoud` 会把任何未处理的 rejection 变成 `process.exit(1)` —— 如果它与 Electron 同进程，
整个应用都会被带走。窗口通过回环地址加载子进程打印出来的 URL，用的是该进程自己的启动令牌；那个
令牌是一次会话的凭据，所以本应用把它交给窗口，绝不写进日志。终止用 `taskkill /T /F`，因为实测
表明 Windows 从不向子进程投递信号。每一项背后的实测见 `docs/agent-notes/`，其中也包括**四个后来
被推翻的解释**。

## 状态

已在 Windows 10/11、DSH 0.1.5-rc.3（2026-09-23 重新验证）、Node 26.8.1、Electron 44.3.0 上验证
可用。有三件事是**故意未完成**并记录在案，而不是藏起来：

- **同一时间只有一个窗口、一个工作区。** 多窗口既没设计也没实现。曾经承诺这件事的设置项
  **Workspace windows** 被校验、被渲染，却没有任何代码读取它；它已被删除，而不是留着一个无效的
  控件。现在有一条测试会在任何配置键没有读取方时失败。
- **`electron-builder` 的 NSIS 安装包目标是配好的，但从未构建过。** 受支持的路径是
  `bin/pack.mjs`。
- **exe 未签名**，所以 Windows 会显示 SmartScreen 首次运行警告。

## 许可

MIT —— 见 `LICENSE`。
