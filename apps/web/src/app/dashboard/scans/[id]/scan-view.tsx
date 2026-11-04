import type { DashboardRepo, scanForUser } from "@sandchest/db";
import { Dig } from "@/components/app/dig";
import { Heat } from "@/components/app/heat";
import { HoverLink, Link } from "@/components/app/hover-link";
import { ScanClock, ScanFeed, ScanLive, ScanStatus, ScanTrack } from "@/components/app/scan-live";
import { ScanWatch } from "@/components/app/scan-watch";
import { compactNumber, plural, SCAN_KIND_LABEL, SEVERITIES, SEVERITY_LABEL, type Severity } from "@/lib/format";
import { readHacker } from "@/lib/hacker";
import type { OrgPlan } from "@/server/org-plans";
import "../../../rig.css";

/** A scan as the page reads it: the run, its repository and org, what it found and its feed. */
export type ScanRow = NonNullable<Awaited<ReturnType<typeof scanForUser>>>;

export const ACTIVE = new Set(["queued", "running", "publishing"]);

export function title(kind: string, prNumber: number | null): string {
  return kind === "pr_review" && prNumber !== null ? `Review of PR #${prNumber}` : (SCAN_KIND_LABEL[kind] ?? "Scan");
}

/**
 * A scan, drawn from what the page read; its loading state draws it from a sample scan. `again` is the Dig key
 * of a finished deep scan's repo; `next` is the deep scan a running recon is mapping the repo for, and
 * `waitingOn` the recon a queued deep scan waits for.
 */
export function ScanView({ row, again, next, waitingOn }: { row: ScanRow; again?: { repo: DashboardRepo; plan: OrgPlan }; next?: string; waitingOn?: string }) {
  const { scan, repo, org, metrics, findings, events } = row;
  const live = ACTIVE.has(scan.status);
  const shown = findings.filter((finding) => finding.confidence !== "low");
  const stats = (scan.stats ?? {}) as {
    loc?: number;
    checked?: number;
    fixed?: number;
    newFindingIds?: string[];
    warnings?: string[];
    completeness?: "complete" | "partial";
    hunters?: { total: number; completed: number; failed: number };
  };
  const newIds = new Set(stats.newFindingIds ?? []);
  const open = shown.filter((finding) => finding.status === "open");
  const resolved = shown.filter((finding) => finding.status === "fixed" || finding.status === "dismissed");
  const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, shown.filter((finding) => finding.severity === severity).length])) as Record<Severity, number>;
  const findingsHref = `/dashboard/findings?repo=${repo.id}`;
  const partial =
    stats.completeness === "partial" ||
    (stats.hunters?.failed ?? 0) > 0 ||
    (stats.warnings ?? []).some((warning) => /could not finish|stopped early|AI capacity was unavailable/i.test(warning));

  const initial = {
    kind: scan.kind,
    status: scan.status,
    createdAt: scan.createdAt.getTime(),
    startedAt: scan.startedAt?.getTime() ?? null,
    finishedAt: scan.finishedAt?.getTime() ?? null,
    durationMs: metrics?.durationMs ?? null,
    renderedAt: Date.now(),
    events: events.map((event) => ({ seq: event.seq, type: event.type, message: event.message, at: event.createdAt.getTime() })),
  };

  return (
    <>
      {/* Keyed by status: when the scan ends and the page refreshes, the view starts again from the
          finished scan (its end time and measured duration) instead of keeping what it followed live. */}
      <ScanLive key={scan.status} scanId={scan.id} initial={initial}>
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/dashboard/scans">Scans</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/dashboard/repos/${repo.id}`}>{repo.fullName}</Link>
        </nav>

        <div className="page-head">
          <div>
            <h1 className="page-title">{title(scan.kind, scan.prNumber)}</h1>
            <p className="page-sub">
              <ScanStatus /> on <code>{scan.headSha === "HEAD" ? "the default branch" : scan.headSha.slice(0, 7)}</code>
            </p>
          </div>
          {scan.prNumber !== null && (
            <a className="key key-secondary" href={`https://github.com/${repo.fullName}/pull/${scan.prNumber}`} target="_blank" rel="noreferrer">
              <span className="key-face">Open the pull request</span>
            </a>
          )}
          {again && <Dig repo={again.repo} plan={again.plan} />}
        </div>

        {scan.error && <p className="scan-error">{scan.error}</p>}

        {next && (
          <HoverLink href={`/dashboard/scans/${next}`} className="running-strip">
            <span className="blink" aria-hidden="true" />
            <span>
              Recon maps <strong>{repo.fullName}</strong> first, usually in under a minute. The deep scan starts from this map.
            </span>
            <span className="running-strip-go">Watch the deep scan</span>
          </HoverLink>
        )}
        {waitingOn && (
          <HoverLink href={`/dashboard/scans/${waitingOn}`} className="running-strip">
            <span className="blink" aria-hidden="true" />
            <span>
              Recon is mapping <strong>{repo.fullName}</strong> first, usually in under a minute. This deep scan starts from that map.
            </span>
            <span className="running-strip-go">Watch recon</span>
          </HoverLink>
        )}

        <ScanWatch profile={readHacker(org.hacker)} repo={repo.fullName} findings={shown.length} hackerHref={`/dashboard/hacker?org=${scan.orgId}`} />

        <dl className="stats">
          <ScanClock />
          {scan.kind === "fix_check" ? (
            <div className="stat">
              <dt>Fixed</dt>
              <dd>{stats.checked !== undefined ? `${stats.fixed ?? 0} of ${stats.checked}` : "…"}</dd>
            </div>
          ) : (
            !live && (
              <div className="stat">
                <dt>Findings</dt>
                <dd>{shown.length}</dd>
              </div>
            )
          )}
          {stats.loc !== undefined && (
            <div className="stat">
              <dt>Lines read</dt>
              <dd>{compactNumber(stats.loc)}</dd>
            </div>
          )}
          {/* What was charged, once it was: a free deep scan, or a scan still running, shows no cost. */}
          {scan.billing === "charged" && scan.credits > 0 && (
            <div className="stat">
              <dt>Cost</dt>
              <dd>{plural(scan.credits, "credit")}</dd>
            </div>
          )}
        </dl>

        {!live && scan.kind !== "fix_check" && (
          <section className="block" aria-labelledby="results-title">
            <div className="block-head">
              <h2 id="results-title" className="block-title">
                Results
              </h2>
              <Link className="quiet" href={findingsHref}>
                View repository findings
              </Link>
            </div>
            {scan.status === "failed" ? (
              <p className="block-empty">This scan failed before a complete result was available.{scan.error ? ` ${scan.error}` : ""}</p>
            ) : scan.status === "cancelled" || scan.status === "refused" ? (
              <p className="block-empty">This scan did not finish, so there is no findings result to show.</p>
            ) : (
              <>
                {partial && (
                  <p className="block-empty" role="status">
                    Partial analysis: some AI hunters could not finish (often due to temporary AI capacity limits). Findings listed below were still identified; uncovered areas may remain unscanned.
                  </p>
                )}
                {shown.length === 0 ? (
                  <p className="block-empty">
                    No security findings were identified in this scan. That does not guarantee the repository is secure.
                  </p>
                ) : (
                  <dl className="stats results-summary">
                    <div className="stat">
                      <dt>Associated findings</dt>
                      <dd>{shown.length}</dd>
                    </div>
                    <div className="stat">
                      <dt>Needs review</dt>
                      <dd>{open.length}</dd>
                    </div>
                    {resolved.length > 0 && (
                      <div className="stat">
                        <dt>Resolved</dt>
                        <dd>{resolved.length}</dd>
                      </div>
                    )}
                    {SEVERITIES.filter((severity) => bySeverity[severity] > 0).map((severity) => (
                      <div key={severity} className="stat">
                        <dt>{SEVERITY_LABEL[severity]}</dt>
                        <dd>{bySeverity[severity]}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            )}
          </section>
        )}

        {shown.length > 0 && (
          <section className="block" aria-labelledby="found-title">
            <h2 id="found-title" className="block-title">
              Findings
            </h2>
            <ul className="rows">
              {shown.map((finding) => {
                const location = locationOf(finding);
                return (
                  <li key={finding.id} className="row finding-row">
                    <HoverLink href={`/dashboard/findings/${finding.id}`}>
                      <Heat severity={finding.severity} label />
                      <span className="finding-row-title">{finding.title}</span>
                      <span className="finding-row-when">
                        {newIds.has(finding.id) && <span className="status status-badge">New</span>}
                        {(finding.status === "fixed" || finding.status === "dismissed") && (
                          <span className="status status-badge" data-status={finding.status}>
                            {finding.status === "fixed" ? "Fixed" : "Dismissed"}
                          </span>
                        )}
                        {finding.status === "open" && <span className="status status-badge">Open</span>}
                      </span>
                      {location && (
                        <span className="finding-row-where">
                          <code>{location}</code>
                        </span>
                      )}
                      {finding.impact && <span className="finding-row-when">{clip(finding.impact, 140)}</span>}
                    </HoverLink>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="block" aria-labelledby="feed-title">
          <h2 id="feed-title" className="block-title">
            {live ? "Live" : "Activity"}
          </h2>
          <ScanTrack />
          <ScanFeed />
        </section>
      </ScanLive>
    </>
  );
}

function locationOf(finding: ScanRow["findings"][number]): string | null {
  const sink = finding.sink;
  if (sink && typeof sink === "object" && "file" in sink && typeof sink.file === "string") {
    return `${sink.file}:${typeof sink.line === "number" ? sink.line : "?"}`;
  }
  const entry = finding.entryPoint;
  if (entry && typeof entry === "object" && entry !== null && "file" in entry && typeof (entry as { file: unknown }).file === "string") {
    const file = (entry as { file: string; line?: number }).file;
    const line = (entry as { line?: number }).line;
    return `${file}:${typeof line === "number" ? line : "?"}`;
  }
  return null;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
