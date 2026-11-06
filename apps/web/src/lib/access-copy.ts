/**
 * Public access messaging shared by get-started and the homepage $NEST section.
 * Keep wording aligned with /docs/pricing: one lifetime free scan, then $NEST holders.
 */

/** Final get-started “You’re ready” lead when hosted billing is off (production RedNest). */
export const GET_STARTED_READY_LEAD =
  "Sign in with GitHub to start securing your repositories. Your first security scan is free, with no payment details required. Eligible $NEST holders unlock additional monthly scans with a verified Solana wallet.";

export const FREE_ACCESS_SUMMARY =
  "One lifetime security scan after GitHub sign-in. No payment details required.";

export const HOLDER_ACCESS_SUMMARY =
  "Hold at least 50,000 $NEST in a verified Solana wallet for 50 scans per UTC month while eligible.";

/** Shown on the homepage when RED_HOLDER_SCANS_ENABLED is not true. */
export const HOLDER_STATUS_INACTIVE =
  "Token-holder scanning is not active yet. Wallet verification is available ahead of the official $NEST launch.";

export const HOLDER_STATUS_ACTIVE = "Token-holder scanning is enabled for eligible verified wallets.";

export const HOLDER_ACCESS_TITLE_INACTIVE = "$NEST holder access — coming soon";
export const HOLDER_ACCESS_TITLE_ACTIVE = "$NEST holder access";

export const MINT_COMING_SOON = "Official mint address coming soon.";

/** Shown with a published reserved mint before holder activation / on-chain launch. */
export const TOKEN_NOT_LAUNCHED =
  "This mint address is reserved. $NEST has not launched yet — holder scanning stays disabled until activation.";
