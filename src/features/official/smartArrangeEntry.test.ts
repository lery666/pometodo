import { describe, expect, it } from "vitest";
import { salesOpen, smartArrangeEntry } from "./smartArrangeEntry";
import type { OfficialAccount, OfficialOffers } from "../../contracts/official";

const account: OfficialAccount = { configured: true, loggedIn: true, accountId: "fixture", message: "", entitlement: { product: "pometodo", remaining: 99, paidRemaining: 0, paidTotal: 0, canExtract: false, trial: { claimed: true, total: 100, remaining: 99, expiresAt: "2099-10-06" } } };
const offers: OfficialOffers = { product: "pometodo", salesEnabled: true, offers: [{ product: "pometodo", id: "offer-500", revision: 1, name: "500次", enabled: true, amountFen: 2500, currency: "CNY", benefit: { kind: "count", extractions: 500, validityDays: null }, termsVersion: "1" }] };

describe("整理按钮入口", () => {
  it("启用的自带Key直接整理，不被微信账号状态拦截", () => {
    expect(smartArrangeEntry({ preferences: { enabled: true, source: "byok" }, available: true, message: "" }, null)).toEqual({ label: "粘贴并整理", action: "arrange", tone: "primary", autoLogin: false });
  });
  it("已登录但服务暂停时按可售情况区分购买与暂不可用，不再显示含糊的状态文案", () => {
    expect(smartArrangeEntry(null, account, offers)).toEqual({ label: "购买次数", action: "purchase", tone: "primary", autoLogin: false });
    expect(smartArrangeEntry(null, account)).toEqual({ label: "暂不可用", action: "account", tone: "secondary", autoLogin: false });
  });
  it("只有明确未登录才提供一步扫码入口，读取未知不猜登录状态", () => {
    expect(smartArrangeEntry(null, { ...account, loggedIn: false, entitlement: null })).toEqual({ label: "绑定微信体验智能整理", action: "account", tone: "medium", autoLogin: true });
    expect(smartArrangeEntry(null, null).autoLogin).toBe(false);
    expect(smartArrangeEntry(null, null)).toEqual({ label: "暂不可用", action: "account", tone: "secondary", autoLogin: false });
  });
  it("已选择并启用但不可用的自带Key回设置，不强制切官方登录", () => {
    expect(smartArrangeEntry({ preferences: { enabled: true, source: "byok" }, available: false, message: "Key不可用" }, null)).toEqual({ label: "配置智能整理", action: "settings", tone: "secondary", autoLogin: false });
  });
  it("已登录有可用次数但未开启时给出直接启用入口", () => {
    const unclaimed = { ...account, entitlement: { ...account.entitlement!, trial: { ...account.entitlement!.trial, claimed: false } } };
    const usable = { ...account, entitlement: { ...account.entitlement!, canExtract: true } };
    expect(smartArrangeEntry(null, unclaimed, offers)).toEqual({ label: "启用智能整理", action: "enable", tone: "medium", autoLogin: false });
    expect(smartArrangeEntry(null, usable, offers)).toEqual({ label: "启用智能整理", action: "enable", tone: "medium", autoLogin: false });
  });
  it("销售关闭或目录为空时不算可售，已登录次数不足落到暂不可用", () => {
    expect(salesOpen(null)).toBe(false);
    expect(salesOpen({ product: "pometodo", salesEnabled: true, offers: [] })).toBe(false);
    expect(salesOpen({ product: "pometodo", salesEnabled: false, offers: offers.offers })).toBe(false);
    expect(smartArrangeEntry(null, account, { product: "pometodo", salesEnabled: false, offers: offers.offers })).toEqual({ label: "暂不可用", action: "account", tone: "secondary", autoLogin: false });
  });
});
