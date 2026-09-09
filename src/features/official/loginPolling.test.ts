import { expect, it } from "vitest";
import { nextLoginRetry } from "./loginPolling";
import { OfficialServiceError } from "../../contracts/official";

it("keeps the current ticket after transient failure only within its lifetime", () => {
  expect(nextLoginRetry(new OfficialServiceError("暂时断网", true), "2026-09-06T10:03:00Z", 1500, Date.parse("2026-09-06T10:01:00Z"))).toBe(3000);
  expect(nextLoginRetry(new OfficialServiceError("暂时断网", true), "2026-09-06T10:03:00Z", 8000, Date.parse("2026-09-06T10:01:00Z"))).toBe(10000);
  expect(nextLoginRetry(new OfficialServiceError("票据无效", false), "2026-09-06T10:03:00Z", 1500, Date.parse("2026-09-06T10:01:00Z"))).toBeNull();
  expect(nextLoginRetry(new OfficialServiceError("暂时断网", true), "2026-09-06T10:03:00Z", 1500, Date.parse("2026-09-06T10:03:00Z"))).toBeNull();
});
