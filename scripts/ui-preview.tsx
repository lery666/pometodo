/** 仅供 Vite 本地视觉验收；使用真实组件和虚构内存数据，不调用原生/AI，不进入 index.html 构建入口。 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import TodoPage from "../src/features/todo/TodoPage";
import SettingsPage from "../src/features/settings/SettingsPage";
import type { TodoDraft, TodoServices, TodoTask } from "../src/contracts/todo";
import type { SettingsServices, SettingsSnapshot } from "../src/contracts/settings";
import AccountCard from "../src/features/official/AccountCard";
import OfficialLoginCard from "../src/features/official/OfficialLoginCard";
import type { Entitlement, OfficialServices, OfficialOrder } from "../src/contracts/official";
import { OfficialServiceError } from "../src/contracts/official";
import "../src/app/shell.css";
const today = new Date().toISOString();
const previewQuery = new URLSearchParams(location.search);
const focusTaskId = previewQuery.get("focus");
const reliability = previewQuery.has("reliability");
const smartPreview = previewQuery.has("smartArrange");
let recognitionCalls = 0, attachmentCalls = 0, loginPolls = 0, paymentPolls = 0;
let mobileConfirmed = false, paid = false, loggedIn = false;
let entitlement: Entitlement = { product: "pometodo", trial: { claimed: false, total: 100, remaining: 0, expiresAt: null }, remaining: 0, paidRemaining: 0, canExtract: false };
const evidence = () => { const output = document.getElementById("smart-evidence"); if (output) output.textContent = JSON.stringify({ recognitionCalls, attachmentCalls, loginPolls, paymentPolls, loggedIn }); };
const previewQr = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=";
const officialAccount = () => ({ configured: true, loggedIn, accountId: loggedIn ? "synthetic-account" : null, entitlement: loggedIn ? entitlement : null, message: "虚构账号，仅用于隔离验收" });
const previewOffer = { product: "pometodo" as const, id: "synthetic-only", revision: 1, name: "虚构联测商品", enabled: true, amountFen: 111, currency: "CNY" as const, benefit: { kind: "count" as const, extractions: 5, validityDays: null }, termsVersion: "fixture-1" };
let pendingOrder: OfficialOrder | null = null;
const officialServices: OfficialServices = {
  account: async () => officialAccount(),
  begin: async () => ({ status: "pending", qrCodeDataUrl: previewQr, expiresAt: new Date(Date.now() + 180000).toISOString(), pollIntervalMs: 1000, account: null }),
  poll: async () => { loginPolls++; evidence(); if (previewQuery.has("pollFailure") && loginPolls === 1) throw new OfficialServiceError("隔离验收：首次轮询断网", true); if (mobileConfirmed) loggedIn = true; evidence(); return { status: mobileConfirmed ? "confirmed" : "pending", qrCodeDataUrl: null, expiresAt: new Date(Date.now() + 180000).toISOString(), pollIntervalMs: 1000, account: mobileConfirmed ? officialAccount() : null }; },
  cancel: async () => { mobileConfirmed = false; },
  trial: async () => { if (!entitlement.trial.claimed) entitlement = { ...entitlement, trial: { claimed: true, total: 100, remaining: 100, expiresAt: "2026-10-06T00:00:00Z" }, remaining: 100, canExtract: true }; return entitlement; },
  logout: async () => { loggedIn = false; mobileConfirmed = false; evidence(); },
  offers: async () => ({ product: "pometodo", salesEnabled: true, offers: [previewOffer] }),
  order: async () => { pendingOrder = { product: "pometodo", orderNo: "synthetic-order", status: "paying", amountFen: 111, currency: "CNY", expiresAt: new Date(Date.now() + 600000).toISOString(), qrCodeDataUrl: previewQr, snapshot: { ...previewOffer, offerId: previewOffer.id, offerRevision: 1 } }; return pendingOrder; },
  pendingOrder: async () => pendingOrder,
  orderStatus: async orderNo => { paymentPolls++; if (paid) { entitlement = { ...entitlement, remaining: 5, paidRemaining: 5, canExtract: true }; pendingOrder = null; } evidence(); return { orderNo, status: paid ? "paid" : "paying", paid, entitlementGranted: paid, amountFen: 111, currency: "CNY", expiresAt: new Date(Date.now() + 600000).toISOString(), paidAt: paid ? new Date().toISOString() : null }; },
};
let pendingSave: { resolve: () => void; reject: (error: Error) => void } | null = null;
let pendingRecognition: (() => void) | null = null;
let saveAttempts = 0;
const gateSave = async (operation: string, draft: TodoDraft) => {
  if (!reliability) return;
  saveAttempts += 1;
  document.getElementById("save-evidence")!.textContent = JSON.stringify({ operation, saveAttempts, draft });
  await new Promise<void>((resolve, reject) => { pendingSave = { resolve, reject }; });
};
const finishSave = (fail: boolean) => {
  const pending = pendingSave;
  pendingSave = null;
  if (fail) pending?.reject(new Error("验收注入：磁盘写入失败"));
  else pending?.resolve();
};
const daysAgo = (days: number) => { const date = new Date(); date.setDate(date.getDate() - days); return date.toISOString(); };
let tasks: TodoTask[] = ["pending", "in_progress", "completed"].map((status, i) => ({
  id: `visual-${i}`, customerName: "星河示例客户", title: ["核对展板初稿", "准备展板说明", "确认测试反馈"][i],
  note: "虚构内容，仅用于检查字体、布局和动效。", status: status as TodoTask["status"], receivedAt: today,
  dueAt: today, completedAt: status === "completed" ? today : null, attachmentPaths: [],
}));
tasks.push(
  {...tasks[0],id:"visual-overdue",title:"核对逾期示例",dueAt:daysAgo(2),note:"这是一条虚构的较长备注，用于检查两行文字的阅读效果，以及日期和截图标签的间距。"},
  {...tasks[0],id:"visual-no-date",title:"未设日期示例",dueAt:null},
  {...tasks[2],id:"visual-yesterday",title:"昨日完成示例",completedAt:daysAgo(1)},
  {...tasks[2],id:"visual-archive",title:"历史展板归档示例",completedAt:daysAgo(8),dueAt:daysAgo(10)},
);
if (previewQuery.has("stress")) {
  for (let i = 0; i < 14; i++) tasks.push({...tasks[2],id:`visual-history-${i}`,title:`分页示例 ${i}`,completedAt:daysAgo(previewQuery.get("stress") === "recent" ? 1 : 9)});
}
let snapshot: SettingsSnapshot = {
  settings: { theme: "light", startWithWindows: false, startMinimized: false, floatingBallEnabled: false, closeAction: "exit", dailyReminderEnabled: true, dailyReminderTime: "09:00", quickDueOptions: [{label:"今天",days:0},{label:"明天",days:1}], aiProvider:"deepseek" },
  customers: [{originalName:"星河示例客户",displayName:"星河示例客户",activeCount:2}], keyConfigured: {deepseek:false,qwen:false,glm:false},
  dataDirectory: "虚构数据目录", screenshotDirectory:"虚构截图目录", version:"视觉验收",
};
const unsupported = async (): Promise<never> => { throw new Error("视觉验收不执行此操作"); };
const attachmentData = new Map<string, string>();
if (reliability || smartPreview) {
  const fixturePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=";
  attachmentData.set("fixture-one.png", fixturePng);
  attachmentData.set("fixture-two.png", fixturePng);
  tasks[0].attachmentPaths = ["fixture-one.png", "fixture-two.png"];
}
const importImage = async (png: string) => { const id = crypto.randomUUID(); attachmentData.set(id, `data:image/png;base64,${png}`); return id; };
const todoServices: TodoServices = {
  listTasks: async()=>tasks,
  createTask: async(draft)=>{await gateSave("create", draft);const task: TodoTask={...draft,id:crypto.randomUUID(),status:"pending",completedAt:null,updatedAt:new Date().toISOString()};tasks=[task,...tasks];return task;},
  updateTask: async(id,draft)=>{await gateSave("update", draft);tasks=tasks.map(task=>task.id===id?{...task,...draft}:task);return tasks.find(task=>task.id===id)!;},
  setTaskStatus: async(id,status)=>{ tasks=tasks.map(t=>t.id===id?{...t,status}:t);return tasks.find(t=>t.id===id)!; },
  setTaskUrgent: unsupported, deleteTask: unsupported,
  recognizeClipboard: async () => {
    if (!reliability && !smartPreview) return unsupported();
    recognitionCalls++; evidence();
    if (previewQuery.has("slowRecognition")) await new Promise<void>(resolve => { pendingRecognition = resolve; });
    if (previewQuery.has("aiSuccess")) return { kind: "ai", draft: { customerName: "AI示例客户", title: "AI示例任务", dueAt: null, attachmentPaths: ["fixture-one.png", "fixture-two.png"] } };
    return { kind: "local", draft: { customerName: "不应回填", title: "不应回填", attachmentPaths: ["fixture-one.png", "fixture-two.png"] }, message: "隔离验收：AI失败，保留附件" };
  },
  saveClipboardAttachment: async () => { if (!smartPreview) return unsupported(); attachmentCalls++; evidence(); return "fixture-one.png"; }, getAttachmentDataUrl: async id => attachmentData.get(id) ?? "",
};
const settingsServices: SettingsServices = {
  load: async()=>snapshot, update: async(patch)=>{await new Promise(resolve=>setTimeout(resolve,1000));snapshot={...snapshot,settings:{...snapshot.settings,...patch}};return snapshot;},
  renameCustomer: unsupported, hideCustomer: unsupported, saveApiKey: unsupported, clearApiKey: unsupported,
  chooseDirectory: unsupported, applyDirectoryChange: unsupported, exportBackup: unsupported, chooseBackupImport: unsupported, importBackup: unsupported,
};
function Preview() {
  const [settings, setSettings] = useState(false);
  const [dark, setDark] = useState(false);
  const [loginPanelOpen, setLoginPanelOpen] = useState(false);
  const [smartPreferences, setSmartPreferences] = useState({ enabled: previewQuery.has("enabled") || reliability, source: "byok" as "official" | "byok" });
  const available = smartPreferences.enabled && (smartPreferences.source === "byok" || loggedIn && entitlement.canExtract);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  return <><div className="pometodo-shell" style={smartPreview ? { width: 460 } : undefined}>
    <header className="pome-titlebar"><div className="pome-brand"><span className="pome-mark"/>PomeTodo</div>
      <div className="pome-title-tools"><button className="pome-icon-button" onClick={()=>setDark(!dark)}>主题</button><button className="pome-icon-button" onClick={()=>setSettings(true)}>设置</button><button className="pome-icon-button pome-close-button" aria-label="关闭演示">×</button></div></header>
    <main className="pome-content">
      {settings && <SettingsPage services={settingsServices} accountCard={<AccountCard services={officialServices} onActivated={async () => { setSmartPreferences({ enabled: true, source: "official" }); }} onChanged={() => setSmartPreferences(value => ({ ...value }))} onMessage={() => {}} />} smartArrange={{ snapshot: { preferences: smartPreferences, available, message: "隔离验收的虚构服务状态" }, busy: false, onChange: setSmartPreferences }} onBack={()=>setSettings(false)} onChanged={s=>setDark(s.settings.theme==="dark")} />}
      <div className="pome-page" hidden={settings} inert={settings || undefined}><TodoPage services={todoServices} active={!settings} smartArrangeAvailable={available} onEnableSmartArrange={() => setLoginPanelOpen(true)} onImportAttachment={importImage} focusTaskRequest={focusTaskId ? {taskId:focusTaskId,requestId:1} : undefined} customerSuggestions={["星河示例客户", "第二个示例客户", "较长名称用于检查菜单宽度是否得到限制的示例客户"]} loginPanel={loginPanelOpen ? <OfficialLoginCard services={officialServices} autoLogin onChanged={() => setSmartPreferences(value => ({ ...value }))} onActivated={async () => { setSmartPreferences({ enabled: true, source: "official" }); }} onSignedIn={() => setLoginPanelOpen(false)} onCancel={() => setLoginPanelOpen(false)} onMessage={() => {}} /> : undefined} /></div>
    </main></div>{reliability && <aside aria-label="隔离验收控制" style={{ position: "fixed", top: 36, right: 120, width: 320, zIndex: 1000, background: "white", color: "black", fontSize: 12 }}>
      <button onClick={() => finishSave(true)}>验收：保存失败</button><button onClick={() => finishSave(false)}>验收：保存成功</button>
      {previewQuery.has("slowRecognition") && <button onClick={() => { pendingRecognition?.(); pendingRecognition = null; }}>验收：识别完成</button>}
      <output id="save-evidence" style={{ display: "block", overflowWrap: "anywhere" }}>等待保存</output>
    </aside>}{smartPreview && <aside aria-label="智能整理隔离验收" style={{ position: "fixed", top: 36, right: 40, width: 300, zIndex: 1000, background: "white", color: "black", fontSize: 12 }}><button onClick={() => { mobileConfirmed = true; }}>验收：手机确认</button><button onClick={() => { paid = true; }}>验收：付款到账</button><button onClick={() => setSmartPreferences(v => ({ ...v, enabled: !v.enabled }))}>验收：切换AI开关</button><output id="smart-evidence" style={{ display: "block" }}>等待操作</output></aside>}</>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
