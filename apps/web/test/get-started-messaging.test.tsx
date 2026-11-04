import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GET_STARTED_READY_LEAD } from "@/lib/access-copy";

describe("get-started messaging", () => {
  test("ready lead matches the lifetime free scan and $RED-coming-soon model", () => {
    expect(GET_STARTED_READY_LEAD).toContain("Sign in with GitHub");
    expect(GET_STARTED_READY_LEAD).toContain("first security scan is free");
    expect(GET_STARTED_READY_LEAD).toContain("no payment details required");
    expect(GET_STARTED_READY_LEAD).toContain("After $RED launches");
    expect(GET_STARTED_READY_LEAD).toContain("eligible token holders can unlock additional monthly scans");
    expect(GET_STARTED_READY_LEAD).not.toMatch(/resets|subscription|Stripe|Autumn|\bjake\b|mapping|without billing/i);
  });

  test("recruit Credits step without billing renders the approved ready lead", () => {
    const source = readFileSync(join(import.meta.dir, "../src/components/recruit/recruit.tsx"), "utf8");
    expect(source).toContain("GET_STARTED_READY_LEAD");
    expect(source).not.toContain("This server runs without billing");
    expect(source).not.toContain("starts mapping");
  });
});
