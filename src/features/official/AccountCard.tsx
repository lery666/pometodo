import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Entitlement, OfficialOffers, OfficialOrder, OfficialServices } from "../../contracts/official";
import type { StatusMessage } from "../../components/StatusBar";
import { activeOrder, benefitText, createOfficialController, offerButtonText, orderStatusText, trialSubText } from "./officialController";
import OfficialLoginCard from "./OfficialLoginCard";
import "./official.css";

function ChevronIcon() {
  return <svg className="settings-card-chevron" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>;
}

export interface AccountCardProps {
  services: OfficialServices;
  onActivated(entitlement: Entitlement): Promise<void>;
  onChanged(): void;
  onMessage(message: StatusMessage): void;
  /** 待支付订单上报宿主，用于底栏提示。 */
  onPurchaseActive?(active: boolean): void;
  /** 登录、账号操作或付款进行中上报宿主，避免此时启动安装更新。 */
  onBusyChange?(active: boolean): void;
  /** 自带 Key 正在成功服务：官方额度不消耗，进度条冻结置灰并提示。 */
  byokActive?: boolean;
  /** 用户是否开启了智能整理（与来源无关）；关闭时折叠摘要不显示次数行。 */
  smartArrangeEnabled?: boolean;
}

interface AccountCardBusyState {
  loginOpen: boolean;
  controllerBusy: boolean;
  orderLoading: boolean;
  orderPending: boolean;
}

export function accountCardBusy(state: AccountCardBusyState) {
  return state.loginOpen || state.controllerBusy || state.orderLoading || state.orderPending;
}

export function finishAccountCardLogin(collapse: () => void, reload: () => Promise<unknown>) {
  collapse();
  void reload();
}

/** 折叠态展示用的账户 ID 掩码：只露首尾，避免完整标识外泄。 */
/** 支付二维码展开：挂载后延迟一帧打开，保证与设置分组一致的展开/收起动画。 */
function PaymentShell({ open, children }: { open: boolean; children: ReactNode }) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!open) { setActive(false); return; }
    const raf = requestAnimationFrame(() => setActive(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);
  return (
    <div className={`official-offer-payment-shell${active ? " open" : ""}`}>
      <div className="official-offer-payment">{children}</div>
    </div>
  );
}

/** 账户占位用的旋转加载图标。 */
function LoadingDot() {
  return <svg className="official-spin" aria-label="加载中" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3a9 9 0 1 1-8.2 5.3" /></svg>;
}

export function maskAccountId(accountId: string | null): string | null {
  if (!accountId) return null;
  return `${accountId.slice(0, 8)}…${accountId.slice(-4)}`;
}

/** 只有服务端确有可售商品，或存在待支付订单需要找回时，才显示购买入口。 */
export function accountPurchaseVisible(offers: OfficialOffers | null, order: OfficialOrder | null): boolean {
  return Boolean(order && activeOrder(order)) || Boolean(offers?.salesEnabled && offers.offers.some(offer => offer.enabled));
}

/** 二维码剩余支付时间倒计时；归零后自动查询一次订单状态（服务端会将其关闭并提示可重新购买）。 */
export function formatCountdown(expiresAt: string | null, nowMs: number): string | null {
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
  const left = Math.floor((Date.parse(expiresAt) - nowMs) / 1000);
  if (left <= 0) return null;
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function usePaymentCountdown(expiresAt: string | null, onExpire: () => void): string | null {
  const [text, setText] = useState<string | null>(null);
  const fired = useRef(false);
  useEffect(() => {
    fired.current = false;
    if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) { setText(null); return; }
    const target = Date.parse(expiresAt);
    const tick = () => {
      if (fired.current) return;
      const value = formatCountdown(expiresAt, Date.now());
      setText(value);
      if (value === null) { fired.current = true; onExpire(); }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, onExpire]);
  return text;
}

/** 剩余次数变化时让摘要数字跳动一次；初次读取与相同值不触发。 */
export function nextBumpState(previous: number | null, current: number | null): boolean {
  return previous !== null && current !== null && current !== previous;
}

export function useRemainingBump(remaining: number | null): boolean {
  const [bump, setBump] = useState(false);
  const previous = useRef<number | null>(null);
  useEffect(() => {
    const changed = nextBumpState(previous.current, remaining);
    previous.current = remaining;
    if (!changed) return;
    setBump(true);
    const timer = setTimeout(() => setBump(false), 1400);
    return () => clearTimeout(timer);
  }, [remaining]);
  return bump;
}

/** 设置页顶部账户卡片：与设置页其他折叠分组同一套卡片、箭头与折叠动效。 */
export default function AccountCard({ services, onActivated, onChanged, onMessage, onPurchaseActive, onBusyChange, byokActive, smartArrangeEnabled }: AccountCardProps) {
  const core = useMemo(() => createOfficialController(services, {
    onBack: () => {},
    onActivated: entitlement => onActivated(entitlement),
    onChanged: () => onChanged(),
    onSignedIn: () => {},
    onMessage: message => onMessage(message),
  }), [services]);
  core.setCallbacks({ onBack: () => {}, onActivated: entitlement => onActivated(entitlement), onChanged: () => onChanged(), onSignedIn: () => {}, onMessage: message => onMessage(message) });
  const state = useSyncExternalStore(core.subscribe, core.getSnapshot, core.getSnapshot);
  useEffect(() => core.mount(false), [core]);
  const { account, order, offers } = state;
  const entitlement = account?.entitlement ?? null;
  const busy = Boolean(state.busy);
  const pending = activeOrder(order);
  const availableOffers = offers?.offers.filter(offer => offer.enabled) ?? [];

  const [showLogin, setShowLogin] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [qrCollapsed, setQrCollapsed] = useState(false);
  const [qrEverShown, setQrEverShown] = useState(false);
  const copyIdTimer = useRef<number | null>(null);
  const handleCopyId = useCallback(async (accountId: string) => {
    try {
      await navigator.clipboard?.writeText(accountId);
      setCopiedId(true);
      if (copyIdTimer.current) window.clearTimeout(copyIdTimer.current);
      copyIdTimer.current = window.setTimeout(() => setCopiedId(false), 2000);
    } catch {
      onMessage?.({ tone: "warn", text: "复制失败，请手动选择复制" });
    }
  }, [onMessage]);
  const orderNo = order?.orderNo ?? null;
  // 有待完成订单或次数用尽时按需展开详情，平时不常驻。
  useEffect(() => { if (orderNo) setDetailsOpen(true); }, [orderNo]);
  useEffect(() => { if (entitlement && !entitlement.canExtract && entitlement.remaining === 0) setDetailsOpen(true); }, [entitlement]);
  useEffect(() => { onPurchaseActive?.(pending); return () => onPurchaseActive?.(false); }, [pending, onPurchaseActive]);
  const activityBusy = accountCardBusy({ loginOpen: showLogin, controllerBusy: busy, orderLoading: state.orderLoading, orderPending: pending });
  useEffect(() => { onBusyChange?.(activityBusy); return () => onBusyChange?.(false); }, [activityBusy, onBusyChange]);

  const bump = useRemainingBump(entitlement?.remaining ?? null);
  const countdown = usePaymentCountdown(order?.expiresAt ?? null, () => core.retryOrder());
  const buyVisible = accountPurchaseVisible(offers, order);

  let summary: ReactNode;
  // 加载中保持与登录态一致的行结构（微信/次数两行），用旋转图标占位，避免卡片高度突变造成的闪烁与对焦错位。
  if (state.accountLoading) summary = <div className="official-account-rows">
    <div className="official-account-row">
      <span className="official-account-row-label">微信</span>
      <span className="official-account-row-value"><LoadingDot /></span>
    </div>
    <div className="official-account-row">
      <span className="official-account-row-label">智能整理次数</span>
      <span className="official-account-row-value"><LoadingDot /></span>
    </div>
  </div>;
  else if (state.accountError) summary = <>
    <p className="official-account-card-text official-account-summary-text"><span className="official-error" role="alert">{state.accountError}</span></p>
    <button className="official-button" type="button" onClick={() => void core.reload()}>重新读取</button>
  </>;
  else if (account && !account.configured) summary = <p className="official-account-summary-text">{account.message || "账号服务暂不可用"}</p>;
  else if (account && !account.loggedIn) summary = <div className="official-account-rows">
    <div className="official-account-row">
      <span className="official-account-row-label">微信</span>
      <button className="official-button official-account-buy" type="button" onClick={() => setShowLogin(true)}>绑定微信</button>
    </div>
  </div>;
  else summary = <div className="official-account-rows">
    <div className="official-account-row">
      <span className="official-account-row-label">微信</span>
      <span className="official-account-row-value official-account-bind-state">已绑定</span>
    </div>
    {smartArrangeEnabled && entitlement && <div className="official-account-row">
      <span className="official-account-row-label">智能整理次数</span>
      <span className={`official-account-row-value${bump ? " official-account-bump" : ""}`}>{entitlement.remaining} 次</span>
    </div>}
  </div>;

  if (showLogin) return <section className="settings-card official-account-card">
    <h2 className="settings-card-title">账户</h2>
    <div className="official-account-login-body">
      <OfficialLoginCard services={services} autoLogin onActivated={onActivated} onChanged={onChanged} onMessage={onMessage}
        onSignedIn={() => finishAccountCardLogin(() => setShowLogin(false), core.reload)} onCancel={() => setShowLogin(false)} />
    </div>
  </section>;

  const detailsBody = account?.loggedIn ? <>
    <div className="official-quota-list">
      {entitlement && entitlement.paidRemaining > 0 && <div className="official-quota-row">
        <span className="official-quota-name">已购次数 · {entitlement.paidTotal} 次</span>
        <span className="official-quota-sub">长期有效</span>
        <span className={`official-quota-remaining${byokActive ? " official-quota-frozen" : ""}`}>{entitlement.paidRemaining} 次</span>
      </div>}
      {entitlement?.trial.claimed && <div className="official-quota-row">
        <span className="official-quota-name">赠送体验 · {entitlement.trial.total} 次</span>
        <span className="official-quota-sub">{entitlement.trial.remaining > 0 ? trialSubText(entitlement.trial.expiresAt, entitlement.trial.remaining) : "已结束"}</span>
        <span className={`official-quota-remaining${byokActive ? " official-quota-frozen" : ""}`}>{entitlement.trial.remaining > 0 ? `${entitlement.trial.remaining} 次` : "已用完"}</span>
      </div>}
    </div>
    {state.activationError && <p className="official-error" role="alert">{state.activationError}</p>}
    {buyVisible && <div className="official-purchase-body">
      {state.offersLoading && <p className="official-hint" role="status">正在读取商品…</p>}
      {state.offersError && <><p className="official-error" role="alert">{state.offersError}</p><button className="official-button" type="button" disabled={busy} onClick={() => void core.reloadPurchases()}>重新读取商品</button></>}
      {state.orderLoading && <p className="official-hint" role="status">正在读取待完成订单…</p>}
      {state.orderError && <><p className="official-error" role="alert">{state.orderError}</p><button className="official-button" type="button" disabled={busy} onClick={() => order ? core.retryOrder() : void core.reloadPurchases()}>重新查询订单</button></>}
      {!state.offersLoading && !state.offersError && availableOffers.map(offer => {
        const orderForOffer = order && order.snapshot.offerId === offer.id ? order : null;
        return <div className="official-offer" key={offer.id}>
          <div className="official-offer-info"><h4>{offer.name}</h4></div>
          <button className="official-button official-account-buy" type="button" disabled={busy || pending || state.orderLoading || Boolean(state.orderError && !order)} onClick={() => { setQrCollapsed(false); setQrEverShown(true); void core.buy(offer.id); }}>{offerButtonText(offer)}</button>
          {orderForOffer && (
            <PaymentShell open={Boolean(pending && orderForOffer.status !== "paid" && !qrCollapsed)}>
              {orderForOffer.qrCodeDataUrl
                ? <img className="official-qr-image" src={orderForOffer.qrCodeDataUrl} alt="微信付款二维码"/>
                : <div className="official-qr-loading" role="status"><LoadingDot />正在生成…</div>}
              <p className="official-countdown">
                <span className="official-countdown-label">微信扫码支付</span>
                <span className="official-countdown-time">{pending && orderForOffer.status !== "paid" ? (countdown === null ? "二维码已过期" : `${countdown} 后失效`) : "订单已取消"}</span>
              </p>
              <button className="official-cancel-order" type="button" disabled={busy || !pending || orderForOffer.status === "paid"} onClick={() => {
                setQrCollapsed(true);
                void core.cancelOrder().catch(() => setQrCollapsed(false));
              }}>{state.busy === "purchase" ? "正在取消…" : "取消订单"}</button>
            </PaymentShell>
          )}
        </div>;
      })}
    </div>}
    <div className="official-account-details-actions">
      {account?.accountId && (
        <button className="official-account-id-button" type="button" title="点击复制到剪贴板" onClick={() => void handleCopyId(account.accountId!)}>
          {copiedId ? "已复制" : "账号ID"}
        </button>
      )}
      <button className="official-button official-signout" type="button" disabled={busy} onClick={() => void core.logout()}>{state.busy === "logout" ? "正在解除…" : "解除绑定"}</button>
    </div>
  </> : null;

  return <section className={`settings-card collapsible${detailsOpen ? " open" : ""} official-account-card`}>
    <button className="settings-card-toggle" type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}>
      <span className="settings-card-title">账户</span>
      <ChevronIcon/>
    </button>
    <div className="settings-card-summary">{summary}</div>
    {detailsBody && <div className="settings-card-content-shell" aria-hidden={!detailsOpen} inert={!detailsOpen || undefined}>
      <div className="settings-card-content"><div className="settings-card-body settings-card-body-tight">{detailsBody}</div></div>
    </div>}
  </section>;
}
