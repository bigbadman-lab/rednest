# RedNest

AI-powered security scanning for GitHub repositories.

**Website:** [https://rednest.tech](https://rednest.tech)  
**Docs:** [https://rednest.tech/docs](https://rednest.tech/docs)

## Overview

RedNest helps developers find and understand security issues in their codebases before attackers do. Sign in with GitHub, connect repositories through the RedNest GitHub App, and run AI-assisted scans that map attack surface, hunt for exploitable paths, and report findings with evidence—attack path, proof of concept, and a fix prompt for your coding agent.

Hosted RedNest is available at [rednest.tech](https://rednest.tech). This repository is the open-source codebase (AGPL-3.0), derived from [Sandchest](https://github.com/CapSoftware/Sandchest).

## Features

Confirmed in this codebase and available on the hosted product unless noted:

| Feature | Status |
| --- | --- |
| GitHub authentication (OAuth / Better Auth) | Implemented |
| Repository integration via the RedNest GitHub App | Implemented |
| AI-assisted deep scans, recon / threat models, and skeptic verification | Implemented |
| Public repository Quick Scan (signed-in, no App install required for public URLs) | Implemented |
| Security findings, reports, and dashboard views | Implemented |
| Pull request security reviews and Checks | Implemented |
| Agent / MCP access (`/api/mcp`) and HTTP API with device flow | Implemented |
| Solana wallet connect + server-side ownership verification (Settings) | Implemented |
| Self-hosting via Docker | Implemented (see [docker/README.md](docker/README.md)) |
| Lifetime free scan entitlement (one per GitHub account) | Implemented |
| $NEST holder eligibility (≥ 50,000 tokens, 50 scans / UTC month) | **Active** for eligible verified wallets |

Billing modules from the upstream project may still appear in code paths for accounts that use them; public hosted access uses the free-scan + $NEST holder model.

## Getting started

1. Open [https://rednest.tech](https://rednest.tech) and sign in with GitHub.
2. Install the RedNest GitHub App on the accounts and repositories you want scanned.
3. Use **Quick Scan** for a public GitHub URL, or open a connected repository and start a deep scan / wait for PR reviews.

Agent setup (Claude Code, Cursor, Codex, and similar):

```sh
claude mcp add --transport http sandchest https://rednest.tech/api/mcp
```

See [Use it from your agent](https://rednest.tech/docs/agents) for MCP and HTTP API details. The MCP server id may still appear as `sandchest` in client configs; the hosted endpoint is RedNest.

## Access and scan allowances

- **One lifetime free scan** per GitHub account.
- **$NEST holder access:** at least **50,000** $NEST in a verified Solana wallet, with **50** holder scans per UTC month.
- **Holder scanning is active** for eligible verified wallets. Missing mint or a disabled holder-scan flag keeps that path fail-closed; GitHub sign-in and the free scan continue to work.

## Technology

Monorepo layout:

- `apps/web` — Next.js application (dashboard, GitHub webhooks, MCP, docs)
- `packages/*` — shared libraries (database, scan engine, GitHub integration, billing, email, workspace)
- `crates/indexer` — Rust indexer used during scans
- `docker/` — self-hosted Compose stack and development Postgres
- `evals/` — evaluation harness and public fixtures

Runtime stack in brief: Bun workspaces, Turborepo, Next.js, PostgreSQL (Drizzle), Better Auth with GitHub, optional Stripe/Autumn billing modules, and chat-completions LLM endpoints with tool calling.

## Local development

Verified from the root `package.json` scripts. Do not commit secrets; copy `.env.example` and fill values locally only.

```sh
bun install
docker compose -f docker/compose.dev.yml up -d
bun run indexer:build
bun run typecheck
bun test
bun run check:build   # clean production-style Next.js build check
```

Development server (from the workspace / `apps/web` as documented for your setup):

```sh
bun run dev
```

For local GitHub sign-in, create a development GitHub App (for example `bun scripts/dev-app.ts` under `apps/web`) so `.env.development.local` points at local Postgres and disables hosted billing/email as appropriate. Webhooks need a public HTTPS URL (tunnel) if you want PR reviews to fire locally.

Required categories of configuration (see `.env.example`; leave empty in docs and commits):

- App / site URLs and Better Auth secret
- Postgres `DATABASE_URL` (and optional pooler / migration URLs)
- GitHub App credentials
- LLM endpoint (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, optional per-role models)

Holder-related variables (`RED_HOLDER_SCANS_ENABLED`, `RED_TOKEN_MINT`, `RED_MINT_PUBLIC`, `SOLANA_RPC_URL`, `NEXT_PUBLIC_REOWN_PROJECT_ID`) enable $NEST holder access in production. Homepage mint display requires `RED_MINT_PUBLIC=true` and never enables holder scans by itself; missing mint or a disabled holder-scan flag keeps that path fail-closed.

## Security

RedNest only reads repositories you install it on or public URLs you submit for Quick Scan. It does not execute your application code or the exploits it drafts. Findings are shown to people with appropriate GitHub access. Model prompts treat repository content as untrusted input. Self-hosted installs send nothing to rednest.tech; your code goes to GitHub and to the model endpoint you configure.

Do not put production secrets, private keys, or real scan output in this repository.

## License and attribution

This software is licensed under the **GNU Affero General Public License v3.0** (`AGPL-3.0-only`). See [`LICENSE`](LICENSE).

RedNest is based on **Sandchest** by Cap Software ([https://github.com/CapSoftware/Sandchest](https://github.com/CapSoftware/Sandchest)). Upstream copyright and license terms continue to apply to the inherited code. The Sandchest name and brand assets are trademarks of their owners and are **not** licensed under the AGPL; see [`TRADEMARKS.md`](TRADEMARKS.md). RedNest uses its own branding for the hosted product at [rednest.tech](https://rednest.tech).
