import { describe, expect, it } from "vitest";
import { activeOrder, orderExpired } from "./officialController";
import type { OfficialOrder } from "../../contracts/official";

function order(status: string, expiresAt: string): OfficialOrder {
  return {
    product: "pometodo", orderNo: "TEST", status, amountFen: 2500, currency: "CNY", expiresAt,
    qrCodeDataUrl: "data:image/png;base64,x",
    snapshot: { product: "pometodo", offerId: "o", offerRevision: 1, name: "测试", amountFen: 2500, currency: "CNY", benefit: { kind: "count", extractions: 500, validityDays: null }, termsVersion: "1" },
  };
}

describe("订单活跃判定", () => {
  it("已结束与已过期的订单不再视为活跃（残留订单不展示二维码）", () => {
    const now = Date.now();
    expect(activeOrder(order("created", new Date(now + 60_000).toISOString()))).toBe(true);
    expect(activeOrder(order("created", new Date(now - 1_000).toISOString()))).toBe(false);
    expect(activeOrder(order("closed", new Date(now + 60_000).toISOString()))).toBe(false);
    expect(activeOrder(order("paid", new Date(now + 60_000).toISOString()))).toBe(false);
    expect(activeOrder(null)).toBe(false);
  });

  it("orderExpired 仅按有效期判断", () => {
    const now = Date.now();
    expect(orderExpired(order("created", new Date(now - 1_000).toISOString()))).toBe(true);
    expect(orderExpired(order("created", new Date(now + 60_000).toISOString()))).toBe(false);
  });
});
