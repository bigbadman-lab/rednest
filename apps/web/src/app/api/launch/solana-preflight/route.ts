/**
 * Operator-only Solana preflight for $NEST launch activation.
 * Uses production SOLANA_RPC_URL server-side; never returns the RPC URL.
 *
 *   Authorization: Bearer <SANDCHEST_ADMIN_TOKEN>
 *   POST { "mint": "<pubkey>" }
 */
import { z } from "zod";
import { isOperator } from "@/server/auth";
import { runLaunchSolanaPreflight } from "@/server/launch-solana-preflight";

export const dynamic = "force-dynamic";

const Body = z.object({
  mint: z.string().min(32).max(64),
});

export async function POST(request: Request): Promise<Response> {
  if (!isOperator(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "expected { mint: string }" }, { status: 400 });
  }

  const result = await runLaunchSolanaPreflight(parsed.data.mint);
  if (!result.ok) {
    const status =
      result.error === "account_absent" || result.error === "not_a_mint" || result.error.startsWith("pump_fun_unverified")
        ? 422
        : result.error === "production_mint_mismatch" || result.error === "production_mint_unconfigured"
          ? 409
          : 503;
    return Response.json(result, { status });
  }
  return Response.json(result);
}
