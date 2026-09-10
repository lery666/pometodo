# PomeTodo

Windows 上的轻量待办工具：记录任务、日期、备注和截图，用 AI 把粘贴内容整理成待办草稿。

公开源码方便你按自己的习惯修改界面、添加功能，做一款适合自己的待办工具。

> **本仓库是衍生版本，不是官方发布。** 上游原项目为
> [ShiliuX-Team/pometodo](https://github.com/ShiliuX-Team/pometodo)。
> 本仓库在原版基础上增加了**自定义 AI 服务商**能力：可以填入任意 OpenAI 兼容的接口地址与模型名，
> 也内置了 Agnes 一键预设。原项目版权归原作者所有，本仓库同样采用 [GPL-3.0-only](LICENSE)，
> 并保留上游原有的版权与许可声明。原版软件的功能说明、官方安装包与技术支持，请以上游仓库和
> [ShiliuX 官网](https://www.shiliux.com/) 为准。

[上游原项目](https://github.com/ShiliuX-Team/pometodo) · [开发指南](docs/DEVELOPMENT.md) · [项目状态](docs/STATUS.md)

## 能做什么

- 本地记录、搜索和归档待办，保存截图附件，导出与恢复备份。
- 用文字或截图进行 AI 整理，核对草稿后再保存。
- 支持工作、生活、学习场景，以及浮球快捷入口。

**本仓库的软件免登录，没有官方账户模块。** 本地待办可直接使用；AI 整理填写自己的 API Key，内置 DeepSeek、千问和智谱，另支持**自定义服务商**——填入任意 OpenAI 兼容的接口地址与模型名即可，详见[自定义 AI 服务商](#自定义-ai-服务商)。需要官方账户与 AI 服务，可使用 ShiliuX 官网提供的安装包；官网版也支持自带 Key。

## 下载或修改

想直接使用，可到[本仓库发布页](https://github.com/lery666/pometodo/releases)下载安装包，其中已包含自定义 AI 服务商的改动；需要官方版本，请到[上游发布页](https://github.com/ShiliuX-Team/pometodo/releases)。想自行修改源码，按下面的步骤构建即可。GitHub 的“Download ZIP”下载的是源码，解压后不能直接当作软件运行。

想修改源码，先准备 Node.js 22、pnpm 11、Rust 和 Windows 构建工具，具体见[开发环境](docs/DEVELOPMENT.md#开发环境)，然后在项目根目录运行：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

调试版使用独立数据目录。常用修改入口与检查命令见[开发指南](docs/DEVELOPMENT.md)。

## 与上游的差异

除自定义 AI 服务商外，本仓库还做了两处调整，以便公开分发时与官方版本互不干扰：

- **应用标识**改为 `io.github.lery666.pometodo`。官方版是 `com.pome.todo`，两者配置目录、安装标识相互独立，不会互相覆盖数据。
- **已断开官方更新渠道**：不再请求 `www.shiliux.com` 的更新清单，避免提示用户去安装官方版。需要恢复时见 `src-tauri/src/distribution.rs` 的注释。

## 自定义 AI 服务商

设置页的「AI 服务商」除 DeepSeek、千问、智谱外，多了第 4 项**自定义**。选中后出现两个输入框：

- **接口地址**：任意 OpenAI 兼容的 Chat Completions 地址。填完整的
  `https://example.com/v1/chat/completions` 可以；只填 `https://example.com/v1` 也可以，
  程序会自动补上 `/chat/completions`。
- **模型名**：该服务商下的模型标识，例如 `agnes-2.0-flash`。

旁边还有「填入 Agnes 预设」按钮，一键填好 Agnes 的官方地址与模型名。空着不填时程序会提示，不会发出请求。

为兼容本地模型和内网中转，接口地址**允许使用 http**，例如用 `http://127.0.0.1:11434/v1`
连接本机 Ollama。

自定义服务商不会附加 `response_format`、思考开关等可选参数，以最大化第三方与中转服务的兼容性；
提示词本身已要求只返回 JSON。文字整理与截图识别共用同一个模型名，若该模型不支持图片输入，
会自动退回 Windows OCR 文字识别。

## 数据与范围

任务和附件保存在本机。使用 AI 时，文字或处理后的截图会发送给你选择的服务商，费用由自己的服务商账户承担；图片直传失败时回退 Windows OCR 文字识别。本衍生版本已断开上游更新渠道，不会检查更新。详情见[数据与网络](docs/DEVELOPMENT.md#数据与网络)。

当前公开源码不含官方账户实现、网关后台、服务密钥或真实用户资料。早期公开版本及其许可保留在历史记录中。手机版与跨设备同步尚未交付。

## 许可与参与

采用 [GPL-3.0-only](LICENSE)，允许使用、修改和商业分发；分发受 GPL 覆盖的程序时，须按许可证提供对应源码并保留必要声明。第三方许可和品牌范围见[版权说明](docs/NOTICE.md)。

你可以只在自己电脑上修改使用，也可以按[参与指南](.github/CONTRIBUTING.md)提交改进。安全问题请按[安全反馈说明](.github/SECURITY.md)私下报告。
