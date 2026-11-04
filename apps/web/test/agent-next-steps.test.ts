/**
 * RedNest get_me next_steps: entitlement-aware guidance, no legacy credit
 * steps unless SANDCHEST_LEGACY_CREDITS_NEXT_STEPS is set.
 */
import { describe, expect, test } from "bun:test";
import { legacyCreditsNextStepsEnabled } from "@/server/agent/ops/account";
import { inputSchema } from "@/server/agent/schema";
import { OPERATIONS } from "@/server/agent/registry";

describe("legacy credits next_steps gate", () => {
  test("defaults off so RedNest mode never emits credit/payment steps via that path", () => {
    expect(legacyCreditsNextStepsEnabled({})).toBe(false);
    expect(legacyCreditsNextStepsEnabled({ SANDCHEST_LEGACY_CREDITS_NEXT_STEPS: "true" })).toBe(true);
    expect(legacyCreditsNextStepsEnabled({ SANDCHEST_LEGACY_CREDITS_NEXT_STEPS: "false" })).toBe(false);
  });
});

describe("MCP tool schemas (get_me and peers)", () => {
  test("tool names and empty get_me input schema stay stable", () => {
    const names = OPERATIONS.map((op) => op.name);
    expect(names).toContain("get_me");
    expect(names).toContain("start_deep_scan");
    const getMe = OPERATIONS.find((op) => op.name === "get_me")!;
    expect(inputSchema(getMe)).toMatchObject({ type: "object", properties: {} });
  });
});
