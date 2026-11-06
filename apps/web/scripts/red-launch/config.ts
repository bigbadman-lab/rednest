/** Hard-locked production target for the $NEST launch CLI. */

export const LAUNCH_TEAM = "cope2";
export const LAUNCH_PROJECT = "rednest";
export const LAUNCH_ENVIRONMENT = "production" as const;
export const PRODUCTION_URL = "https://rednest.tech";
export const HEALTH_URL = `${PRODUCTION_URL}/api/health`;
/** Canonical production hostnames that must remain attached after launch deploys. */
export const PRODUCTION_ALIASES = ["rednest.tech", "www.rednest.tech"] as const;

export const ENV_MINT = "RED_TOKEN_MINT";
export const ENV_MINT_PUBLIC = "RED_MINT_PUBLIC";
export const ENV_HOLDER = "RED_HOLDER_SCANS_ENABLED";
export const ENV_RPC = "SOLANA_RPC_URL";

/** Local verification receipt — never stores RPC URLs or API keys. */
export const VERIFY_STATE_RELATIVE = ".red-launch/verify-result.json";

export const PUMP_COIN_URL = (mint: string) => `https://frontend-api-v3.pump.fun/coins-v2/${mint}`;
