import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as panel from "./officialController";
import { OfficialServiceError } from "../../contracts/official";
import type { Entitlement, OfficialAccount, OfficialLogin, OfficialOffers, OfficialOrder, OfficialOrderStatus, OfficialServices } from "../../contracts/official";

const entitlement: Entitlement = { product: "pometodo", trial: { claimed: true, total: 100, remaining: 99, expiresAt: "2099-01-01T00:00:00Z" }, paidRemaining: 0, paidTotal: 0, remaining: 99, canExtract: true };
const signedOut: OfficialAccount = { configured: true, loggedIn: false, accountId: null, entitlement: null, message: "" };
const signedIn: OfficialAccount = { ...signedOut, loggedIn: true, accountId: "preview-account", entitlement };
const ticket: OfficialLogin = { status: "pending", qrCodeDataUrl: "data:image/png;base64,preview", expiresAt: "2099-01-01T00:00:00Z", pollIntervalMs: 1000, account: null };
const order: OfficialOrder = { product: "pometodo", orderNo: "preview-order", status: "created", amountFen: 1234, currency: "CNY", expiresAt: "2099-01-01T00:00:00Z", qrCodeDataUrl: "data:image/png;base64,preview", snapshot: { product: "pometodo", offerId: "preview-offer", offerRevision: 1, name: "服务返回的商品", amountFen: 1234, currency: "CNY", benefit: { kind: "count", extractions: 42, validityDays: null }, termsVersion: "1" } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 18; i++) await Promise.resolve(); }
function services(overrides: Partial<OfficialServices> = {}): OfficialServices {
  return { account: vi.fn(async () => signedOut), begin: vi.fn(async () => ticket), poll: vi.fn(async () => ticket), cancel: vi.fn(async () => {}), trial: vi.fn(async () => entitlement), logout: vi.fn(async () => {}), offers: vi.fn(async (): Promise<OfficialOffers> => ({ product: "pometodo", salesEnabled: false, offers: [] })), order: vi.fn(async () => order), pendingOrder: vi.fn(async () => null), orderStatus: vi.fn(async (): Promise<OfficialOrderStatus> => ({ orderNo: order.orderNo, status: "paying", paid: false, entitlementGranted: false, amountFen: order.amountFen, currency: "CNY", expiresAt: order.expiresAt, paidAt: null })), cancelOrder: vi.fn(async (orderNo: string) => ({ orderNo, status: "closed" })), ...overrides };
}
function setup(service = services(), autoLogin = true) {
  // This assertion first fails against the former page, before the new flow exists.
  expect(panel).toHaveProperty("createOfficialController", expect.any(Function));
  const callbacks = { onBack: vi.fn(), onActivated: vi.fn(async (_: Entitlement) => {}), onChanged: vi.fn(), onSignedIn: vi.fn(), onMessage: vi.fn() };
  const core = panel.createOfficialController(service, callbacks);
  const detach = core.mount(autoLogin);
  return { core, service, callbacks, detach };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("embedded official account flow", () => {
  it("starts one login for StrictMode replay, rerenders and duplicate clicks", async () => {
    const pending = deferred<OfficialLogin>();
    const s = services({ begin: vi.fn(() => pending.promise) });
    const { core, detach } = setup(s);
    detach(); core.mount(true); await settle();
    void core.begin(); void core.begin(); await settle();
    expect(s.begin).toHaveBeenCalledTimes(1);
    expect(core.getSnapshot().loginLoading).toBe(true);
    pending.resolve(ticket); await settle();
    expect(core.getSnapshot().login?.qrCodeDataUrl).toBe(ticket.qrCodeDataUrl);
    core.back(); await settle();
  });
  it("returns immediately during begin and cancels its late ticket without reopening", async () => {
    const pending = deferred<OfficialLogin>();
    const { core, service, callbacks } = setup(services({ begin: vi.fn(() => pending.promise) }));
    await settle(); core.back();
    expect(callbacks.onBack).toHaveBeenCalledOnce();
    pending.resolve(ticket); await settle();
    expect(service.cancel).toHaveBeenCalledOnce();
    expect(callbacks.onSignedIn).not.toHaveBeenCalled();
    expect(core.getSnapshot().login).toBeNull();
  });
  it("does not cancel a confirmation arriving after the user returned", async () => {
    const pending = deferred<OfficialLogin>();
    const { core, service, callbacks } = setup(services({ poll: vi.fn(() => pending.promise) }));
    await settle(); await vi.advanceTimersByTimeAsync(1000);
    core.back(); pending.resolve({ ...ticket, status: "confirmed", account: signedIn }); await settle();
    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.trial).not.toHaveBeenCalled();
    expect(callbacks.onSignedIn).not.toHaveBeenCalled();
    expect(callbacks.onActivated).not.toHaveBeenCalled();
  });
  it("serializes cancellation before a quickly reopened login", async () => {
    const pending = deferred<OfficialLogin>(); const calls: string[] = [];
    const s = services({ begin: vi.fn().mockImplementationOnce(() => { calls.push("begin1"); return pending.promise; }).mockImplementationOnce(async () => { calls.push("begin2"); return ticket; }), cancel: vi.fn(async () => { calls.push("cancel1"); }) });
    const first = setup(s); await settle(); first.core.back();
    const second = setup(s); await settle(); pending.resolve(ticket); await settle();
    expect(calls).toEqual(["begin1", "cancel1", "begin2"]);
    expect(second.core.getSnapshot().login?.status).toBe("pending");
    second.core.back(); await settle();
  });
  it("returns after confirmation even when 99 remaining uses are temporarily unavailable", async () => {
    const paused = { ...signedIn, entitlement: { ...entitlement, canExtract: false } };
    const { core, service, callbacks } = setup(services({ poll: vi.fn(async (): Promise<OfficialLogin> => ({ ...ticket, status: "confirmed", account: paused })) }));
    await settle(); await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(callbacks.onSignedIn).toHaveBeenCalledOnce();
    expect(callbacks.onActivated).not.toHaveBeenCalled();
    expect(callbacks.onMessage).toHaveBeenCalledWith({ tone: "info", text: "智能整理暂不可用" });
    expect(core.getSnapshot().account?.entitlement?.remaining).toBe(99);
    core.back(); await settle();
    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.logout).not.toHaveBeenCalled();
  });
  it("claims a first trial once and enables it before returning", async () => {
    const unclaimed = { ...signedIn, entitlement: { ...entitlement, trial: { ...entitlement.trial, claimed: false } } };
    const { core, service, callbacks } = setup(services({ poll: vi.fn(async (): Promise<OfficialLogin> => ({ ...ticket, status: "confirmed", account: unclaimed })) }));
    await settle(); await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(service.trial).toHaveBeenCalledOnce();
    expect(callbacks.onActivated).toHaveBeenCalledWith(entitlement);
    expect(callbacks.onSignedIn).toHaveBeenCalledOnce();
    core.back(); await settle(); expect(service.cancel).not.toHaveBeenCalled();
  });
  it("keeps an activation error visible, allows retry, and never cancels a signed-in ticket", async () => {
    const { core, service, callbacks } = setup(services({ poll: vi.fn(async (): Promise<OfficialLogin> => ({ ...ticket, status: "confirmed", account: signedIn })) }));
    callbacks.onActivated.mockRejectedValueOnce(new Error("启用失败，请重试"));
    await settle(); await vi.advanceTimersByTimeAsync(1000); await settle();
    expect(core.getSnapshot().activationError).toBe("启用失败，请重试");
    expect(callbacks.onSignedIn).not.toHaveBeenCalled();
    await core.activate(); await settle();
    expect(callbacks.onSignedIn).toHaveBeenCalledOnce();
    core.back(); await settle(); expect(service.cancel).not.toHaveBeenCalled();
  });
  it("leaves expired login in place until the user explicitly retries", async () => {
    const { core, service } = setup(services({ poll: vi.fn(async (): Promise<OfficialLogin> => ({ ...ticket, status: "expired" })) }));
    await settle(); await vi.advanceTimersByTimeAsync(20000);
    expect(service.begin).toHaveBeenCalledOnce();
    expect(core.getSnapshot().login?.status).toBe("expired");
    await core.begin(); expect(service.begin).toHaveBeenCalledTimes(2);
    core.back(); await settle();
  });
  it("account entry reads data without logging in, activating or ordering", async () => {
    const { core, service } = setup(services({ account: vi.fn(async () => signedIn) }), false);
    await settle();
    expect(service.begin).not.toHaveBeenCalled(); expect(service.trial).not.toHaveBeenCalled(); expect(service.order).not.toHaveBeenCalled();
    expect(core.getSnapshot().offers?.salesEnabled).toBe(false);
    core.back(); await settle();
  });
  it("does not treat paid without entitlementGranted as credited", async () => {
    const s = services({ account: vi.fn(async () => signedIn), pendingOrder: vi.fn(async () => order), orderStatus: vi.fn(async (): Promise<OfficialOrderStatus> => ({ orderNo: order.orderNo, status: "paid", paid: true, entitlementGranted: false, amountFen: order.amountFen, currency: "CNY", expiresAt: order.expiresAt, paidAt: "2026-09-06T00:00:00Z" })) });
    const { core, callbacks } = setup(s, false); await settle();
    await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(core.getSnapshot().order?.status).toBe("paid");
    expect(s.account).toHaveBeenCalledTimes(1); expect(callbacks.onActivated).not.toHaveBeenCalled(); expect(callbacks.onChanged).not.toHaveBeenCalled();
    core.back(); await settle();
  });
  it("updates counts only after both payment and entitlement are confirmed", async () => {
    const s = services({ account: vi.fn(async () => signedIn), pendingOrder: vi.fn(async () => order), orderStatus: vi.fn(async (): Promise<OfficialOrderStatus> => ({ orderNo: order.orderNo, status: "paid", paid: true, entitlementGranted: true, amountFen: order.amountFen, currency: "CNY", expiresAt: order.expiresAt, paidAt: "2026-09-06T00:00:00Z" })) });
    const { core, callbacks } = setup(s, false); await settle();
    await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(core.getSnapshot().order).toBeNull();
    expect(callbacks.onMessage).toHaveBeenCalledWith({ tone: "info", text: "购买成功，次数已到账" });
    expect(s.account).toHaveBeenCalledTimes(2); expect(callbacks.onChanged).toHaveBeenCalledOnce();
    core.back(); await settle();
  });
  it("ignores an old payment response as soon as logout starts", async () => {
    const payment = deferred<OfficialOrderStatus>(); const loggingOut = deferred<void>();
    const s = services({ account: vi.fn(async () => signedIn), pendingOrder: vi.fn(async () => order), orderStatus: vi.fn(() => payment.promise), logout: vi.fn(() => loggingOut.promise) });
    const { core, callbacks } = setup(s, false); await settle(); await vi.advanceTimersByTimeAsync(2000);
    void core.logout();
    payment.resolve({ orderNo: order.orderNo, status: "paid", paid: true, entitlementGranted: true, amountFen: order.amountFen, currency: "CNY", expiresAt: order.expiresAt, paidAt: "2026-09-06T00:00:00Z" }); await settle();
    expect(s.account).toHaveBeenCalledTimes(1); expect(callbacks.onActivated).not.toHaveBeenCalled();
    loggingOut.resolve(); await settle(); core.back(); await settle();
  });
  it("does not overlap manual and scheduled order queries", async () => {
    const payment = deferred<OfficialOrderStatus>();
    const s = services({ account: vi.fn(async () => signedIn), pendingOrder: vi.fn(async () => order), orderStatus: vi.fn(() => payment.promise) });
    const { core } = setup(s, false); await settle(); await vi.advanceTimersByTimeAsync(2000);
    core.retryOrder(); core.retryOrder(); await settle();
    expect(s.orderStatus).toHaveBeenCalledOnce();
    core.back(); payment.resolve({ orderNo: order.orderNo, status: "closed", paid: false, entitlementGranted: false, amountFen: order.amountFen, currency: "CNY", expiresAt: order.expiresAt, paidAt: null }); await settle();
  });
  it("does not create a new order until the existing-order read is known", async () => {
    const pendingOrder = deferred<OfficialOrder | null>();
    const s = services({ account: vi.fn(async () => signedIn), pendingOrder: vi.fn(() => pendingOrder.promise), offers: vi.fn(async (): Promise<OfficialOffers> => ({ product: "pometodo", salesEnabled: true, offers: [{ product: "pometodo", id: "preview-offer", revision: 1, name: "服务返回的商品", enabled: true, amountFen: 1234, currency: "CNY", benefit: { kind: "count", extractions: 42, validityDays: null }, termsVersion: "1" }] })) });
    const { core } = setup(s, false); await settle();
    await core.buy("preview-offer"); expect(s.order).not.toHaveBeenCalled();
    pendingOrder.resolve(null); await settle(); await core.buy("preview-offer");
    expect(s.order).toHaveBeenCalledOnce(); expect(core.getSnapshot().order?.snapshot.benefit).toEqual({ kind: "count", extractions: 42, validityDays: null });
    core.back(); await settle();
  });
  it("reports unknown, paused, expired and exhausted entitlements without guessing", () => {
    expect(panel).toHaveProperty("entitlementMessage", expect.any(Function));
    expect(panel.entitlementMessage(null)).toBe("暂时无法读取服务状态");
    expect(panel.entitlementMessage({ ...entitlement, canExtract: false })).toBe("智能整理暂不可用");
    expect(panel.entitlementMessage({ ...entitlement, remaining: 0, canExtract: false, trial: { ...entitlement.trial, remaining: 0 } })).toBe("次数已用完，可购买更多");
    expect(panel.entitlementMessage({ ...entitlement, remaining: 0, canExtract: false, trial: { ...entitlement.trial, expiresAt: "2020-01-01T00:00:00Z" } })).toBe("体验已结束");
  });
  it("keeps missing expiry and inconsistent positive paid counts neutral", () => {
    expect(panel.entitlementMessage({ ...entitlement, remaining: 0, canExtract: false, trial: { ...entitlement.trial, expiresAt: null } })).toBe("暂时无法读取服务状态");
    expect(panel.entitlementMessage({ ...entitlement, remaining: 0, canExtract: false, trial: { ...entitlement.trial, expiresAt: "invalid-date" } })).toBe("暂时无法读取服务状态");
    expect(panel.entitlementMessage({ ...entitlement, remaining: 0, paidRemaining: 5, canExtract: false })).toBe("智能整理暂不可用");
  });
  it.each(["before-query", "during-query", "during-account-read"] as const)("serializes trial activation with payment confirmation: %s", async phase => {
    const trial = deferred<Entitlement>(); const payment = deferred<OfficialOrderStatus>(); const accountRead = deferred<OfficialAccount>();
    const unclaimed = { ...signedIn, entitlement: { ...entitlement, remaining: 0, trial: { ...entitlement.trial, claimed: false } } };
    const credited = { ...signedIn, entitlement: { ...entitlement, remaining: 299, paidRemaining: 200, paidTotal: 200 } };
    const confirmed: OfficialOrderStatus = { orderNo: order.orderNo, status: "paid", paid: true, entitlementGranted: true, amountFen: order.amountFen, currency: "CNY", expiresAt: order.expiresAt, paidAt: "2026-09-06T00:00:00Z" };
    const s = services({ account: vi.fn().mockResolvedValueOnce(unclaimed).mockImplementation(() => accountRead.promise), trial: vi.fn(() => trial.promise), pendingOrder: vi.fn(async () => order), orderStatus: vi.fn(() => payment.promise) });
    const { core } = setup(s, false); await settle();
    if (phase !== "before-query") { core.retryOrder(); await settle(); }
    if (phase === "during-account-read") { payment.resolve(confirmed); await settle(); expect(s.account).toHaveBeenCalledTimes(2); }
    const activating = core.activate(); await settle();
    if (phase === "before-query") { core.retryOrder(); await settle(); }
    payment.resolve(confirmed); accountRead.resolve(credited); await settle();
    trial.resolve({ ...entitlement, remaining: 100, trial: { ...entitlement.trial, remaining: 100 } }); await activating; await settle();
    await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(core.getSnapshot().account?.entitlement).toMatchObject({ remaining: 299, paidRemaining: 200, paidTotal: 200 });
    expect(core.getSnapshot().order).toBeNull();
    core.back(); await settle();
  });
  it("does not create a queued replacement ticket after an in-flight retry confirms login", async () => {
    const confirmed = deferred<OfficialLogin>(); const trial = deferred<Entitlement>();
    const unclaimed = { ...signedIn, entitlement: { ...entitlement, trial: { ...entitlement.trial, claimed: false } } };
    const s = services({ poll: vi.fn().mockRejectedValueOnce(new OfficialServiceError("暂时查询失败", true)).mockImplementation(() => confirmed.promise), trial: vi.fn(() => trial.promise) });
    const { core, callbacks } = setup(s); await settle(); await vi.advanceTimersByTimeAsync(1000);
    expect(core.getSnapshot().loginError).toBe("暂时查询失败");
    await vi.advanceTimersByTimeAsync(2000); expect(s.poll).toHaveBeenCalledTimes(2);
    const replacing = core.begin();
    confirmed.resolve({ ...ticket, status: "confirmed", account: unclaimed }); await settle();
    expect(s.begin).toHaveBeenCalledOnce(); expect(s.cancel).not.toHaveBeenCalled();
    expect(core.getSnapshot().account?.loggedIn).toBe(true); expect(core.getSnapshot().login?.status).toBe("confirmed");
    trial.resolve(entitlement); await replacing; await settle();
    expect(callbacks.onSignedIn).toHaveBeenCalledOnce();
    expect(core.getSnapshot().loginLoading).toBe(false); core.back(); await settle();
  });
  it("recovers account and purchase reads after logout fails instead of leaving loading stuck", async () => {
    const catalog = deferred<OfficialOffers>(); const pendingOrder = deferred<OfficialOrder | null>();
    const s = services({ account: vi.fn(async () => signedIn), offers: vi.fn(() => catalog.promise), pendingOrder: vi.fn(() => pendingOrder.promise), logout: vi.fn(async () => { throw new Error("退出失败，请重试"); }) });
    const { core } = setup(s, false); await settle();
    expect(core.getSnapshot()).toMatchObject({ offersLoading: true, orderLoading: true });
    await core.logout();
    catalog.resolve({ product: "pometodo", salesEnabled: false, offers: [] }); pendingOrder.resolve(null); await settle();
    expect(core.getSnapshot()).toMatchObject({ accountLoading: false, offersLoading: false, orderLoading: false, activationError: "退出失败，请重试" });
    expect(core.getSnapshot().account?.loggedIn).toBe(true); expect(core.getSnapshot().offers?.salesEnabled).toBe(false);
    core.back(); await settle();
  });
});
