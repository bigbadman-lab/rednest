/**
 * RedNest entitlement service behaviour (holder fail-closed, error mapping).
 * Does not require Postgres.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EntitlementError, checkHolderEligibility, setHolderEligibilityProvider } from "@/server/entitlements";

afterEach(() => {
  setHolderEligibilityProvider(undefined);
});

describe("holder eligibility", () => {
  test("defaults to not_activated (pre-launch / fail-closed)", async () => {
    expect(await checkHolderEligibility("user-1")).toBe("not_activated");
  });

  test("test provider can return eligible without affecting production default after reset", async () => {
    setHolderEligibilityProvider(async (): Promise<"eligible"> => "eligible");
    expect(await checkHolderEligibility("user-1")).toBe("eligible");
    setHolderEligibilityProvider(undefined);
    expect(await checkHolderEligibility("user-1")).toBe("not_activated");
  });

  test("provider failures become unavailable", async () => {
    setHolderEligibilityProvider((): "eligible" => {
      throw new Error("rpc down");
    });
    expect(await checkHolderEligibility("user-1")).toBe("unavailable");
  });
});

describe("EntitlementError", () => {
  test("carries a stable code", () => {
    const error = new EntitlementError("quota_exhausted", "full");
    expect(error.code).toBe("quota_exhausted");
    expect(error.message).toBe("full");
  });
});
