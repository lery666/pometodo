/** 独立视觉验收入口：只使用下面的内存假服务，不调用原生、网络、AI、付款或系统剪贴板。 */
import { StrictMode, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { StatusMessage } from "../src/components/StatusBar";
import TodoPage from "../src/features/todo/TodoPage";
import AccountCard from "../src/features/official/AccountCard";
import OfficialLoginCard from "../src/features/official/OfficialLoginCard";
import { smartArrangeEntry } from "../src/features/official/smartArrangeEntry";
import { OfficialServiceError, type Entitlement, type OfficialAccount, type OfficialLogin, type OfficialOrder, type OfficialServices, type Offer } from "../src/contracts/official";
import type { TodoDraft, TodoServices, TodoTask } from "../src/contracts/todo";
import "../src/app/shell.css";

const query = new URLSearchParams(location.search);
const scenarios = [
  ["logged_out", "未登录 · 一步扫码"],
  ["available", "已登录 · 剩余 99 次可用"],
  ["paused", "剩余 99 次 · 服务暂停"],
  ["expired", "体验已结束"],
  ["exhausted", "次数已用完"],
  ["account_error", "账号读取失败"],
  ["unknown", "账号权益暂时未知"],
  ["sales_closed", "购买暂未开放"],
  ["catalog", "服务返回商品"],
  ["paying", "扫码付款中"],
  ["paid_pending", "已付款 · 次数处理中"],
  ["paid", "服务端确认到账"],
  ["closed", "订单已关闭"],
  ["qr_expired", "二维码已过期"],
  ["qr_error", "二维码生成失败"],
  ["poll_error", "登录查询失败"],
] as const;
type Scenario = typeof scenarios[number][0];
type MobileResult = "pending" | "confirmed" | "expired" | "cancelled" | "error";
type PaymentResult = "paying" | "paid_pending" | "paid" | "closed";
const initialScenario = scenarios.some(([value]) => value === query.get("scenario")) ? query.get("scenario") as Scenario : "logged_out";
const strict = query.get("strict") !== "0";
const futureDate = () => new Date(Date.now() + 25 * 86400000).toISOString();
const pastDate = () => new Date(Date.now() - 86400000).toISOString();
const futureQrDate = () => new Date(Date.now() + 180000).toISOString();
const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
// 特意不使用有效二维码图案、二维码生成库或支付 URL。
const fakeQr = svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><rect width="240" height="240" rx="12" fill="#fff"/><defs><pattern id="grid" width="18" height="18" patternUnits="userSpaceOnUse"><rect x="3" y="3" width="7" height="7" fill="#c7cdd3"/></pattern></defs><rect x="18" y="18" width="204" height="204" fill="url(#grid)"/><path d="M22 22L218 218M218 22L22 218" stroke="#7f8e9e" stroke-width="4"/><rect x="31" y="89" width="178" height="62" rx="8" fill="#fff"/><text x="120" y="115" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#425368">仅供预览</text><text x="120" y="138" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#6b7280">假二维码 · 无法扫码</text></svg>`);
const attachmentUrls = new Map([
  ["preview-attachment-one", svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#e8f0f9"/><rect x="20" y="24" width="280" height="28" rx="5" fill="#9eb6ce"/><rect x="20" y="74" width="178" height="12" rx="3" fill="#bacbda"/><rect x="20" y="99" width="238" height="12" rx="3" fill="#bacbda"/><text x="20" y="161" font-family="sans-serif" font-size="20" fill="#48627a">虚构展板 · 预览附件 1</text></svg>')],
  ["preview-attachment-two", svgUrl('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#eef2e6"/><rect x="20" y="24" width="280" height="28" rx="5" fill="#acb996"/><rect x="20" y="74" width="210" height="12" rx="3" fill="#c8d1b9"/><rect x="20" y="99" width="254" height="12" rx="3" fill="#c8d1b9"/><text x="20" y="161" font-family="sans-serif" font-size="20" fill="#68784d">虚构说明 · 预览附件 2</text></svg>')],
]);
const offer: Offer = { product: "pometodo", id: "preview-offer", revision: 7, name: "预览示例次数包", enabled: true, amountFen: 1680, currency: "CNY", benefit: { kind: "count", extractions: 320, validityDays: null }, termsVersion: "preview-only-v1" };
const counters = { account: 0, begin: 0, poll: 0, cancel: 0, trial: 0, clipboard: 0, AI: 0, save: 0, logout: 0, order: 0, orderStatus: 0 };
type Counter = keyof typeof counters;
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const emit = () => { version++; listeners.forEach(listener => listener()); };
const count = (key: Counter) => { counters[key]++; emit(); };
const emptyEntitlement = (): Entitlement => ({ product: "pometodo", trial: { claimed: false, total: 100, remaining: 0, expiresAt: null }, paidRemaining: 0, remaining: 0, canExtract: false });
let scenario: Scenario = initialScenario;
let loggedIn = false;
let accountFailure = false;
let unknownEntitlement = false;
let salesEnabled = false;
let entitlement = emptyEntitlement();
let mobileResult: MobileResult = "pending";
let paymentResult: PaymentResult = "paying";
let pendingOrder: OfficialOrder | null = null;
let orderGranted = false;
let loginExpiresAt = futureQrDate();
let enabled = false;
let byok = false;
let slowBegin = false;
let releaseBegin: (() => void) | null = null;
let lastSave: { operation: string; taskId: string; draft: TodoDraft } | null = null;
const accountSnapshot = (): OfficialAccount => ({ configured: true, loggedIn, accountId: loggedIn ? "preview-account-only" : null, entitlement: loggedIn && !unknownEntitlement ? structuredClone(entitlement) : null, message: "仅供预览的虚构账号" });
const createOrder = (): OfficialOrder => ({ product: "pometodo", orderNo: "preview-order-001", status: "paying", amountFen: offer.amountFen, currency: offer.currency, expiresAt: new Date(Date.now() + 600000).toISOString(), qrCodeDataUrl: fakeQr, snapshot: { product: offer.product, offerId: offer.id, offerRevision: offer.revision, name: offer.name, amountFen: offer.amountFen, currency: offer.currency, benefit: { ...offer.benefit }, termsVersion: offer.termsVersion } });

function selectScenario(next: Scenario) {
  scenario = next;
  loggedIn = !["logged_out", "qr_expired", "qr_error", "poll_error"].includes(next);
  accountFailure = next === "account_error";
  unknownEntitlement = next === "unknown";
  salesEnabled = ["catalog", "paying", "paid_pending", "paid", "closed"].includes(next);
  entitlement = loggedIn ? { product: "pometodo", trial: { claimed: true, total: 100, remaining: next === "exhausted" ? 0 : 99, expiresAt: next === "expired" ? pastDate() : futureDate() }, paidRemaining: 0, remaining: ["expired", "exhausted"].includes(next) ? 0 : 99, canExtract: !["paused", "expired", "exhausted", "account_error", "unknown"].includes(next) } : emptyEntitlement();
  mobileResult = next === "qr_expired" ? "expired" : next === "poll_error" ? "error" : "pending";
  paymentResult = next === "paid_pending" ? "paid_pending" : next === "paid" ? "paid" : next === "closed" ? "closed" : "paying";
  pendingOrder = ["paying", "paid_pending", "paid", "closed"].includes(next) ? createOrder() : null;
  orderGranted = false;
  enabled = loggedIn;
  byok = false;
  emit();
}
selectScenario(initialScenario);

const officialServices: OfficialServices = {
  account: async () => { count("account"); if (accountFailure) throw new OfficialServiceError("暂时无法读取账号，请重试", true); return accountSnapshot(); },
  begin: async () => {
    count("begin");
    mobileResult = scenario === "qr_expired" ? "expired" : scenario === "poll_error" ? "error" : "pending";
    if (slowBegin) await new Promise<void>(resolve => { releaseBegin = resolve; emit(); });
    else await new Promise<void>(resolve => setTimeout(resolve, 450));
    if (scenario === "qr_error") throw new OfficialServiceError("二维码生成失败，请重试", false);
    loginExpiresAt = futureQrDate();
    return { status: "pending", qrCodeDataUrl: fakeQr, expiresAt: loginExpiresAt, pollIntervalMs: 700, account: null };
  },
  poll: async (): Promise<OfficialLogin> => {
    count("poll");
    if (mobileResult === "error") throw new OfficialServiceError("登录查询失败，请重新获取二维码", false);
    if (mobileResult === "confirmed") loggedIn = true;
    emit();
    return { status: mobileResult, qrCodeDataUrl: null, expiresAt: loginExpiresAt, pollIntervalMs: 700, account: mobileResult === "confirmed" ? accountSnapshot() : null };
  },
  cancel: async () => { count("cancel"); if (!loggedIn) mobileResult = "cancelled"; emit(); },
  trial: async () => { count("trial"); if (!entitlement.trial.claimed) entitlement = { product: "pometodo", trial: { claimed: true, total: 100, remaining: 100, expiresAt: futureDate() }, paidRemaining: 0, remaining: 100, canExtract: true }; emit(); return structuredClone(entitlement); },
  logout: async () => { count("logout"); loggedIn = false; enabled = false; mobileResult = "pending"; emit(); },
  offers: async () => ({ product: "pometodo", salesEnabled, offers: salesEnabled ? [structuredClone(offer)] : [] }),
  order: async () => { count("order"); pendingOrder = createOrder(); paymentResult = "paying"; orderGranted = false; emit(); return structuredClone(pendingOrder); },
  pendingOrder: async () => pendingOrder ? structuredClone(pendingOrder) : null,
  orderStatus: async orderNo => {
    count("orderStatus");
    if (paymentResult === "paid" && !orderGranted) {
      orderGranted = true;
      const extractions = offer.benefit.kind === "count" ? offer.benefit.extractions : offer.benefit.extractionLimit;
      entitlement = { ...entitlement, paidRemaining: entitlement.paidRemaining + extractions, remaining: entitlement.remaining + extractions, canExtract: true };
      pendingOrder = null;
    }
    const paid = paymentResult === "paid" || paymentResult === "paid_pending";
    emit();
    return { orderNo, status: paid ? "paid" : paymentResult === "closed" ? "closed" : "paying", paid, entitlementGranted: orderGranted, amountFen: offer.amountFen, currency: offer.currency, expiresAt: pendingOrder?.expiresAt ?? futureQrDate(), paidAt: paid ? new Date().toISOString() : null };
  },
};

const today = new Date().toISOString();
let tasks: TodoTask[] = [
  { id: "preview-draft", customerName: "星河示例客户", title: "核对展板初稿与说明", note: "这是虚构的非空草稿。\n请保留这行备注和两张附件，扫码结束后继续编辑。", status: "pending", receivedAt: today, dueAt: today, completedAt: null, attachmentPaths: ["preview-attachment-one", "preview-attachment-two"] },
  { id: "preview-second", customerName: "远山示例客户", title: "确认展示时间", note: "仅供检查列表与底部入口的位置。", status: "in_progress", receivedAt: today, dueAt: today, completedAt: null, attachmentPaths: [] },
];
function updateTask(id: string, patch: Partial<TodoTask>): TodoTask {
  const target = tasks.find(task => task.id === id);
  if (!target) throw new Error("预览任务不存在");
  const next = { ...target, ...patch };
  tasks = tasks.map(task => task.id === id ? next : task);
  return structuredClone(next);
}
function recordSave(operation: string, taskId: string, draft: TodoDraft) {
  lastSave = { operation, taskId, draft: structuredClone(draft) };
  count("save");
}
const todoServices: TodoServices = {
  listTasks: async () => structuredClone(tasks),
  createTask: async draft => { const id = `preview-${crypto.randomUUID()}`; recordSave("create", id, draft); const task: TodoTask = { ...structuredClone(draft), id, status: "pending", completedAt: null }; tasks = [task, ...tasks]; return structuredClone(task); },
  updateTask: async (id, draft) => { recordSave("update", id, draft); return updateTask(id, structuredClone(draft)); },
  setTaskStatus: async (id, status) => updateTask(id, { status, completedAt: status === "completed" ? new Date().toISOString() : null }),
  setTaskUrgent: async (id, urgent) => updateTask(id, { urgentAt: urgent ? new Date().toISOString() : null }),
  deleteTask: async id => { tasks = tasks.filter(task => task.id !== id); },
  recognizeClipboard: async () => { count("clipboard"); count("AI"); return { kind: "empty", message: "预览未读取剪贴板，当前草稿保留" }; },
  saveClipboardAttachment: async () => { count("clipboard"); return null; },
  getAttachmentDataUrl: async path => attachmentUrls.get(path) ?? "",
};

const previewCss = `
  html, body, #root { min-width: 820px; min-height: 880px; overflow: auto; }
  body { background: #e5e9ed; }
  .official-preview-workspace { display: flex; align-items: flex-start; gap: 28px; width: 814px; margin: 20px auto; padding: 0 14px 24px; font-family: "Microsoft YaHei UI", sans-serif; }
  .official-preview-sample { flex: 0 0 460px; }
  .official-preview-caption { color: #526170; font-size: 12px; margin: 0 0 8px; line-height: 1.5; }
  .official-preview-window { width: 460px; height: 800px; overflow: hidden; border: 1px solid #b8c0c9; border-radius: 10px; box-sizing: content-box; background: var(--surface-bg); }
  .official-preview-window .pometodo-shell { width: 460px; height: 800px; }
  .official-preview-controls { flex: 0 0 310px; background: #fff; color: #25323e; border: 1px solid #ccd4dc; border-radius: 10px; padding: 16px; box-sizing: border-box; font-size: 12px; line-height: 1.65; }
  .official-preview-controls h1 { font-size: 17px; line-height: 1.4; margin: 0 0 8px; }
  .official-preview-controls h2 { font-size: 12px; margin: 16px 0 6px; }
  .official-preview-controls p { margin: 6px 0; }
  .official-preview-controls label { display: block; margin: 8px 0; }
  .official-preview-controls select { width: 100%; padding: 6px; margin-top: 4px; color: #25323e; background: #fff; border: 1px solid #b8c3ce; border-radius: 5px; }
  .official-preview-controls button { color: #25323e; background: #f3f5f7; border: 1px solid #cbd3db; border-radius: 5px; padding: 5px 8px; margin: 3px 5px 3px 0; cursor: pointer; font-size: 12px; }
  .official-preview-controls button:hover { background: #e6ecf1; }
  .official-preview-controls button:disabled { opacity: .5; cursor: default; }
  .official-preview-controls input { vertical-align: middle; margin: 0 6px 0 0; }
  .official-preview-evidence { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; font-family: Consolas, monospace; }
  .official-preview-evidence span { border-radius: 4px; padding: 4px 6px; background: #f0f3f6; }
  .official-preview-controls pre { margin: 8px 0 0; padding: 8px; background: #f0f3f6; border-radius: 5px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; max-height: 230px; overflow: auto; }
  .official-preview-small { color: #667482; font-size: 11px; }
  .official-preview-account { border: 1px solid #ccd4dc; border-radius: 8px; background: #fff; padding: 12px; margin: 10px 0 2px; }
  .pometodo-shell[data-theme], .official-preview-account { color-scheme: light dark; }
`;

function Preview() {
  useSyncExternalStore(subscribe, () => version);
  const [dark, setDark] = useState(query.get("theme") === "dark");
  const [loginPanelOpen, setLoginPanelOpen] = useState(false);
  const [accountRevision, setAccountRevision] = useState(0);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ taskId: string; requestId: number }>();
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  const activate = useCallback(async (value: Entitlement) => { entitlement = structuredClone(value); enabled = true; emit(); }, []);
  const signedIn = useCallback(() => { setLoginPanelOpen(false); setMessage({ text: "登录成功，可继续编辑", tone: "info" }); }, []);
  const available = enabled && (byok || loggedIn && !accountFailure && !unknownEntitlement && entitlement.canExtract);
  const entry = smartArrangeEntry({ preferences: { enabled, source: byok ? "byok" : "official" }, available, message: "仅供预览的内存状态" }, accountFailure ? null : accountSnapshot());
  const pickScenario = (value: Scenario) => {
    selectScenario(value);
    setAccountRevision(current => current + 1);
    setLoginPanelOpen(false);
    setMessage(null);
  };
  return <>
    <style>{previewCss}</style>
    <div className="official-preview-workspace">
      <section className="official-preview-sample" aria-label="460 × 800 预览窗口">
        <p className="official-preview-caption">仅供本地预览 · 460 × 800 · 全部为假数据，二维码无法扫码</p>
        <div className="official-preview-window">
          <div className="pometodo-shell">
              <header className="pome-titlebar">
                <div className="pome-brand"><span className="pome-mark" />PomeTodo</div>
                <div className="pome-title-tools"><button className="pome-icon-button" aria-label="切换明暗主题" title="切换明暗主题" onClick={() => setDark(value => !value)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2Z" /></svg></button><span className="pome-title-divider" /><button className="pome-icon-button" aria-label="预览窗口最小化不可用" disabled>−</button><button className="pome-icon-button" aria-label="预览窗口关闭不可用" disabled>×</button></div>
              </header>
              <main className="pome-content"><div className="pome-page">
                <TodoPage services={todoServices} active smartArrangeAvailable={available} smartArrangeLabel={entry.label} onEnableSmartArrange={() => entry.action === "settings" ? setMessage({ text: "预览未连接真实 Key 设置", tone: "info" }) : setLoginPanelOpen(true)} customerSuggestions={["星河示例客户", "远山示例客户"]} focusTaskRequest={focusRequest} systemMessage={message} onDismissSystemMessage={() => setMessage(null)} loginPanel={loginPanelOpen ? <OfficialLoginCard key={accountRevision} services={officialServices} autoLogin onActivated={activate} onChanged={emit} onSignedIn={signedIn} onCancel={() => setLoginPanelOpen(false)} onMessage={setMessage} /> : undefined} onOpenAttachment={async () => setMessage({ text: "这是预览附件，未访问本机文件", tone: "info" })} />
              </div></main>
          </div>
        </div>
      </section>
      <aside className="official-preview-controls" aria-label="预览控制区">
        <h1>账号与扫码界面预览</h1>
        <p>左侧是真实组件。此处仅切换内存假状态，不连接真实登录、AI 或支付。</p>
        <div className="official-preview-account" aria-label="设置页账户卡片预览"><AccountCard key={accountRevision} services={officialServices} onActivated={activate} onChanged={emit} onMessage={setMessage} /></div>
        <p className="official-preview-small">上方是设置页顶部账户卡片；扫码出现在左侧新增/编辑表单内部，确认后回到原表单并保留草稿。</p>
        <p className="official-preview-small">点击第一张任务卡片开始编辑，可修改客户、任务、日期、备注；已有两张假附件。</p>
        <button onClick={() => setFocusRequest({ taskId: "preview-draft", requestId: Date.now() })}>定位示例任务</button>
        <label>账号场景<select aria-label="账号场景" value={scenario} onChange={event => pickScenario(event.target.value as Scenario)}>{scenarios.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
        <button onClick={() => setLoginPanelOpen(true)} disabled={loggedIn}>在表单中显示扫码</button><button onClick={() => setLoginPanelOpen(false)} disabled={!loginPanelOpen}>暂不登录（返回表单）</button>
        <label><input type="checkbox" checked={dark} onChange={event => setDark(event.target.checked)} />深色主题</label>
        <label><input type="checkbox" checked={byok} onChange={event => { byok = event.target.checked; enabled = byok || loggedIn; emit(); }} />模拟自带 Key 可用（无需登录）</label>
        <label><input type="checkbox" checked={enabled} onChange={event => { enabled = event.target.checked; emit(); }} />智能整理已启用</label>
        <h2>模拟手机与接口结果</h2>
        <button onClick={() => { mobileResult = "confirmed"; emit(); }}>手机确认登录</button><button onClick={() => { mobileResult = "expired"; emit(); }}>二维码过期</button><button onClick={() => { mobileResult = "error"; emit(); }}>登录查询失败</button><button onClick={() => { mobileResult = "pending"; accountFailure = false; if (scenario === "qr_error") scenario = "logged_out"; emit(); }}>恢复假服务</button>
        <label><input type="checkbox" checked={slowBegin} onChange={event => { slowBegin = event.target.checked; emit(); }} />延迟生成二维码（检查快速返回）</label>
        <button disabled={!releaseBegin} onClick={() => { const release = releaseBegin; releaseBegin = null; release?.(); emit(); }}>释放二维码响应</button>
        <h2>模拟服务端支付确认</h2>
        <button onClick={() => { paymentResult = "paid_pending"; emit(); }}>已付款，待发放次数</button><button onClick={() => { paymentResult = "paid"; emit(); }}>确认到账并发放</button><button onClick={() => { paymentResult = "closed"; emit(); }}>关闭订单</button>
        <p className="official-preview-small">演示商品由假服务返回：¥16.80 / 320 次。与真实销售配置无关。支付按钮只改变假服务状态，页面通过订单轮询读取。</p>
        <h2>交互计数 · {strict ? "StrictMode 已启用" : "StrictMode 未启用"}</h2>
        <output className="official-preview-evidence" id="official-preview-evidence">{Object.entries(counters).map(([key, value]) => <span key={key} data-counter={key}>{key}: {value}</span>)}</output>
        <button onClick={() => { for (const key of Object.keys(counters) as Counter[]) counters[key] = 0; emit(); }}>清零计数</button>
        <p className="official-preview-small">登录成功应返回原表单；clipboard / AI / save / logout 应保持 0。begin 每次明确获取二维码只增加 1。</p>
        <details><summary>内存状态和最后保存内容</summary><pre id="official-preview-state">{JSON.stringify({ loggedIn, enabled, byok, remaining: loggedIn ? entitlement.remaining : null, canExtract: available, loginPanelOpen, mobileResult, paymentResult, lastSave }, null, 2)}</pre></details>
      </aside>
    </div>
  </>;
}

const previewRoot = createRoot(document.getElementById("root")!);
previewRoot.render(strict ? <StrictMode><Preview /></StrictMode> : <Preview />);
if (import.meta.hot) import.meta.hot.dispose(() => previewRoot.unmount());
