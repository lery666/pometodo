import type { OfficialAccount, OfficialOffers } from "../../contracts/official";
import type { SmartArrangeSnapshot } from "../../contracts/smartArrange";

export type SmartArrangeEntryAction = "arrange" | "account" | "settings" | "enable" | "purchase";
export type SmartArrangeEntryTone = "primary" | "medium" | "secondary";

export interface SmartArrangeEntry { label: string; action: SmartArrangeEntryAction; tone: SmartArrangeEntryTone; autoLogin: boolean }

/** 服务端返回可售商品且至少一个启用时视为可购买。 */
export function salesOpen(offers: OfficialOffers | null): boolean {
  return Boolean(offers?.salesEnabled && offers.offers.some(offer => offer.enabled));
}

/**
 * 新增/编辑页右上角智能整理入口的状态。
 * 依次判断：已可用 → 自带 Key 需处理 → 未登录 → 可直接启用 → 可购买 → 暂不可用。
 * offers 只有登录后才有数据；次数不足且拿不到可售商品时按服务暂不可用处理。
 */
export function smartArrangeEntry(snapshot: SmartArrangeSnapshot | null, account: OfficialAccount | null, offers: OfficialOffers | null = null): SmartArrangeEntry {
  if (snapshot?.available) return { label: "粘贴并整理", action: "arrange", tone: "primary", autoLogin: false };
  if (snapshot?.preferences.enabled && snapshot.preferences.source === "byok") return { label: "配置智能整理", action: "settings", tone: "secondary", autoLogin: false };
  if (account?.loggedIn === false && account.configured) return { label: "绑定微信体验智能整理", action: "account", tone: "medium", autoLogin: true };
  if (account?.entitlement && (!account.entitlement.trial.claimed || account.entitlement.canExtract)) return { label: "启用智能整理", action: "enable", tone: "medium", autoLogin: false };
  if (account?.loggedIn && salesOpen(offers)) return { label: "购买次数", action: "purchase", tone: "primary", autoLogin: false };
  return { label: "暂不可用", action: "account", tone: "secondary", autoLogin: false };
}
