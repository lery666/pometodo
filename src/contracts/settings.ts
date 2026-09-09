/** 第二批设置界面固定合同 v1。主控维护；页面不得直接调用系统或保存秘密。 */
export type SettingsTheme = "system" | "light" | "dark";
export type AiProvider = "deepseek" | "qwen" | "glm";
export type DirectoryKind = "data" | "screenshots";
export interface QuickDueSetting { label: string; days: number }
export interface CustomerSetting { originalName: string; displayName: string; activeCount: number }

export interface AppSettings {
  theme: SettingsTheme;
  startWithWindows: boolean;
  startMinimized: boolean;
  floatingBallEnabled: boolean;
  closeAction: "tray" | "exit";
  dailyReminderEnabled: boolean;
  dailyReminderTime: string;
  quickDueOptions: QuickDueSetting[];
  aiProvider: AiProvider;
  /** “客户”字段的显示名（默认“客户”），仅影响界面文案。 */
  customerLabel: string;
}
export interface SettingsSnapshot {
  settings: AppSettings;
  customers: CustomerSetting[];
  keyConfigured: Record<AiProvider, boolean>;
  dataDirectory: string;
  screenshotDirectory: string;
  version: string;
}
/** 预检和执行分开；token 由原生宿主管理，前端不能自行构造路径或文件内容。 */
export interface DirectoryChangePreview {
  token: string;
  kind: DirectoryKind;
  source: string;
  destination: string;
  message: string;
}
export interface BackupImportPreview {
  token: string;
  fileName: string;
  taskCount: number;
  attachmentCount: number;
  message: string;
}
export interface SettingsActionResult {
  snapshot: SettingsSnapshot;
  message: string;
}
export interface SettingsServices {
  load(): Promise<SettingsSnapshot>;
  /** 只传变更字段；resolve 表示系统应用及本地保存成功，reject 保留旧值并提示。 */
  update(patch: Partial<AppSettings>): Promise<SettingsSnapshot>;
  renameCustomer(originalName: string, displayName: string): Promise<SettingsSnapshot>;
  hideCustomer(originalName: string): Promise<SettingsSnapshot>;
  saveApiKey(provider: AiProvider, key: string): Promise<SettingsSnapshot>;
  clearApiKey(provider: AiProvider): Promise<SettingsSnapshot>;
  chooseDirectory(kind: DirectoryKind): Promise<DirectoryChangePreview | null>;
  applyDirectoryChange(token: string): Promise<SettingsActionResult>;
  exportBackup(): Promise<{ message: string } | null>;
  chooseBackupImport(): Promise<BackupImportPreview | null>;
  importBackup(token: string): Promise<SettingsActionResult>;
}
export interface SettingsPageProps {
  services: SettingsServices;
  onBack(): void;
  /** 每次已确认成功后通知宿主同步主题、标签、客户联想、数据刷新。 */
  onChanged?(snapshot: SettingsSnapshot): void;
}
