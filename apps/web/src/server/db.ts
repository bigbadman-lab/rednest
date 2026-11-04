/**
 * The database handles, on their own so the dashboard's pages load only the
 * database client: not the engine, GitHub App or workflow runtime that
 * `services` brings in for scans.
 *
 * - `db()`: everything the app does, through the pooler when there is one
 *   (`DATABASE_POOLER_URL`). Each server instance keeps a few connections to
 *   the pooler, which lends out the database's own connections one
 *   transaction at a time, so the database's connection count stays fixed
 *   however many instances run, and an instance Vercel suspends holds none.
 *   About a millisecond more per query than a direct connection.
 * - `analyticsDb()`: analytics writes, the same way on a connection of their
 *   own, so they never queue behind the app. Writes run after the response
 *   and give way under load (see `recordEvents`).
 */
import { createDb, type Db } from "@sandchest/db";
import { config } from "./config";
import { runtimeDatabaseUrl } from "./database-url";

let instance: Db | undefined;
let analytics: Db | undefined;

/** The URL the app's queries use: the pooler when there is one. Migrations and the workflow World use their own. */
export function appDatabaseUrl(): string {
  const settings = config();
  return runtimeDatabaseUrl({
    DATABASE_POOLER_URL: settings.DATABASE_POOLER_URL,
    DATABASE_URL: settings.DATABASE_URL,
  })!;
}

/**
 * Per-instance pool size. On Vercel each suspended isolate can still hold
 * idle sockets briefly; keep this at 1 so many concurrent lambdas do not
 * multiply toward the pooler's client cap. Local/self-host may open a few.
 */
const APP_POOL_SIZE = process.env.VERCEL ? 1 : 4;

export function db(): Db {
  return (instance ??= createDb(appDatabaseUrl(), {
    max: APP_POOL_SIZE,
    idleTimeout: process.env.VERCEL ? 5 : 20,
    maxLifetime: process.env.VERCEL ? 60 : undefined,
    applicationName: "sandchest",
  }));
}

export function analyticsDb(): Db {
  return (analytics ??= createDb(appDatabaseUrl(), {
    max: 1,
    idleTimeout: 5,
    connectTimeout: 5,
    maxLifetime: process.env.VERCEL ? 60 : undefined,
    applicationName: "sandchest-analytics",
  }));
}

/** For tests: every handle uses this database. */
export function setDb(database: Db): void {
  instance = database;
  analytics = database;
}
