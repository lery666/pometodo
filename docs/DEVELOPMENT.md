# 开发指南

本仓库是 React + TypeScript + Tauri 2 的 Windows 客户端，使用 SQLite 保存数据。无需其他产品源码即可构建；源码版本与安装包对应情况见[项目状态](STATUS.md)。

## 开发环境

- Windows x64；当前面向 Windows 10 / 11。
- Node.js 22、pnpm 11、Rust stable。
- Visual Studio C++ Build Tools 与 Windows SDK，安装要求见 [Tauri Windows 环境说明](https://v2.tauri.app/start/prerequisites/#windows)。
- WebView2；本地截图 OCR 还需要相应 Windows 语言组件。

在项目根目录安装依赖并启动：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

首次安装或编译需要下载依赖。Rust 的 `--offline` 仅适用于本机已有完整缓存的情况。

调试版使用独立的 `development` 数据目录。开发验证请使用虚构待办与截图，不要复制正式数据或凭据。

## 从哪里修改

| 想修改的内容 | 入口 |
| --- | --- |
| 待办列表、表单、日历与交互 | `src/features/todo/` |
| 工作／生活／学习的显示文字 | `src/features/todo/wordPacks.ts` |
| 设置页面 | `src/features/settings/` |
| 主窗口、浮球、主题 | `src/app/` |
| 存储、附件与备份恢复 | `crates/todo-core/` |
| Windows 窗口、OCR、提醒与更新 | `src-tauri/src/` |
| 界面与原生能力的数据接口 | `src/contracts/`、`src/native/` |
| 官方服务的客户端登录、次数与购买界面 | `src/features/official/` |
| 官方服务的客户端请求与会话保存 | `src-tauri/src/official.rs` |

最后两项是客户端代码，不含账号数据库、网关后台或服务密钥。它们与设置和智能整理流程相连，直接删除目录会破坏现有引用。

本地待办与自带 API Key 不依赖官方登录。自带 Key 支持 DeepSeek、千问和智谱，客户端直连所选服务商，费用由自己的服务商账户承担。

官方服务地址由 `POMETODO_API_BASE_URL` 环境变量或编译时配置读取。未配置时，本地和自带 Key 功能仍可使用，官方登录、次数及购买功能不可用。这个变量是服务地址，不是访问权限或模型密钥。

## 检查与构建

按修改涉及的范围执行：

```powershell
corepack pnpm test
corepack pnpm run check:host
corepack pnpm run build
cargo test --workspace --locked
cargo test --manifest-path src-tauri/Cargo.toml --lib --tests --locked
```

常规测试使用虚构数据、临时目录及本机模拟服务，不应调用付费模型。标为 ignored 的系统 OCR 测试不在默认测试中；自动测试不代表所有 Windows 配置都已验收。

生成原生开发候选：

```powershell
corepack pnpm tauri build --debug --no-bundle
```

结果位于 `src-tauri/target/debug/pometodo-desktop.exe`。它是开发候选，尚未经过官方安装升级验收。不要用自行编译的 release 程序直接覆盖正在使用的正式安装版；发布自己的版本前检查应用标识、数据目录和更新地址，避免与官方版本相互覆盖。

`scripts/ui-preview.html` 与 `scripts/official-ui-preview.html` 使用虚构服务预览真实前端组件。OCR 测试图片由 `scripts/create-ocr-fixture.ps1` 和 `scripts/create-chat-ocr-fixture.ps1` 生成。保留这些脚本与测试，可帮助验证自己的改动。

## 数据与网络

- 任务及附件保存在本机，支持备份导出和恢复；目前没有跨设备同步，也没有旧 WPF 数据成功转换入口。
- 未启用智能整理时，粘贴保留普通文字及截图附件，不自动理解内容或填写字段。
- 官方 AI 整理截图时，将处理后的截图和相关文字发送到官方服务，再由服务器调用模型。
- 自带 Key 整理截图时，先用 Windows 本地 OCR，再发送提取的文字给所选服务商。文字整理同样会发送待整理文字。
- API Key 和官方会话使用 Windows 用户级加密保存，常规任务 ZIP 备份不包含这些凭据。
- AI 结果写入草稿，由用户核对后保存；失败时应保留已有输入。
- 客户端启动时检查官网更新清单。本地待办不依赖 GitHub，但软件并非完全没有网络请求。

## 提交改进

自己电脑上的修改不必提交给官方。希望合入官方版本时，请阅读[参与指南](../.github/CONTRIBUTING.md)，说明改动与验证结果。
