import { OfficialServiceError } from "../../contracts/official";
export function nextLoginRetry(error: unknown, expiresAt: string | null, interval: number, now: number): number | null {
  if (!(error instanceof OfficialServiceError) || !error.retryable || !expiresAt || !(Date.parse(expiresAt) > now)) return null;
  return Math.min(10000, Math.max(1000, interval) * 2);
}
