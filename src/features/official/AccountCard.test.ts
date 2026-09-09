/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accountCardBusy, accountPurchaseVisible, finishAccountCardLogin, maskAccountId, nextBumpState } from "./AccountCard";
import { offerButtonText, orderStatusText, trialSubText } from "./officialController";
import type { Entitlement, OfficialOffers, OfficialOrder } from "../../contracts/official";

const entitlement: Entitlement = { product: "pometodo", trial: { claimed: true, total: 20, remaining: 19, expiresAt: "2026-10-06T00:00:00Z" }, paidRemaining: 0, paidTotal: 0, remaining: 19, canExtract: true };
const offers: OfficialOffers = { product: "pometodo", salesEnabled: true, offers: [{ product: "pometodo", id: "offer-500", revision: 1, name: "500次", enabled: true, amountFen: 2500, currency: "CNY", benefit: { kind: "count", extractions: 500, validityDays: null }, termsVersion: "1" }] };
const order = (status: string): OfficialOrder => ({ product: "pometodo", orderNo: "order-1", status, amountFen: 2500, currency: "CNY", expiresAt: "2099-01-01T00:00:00Z", qrCodeDataUrl: "data:image/png;base64,x", snapshot: { product: "pometodo", offerId: "offer-500", offerRevision: 1, name: "500次", amountFen: 2500, currency: "CNY", benefit: { kind: "count", extractions: 500, validityDays: null }, termsVersion: "1" } });

describe("设置页账户卡片", () => {
  it("账户 ID 折叠展示只露首尾，缺失时不显示该行", () => {
    expect(maskAccountId("6d9cddeefixme9194")).toBe("6d9cddee…9194");
    expect(maskAccountId(null)).toBeNull();
  });
  it("绑定状态与体验副行各自一句话，已结束的体验不再补充日期", () => {
    expect(trialSubText("2026-10-06T00:00:00Z", 19)).toBe("2026/10/6 前有效");
    expect(trialSubText(null, 19)).toBeNull();
    expect(trialSubText("not-a-date", 19)).toBeNull();
    expect(trialSubText("2026-10-06T00:00:00Z", 0)).toBeNull();
  });
  it("购买按钮文案按服务端返回组合为 ¥25元 / 500次 形式", () => {
    expect(offerButtonText(offers.offers[0])).toBe("¥25 元 / 500 次");
  });
  it("支付流程每种状态只保留一句最重要的说明", () => {
    expect(orderStatusText("granted")).toBe("购买成功，次数已到账");
    expect(orderStatusText("created")).toBe("微信扫码付款，到账自动开通");
    expect(orderStatusText("paying")).toBe("微信扫码付款，到账自动开通");
    expect(orderStatusText("paid")).toBe("付款已收到，正在确认到账");
    expect(orderStatusText("closed")).toBe("订单已关闭，可重新购买");
    expect(orderStatusText("failed")).toBe("支付未完成，可重新购买");
    expect(orderStatusText("query_failed")).toBe("暂时无法确认支付，稍后自动重试");
  });
  it("只有服务端确认可售或有待支付订单时才显示购买入口", () => {
    expect(accountPurchaseVisible(offers, null)).toBe(true);
    expect(accountPurchaseVisible({ ...offers, salesEnabled: false }, null)).toBe(false);
    expect(accountPurchaseVisible({ ...offers, offers: [] }, null)).toBe(false);
    expect(accountPurchaseVisible(null, null)).toBe(false);
    expect(accountPurchaseVisible(null, order("created"))).toBe(true);
    expect(accountPurchaseVisible(null, order("closed"))).toBe(false);
  });
  it("扫码成功后先收起二维码并重新读取卡片内账号与订单", async () => {
    const collapse = vi.fn();
    const reload = vi.fn(async () => {});
    finishAccountCardLogin(collapse, reload);
    expect(collapse).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
  it("登录二维码、下单请求、待支付订单都会阻止安装", () => {
    expect(accountCardBusy({ loginOpen: true, controllerBusy: false, orderLoading: false, orderPending: false })).toBe(true);
    expect(accountCardBusy({ loginOpen: false, controllerBusy: true, orderLoading: false, orderPending: false })).toBe(true);
    expect(accountCardBusy({ loginOpen: false, controllerBusy: false, orderLoading: false, orderPending: true })).toBe(true);
    expect(accountCardBusy({ loginOpen: false, controllerBusy: false, orderLoading: false, orderPending: false })).toBe(false);
  });
  it("到账动效：剩余次数变化时触发一次，初次读取与相同值不触发", () => {
    expect(nextBumpState(null, 19)).toBe(false);
    expect(nextBumpState(19, 19)).toBe(false);
    expect(nextBumpState(19, 519)).toBe(true);
    expect(nextBumpState(519, 518)).toBe(true);
  });
  it("行式摘要、额度卡片与低权重购买按钮样式齐备", () => {
    const css = readFileSync(fileURLToPath(new URL("./official.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.official-account-card \.official-account-row \{/);
    expect(css).toMatch(/\.official-account-card \.official-account-row \+ \.official-account-row \{ border-top: 1px solid var\(--separator\); \}/);
    expect(css).toMatch(/\.official-account-card \.official-account-row-label \{/);
    expect(css).toMatch(/\.official-account-card \.official-quota-item \{/);
    expect(css).toMatch(/\.pometodo-settings \.official-account-card \.settings-card-body \{ gap: 8px; \}/);
    expect(css).toMatch(/@keyframes official-count-bump/);
    expect(css).toMatch(/\.official-account-card \.official-account-buy \{ background: var\(--input-bg\); border-color: transparent;/);
    expect(css).toMatch(/\.official-account-card \.official-account-details-actions \{ display: flex; align-items: center; justify-content: space-between; gap: 8px; \}/);
    expect(css).not.toMatch(/\.official-account-details-toggle/);
    expect(css).not.toMatch(/official-account-detail-line/);
    expect(css).not.toMatch(/official-account-quota-line/);
    expect(css).not.toMatch(/official-icon-button/);
  });
});
