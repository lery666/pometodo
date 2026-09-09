import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createTodoServices, nativeError } from "../native/todoServices";
import { createSettingsServices } from "../native/settingsServices";
import { SettingsPage } from "../features/settings";
import { TodoPage } from "../features/todo";
import type { CustomerSetting, QuickDueSetting, SettingsServices, SettingsSnapshot, SettingsTheme } from "../contracts/settings";
import "./shell.css";
import logoUrl from "../assets/pometodo-logo.png";
import type { StatusMessage } from "../components/StatusBar";
import type { SmartArrangePreferences, SmartArrangeSnapshot } from "../contracts/smartArrange";
import { createOfficialServices, type Entitlement, type OfficialAccount, type OfficialOffers } from "../contracts/official";
import AccountCard from "../features/official/AccountCard";
import OfficialLoginCard from "../features/official/OfficialLoginCard";
import { smartArrangeEntry } from "../features/official/smartArrangeEntry";
import { createUpdateController } from "./updateController";
import { updateServices } from "../native/updateServices";
import UpdatePanel from "./UpdatePanel";

interface AppInfo {
  dataDirectory: string; theme: SettingsTheme; version: string;
  quickDueOptions: QuickDueSetting[]; customers: CustomerSetting[]; closeAction: "tray" | "exit"; floatingBallEnabled: boolean; customerLabel: string;
}
interface OpenRequest { taskId?: string; settings: boolean; pending?: boolean; requestId: number }
const todoServices = createTodoServices(invoke);
const settingsServices = createSettingsServices(invoke);
const officialServices = createOfficialServices(invoke);
async function openAttachment(path: string) {
  try { await invoke("pometodo_open_attachment", { path }); }
  catch (error) { throw nativeError(error); }
}
async function importAttachment(png: string): Promise<string> {
  try { return await invoke("pometodo_import_attachment", { png }); }
  catch (error) { throw nativeError(error); }
}

interface UpdateInstallActivity {
  todoBusy: boolean;
  todoEditorOpen: boolean;
  todoLoginOpen: boolean;
  accountBusy: boolean;
  settingsBusy: boolean;
  smartArrangeBusy: boolean;
  themeSaving: boolean;
  pinSaving: boolean;
  installing: boolean;
}

export function canInstallUpdate(activity: UpdateInstallActivity) {
  return !Object.values(activity).some(Boolean);
}

interface LeaveSettingsOptions {
  closeSettings(): void;
}

/**
 * 返回设置页一律放行：扫码绑定中离开只是取消当前二维码（不影响已登录设备），
 * 付款由服务端轮询与后台补偿兜底；页面上的保存均为自动保存，离开不中断。
 */
export function leaveSettings({ closeSettings }: LeaveSettingsOptions) {
  closeSettings();
  return true;
}

interface SettingsLeaveGateOptions {
  closeSettings(): void;
}

/** 原生打开事件长期监听同一函数；保留入口以兼容原生打开事件与设置页返回。 */
export function createSettingsLeaveGate({ closeSettings }: SettingsLeaveGateOptions) {
  return () => leaveSettings({ closeSettings });
}

/** 设置页写操作由宿主统一计数，更新页不需要依赖页面文案判断是否安全安装。 */
export function trackSettingsActivity(services: SettingsServices, onBusyChange: (busy: boolean) => void): SettingsServices {
  let active = 0;
  async function track<T>(operation: () => Promise<T>): Promise<T> {
    active++;
    if (active === 1) onBusyChange(true);
    try { return await operation(); }
    finally {
      active = Math.max(0, active - 1);
      if (active === 0) onBusyChange(false);
    }
  }
  return {
    load: () => services.load(),
    update: patch => track(() => services.update(patch)),
    renameCustomer: (originalName, displayName) => track(() => services.renameCustomer(originalName, displayName)),
    hideCustomer: originalName => track(() => services.hideCustomer(originalName)),
    saveApiKey: (provider, key) => track(() => services.saveApiKey(provider, key)),
    clearApiKey: provider => track(() => services.clearApiKey(provider)),
    chooseDirectory: kind => track(() => services.chooseDirectory(kind)),
    applyDirectoryChange: token => track(() => services.applyDirectoryChange(token)),
    exportBackup: () => track(() => services.exportBackup()),
    chooseBackupImport: () => track(() => services.chooseBackupImport()),
    importBackup: token => track(() => services.importBackup(token)),
  };
}

function Icon({ kind }: { kind: "theme" | "settings" | "close" | "minimize" | "pin" | "update" }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "minimize" && <path d="M5 12h14" />}
    {kind === "pin" && <><path d="M8 3h8M9 3v6l-3 4h12l-3-4V3M12 13v8" /></>}
    {kind === "close" && <path d="m6 6 12 12M18 6 6 18" />}
    {kind === "theme" && <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}
    {kind === "settings" && <><path d="m9 3-.7 2.2-2.2 1.3-2.3-.4L2.3 9l1.6 1.7v2.6L2.3 15l1.5 2.9 2.3-.4 2.2 1.3L9 21h6l.7-2.2 2.2-1.3 2.3.4 1.5-2.9-1.6-1.7v-2.6L21.7 9l-1.5-2.9-2.3.4-2.2-1.3L15 3Z" /><circle cx="12" cy="12" r="3" /></>}
    {kind === "update" && <><path d="M12 3v10" /><path d="m8.5 9.5 3.5 3.5 3.5-3.5" /><path d="M5 16v2.2A1.8 1.8 0 0 0 6.8 20h10.4a1.8 1.8 0 0 0 1.8-1.8V16" /></>}
  </svg>;
}

export function AppShell() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  // 设置保存后先占位新版本；迟到的全量 app_info 应答只允许覆盖同版本旧值，防止快速切场景时旧值回写。
  const infoVersionRef = useRef(0);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [actionError, setActionMessage] = useState<StatusMessage | null>(null);
  const setActionError = (text: string | null) => setActionMessage(text ? { text, tone: "error" } : null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 本次打开设置页需要对焦的分组请求（递增 seq）；打开设置页后由 SettingsPage 按 seq 处理，重开普通设置不再对焦。 */
  const [settingsFocusRequest, setSettingsFocusRequest] = useState<{ seq: number; target: string } | null>(null);
  const focusSeqRef = useRef(0);
  const [todoBusy, setTodoBusy] = useState(false);
  const [todoEditorOpen, setTodoEditorOpen] = useState(false);
  const [loginPanelOpen, setLoginPanelOpen] = useState(false);
  const [purchaseActive, setPurchaseActive] = useState(false);
  const purchaseActiveRef = useRef(false);
  const reportPurchaseActive = useCallback((active: boolean) => { purchaseActiveRef.current = active; setPurchaseActive(active); }, []);
  const [accountBusy, setAccountBusy] = useState(false);
  const accountBusyRef = useRef(false);
  const reportAccountBusy = useCallback((busy: boolean) => {
    accountBusyRef.current = busy;
    setAccountBusy(busy);
  }, []);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const guardedSettingsServices = useMemo(() => trackSettingsActivity(settingsServices, setSettingsBusy), []);
  const [officialAccount, setOfficialAccount] = useState<OfficialAccount | null>(null);
  const [officialOffers, setOfficialOffers] = useState<OfficialOffers | null>(null);
  const accountSequence = useRef(0);
  const refreshOfficialAccount = useCallback(async () => {
    const sequence = ++accountSequence.current;
    try {
      const account = await officialServices.account();
      if (sequence !== accountSequence.current) return;
      setOfficialAccount(account);
      // 商品目录只在登录后读取；入口文案只区分"可购买/暂不可用"，失败时静默当作暂不可用。
      if (!account.loggedIn) { setOfficialOffers(null); return; }
      try {
        const offers = await officialServices.offers();
        if (sequence === accountSequence.current) setOfficialOffers(offers);
      } catch {
        if (sequence === accountSequence.current) setOfficialOffers(null);
      }
    } catch {
      if (sequence === accountSequence.current) { setOfficialAccount(null); setOfficialOffers(null); }
    }
  }, []);
  useEffect(() => { void refreshOfficialAccount(); return () => { accountSequence.current++; }; }, [refreshOfficialAccount]);
  const [smartArrange, setSmartArrange] = useState<SmartArrangeSnapshot | null>(null);
  const [smartArrangeBusy, setSmartArrangeBusy] = useState(false);
  const smartArrangeSequence = useRef(0);
  const refreshSmartArrange = useCallback(async () => {
    const sequence = ++smartArrangeSequence.current;
    try {
      const snapshot = await invoke<SmartArrangeSnapshot>("pometodo_smart_arrange_state");
      if (sequence === smartArrangeSequence.current) setSmartArrange(snapshot);
    } catch (error) {
      if (sequence === smartArrangeSequence.current) { setSmartArrange(null); setActionMessage({ tone: "warn", text: nativeError(error).message }); }
    }
  }, []);
  useEffect(() => { void refreshSmartArrange(); return () => { smartArrangeSequence.current++; }; }, [refreshSmartArrange]);
  async function updateSmartArrange(preferences: SmartArrangePreferences) {
    if (smartArrangeBusy) return;
    setSmartArrangeBusy(true);
    const sequence = ++smartArrangeSequence.current;
    try {
      const snapshot = await invoke<SmartArrangeSnapshot>("pometodo_set_smart_arrange", { preferences });
      if (sequence === smartArrangeSequence.current) setSmartArrange(snapshot);
      setActionMessage({ tone: "info", text: snapshot.message });
    } catch (error) { setActionMessage({ tone: "warn", text: nativeError(error).message }); }
    finally { setSmartArrangeBusy(false); }
  }
  function officialChanged() {
    void refreshOfficialAccount();
    void refreshSmartArrange();
  }
  async function activateOfficial(entitlement: Entitlement) {
    if (!entitlement.canExtract) throw new Error("官方权益暂不可用");
    const snapshot = await invoke<SmartArrangeSnapshot>("pometodo_set_smart_arrange", { preferences: { enabled: true, source: "official" } });
    smartArrangeSequence.current++;
    setSmartArrange(snapshot);
    if (!snapshot.available) throw new Error(snapshot.message);
    setActionMessage({ tone: "info", text: "智能整理已开启" });
  }
  const smartArrangeEnabled = Boolean(smartArrange?.preferences.enabled);
  const byokActive = Boolean(smartArrangeEnabled && smartArrange?.preferences.source === "byok" && smartArrange.available);
  const arrangeEntry = smartArrangeEntry(smartArrange, officialAccount, officialOffers);
  /** 卡片上的智能整理入口：未登录→表单内原位扫码；可直接启用→领取并开启；其余去设置页。 */
  function openArrangeEntry() {
    if (arrangeEntry.autoLogin) { setLoginPanelOpen(true); return; }
    if (arrangeEntry.action === "enable") { void enableOfficialSmartArrange(); return; }
    if (arrangeEntry.action === "settings") {
      focusSeqRef.current += 1;
      setSettingsFocusRequest({ seq: focusSeqRef.current, target: "smartArrange" });
    }
    setSettingsOpen(true);
  }
  // 表单上的"启用智能整理"：登录状态下领取（如需）并直接开启官方来源，成功后入口即变"粘贴并整理"。
  async function enableOfficialSmartArrange() {
    if (smartArrangeBusy || accountBusyRef.current) return;
    setSmartArrangeBusy(true);
    try {
      const account = await officialServices.account();
      if (!account?.loggedIn) throw new Error("请先登录微信账号");
      const entitlement = account.entitlement?.trial.claimed ? account.entitlement : await officialServices.trial();
      await activateOfficial(entitlement);
    } catch (error) {
      setActionMessage({ tone: "warn", text: nativeError(error).message });
    } finally { setSmartArrangeBusy(false); }
  }
  // 更新：启动安静检查一次，窗口恢复焦点时检查但至少间隔 6 小时。
  const updateController = useMemo(() => createUpdateController(updateServices), []);
  const updateState = useSyncExternalStore(updateController.subscribe, updateController.getSnapshot, updateController.getSnapshot);
  useEffect(() => updateController.mount(), [updateController]);
  useEffect(() => { updateController.checkAuto(); }, [updateController]);
  useEffect(() => {
    const onFocus = () => updateController.checkAuto();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [updateController]);
  const updateAvailable = Boolean(updateState.check?.available && updateState.check.release);
  const [updateOpen, setUpdateOpen] = useState(false);
  const handleCheckUpdate = useCallback(() => {
    void updateController.checkManual().then(result => {
      if (!result.ok) setActionMessage({ tone: "warn", text: result.error });
      else if (result.check.available && result.check.release) setActionMessage({ tone: "info", text: `发现新版本 v${result.check.release.version}` });
      else setActionMessage({ tone: "info", text: "已是最新版本" });
    });
  }, [updateController]);
  // 表单关闭后不再保留其中的登录请求；安装前须无草稿、保存、登录或付款。
  useEffect(() => { if (!todoEditorOpen) setLoginPanelOpen(false); }, [todoEditorOpen]);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [focusTaskRequest, setFocusTaskRequest] = useState<{ taskId: string; requestId: number }>();
  const [pendingRequest, setPendingRequest] = useState(0);
  const [savingTheme, setSavingTheme] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [savingPin, setSavingPin] = useState(false);
  const canInstall = canInstallUpdate({
    todoBusy, todoEditorOpen, todoLoginOpen: loginPanelOpen, accountBusy, settingsBusy,
    smartArrangeBusy, themeSaving: savingTheme, pinSaving: savingPin, installing: updateState.installing,
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const leaveSettingsPage = useMemo(() => createSettingsLeaveGate({
    closeSettings: () => {
      setSettingsOpen(false);
      requestAnimationFrame(() => settingsButton.current?.focus());
    },
  }), []);
  const preference = info?.theme ?? "system";
  const theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  useEffect(() => {
    let active = true;
    const version = infoVersionRef.current;
    void getCurrentWindow().isAlwaysOnTop().then((value) => { if (active) setPinned(value); })
      .catch((error: unknown) => { if (active) setActionError(nativeError(error).message); });
    invoke<AppInfo>("pometodo_app_info").then((result) => { if (active && version === infoVersionRef.current) setInfo(result); })
      .catch((error: unknown) => { if (active) setStartupError(nativeError(error).message); });
    const subscriptions = [
      listen<string>("pometodo-system-error", ({ payload }) => { if (active) setActionError(payload); }),
      listen<boolean>("pometodo-floating-enabled", ({ payload }) => {
        if (active) setInfo(current => current ? { ...current, floatingBallEnabled: payload } : current);
      }),
      listen<OpenRequest>("pometodo-open", ({ payload }) => {
        if (!active) return;
        if (payload.settings) setSettingsOpen(true);
        else if (!leaveSettingsPage()) return;
        if (payload.taskId) setFocusTaskRequest({ taskId: payload.taskId, requestId: payload.requestId });
        else if (payload.pending) setPendingRequest(payload.requestId);
      }),
      listen("pometodo-data-changed", () => {
        const infoVersion = infoVersionRef.current;
        void invoke<AppInfo>("pometodo_app_info").then((result) => { if (active && infoVersion === infoVersionRef.current) setInfo(result); })
          .catch((error: unknown) => { if (active) setActionError(nativeError(error).message); });
      }),
    ];
    for (const promise of subscriptions) void promise.catch((error: unknown) => { if (active) setActionError(nativeError(error).message); });
    return () => { active = false; for (const promise of subscriptions) void promise.then((unlisten) => unlisten()).catch(() => {}); };
  }, [leaveSettingsPage]);

  const onSettingsChanged = useCallback((snapshot: SettingsSnapshot) => {
    void refreshSmartArrange();
    setInfo({ dataDirectory: snapshot.dataDirectory, theme: snapshot.settings.theme, version: snapshot.version,
      customers: snapshot.customers, quickDueOptions: snapshot.settings.quickDueOptions, closeAction: snapshot.settings.closeAction,
      floatingBallEnabled: snapshot.settings.floatingBallEnabled, customerLabel: snapshot.settings.customerLabel });
    setRefreshRequest((value) => value + 1);
  }, [refreshSmartArrange]);

  async function setTheme(value: SettingsTheme) {
    if (!info || savingTheme) return;
    setSavingTheme(true); setActionError(null);
    try {
      await invoke("pometodo_set_theme", { theme: value });
      setInfo((current) => current ? { ...current, theme: value } : current);
    } catch (error) { setActionMessage({ tone: "warn", text: nativeError(error).message }); }
    finally { setSavingTheme(false); }
  }

  async function windowAction(action: "minimize" | "close") {
    try { await getCurrentWindow()[action](); }
    catch (error) { setActionMessage({ tone: "warn", text: nativeError(error).message }); }
  }

  async function togglePin() {
    if (savingPin) return;
    setSavingPin(true);
    setActionError(null);
    try {
      await getCurrentWindow().setAlwaysOnTop(!pinned);
      setPinned(!pinned);
    } catch (error) { setActionError(nativeError(error).message); }
    finally { setSavingPin(false); }
  }

  const closeLabel = info?.closeAction === "exit" ? "退出 PomeTodo" : "收起到托盘";
  return <div className="pometodo-shell">
    <header className="pome-titlebar">
      <div className="pome-brand" data-tauri-drag-region>
        <img className="pome-mark" src={logoUrl} alt="" data-tauri-drag-region />
        <span data-tauri-drag-region>PomeTodo</span>
      </div>
      <div className="pome-title-tools">
        {updateAvailable && <button className="pome-icon-button" aria-label="发现新版本" title="发现新版本" aria-pressed={updateOpen} onClick={() => setUpdateOpen(value => !value)}><Icon kind="update" /></button>}
        <button className="pome-icon-button" aria-label={pinned ? "取消置顶" : "置顶窗口"} title={pinned ? "取消置顶" : "置顶窗口"} aria-pressed={pinned} disabled={savingPin} onClick={() => void togglePin()}><Icon kind="pin" /></button>
        <button className="pome-icon-button" aria-label="切换明暗主题" title="切换明暗主题" disabled={!info || savingTheme || updateOpen} onClick={() => void setTheme(theme === "dark" ? "light" : "dark")}><Icon kind="theme" /></button>
        <button ref={settingsButton} className="pome-icon-button" aria-label="设置" title="设置" disabled={!info || settingsOpen || todoBusy} onClick={() => { setSettingsFocusRequest(null); setLoginPanelOpen(false); setSettingsOpen(true); }}><Icon kind="settings" /></button>
        <span className="pome-title-divider" />
        <button className="pome-icon-button" aria-label="最小化" title="最小化" onClick={() => void windowAction("minimize")}><Icon kind="minimize" /></button>
        <button className="pome-icon-button pome-close-button" aria-label={closeLabel} title={closeLabel} onClick={() => void windowAction("close")}><Icon kind="close" /></button>
      </div>
    </header>
    <main className="pome-content">
      {startupError ? <section className="pome-startup-state" role="alert"><h1>未能打开本地数据</h1><p>{startupError}</p><p>请检查后重新启动 PomeTodo，原数据文件会保留。</p></section>
        : info ? <>
          <div className="pome-page" hidden={settingsOpen || updateOpen} inert={settingsOpen || updateOpen || undefined}>
            <TodoPage services={todoServices} smartArrangeAvailable={smartArrange?.available ?? false} smartArrangeLabel={arrangeEntry.label} smartArrangeTone={arrangeEntry.tone} onEnableSmartArrange={openArrangeEntry} onBusyChange={setTodoBusy} onEditorOpenChange={setTodoEditorOpen}
              loginPanel={loginPanelOpen && !settingsOpen ? <OfficialLoginCard services={officialServices} autoLogin onActivated={activateOfficial} onChanged={officialChanged} onSignedIn={() => { setLoginPanelOpen(false); }} onCancel={() => setLoginPanelOpen(false)} onMessage={setActionMessage} /> : undefined}
              systemMessage={actionError} onDismissSystemMessage={() => setActionError(null)} onOpenAttachment={openAttachment} onImportAttachment={importAttachment} pendingRequest={pendingRequest} active={!settingsOpen && !updateOpen} refreshRequest={refreshRequest} quickDueOptions={JSON.stringify(info.quickDueOptions)} customerSuggestions={info.customers.map((customer) => customer.displayName)} customerLabel={info.customerLabel} focusTaskRequest={focusTaskRequest} />
          </div>
          {settingsOpen && <div className="pome-page" hidden={updateOpen} inert={updateOpen || undefined}>
            <SettingsPage active={!updateOpen} services={guardedSettingsServices} accountCard={<AccountCard services={officialServices} byokActive={byokActive} smartArrangeEnabled={smartArrangeEnabled} onActivated={activateOfficial} onChanged={officialChanged} onMessage={setActionMessage} onPurchaseActive={reportPurchaseActive} onBusyChange={reportAccountBusy} />} hint={purchaseActive ? "一次支付自动到账，不自动续费" : undefined} onCheckUpdate={handleCheckUpdate} updateChecking={updateState.checking} activeTheme={info.theme} smartArrange={{ snapshot: smartArrange, busy: smartArrangeBusy, onChange: preferences => void updateSmartArrange(preferences) }} systemMessage={actionError} onDismissSystemMessage={() => setActionError(null)} floatingBallEnabled={info.floatingBallEnabled} onChanged={onSettingsChanged} onBack={() => void leaveSettingsPage()} settingsFocusRequest={settingsFocusRequest} />
          </div>}
          {updateOpen && <UpdatePanel controller={updateController} canInstall={canInstall} onBack={() => setUpdateOpen(false)} />}
        </> : <div className="pome-startup-state" role="status">正在打开待办…</div>}
    </main>
  </div>;
}
