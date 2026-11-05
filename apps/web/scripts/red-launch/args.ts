/**
 * Minimal argv parser for `bun run red:launch <command> ...`.
 * Rejects unknown flags; mutating commands accept --dry-run and --yes.
 */

export type LaunchCommand = "status" | "prepare" | "register" | "publish" | "verify" | "activate" | "disable";

export type ParsedArgs =
  | { ok: false; error: string }
  | {
      ok: true;
      command: LaunchCommand;
      dryRun: boolean;
      yes: boolean;
      mint?: string;
      eligible?: string;
      ineligible?: string;
    };

const COMMANDS = new Set<LaunchCommand>(["status", "prepare", "register", "publish", "verify", "activate", "disable"]);

const MUTATING = new Set<LaunchCommand>(["prepare", "register", "publish", "activate", "disable"]);
const MINT_COMMANDS = new Set<LaunchCommand>(["prepare", "register"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice();
  // bun run scripts/red-launch/cli.ts …  OR  bun run red:launch …
  while (args[0] && (args[0].endsWith("cli.ts") || args[0].endsWith("red-launch") || args[0] === "--")) {
    args.shift();
  }

  const commandRaw = args.shift();
  if (!commandRaw || commandRaw === "--help" || commandRaw === "-h") {
    return { ok: false, error: usage() };
  }
  if (!COMMANDS.has(commandRaw as LaunchCommand)) {
    return { ok: false, error: `Unknown command "${commandRaw}".\n\n${usage()}` };
  }
  const command = commandRaw as LaunchCommand;

  let dryRun = false;
  let yes = false;
  let mint: string | undefined;
  let eligible: string | undefined;
  let ineligible: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--yes" || a === "-y") {
      yes = true;
      continue;
    }
    if (a === "--mint") {
      mint = args[++i];
      if (!mint) return { ok: false, error: "--mint requires a value." };
      continue;
    }
    if (a.startsWith("--mint=")) {
      mint = a.slice("--mint=".length);
      continue;
    }
    if (a === "--eligible") {
      eligible = args[++i];
      if (!eligible) return { ok: false, error: "--eligible requires a value." };
      continue;
    }
    if (a.startsWith("--eligible=")) {
      eligible = a.slice("--eligible=".length);
      continue;
    }
    if (a === "--ineligible") {
      ineligible = args[++i];
      if (!ineligible) return { ok: false, error: "--ineligible requires a value." };
      continue;
    }
    if (a.startsWith("--ineligible=")) {
      ineligible = a.slice("--ineligible=".length);
      continue;
    }
    return { ok: false, error: `Unsupported flag "${a}".\n\n${usage()}` };
  }

  if (MINT_COMMANDS.has(command) && !mint) return { ok: false, error: `${command} requires --mint <MINT>.` };
  if (command === "verify" && (!eligible || !ineligible)) {
    return { ok: false, error: "verify requires --eligible <WALLET> and --ineligible <WALLET>." };
  }
  if (!MINT_COMMANDS.has(command) && mint !== undefined) {
    return { ok: false, error: `--mint is only valid for prepare or register.` };
  }
  if (command !== "verify" && (eligible !== undefined || ineligible !== undefined)) {
    return { ok: false, error: `--eligible / --ineligible are only valid for verify.` };
  }
  if (dryRun && command === "status") {
    return { ok: false, error: "status does not accept --dry-run." };
  }
  if (dryRun && !MUTATING.has(command) && command !== "verify") {
    // status already rejected; verify allows dry-run as a no-op label
  }

  return { ok: true, command, dryRun, yes, mint, eligible, ineligible };
}

export function usage(): string {
  return `Usage:
  bun run red:launch status
  bun run red:launch prepare --mint <RESERVED_MINT> [--dry-run] [--yes]
  bun run red:launch register --mint <MINT> [--dry-run] [--yes]
  bun run red:launch publish [--dry-run] [--yes]
  bun run red:launch verify --eligible <WALLET> --ineligible <WALLET>   # optional diagnostic
  bun run red:launch activate [--dry-run] [--yes]
  bun run red:launch disable [--dry-run] [--yes]

Targets only Vercel team cope2 / project rednest / production.
Does not create tokens. Pump.fun remains the token creation platform.
prepare registers a reserved mint before on-chain creation (holders stay disabled; never claims the token is live).
register requires an existing on-chain Pump.fun mint.
activate requires registered mint, publication, valid on-chain Pump.fun mint, healthy RPC, and confirmation — not wallet Stage C receipts.`;
}
