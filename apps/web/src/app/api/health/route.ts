/**
 * For health checks: 200 when the settings are usable and the database
 * answers, setup mode included, and 503 otherwise. On failure, `reason` is
 * only `configuration` or `database` — never setting names or values.
 */
import { healthStatus } from "@/server/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const status = await healthStatus();
  return Response.json(status, { status: status.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
