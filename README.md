# PomeTodo

PomeTodo 是 Windows 上的轻量待办工具，用于记录客户任务、交付日期、备注和截图，也可以用 AI 把粘贴的内容整理成待办草稿。

> 本仓库提供 PomeTodo **Windows 桌面客户端**源码，采用 **GNU GPL v3（GPL-3.0-only）**。官方账号、支付及 AI 服务后台不在此仓库内。
>
> 当前公开的是版本号为 **0.1.3** 的 Windows 开发源码快照，尚未核实它与官网 0.1.3 安装包的完整构建对应关系。已知问题见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 使用方式

普通用户可从 [ShiliuX 官网](https://www.shiliux.com/) 的 PomeTodo 入口获取安装包，不需要配置开发环境。

- 本地基础待办长期免费，免登录；支持客户、任务、日期、备注、截图附件、搜索和归档。
- 未启用智能整理时，粘贴保留普通文字输入及截图附件，不自动理解内容或填写字段。
- 启用智能整理后，可选择官方服务或自带 API Key。AI 结果填入草稿，由用户核对并保存。
- 自带 Key 支持 DeepSeek、千问和智谱，客户端直连所选服务商，费用由对应服务商账户承担，本地与自带 Key 模式免官方登录。
- 官方 AI 是独立提供的服务，使用条件见 ShiliuX 官网和客户端说明；源码许可不包含官方服务的使用权益。

目前主要面向 Windows 10 / 11 x64；部分系统兼容性反馈仍在调查记录中，不承诺覆盖所有系统配置。

## 数据与网络

任务及附件保存在用户电脑上，软件提供备份导出与恢复。当前没有跨设备云同步，也没有旧 WPF 版本数据的成功转换入口。

- 本地待办不依赖官方账号或 AI 次数。
- 官方 AI 整理截图时，会将处理后的截图连同相关文字发送给官方 AI 服务，再由服务端调用模型；截图内容会离开本机。
- 自带 Key 整理截图时，先使用 Windows 本地 OCR，再把提取的文字发送给所选模型服务商。文字整理同样会发送待整理文字。启用云端 AI 后不能视为完全离线。
- API Key 和官方会话由 Windows 用户级加密机制保存，常规任务 ZIP 备份不包含这些凭据。
- AI 只生成草稿，不替用户自动保存；失败时应保留已有输入，用户可手动继续记录。
- 客户端启动会检查官网的更新清单；本地待办功能不依赖 GitHub，但“使用本地待办”不等于软件完全没有网络请求。

## 开发环境

当前开发验证环境为 Windows x64、Node.js 22、pnpm 11、Rust stable，以及 Visual Studio C++ Build Tools / Windows SDK。原生界面依赖 WebView2；本地截图 OCR 需要相应 Windows 语言组件。

源码使用 React、TypeScript、Tauri 2 和 SQLite。三个依赖清单与锁文件都在本目录中，不需要其他 Pome 产品的源码目录。

首次安装前端依赖：

```powershell
corepack pnpm install --frozen-lockfile
```

首次编译需要下载锁定的 Rust 依赖；`--offline` 只适用于本机已有完整缓存的情况。运行开发版：

```powershell
corepack pnpm tauri dev
```

调试版使用独立的 `development` 数据目录。验证修改时使用虚构数据，避免把正式任务、截图或登录凭据放入源码、测试或问题反馈中。

官方服务地址从 `POMETODO_API_BASE_URL` 环境变量或编译时配置读取。未配置时，本地和自带 Key 功能仍可使用，官方登录、次数及购买功能不可用。这个变量是服务地址，不是模型密钥。开发和普通测试不需要作者的模型密钥、商户凭据或生产后台权限。

## 检查与构建

在项目根目录运行：

```powershell
corepack pnpm test
corepack pnpm run check:host
corepack pnpm run build
cargo test --workspace --locked
cargo test --manifest-path src-tauri/Cargo.toml --lib --tests --locked
```

上述常规测试使用虚构数据及本机模拟服务，不应调用付费模型。标为 ignored 的系统 OCR 测试不在默认测试中。

生成原生开发候选：

```powershell
corepack pnpm tauri build --debug --no-bundle
```

结果位于 `src-tauri/target/debug/pometodo-desktop.exe`。这只是开发候选，不是经过安装升级验收的官方发布包。不要用自行编译的 release 程序直接覆盖正在使用的正式安装版。

`scripts/ui-preview.html` 与 `scripts/official-ui-preview.html` 使用虚构前端服务，供开发侧验证界面，不代表真实账号、支付或模型已接通。

## 目录

| 目录 | 内容 |
| --- | --- |
| `src/features/todo/` | 待办列表、表单与任务交互 |
| `src/features/settings/` | 设置页面 |
| `src/features/official/` | 官方账号与 AI 服务界面 |
| `src/contracts/`、`src/native/` | 界面与原生能力的接口 |
| `crates/todo-core/` | SQLite、附件、设置、备份恢复 |
| `src-tauri/src/` | Windows 窗口、OCR、AI 请求、凭据、提醒与更新 |

应用使用系统字体。来源目录中留存的受限字体不用于构建，也不得进入公开源码、源码历史或发行附件。

## 参与与许可

参与方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。普通用户反馈已有现象即可，不需要复现故障、切换系统设置或安装调试包。

本项目自有代码、文档与随附自有资源按 [GNU GPL v3](LICENSE) 提供，具体范围与品牌说明见 [NOTICE.md](NOTICE.md)。第三方组件保留其各自许可，来源记录见 [docs/SOURCE_PROVENANCE.md](docs/SOURCE_PROVENANCE.md)，依赖清单见 [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)。

可以使用、修改与商业分发；分发受 GPL 覆盖的程序及修改版时，需要遵守许可证并提供对应源码。获得源码不代表获得官方 AI 免费额度、账号权限或品牌背书。上述说明不替代 LICENSE 正文。

当前只发布 Windows 客户端源码。手机版和跨设备同步属于后续规划，尚不是本仓库可用功能，也没有承诺交付日期。维护安排见 [ROADMAP.md](ROADMAP.md)，安全问题报告方式见 [SECURITY.md](SECURITY.md)。
