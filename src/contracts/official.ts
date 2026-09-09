import type { InvokeCommand } from "../native/todoServices";
import { nativeError } from "../native/todoServices";
export class OfficialServiceError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export interface Entitlement {
  product: "pometodo";
  trial: { claimed: boolean; total: number; remaining: number; expiresAt: string | null };
  paidRemaining: number;
  /** 已购次数购买总量（未含体验），供额度进度条计算比例。 */
  paidTotal: number;
  remaining: number; canExtract: boolean;
}
export interface OfficialAccount { configured: boolean; loggedIn: boolean; accountId: string | null; entitlement: Entitlement | null; message: string }
export interface OfficialLogin { status: "pending" | "confirmed" | "cancelled" | "expired"; qrCodeDataUrl: string | null; expiresAt: string | null; pollIntervalMs: number; account: OfficialAccount | null }
export type Benefit = { kind: "period"; months: number; extractionLimit: number } | { kind: "count"; extractions: number; validityDays: number | null };
export interface Offer { product: "pometodo"; id: string; revision: number; name: string; enabled: boolean; amountFen: number; currency: "CNY"; benefit: Benefit; termsVersion: string }
export interface OfficialOffers { product: "pometodo"; salesEnabled: boolean; offers: Offer[] }
export interface OfficialOrder { product: "pometodo"; orderNo: string; status: string; amountFen: number; currency: "CNY"; expiresAt: string; qrCodeDataUrl: string; snapshot: { product: "pometodo"; offerId: string; offerRevision: number; name: string; amountFen: number; currency: "CNY"; benefit: Benefit; termsVersion: string } }
export interface OfficialOrderStatus { orderNo: string; status: "created" | "paying" | "paid" | "closed" | "failed"; paid: boolean; entitlementGranted: boolean; amountFen: number; currency: "CNY"; expiresAt: string; paidAt: string | null }
export interface OfficialServices {
  account(): Promise<OfficialAccount>;
  begin(): Promise<OfficialLogin>;
  poll(): Promise<OfficialLogin>;
  cancel(): Promise<void>;
  trial(): Promise<Entitlement>;
  logout(): Promise<void>;
  offers(): Promise<OfficialOffers>;
  order(offerId: string): Promise<OfficialOrder>;
  pendingOrder(): Promise<OfficialOrder | null>;
  orderStatus(orderNo: string): Promise<OfficialOrderStatus>;
  cancelOrder(orderNo: string): Promise<{ orderNo: string; status: string }>;
}
export function createOfficialServices(invoke: InvokeCommand): OfficialServices {
  async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try { return await invoke<T>(`pometodo_official_${command}`, args); }
    catch (error) {
      if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" && "retryable" in error) throw new OfficialServiceError(error.message, error.retryable === true);
      throw nativeError(error);
    }
  }
  return { account: () => call("account"), begin: () => call("begin"), poll: () => call("poll"), cancel: () => call("cancel"), trial: () => call("trial"), logout: () => call("logout"), offers: () => call("offers"), order: offerId => call("order", { offerId }), pendingOrder: () => call("pending_order"), orderStatus: orderNo => call("order_status", { orderNo }), cancelOrder: orderNo => call("cancel_order", { orderNo }) };
}
