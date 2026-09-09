import type { Benefit, Entitlement, Offer, OfficialAccount, OfficialLogin, OfficialOffers, OfficialOrder, OfficialServices } from "../../contracts/official";
import type { StatusMessage } from "../../components/StatusBar";
import { nextLoginRetry } from "./loginPolling";

/** 商品购买按钮文案：¥25元 / 500次。 */
export function offerButtonText(offer: Offer): string {
  const count = offer.benefit.kind === "count" ? offer.benefit.extractions : offer.benefit.extractionLimit;
  return `¥${offer.amountFen / 100} 元 / ${count} 次`;
}
export function benefitText(benefit: Benefit) {
  return benefit.kind === "period" ? `${benefit.months} 个月内共 ${benefit.extractionLimit} 次成功整理` : `${benefit.extractions} 次成功整理 · ${benefit.validityDays === null ? "次数不设到期日" : `${benefit.validityDays} 天有效`}`;
}
export function dateText(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "有效期暂时无法读取";
  return `有效期至 ${new Date(value).toLocaleDateString("zh-CN")}`;
}
/** 账户卡额度行的副行说明；无信息可补充时返回 null。 */
export function trialSubText(expiresAt: string | null, remaining: number): string | null {
  if (remaining <= 0) return null;
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  return `${new Date(expiresAt).toLocaleDateString("zh-CN")} 前有效`;
}

/** 支付流程只保留一句最重要的状态说明。 */
export function orderStatusText(status: string): string {
  if (status === "granted") return "购买成功，次数已到账";
  if (status === "paid") return "付款已收到，正在确认到账";
  if (status === "closed") return "订单已关闭，可重新购买";
  if (status === "failed") return "支付未完成，可重新购买";
  if (status === "query_failed") return "暂时无法确认支付，稍后自动重试";
  return "微信扫码付款，到账自动开通";
}

export interface OfficialCallbacks {
  onBack(): void;
  onActivated(entitlement: Entitlement): Promise<void>;
  onChanged(): void;
  onSignedIn?(): void;
  onMessage?(message: StatusMessage): void;
}
interface OfficialState {
  account: OfficialAccount | null; accountLoading: boolean; accountError: string | null;
  login: OfficialLogin | null; loginLoading: boolean; loginError: string | null;
  offers: OfficialOffers | null; offersLoading: boolean; offersError: string | null;
  order: OfficialOrder | null; orderLoading: boolean; orderError: string | null;
  busy: "activation" | "purchase" | "logout" | null; activationError: string | null;
}
export function entitlementMessage(value: Entitlement | null, now = Date.now()): string {
  if (!value) return "暂时无法读取服务状态";
  if (value.canExtract) return "";
  if (value.remaining > 0 || value.paidRemaining > 0) return "智能整理暂不可用";
  if (!value.trial.claimed) return "尚未启用智能整理";
  if (!value.trial.expiresAt || !Number.isFinite(Date.parse(value.trial.expiresAt))) return "暂时无法读取服务状态";
  if (value.trial.expiresAt && Date.parse(value.trial.expiresAt) <= now && value.paidRemaining === 0) return "体验已结束";
  return "次数已用完，可购买更多";
}
export const activeOrder = (order: OfficialOrder | null) => Boolean(order && !["closed", "failed", "granted", "paid"].includes(order.status) && !orderExpired(order));
/** 支付订单有效期判断：无有效期限字段时视为有效（兼容旧数据）。 */
export const orderExpired = (order: OfficialOrder | null) => Boolean(order?.expiresAt && Date.parse(order.expiresAt) <= Date.now());
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试";

// Native login RPCs share one current ticket. Finish an old begin/poll/cancel
// before a newly mounted card creates its ticket, so late cleanup cannot cancel it.
const loginQueues = new WeakMap<OfficialServices, Promise<unknown>>();
function loginRequest<T>(services: OfficialServices, request: () => Promise<T>): Promise<T> {
  const previous = loginQueues.get(services) ?? Promise.resolve();
  const result = previous.then(request, request);
  loginQueues.set(services, result.catch(() => {}));
  return result;
}

export function createOfficialController(services: OfficialServices, initialCallbacks: OfficialCallbacks) {
  let callbacks = initialCallbacks;
  let state: OfficialState = { account: null, accountLoading: true, accountError: null, login: null, loginLoading: false, loginError: null, offers: null, offersLoading: false, offersError: null, order: null, orderLoading: false, orderError: null, busy: null, activationError: null };
  const listeners = new Set<() => void>();
  let mounted = 0, started = false, closed = false, loadSequence = 0, activationSequence = 0;
  let loginTimer: ReturnType<typeof setTimeout> | undefined, orderTimer: ReturnType<typeof setTimeout> | undefined;
  let ticketStatus: OfficialLogin["status"] | null = null;
  let beginning = false, orderPolling = false, autoRequested = false, autoAttempted = false, returnAfterActivation = false;
  const live = () => mounted > 0 && !closed;
  function update(patch: Partial<OfficialState>) { if (!live()) return; state = { ...state, ...patch }; listeners.forEach(fn => fn()); }
  function message(text: string, tone = "info") { if (live()) callbacks.onMessage?.({ tone, text }); }
  function close() {
    if (closed) return;
    closed = true; loadSequence++;
    clearTimeout(loginTimer); clearTimeout(orderTimer);
    void loginRequest(services, async () => {
      if (ticketStatus !== "pending") return;
      ticketStatus = "cancelled";
      await services.cancel();
    }).catch(() => {});
  }
  async function loadPurchases() {
    if (!live() || state.busy) return;
    const sequence = ++loadSequence;
    clearTimeout(orderTimer);
    update({ offersLoading: true, offersError: null, orderLoading: true, orderError: null });
    await Promise.all([
      services.offers().then(offers => { if (live() && sequence === loadSequence) update({ offers, offersLoading: false }); }).catch(error => {
        if (live() && sequence === loadSequence) { update({ offersLoading: false, offersError: errorText(error) }); message(errorText(error), "warn"); }
      }),
      services.pendingOrder().then(order => {
        if (live() && sequence === loadSequence) {
          // 重启恢复时丢弃已终结的历史订单，避免“订单已关闭”长期驻留。
          const restored = order && !["closed", "failed", "granted", "paid"].includes(order.status) && !orderExpired(order) ? order : null;
          update({ order: restored, orderLoading: false });
          if (restored) scheduleOrder();
        }
      }).catch(error => {
        if (live() && sequence === loadSequence) { update({ orderLoading: false, orderError: errorText(error) }); message(errorText(error), "error"); }
      }),
    ]);
  }
  async function load() {
    if (!live() || state.busy) return;
    const sequence = ++loadSequence;
    update({ accountLoading: true, accountError: null });
    try {
      const account = await services.account();
      if (!live() || sequence !== loadSequence) return;
      update({ account, accountLoading: false });
      if (autoRequested && !autoAttempted && account.configured) {
        autoAttempted = true;
        if (!account.loggedIn) { await begin(); return; }
        returnAfterActivation = true;
        await activate();
      }
      if (live() && account.loggedIn) await loadPurchases();
    } catch (error) {
      if (live() && sequence === loadSequence) { update({ accountLoading: false, accountError: errorText(error) }); message(errorText(error), "warn"); }
    }
  }
  async function activate() {
    if (!live() || state.busy || state.accountLoading || !state.account?.loggedIn) return;
    const current = state.account;
    // Trial activation and payment confirmation both return a complete balance.
    // Defer order refreshes, including in-flight reads, until activation settles.
    activationSequence++;
    clearTimeout(orderTimer);
    update({ busy: "activation", activationError: null });
    try {
      const entitlement = current.entitlement?.trial.claimed ? current.entitlement : await services.trial();
      if (!live()) return;
      update({ account: { ...current, entitlement } });
      callbacks.onChanged();
      if (entitlement.canExtract) await callbacks.onActivated(entitlement);
      else message(entitlementMessage(entitlement));
      if (!live()) return;
      update({ busy: null });
      if (returnAfterActivation) { returnAfterActivation = false; callbacks.onSignedIn?.(); }
    } catch (error) {
      if (live()) { update({ busy: null, activationError: errorText(error) }); message(errorText(error), "warn"); }
    } finally { scheduleOrder(); }
  }
  async function acceptLogin(result: OfficialLogin) {
    if (!live()) return;
    update({ login: { ...result, qrCodeDataUrl: result.qrCodeDataUrl ?? state.login?.qrCodeDataUrl ?? null }, loginLoading: false, loginError: null });
    if (result.status === "confirmed") {
      if (!result.account?.loggedIn) { update({ loginError: "登录状态未返回，请重新获取二维码" }); return; }
      update({ account: result.account });
      returnAfterActivation = true;
      callbacks.onChanged();
      await activate();
      if (live()) await loadPurchases();
    } else if (result.status === "pending") {
      if (!state.login?.qrCodeDataUrl) { update({ loginError: "二维码未返回，请重新获取" }); return; }
      scheduleLogin();
    }
  }
  function scheduleLogin(delay = state.login?.pollIntervalMs ?? 1500) {
    clearTimeout(loginTimer);
    if (!live() || state.login?.status !== "pending") return;
    loginTimer = setTimeout(() => { void pollLogin(); }, Math.max(250, delay));
  }
  async function pollLogin() {
    const ticket = state.login;
    if (!live() || ticket?.status !== "pending") return;
    if (ticket.expiresAt && Date.parse(ticket.expiresAt) <= Date.now()) { ticketStatus = "expired"; update({ login: { ...ticket, status: "expired" }, loginError: null }); return; }
    try {
      const result = await loginRequest(services, async () => {
        if (!live()) return null;
        const value = await services.poll(); ticketStatus = value.status; return value;
      });
      if (result && live()) await acceptLogin(result);
    } catch (error) {
      if (!live()) return;
      update({ loginError: errorText(error) }); message(errorText(error), "warn");
      const retry = nextLoginRetry(error, ticket.expiresAt, ticket.pollIntervalMs, Date.now());
      if (retry !== null) { update({ login: { ...ticket, pollIntervalMs: retry } }); scheduleLogin(retry); }
    }
  }
  async function begin() {
    if (!live() || beginning || state.busy || state.account?.loggedIn || (state.login?.status === "pending" && !state.loginError)) return;
    const confirmed = () => ticketStatus === "confirmed" || state.account?.loggedIn === true;
    beginning = true; clearTimeout(loginTimer);
    update({ loginLoading: true, loginError: null, login: null });
    try {
      const result = await loginRequest(services, async () => {
        if (!live() || confirmed()) return null;
        if (ticketStatus === "pending") await services.cancel();
        if (!live() || confirmed()) return null;
        const value = await services.begin(); ticketStatus = value.status; return value;
      });
      if (result && live()) await acceptLogin(result);
    } catch (error) { if (live()) { update({ loginLoading: false, loginError: errorText(error) }); message(errorText(error), "warn"); } }
    finally { beginning = false; }
  }
  function scheduleOrder(delay = 2000) {
    clearTimeout(orderTimer);
    if (live() && state.busy !== "logout" && state.busy !== "activation" && !state.accountLoading && activeOrder(state.order)) orderTimer = setTimeout(() => { void pollOrder(); }, delay);
  }
  async function pollOrder() {
    const order = state.order;
    if (!live() || !order || !activeOrder(order) || orderPolling || state.busy === "logout" || state.busy === "activation") return;
    const sequence = loadSequence;
    const activation = activationSequence;
    orderPolling = true;
    try {
      const result = await services.orderStatus(order.orderNo);
      if (!live() || sequence !== loadSequence || activation !== activationSequence || state.order?.orderNo !== order.orderNo) return;
      if (result.paid && result.entitlementGranted) {
        const account = await services.account();
        if (!live() || sequence !== loadSequence || activation !== activationSequence || state.order?.orderNo !== order.orderNo) return;
        // 终态订单不再驻留卡片：到账由摘要数字跳动体现，关闭/失败只留一次底栏提示。
        update({ account, order: null, orderError: null });
        callbacks.onChanged(); message("购买成功，次数已到账");
        if (account.entitlement?.canExtract) {
          try { await callbacks.onActivated(account.entitlement); }
          catch (error) { update({ activationError: errorText(error) }); message(errorText(error), "error"); }
        }
      } else if (result.status === "closed" || result.status === "failed") {
        update({ order: null, orderError: null });
        message(result.status === "closed" ? "订单已关闭，可重新购买" : "支付未完成，可重新购买");
      } else { update({ order: { ...order, status: result.status }, orderError: null }); scheduleOrder(); }
    } catch (error) {
      if (live() && sequence === loadSequence && activation === activationSequence && state.order?.orderNo === order.orderNo) {
        update({ order: { ...order, status: "query_failed" }, orderError: errorText(error) });
        message(errorText(error), "error"); scheduleOrder(6000);
      }
    } finally { orderPolling = false; if (live() && (sequence !== loadSequence || activation !== activationSequence)) scheduleOrder(); }
  }
  async function buy(offerId: string) {
    if (!live() || state.busy || state.orderLoading || Boolean(state.orderError && !state.order) || activeOrder(state.order) || !state.account?.loggedIn || !state.offers?.salesEnabled || !state.offers.offers.some(offer => offer.id === offerId && offer.enabled)) return;
    update({ busy: "purchase", orderError: null });
    try { const order = await services.order(offerId); if (live()) { update({ order }); scheduleOrder(); } }
    catch (error) { update({ orderError: errorText(error) }); message(errorText(error), "error"); }
    finally { update({ busy: null }); }
  }
  async function cancelOrder() {
    const order = state.order;
    if (!live() || state.busy || !order) return;
    update({ busy: "purchase", orderError: null });
    try {
      const result = await services.cancelOrder(order.orderNo);
      if (!live()) return;
      update({ order: null });
      message(result.status === "paid" ? "订单已支付，次数即将到账" : "订单已取消");
    } catch (error) {
      if (live()) { update({ orderError: errorText(error) }); message(errorText(error), "warn"); }
    } finally { if (live()) update({ busy: null }); }
  }
  async function logout() {
    if (!live() || state.busy) return;
    loadSequence++;
    update({ busy: "logout", activationError: null }); clearTimeout(orderTimer);
    try {
      await services.logout();
      if (!live()) return;
      loadSequence++; ticketStatus = null; returnAfterActivation = false;
      update({ account: null, offers: null, order: null, login: null, loginError: null, busy: null });
      callbacks.onChanged(); await load();
    } catch (error) {
      update({ busy: null, activationError: errorText(error), offersLoading: false, orderLoading: false });
      message(errorText(error), "warn");
      // Logout invalidated the old reads; recover from the current service state.
      void load();
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    setCallbacks(next: OfficialCallbacks) { callbacks = next; },
    mount(autoLogin = false) {
      mounted++; autoRequested = autoLogin;
      if (!started) { started = true; void load(); }
      return () => { mounted--; void Promise.resolve().then(() => { if (mounted === 0) close(); }); };
    },
    back() { if (closed) return; close(); callbacks.onBack(); },
    begin, activate, buy, cancelOrder, logout, reload: load, reloadPurchases: loadPurchases,
    retryOrder() { clearTimeout(orderTimer); void pollOrder(); },
  };
}
