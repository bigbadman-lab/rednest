import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@/server/solana/red-balance";
import { parseArgs } from "../scripts/red-launch/args";
import { runLaunch } from "../scripts/red-launch/cli";
import {
  cmdActivate,
  cmdDisable,
  cmdPrepare,
  cmdPublish,
  cmdRegister,
  cmdStatus,
  cmdVerify,
} from "../scripts/red-launch/commands";
import { RPC_PROBE_WALLET } from "../scripts/red-launch/solana";
import type { EnvMap, LaunchDeps, MintOnChain } from "../scripts/red-launch/types";
import { requireCleanApprovedRevision } from "../scripts/red-launch/source";
import { evaluateProductionAlias, parseEnvFile } from "../scripts/red-launch/vercel";

async function sampleMint(): Promise<string> {
  return (await Keypair.generate()).publicKey.toBase58();
}

function createHarness(init: {
  env?: EnvMap;
  assertError?: string;
  /** When true, assertDeployableSource fails (simulates dirty tree / untracked files). */
  dirtyWorkingTree?: boolean;
  deployFails?: boolean;
  healthOk?: boolean;
  homepage?: string;
  mintOnChain?: MintOnChain | { error: string };
  pumpOk?: boolean;
  rpcProbeFails?: boolean;
  balances?: Record<string, { whole: bigint; eligible: boolean } | { error: string }>;
}) {
  const env: EnvMap = {
    RED_TOKEN_MINT: null,
    RED_MINT_PUBLIC: null,
    RED_HOLDER_SCANS_ENABLED: null,
    SOLANA_RPC_URL: "https://example-rpc.test",
    ...init.env,
  };
  const sets: Array<{ name: string; value: string }> = [];
  const state = { deploys: 0 };
  const stateDir = mkdtempSync(join(tmpdir(), "red-launch-test-"));
  const statePath = join(stateDir, "verify-result.json");
  const logs: string[] = [];
  const mintDefault: MintOnChain = {
    mint: "placeholder",
    decimals: 6,
    tokenProgram: "spl-token",
    tokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
  };

  const deps: LaunchDeps = {
    vercel: {
      async assertTarget() {
        if (init.assertError) throw new Error(init.assertError);
        return { team: "cope2", project: "rednest" };
      },
      async assertDeployableSource() {
        if (init.dirtyWorkingTree) {
          throw new Error(
            "Working tree is dirty. Commit or stash changes so the launch CLI deploys the approved git revision only.",
          );
        }
        return { gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
      },
      async readProductionEnv() {
        return { ...env, _unknown: env._unknown ? { ...env._unknown } : undefined, _protected: env._protected ? { ...env._protected } : undefined };
      },
      async setProductionEnv(name, value) {
        if (env._protected?.[name as keyof NonNullable<EnvMap["_protected"]>]) {
          throw new Error(`Existing ${name} is protected (Vercel Secret / [SENSITIVE] on pull). Refuse to overwrite automatically`);
        }
        if (env._unknown?.[name as keyof NonNullable<EnvMap["_unknown"]>]) {
          throw new Error(`Existing ${name} is unreadable; refuse to overwrite automatically.`);
        }
        sets.push({ name, value });
        (env as Record<string, string | null>)[name] = value;
      },
      async removeProductionEnv(name) {
        (env as Record<string, string | null>)[name] = null;
      },
      async deployProduction() {
        state.deploys++;
        if (init.deployFails) throw new Error("deploy exploded");
        return {
          id: "dpl_test",
          url: "https://rednest-test.vercel.app",
          readyState: "READY",
          target: "production",
          gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        };
      },
      async waitUntilReady(d) {
        return { ...d, readyState: "READY" };
      },
      async verifyProductionAlias() {
        // Harness assumes alias verification succeeded unless deployFails.
      },
      async latestProductionDeployment() {
        return { id: "dpl_latest", url: "https://rednest-test.vercel.app", readyState: "READY", target: "production" };
      },
    },
    solana: {
      async inspectMint(raw) {
        if (init.mintOnChain && "error" in init.mintOnChain) return init.mintOnChain;
        const base = init.mintOnChain ?? mintDefault;
        return { ...base, mint: raw };
      },
      async checkBalance({ walletPubkey }) {
        const row = init.balances?.[walletPubkey];
        if (!row) {
          // Default empty successful probe for infrastructure checks.
          if (walletPubkey === RPC_PROBE_WALLET) {
            if (init.rpcProbeFails) return { ok: false, reason: "rpc_error" };
            return { ok: true, rawAmount: 0n, decimals: 6, wholeTokens: 0n, eligible: false };
          }
          return { ok: false, reason: "rpc_error" };
        }
        if ("error" in row) return { ok: false, reason: row.error as "rpc_error" };
        return {
          ok: true,
          rawAmount: row.whole * 1_000_000n,
          decimals: 6,
          wholeTokens: row.whole,
          eligible: row.eligible,
        };
      },
      async probeHolderInfrastructure(mintRaw, rpcUrl) {
        if (init.rpcProbeFails) return { ok: false, error: "rpc_probe_failed:rpc_error" };
        const onChain = await this.inspectMint(mintRaw, rpcUrl);
        if ("error" in onChain) return { ok: false, error: onChain.error };
        const probe = await this.checkBalance({ walletPubkey: RPC_PROBE_WALLET, mint: onChain.mint, rpcUrl });
        if (!probe.ok) return { ok: false, error: `rpc_probe_failed:${probe.reason}` };
        return { ok: true, mint: onChain };
      },
    },
    pump: {
      async lookupCoin() {
        if (init.pumpOk === false) return { ok: false, reason: "not_found_on_pump_fun" };
        return { ok: true, name: "RED", symbol: "RED" };
      },
    },
    site: {
      async health() {
        return { ok: init.healthOk !== false };
      },
      async homepageHtml() {
        return init.homepage ?? "Official mint address coming soon. Token-holder scanning is not active yet.";
      },
    },
    io: {
      log: (l) => logs.push(l),
      error: (l) => logs.push(`ERR:${l}`),
      confirm: async () => true,
    },
    statePath,
    now: () => new Date("2026-11-04T19:00:00.000Z"),
  };

  return { deps, env, sets, state, stateDir, statePath, logs };
}

describe("parseArgs", () => {
  test("rejects unknown commands and flags", () => {
    expect(parseArgs(["nope"]).ok).toBe(false);
    expect(parseArgs(["register", "--mint", "x", "--force"]).ok).toBe(false);
    expect(parseArgs(["status", "--dry-run"]).ok).toBe(false);
  });

  test("parses mutating flags", () => {
    const r = parseArgs(["register", "--mint", "Abc", "--dry-run", "--yes"]);
    expect(r).toMatchObject({ ok: true, command: "register", mint: "Abc", dryRun: true, yes: true });
    const p = parseArgs(["prepare", "--mint", "Def", "--dry-run", "--yes"]);
    expect(p).toMatchObject({ ok: true, command: "prepare", mint: "Def", dryRun: true, yes: true });
  });

  test("prepare requires --mint", () => {
    expect(parseArgs(["prepare"]).ok).toBe(false);
  });
});

describe("parseEnvFile", () => {
  test("reads only launch keys", () => {
    const env = parseEnvFile(`RED_TOKEN_MINT=Mint111\nSOLANA_RPC_URL=https://secret/key\nOTHER=1\n`);
    expect(env.RED_TOKEN_MINT).toBe("Mint111");
    expect(env.SOLANA_RPC_URL).toContain("secret");
    expect(env.RED_MINT_PUBLIC).toBeNull();
  });

  test("never treats [SENSITIVE] as a real mint or flag value", () => {
    const env = parseEnvFile(
      `RED_TOKEN_MINT="[SENSITIVE]"\nRED_MINT_PUBLIC=[SENSITIVE]\nRED_HOLDER_SCANS_ENABLED=false\nSOLANA_RPC_URL="[SENSITIVE]"\n`,
    );
    expect(env.RED_TOKEN_MINT).toBeNull();
    expect(env._protected?.RED_TOKEN_MINT).toBe(true);
    expect(env._protected?.RED_MINT_PUBLIC).toBe(true);
    expect(env._protected?.SOLANA_RPC_URL).toBe(true);
    expect(env.RED_HOLDER_SCANS_ENABLED).toBe("false");
    expect(env._protected?.RED_HOLDER_SCANS_ENABLED).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/\[SENSITIVE\]/);
  });
});

describe("protected mint status and overwrite refusal", () => {
  test("status reports protected mint, not invalid pubkey", async () => {
    const h = createHarness({
      env: {
        RED_TOKEN_MINT: null,
        RED_MINT_PUBLIC: null,
        RED_HOLDER_SCANS_ENABLED: null,
        SOLANA_RPC_URL: "https://rpc.test",
        _protected: { RED_TOKEN_MINT: true },
      },
    });
    const result = await cmdStatus(h.deps);
    expect(result.ok).toBe(true);
    expect(h.logs.some((l) => /RED_TOKEN_MINT: configured \(protected/.test(l))).toBe(true);
    expect(h.logs.some((l) => /invalid pubkey/.test(l))).toBe(false);
    expect(h.logs.some((l) => /\[SENSITIVE\]/.test(l))).toBe(false);
  });

  test("prepare refuses when existing mint is protected without writing", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: {
        RED_TOKEN_MINT: null,
        RED_MINT_PUBLIC: null,
        RED_HOLDER_SCANS_ENABLED: null,
        SOLANA_RPC_URL: "https://rpc.test",
        _protected: { RED_TOKEN_MINT: true },
      },
      mintOnChain: { error: "account_absent" },
    });
    const result = await cmdPrepare(h.deps, { mint, dryRun: false, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/protected|Refuse to overwrite/i);
    expect(h.sets).toEqual([]);
    expect(h.state.deploys).toBe(0);
  });
});

describe("cleanliness before env writes", () => {
  test("prepare refuses dirty working tree before any production env write", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      dirtyWorkingTree: true,
      mintOnChain: { error: "account_absent" },
    });
    const result = await cmdPrepare(h.deps, { mint, dryRun: false, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/dirty/i);
    expect(h.sets).toEqual([]);
    expect(h.state.deploys).toBe(0);
  });

  test("partial deploy failure after a successful mint write is reported without flipping publish/holder flags", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      mintOnChain: { error: "account_absent" },
      deployFails: true,
      homepage: "Official mint address coming soon. Token-holder scanning is not active yet.",
    });
    const result = await cmdPrepare(h.deps, { mint, dryRun: false, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Prepare failed|deploy/i);
    expect(h.sets.some((s) => s.name === "RED_TOKEN_MINT" && s.value === mint)).toBe(true);
    expect(h.sets.some((s) => s.name === "RED_MINT_PUBLIC" || s.name === "RED_HOLDER_SCANS_ENABLED")).toBe(false);
    expect(h.env.RED_MINT_PUBLIC).toBeNull();
    expect(h.env.RED_HOLDER_SCANS_ENABLED).toBeNull();
  });
});

describe("status", () => {
  test("reports unknown vs configured without printing RPC secrets", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: {
        RED_TOKEN_MINT: mint,
        RED_MINT_PUBLIC: "false",
        RED_HOLDER_SCANS_ENABLED: null,
        SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=SUPERSECRET",
      },
    });
    const result = await cmdStatus(h.deps);
    expect(result.ok).toBe(true);
    expect(h.logs.some((l) => l.includes("SUPERSECRET"))).toBe(false);
    expect(h.logs.some((l) => /SOLANA_RPC_URL: configured/.test(l))).toBe(true);
  });

  test("fails closed on wrong Vercel project", async () => {
    const h = createHarness({ assertError: 'Fail-closed: project "rednest" not found under team "cope2".' });
    const result = await cmdStatus(h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Fail-closed");
  });
});

describe("prepare", () => {
  test("accepts valid reserved address when on-chain mint is absent", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      mintOnChain: { error: "account_absent" },
      homepage: "Official mint address coming soon. Token-holder scanning is not active yet.",
    });
    const dry = await cmdPrepare(h.deps, { mint, dryRun: true, yes: true });
    expect(dry.ok).toBe(true);
    expect(h.sets).toEqual([]);
    expect(h.state.deploys).toBe(0);

    const live = await cmdPrepare(h.deps, { mint, dryRun: false, yes: true });
    expect(live.ok).toBe(true);
    expect(h.sets.some((s) => s.name === "RED_TOKEN_MINT" && s.value === mint)).toBe(true);
    expect(h.env.RED_HOLDER_SCANS_ENABLED).toBeNull();
    expect(h.env.RED_MINT_PUBLIC).toBeNull();
    expect(h.logs.some((l) => /NOT live|not live|prelaunch/i.test(l))).toBe(true);
  });

  test("rejects invalid reserved address", async () => {
    const h = createHarness({ mintOnChain: { error: "account_absent" } });
    const result = await cmdPrepare(h.deps, { mint: "not-a-mint", dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Invalid reserved mint|public key/i);
  });

  test("rejects conflicting registered mint", async () => {
    const a = await sampleMint();
    const b = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: a, SOLANA_RPC_URL: "https://rpc.test", RED_MINT_PUBLIC: null, RED_HOLDER_SCANS_ENABLED: null },
      mintOnChain: { error: "account_absent" },
    });
    const result = await cmdPrepare(h.deps, { mint: b, dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Conflicting mint/);
  });

  test("rejects existing non-mint account", async () => {
    const mint = await sampleMint();
    const h = createHarness({ mintOnChain: { error: "not_a_mint" } });
    const result = await cmdPrepare(h.deps, { mint, dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a mint account/i);
  });

  test("rejects when on-chain mint already exists (use register)", async () => {
    const mint = await sampleMint();
    const h = createHarness({});
    const result = await cmdPrepare(h.deps, { mint, dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/already exists|use `register`/i);
  });

  test("RPC failure blocks prepare", async () => {
    const mint = await sampleMint();
    const h = createHarness({ mintOnChain: { error: "rpc_error" } });
    const result = await cmdPrepare(h.deps, { mint, dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/RPC failed/i);
  });

  test("dry-run never mutates production", async () => {
    const mint = await sampleMint();
    const h = createHarness({ mintOnChain: { error: "account_absent" } });
    const result = await cmdPrepare(h.deps, { mint, dryRun: true, yes: true });
    expect(result.ok).toBe(true);
    expect(h.sets).toEqual([]);
    expect(h.state.deploys).toBe(0);
  });

  test("keeps holder access disabled after prepare", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      mintOnChain: { error: "account_absent" },
      homepage: "Official mint address coming soon. Token-holder scanning is not active yet.",
    });
    const result = await cmdPrepare(h.deps, { mint, dryRun: false, yes: true });
    expect(result.ok).toBe(true);
    expect(flagPresenceLike(h.env.RED_HOLDER_SCANS_ENABLED)).not.toBe("true");
    expect(h.sets.every((s) => s.name === "RED_TOKEN_MINT")).toBe(true);
    expect(h.sets.some((s) => s.name === "RED_MINT_PUBLIC" || s.name === "RED_HOLDER_SCANS_ENABLED")).toBe(false);
  });

  test("refuses when RED_MINT_PUBLIC is already true", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: {
        RED_TOKEN_MINT: null,
        RED_MINT_PUBLIC: "true",
        RED_HOLDER_SCANS_ENABLED: null,
        SOLANA_RPC_URL: "https://rpc.test",
      },
      mintOnChain: { error: "account_absent" },
    });
    const result = await cmdPrepare(h.deps, { mint, dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/RED_MINT_PUBLIC is true/i);
    expect(h.sets).toEqual([]);
    expect(h.state.deploys).toBe(0);
  });

  test("refuses when RED_HOLDER_SCANS_ENABLED is already true", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: {
        RED_TOKEN_MINT: null,
        RED_MINT_PUBLIC: null,
        RED_HOLDER_SCANS_ENABLED: "true",
        SOLANA_RPC_URL: "https://rpc.test",
      },
      mintOnChain: { error: "account_absent" },
    });
    const result = await cmdPrepare(h.deps, { mint, dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/RED_HOLDER_SCANS_ENABLED is true/i);
    expect(h.sets).toEqual([]);
    expect(h.state.deploys).toBe(0);
  });

  test("fails closed when publish or holder flags are unreadable", async () => {
    const mint = await sampleMint();
    const hPublic = createHarness({
      env: {
        RED_TOKEN_MINT: null,
        RED_MINT_PUBLIC: null,
        RED_HOLDER_SCANS_ENABLED: null,
        SOLANA_RPC_URL: "https://rpc.test",
        _unknown: { RED_MINT_PUBLIC: true },
      },
      mintOnChain: { error: "account_absent" },
    });
    const pubUnknown = await cmdPrepare(hPublic.deps, { mint, dryRun: true, yes: true });
    expect(pubUnknown.ok).toBe(false);
    if (!pubUnknown.ok) expect(pubUnknown.error).toMatch(/RED_MINT_PUBLIC is unknown/i);
    expect(hPublic.sets).toEqual([]);

    const hHolders = createHarness({
      env: {
        RED_TOKEN_MINT: null,
        RED_MINT_PUBLIC: null,
        RED_HOLDER_SCANS_ENABLED: null,
        SOLANA_RPC_URL: "https://rpc.test",
        _unknown: { RED_HOLDER_SCANS_ENABLED: true },
      },
      mintOnChain: { error: "account_absent" },
    });
    const holdersUnknown = await cmdPrepare(hHolders.deps, { mint, dryRun: true, yes: true });
    expect(holdersUnknown.ok).toBe(false);
    if (!holdersUnknown.ok) expect(holdersUnknown.error).toMatch(/RED_HOLDER_SCANS_ENABLED is unknown/i);
    expect(hHolders.sets).toEqual([]);
  });
});

function flagPresenceLike(value: string | null | undefined): string {
  if (value == null || value === "") return "absent";
  return value.trim().toLowerCase() === "true" ? "true" : "false";
}

describe("register", () => {
  test("rejects invalid mint", async () => {
    const h = createHarness({});
    const result = await cmdRegister(h.deps, { mint: "not-a-mint", dryRun: true, yes: true });
    expect(result.ok).toBe(false);
  });

  test("rejects missing RPC", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { SOLANA_RPC_URL: null, RED_TOKEN_MINT: null, RED_MINT_PUBLIC: null, RED_HOLDER_SCANS_ENABLED: null },
    });
    const result = await cmdRegister(h.deps, { mint, dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/SOLANA_RPC_URL/);
  });

  test("rejects conflicting existing mint", async () => {
    const a = await sampleMint();
    const b = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: a, SOLANA_RPC_URL: "https://rpc.test", RED_MINT_PUBLIC: null, RED_HOLDER_SCANS_ENABLED: null },
    });
    const result = await cmdRegister(h.deps, { mint: b, dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Conflicting mint/);
  });

  test("rejects when Pump.fun verification fails", async () => {
    const mint = await sampleMint();
    const h = createHarness({ pumpOk: false });
    const result = await cmdRegister(h.deps, { mint, dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pump_fun_unverified/);
  });

  test("supports Token-2022 mint program label", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      mintOnChain: {
        mint,
        decimals: 6,
        tokenProgram: "token-2022",
        tokenProgramId: TOKEN_2022_PROGRAM_ID.toBase58(),
      },
    });
    const result = await cmdRegister(h.deps, { mint, dryRun: true, yes: true });
    expect(result.ok).toBe(true);
    expect(h.logs.some((l) => /token-2022/.test(l))).toBe(true);
  });

  test("dry-run does not write env or deploy", async () => {
    const mint = await sampleMint();
    const h = createHarness({});
    const result = await cmdRegister(h.deps, { mint, dryRun: true, yes: true });
    expect(result.ok).toBe(true);
    expect(h.sets).toEqual([]);
    expect(h.state.deploys).toBe(0);
  });

  test("idempotent when same mint already registered", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, SOLANA_RPC_URL: "https://rpc.test", RED_MINT_PUBLIC: null, RED_HOLDER_SCANS_ENABLED: null },
      homepage: "Official mint address coming soon. Token-holder scanning is not active yet.",
    });
    const result = await cmdRegister(h.deps, { mint, dryRun: false, yes: true });
    expect(result.ok).toBe(true);
    expect(h.sets.filter((s) => s.name === "RED_TOKEN_MINT")).toEqual([]);
    expect(h.state.deploys).toBe(1);
  });

  test("reports partial state when deploy fails", async () => {
    const mint = await sampleMint();
    const h = createHarness({ deployFails: true });
    const result = await cmdRegister(h.deps, { mint, dryRun: false, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Register failed|deploy/i);
  });

  test("reports partial state when health fails after deploy", async () => {
    const mint = await sampleMint();
    const h = createHarness({ healthOk: false });
    const result = await cmdRegister(h.deps, { mint, dryRun: false, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/health/i);
  });
});

describe("publish", () => {
  test("requires registered mint", async () => {
    const h = createHarness({
      env: { RED_TOKEN_MINT: null, SOLANA_RPC_URL: "https://rpc.test", RED_MINT_PUBLIC: null, RED_HOLDER_SCANS_ENABLED: null },
    });
    const result = await cmdPublish(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(false);
  });

  test("dry-run publish", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, SOLANA_RPC_URL: "https://rpc.test", RED_MINT_PUBLIC: null, RED_HOLDER_SCANS_ENABLED: null },
    });
    const result = await cmdPublish(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(true);
    expect(h.state.deploys).toBe(0);
  });

  test("verifies homepage mint + solscan and holders still off", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, SOLANA_RPC_URL: "https://rpc.test", RED_MINT_PUBLIC: null, RED_HOLDER_SCANS_ENABLED: "false" },
      homepage: `Official $RED mint ${mint} https://solscan.io/token/${mint} Token-holder scanning is not active yet. $RED has not launched yet`,
    });
    const result = await cmdPublish(h.deps, { dryRun: false, yes: true });
    expect(result.ok).toBe(true);
    expect(h.sets.some((s) => s.name === "RED_MINT_PUBLIC" && s.value === "true")).toBe(true);
    expect(h.env.RED_HOLDER_SCANS_ENABLED).toBe("false");
  });

  test("publication of reserved mint keeps prelaunch wording", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, SOLANA_RPC_URL: "https://rpc.test", RED_MINT_PUBLIC: null, RED_HOLDER_SCANS_ENABLED: null },
      mintOnChain: { error: "account_absent" },
      homepage: `Official $RED mint ${mint} https://solscan.io/token/${mint} This mint address is reserved. $RED has not launched yet — holder scanning stays disabled until activation. Token-holder scanning is not active yet.`,
    });
    const result = await cmdPublish(h.deps, { dryRun: false, yes: true });
    expect(result.ok).toBe(true);
    expect(h.logs.some((l) => /has not launched|reserved/i.test(l))).toBe(true);
    expect(h.env.RED_HOLDER_SCANS_ENABLED).toBeNull();
  });
});

describe("verify", () => {
  test("fails when ineligible wallet is eligible", async () => {
    const mint = await sampleMint();
    const eligible = await sampleMint();
    const ineligible = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, SOLANA_RPC_URL: "https://rpc.test", RED_MINT_PUBLIC: "true", RED_HOLDER_SCANS_ENABLED: null },
      balances: {
        [eligible]: { whole: 50_000n, eligible: true },
        [ineligible]: { whole: 50_000n, eligible: true },
      },
    });
    const result = await cmdVerify(h.deps, { eligible, ineligible });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Stage C verification failed/);
  });

  test("writes receipt when both wallets pass", async () => {
    const mint = await sampleMint();
    const eligible = await sampleMint();
    const ineligible = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, SOLANA_RPC_URL: "https://rpc.test", RED_MINT_PUBLIC: "true", RED_HOLDER_SCANS_ENABLED: null },
      balances: {
        [eligible]: { whole: 50_000n, eligible: true },
        [ineligible]: { whole: 1n, eligible: false },
      },
    });
    const result = await cmdVerify(h.deps, { eligible, ineligible });
    expect(result.ok).toBe(true);
    const receipt = JSON.parse(readFileSync(h.statePath, "utf8"));
    expect(receipt.mint).toBe(mint);
    expect(receipt.rpcConfigured).toBe(true);
    expect(JSON.stringify(receipt)).not.toMatch(/helius|api-key|https?:\/\//i);
    rmSync(h.stateDir, { recursive: true, force: true });
  });
});

describe("activate", () => {
  test("succeeds without Stage C receipt when infrastructure prerequisites pass", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, RED_MINT_PUBLIC: "true", SOLANA_RPC_URL: "https://rpc.test", RED_HOLDER_SCANS_ENABLED: null },
      pumpOk: true,
    });
    const dry = await cmdActivate(h.deps, { dryRun: true, yes: true });
    expect(dry.ok).toBe(true);
    expect(h.state.deploys).toBe(0);

    const live = await cmdActivate(h.deps, { dryRun: false, yes: true });
    expect(live.ok).toBe(true);
    expect(h.sets.some((s) => s.name === "RED_HOLDER_SCANS_ENABLED" && s.value === "true")).toBe(true);
    expect(h.state.deploys).toBe(1);
  });

  test("activation before token creation is rejected", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, RED_MINT_PUBLIC: "true", SOLANA_RPC_URL: "https://rpc.test", RED_HOLDER_SCANS_ENABLED: null },
      mintOnChain: { error: "account_absent" },
    });
    const result = await cmdActivate(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not exist yet|account_absent|create the Pump\.fun/i);
    expect(h.sets).toEqual([]);
  });

  test("activation after valid Pump.fun mint creation is permitted", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, RED_MINT_PUBLIC: "true", SOLANA_RPC_URL: "https://rpc.test", RED_HOLDER_SCANS_ENABLED: null },
      pumpOk: true,
    });
    const result = await cmdActivate(h.deps, { dryRun: false, yes: true });
    expect(result.ok).toBe(true);
    expect(h.env.RED_HOLDER_SCANS_ENABLED).toBe("true");
  });

  test("Pump.fun verification failure blocks activation", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, RED_MINT_PUBLIC: "true", SOLANA_RPC_URL: "https://rpc.test", RED_HOLDER_SCANS_ENABLED: null },
      pumpOk: false,
    });
    const result = await cmdActivate(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/pump_fun_unverified|Activation prerequisites/i);
  });

  test("missing canonical mint blocks activation", async () => {
    const h = createHarness({
      env: { RED_TOKEN_MINT: null, RED_MINT_PUBLIC: "true", SOLANA_RPC_URL: "https://rpc.test", RED_HOLDER_SCANS_ENABLED: null },
    });
    const result = await cmdActivate(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not registered/i);
  });

  test("invalid mint blocks activation", async () => {
    const h = createHarness({
      env: { RED_TOKEN_MINT: "not-a-mint", RED_MINT_PUBLIC: "true", SOLANA_RPC_URL: "https://rpc.test", RED_HOLDER_SCANS_ENABLED: null },
    });
    const result = await cmdActivate(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not registered|invalid/i);
  });

  test("missing RPC blocks activation", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, RED_MINT_PUBLIC: "true", SOLANA_RPC_URL: null, RED_HOLDER_SCANS_ENABLED: null },
    });
    const result = await cmdActivate(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/SOLANA_RPC_URL/);
  });

  test("RPC errors block activation", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, RED_MINT_PUBLIC: "true", SOLANA_RPC_URL: "https://rpc.test", RED_HOLDER_SCANS_ENABLED: null },
      rpcProbeFails: true,
    });
    const result = await cmdActivate(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/rpc_probe_failed|Infrastructure/i);
  });

  test("wrong Vercel project blocks activation", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      assertError: 'Fail-closed: project "rednest" not found under team "cope2".',
      env: { RED_TOKEN_MINT: mint, RED_MINT_PUBLIC: "true", SOLANA_RPC_URL: "https://rpc.test", RED_HOLDER_SCANS_ENABLED: null },
    });
    const result = await cmdActivate(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Fail-closed");
  });

  test("dry-run never mutates production", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: { RED_TOKEN_MINT: mint, RED_MINT_PUBLIC: "true", SOLANA_RPC_URL: "https://rpc.test", RED_HOLDER_SCANS_ENABLED: null },
    });
    const result = await cmdActivate(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(true);
    expect(h.sets).toEqual([]);
    expect(h.state.deploys).toBe(0);
  });

  test("repeated activation is idempotent", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: {
        RED_TOKEN_MINT: mint,
        RED_MINT_PUBLIC: "true",
        SOLANA_RPC_URL: "https://rpc.test",
        RED_HOLDER_SCANS_ENABLED: "true",
      },
    });
    const result = await cmdActivate(h.deps, { dryRun: false, yes: true });
    expect(result.ok).toBe(true);
    expect(h.logs.some((l) => /already true \(idempotent\)/.test(l))).toBe(true);
    expect(h.env.RED_HOLDER_SCANS_ENABLED).toBe("true");
  });
});

describe("disable", () => {
  test("sets holder flag false and leaves mint/publish alone", async () => {
    const mint = await sampleMint();
    const h = createHarness({
      env: {
        RED_TOKEN_MINT: mint,
        RED_MINT_PUBLIC: "true",
        RED_HOLDER_SCANS_ENABLED: "true",
        SOLANA_RPC_URL: "https://rpc.test",
      },
    });
    const result = await cmdDisable(h.deps, { dryRun: false, yes: true });
    expect(result.ok).toBe(true);
    expect(h.env.RED_HOLDER_SCANS_ENABLED).toBe("false");
    expect(h.env.RED_TOKEN_MINT).toBe(mint);
    expect(h.env.RED_MINT_PUBLIC).toBe("true");
  });

  test("idempotent when already disabled", async () => {
    const h = createHarness({
      env: {
        RED_TOKEN_MINT: await sampleMint(),
        RED_MINT_PUBLIC: "true",
        RED_HOLDER_SCANS_ENABLED: "false",
        SOLANA_RPC_URL: "https://rpc.test",
      },
    });
    const result = await cmdDisable(h.deps, { dryRun: false, yes: true });
    expect(result.ok).toBe(true);
    expect(h.state.deploys).toBe(1);
  });

  test("dry-run disable writes nothing", async () => {
    const h = createHarness({
      env: {
        RED_TOKEN_MINT: await sampleMint(),
        RED_MINT_PUBLIC: "true",
        RED_HOLDER_SCANS_ENABLED: "true",
        SOLANA_RPC_URL: "https://rpc.test",
      },
    });
    const result = await cmdDisable(h.deps, { dryRun: true, yes: true });
    expect(result.ok).toBe(true);
    expect(h.sets).toEqual([]);
    expect(h.state.deploys).toBe(0);
  });
});

describe("runLaunch entry", () => {
  test("status via argv", async () => {
    const h = createHarness({});
    const code = await runLaunch(["status"], h.deps);
    expect(code).toBe(0);
  });
});

describe("approved source revision", () => {
  test("refuses dirty working trees", () => {
    expect(() => requireCleanApprovedRevision({ sha: "a".repeat(40), short: "aaaaaaa", clean: false })).toThrow(/dirty/i);
    expect(requireCleanApprovedRevision({ sha: "b".repeat(40), short: "bbbbbbb", clean: true })).toBe("b".repeat(40));
  });
});

describe("production alias verification", () => {
  test("requires Ready + rednest.tech alias", () => {
    const deployment = {
      id: "dpl_1",
      url: "https://rednest-abc.vercel.app",
      readyState: "READY",
      target: "production",
    };
    expect(
      evaluateProductionAlias(
        { readyState: "READY", aliases: ["rednest.tech", "rednest-abc.vercel.app"], url: "https://rednest-abc.vercel.app" },
        deployment,
      ).ok,
    ).toBe(true);
    expect(evaluateProductionAlias({ readyState: "ERROR", aliases: ["rednest.tech"] }, deployment).ok).toBe(false);
    expect(evaluateProductionAlias({ readyState: "READY", aliases: ["other.example"] }, deployment).ok).toBe(false);
    expect(
      evaluateProductionAlias(
        { readyState: "READY", aliases: ["rednest.tech", "rednest-other.vercel.app"], url: "https://rednest-other.vercel.app" },
        deployment,
      ).ok,
    ).toBe(false);
  });
});
