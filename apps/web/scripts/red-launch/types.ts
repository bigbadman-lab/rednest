import type { RedBalanceResult } from "../../src/server/solana/red-balance";

export type EnvKey = "RED_TOKEN_MINT" | "RED_MINT_PUBLIC" | "RED_HOLDER_SCANS_ENABLED" | "SOLANA_RPC_URL";

export type EnvMap = {
  RED_TOKEN_MINT?: string | null;
  RED_MINT_PUBLIC?: string | null;
  RED_HOLDER_SCANS_ENABLED?: string | null;
  SOLANA_RPC_URL?: string | null;
  /** When a key cannot be read reliably (pull failed, etc.). */
  _unknown?: Partial<Record<EnvKey, true>>;
  /**
   * When Vercel `env pull` redacts a Secret as `[SENSITIVE]` (or equivalent).
   * The placeholder is never treated as the real value.
   */
  _protected?: Partial<Record<EnvKey, true>>;
};

export type DeploymentInfo = {
  id: string;
  url: string;
  readyState: string;
  target: string | null;
  createdAt?: number;
  /** Git SHA deployed when known. */
  gitSha?: string;
};

export type MintOnChain = {
  mint: string;
  decimals: number;
  tokenProgram: "spl-token" | "token-2022";
  tokenProgramId: string;
};

export type MintInspection = MintOnChain & {
  pumpFun: { verified: true; name?: string; symbol?: string } | { verified: false; reason: string };
};

export type VerifyReceipt = {
  mint: string;
  verifiedAt: string;
  eligibleWallet: string;
  ineligibleWallet: string;
  eligibleWholeTokens: string;
  ineligibleWholeTokens: string;
  decimals: number;
  tokenProgram: string;
  rpcConfigured: true;
  /** Production deployment id observed at verify time, when known. */
  deploymentId?: string;
};

export type VercelClient = {
  assertTarget(): Promise<{ team: string; project: string }>;
  /**
   * Fail-closed git cleanliness check. Call before any production env write so a
   * later deploy refusal cannot leave partial env mutations.
   */
  assertDeployableSource(): Promise<{ gitSha: string }>;
  readProductionEnv(): Promise<EnvMap>;
  setProductionEnv(name: string, value: string): Promise<void>;
  /**
   * One-time recovery: remove existing Production var (including Secrets) and
   * re-add as a readable Config (`--type config` / `--no-sensitive`). Never used
   * by prepare/register — only recover-mint after explicit operator approval.
   * If remove succeeds and add fails, throws with `partialRecovery: true`.
   */
  replaceProductionEnvAsConfig(name: string, value: string): Promise<void>;
  removeProductionEnv(name: string): Promise<void>;
  /** Deploys clean git HEAD only; refuses a dirty working tree. */
  deployProduction(): Promise<DeploymentInfo>;
  waitUntilReady(deployment: DeploymentInfo, timeoutMs?: number): Promise<DeploymentInfo>;
  /** Confirms https://rednest.tech (production alias) is Ready for this deploy. */
  verifyProductionAlias(deployment: DeploymentInfo): Promise<void>;
  latestProductionDeployment(): Promise<DeploymentInfo | null>;
};

/** Thrown when env rm succeeded but Config re-add did not. */
export type PartialMintRecoveryError = Error & { partialRecovery: true; envName: string };

export type SolanaClient = {
  inspectMint(mint: string, rpcUrl: string): Promise<MintOnChain | { error: string }>;
  checkBalance(input: {
    walletPubkey: string;
    mint: string;
    rpcUrl: string;
  }): Promise<RedBalanceResult>;
  /**
   * Confirms mint metadata and that holder balance queries succeed over RPC.
   * Fail-closed: RPC/malformed errors never count as success.
   */
  probeHolderInfrastructure(
    mint: string,
    rpcUrl: string,
  ): Promise<{ ok: true; mint: MintOnChain } | { ok: false; error: string }>;
};

export type PumpClient = {
  lookupCoin(mint: string): Promise<{ ok: true; name?: string; symbol?: string } | { ok: false; reason: string }>;
};

export type SiteClient = {
  health(): Promise<{ ok: boolean; body?: string }>;
  homepageHtml(): Promise<string>;
};

export type LaunchIO = {
  log: (line: string) => void;
  error: (line: string) => void;
  confirm: (prompt: string) => Promise<boolean>;
};

export type LaunchDeps = {
  vercel: VercelClient;
  solana: SolanaClient;
  pump: PumpClient;
  site: SiteClient;
  io: LaunchIO;
  /** Absolute path for verify receipt. */
  statePath: string;
  now: () => Date;
};

export type CommandResult = { ok: true; code: number; message?: string } | { ok: false; code: number; error: string };
