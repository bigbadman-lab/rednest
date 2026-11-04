import { FREE_CREDITS } from "@sandchest/billing/plans";
import type { Metadata } from "next";
import { ChestStage } from "@/components/chest-stage";
import { FindingStrip } from "@/components/finding-strip";
import { HackerAtWork } from "@/components/hacker-at-work";
import { HeroKey } from "@/components/hero-key";
import { HowItWorks } from "@/components/how-it-works";
import { LiveLines } from "@/components/recruit/live-lines";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

const CREDITS = FREE_CREDITS.credits;
/** Where the key goes: it remembers the claim, then starts recruiting (signing in first if needed). */
const CLAIM = "/claim/start";

export const metadata: Metadata = {
  title: `Tester access · RedNest`,
  description: `Invite-only tester access for RedNest on your own GitHub repositories.`,
  // A link for testers, not a page to find in search.
  robots: { index: false, follow: false },
  alternates: { canonical: "/claim" },
};

/**
 * Free credits for testers: the landing page, retold as an offer. Static, like
 * the landing page; who may claim is decided when they do (see
 * `server/free-credits.ts`).
 */
export default function ClaimPage() {
  return (
    <div className="page">
      <SiteHeader visitor="signed-out" />

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <p className="claim-eyebrow">
            <span className="claim-eyebrow-dot" aria-hidden="true" />
            For testers
          </p>
          <h1 id="hero-title" className="hero-title">
            Tester access.
          </h1>
          <p className="hero-lede">
            Invite-only access to try RedNest on your own repositories: GitHub-connected scanning, pull request reviews,
            and deep scans with actionable findings. Availability is limited.
          </p>
          <div className="hero-actions">
            <HeroKey href={CLAIM} track="claim-hero">Continue as a tester</HeroKey>
            <p className="claim-fine">Requires a GitHub account. Access rules are enforced at claim time.</p>
          </div>
        </section>

        <ChestStage />
        <LiveLines className="landing-live" />

        <section className="section" aria-labelledby="perks-title">
          <h2 id="perks-title" className="section-title">
            What tester access covers
          </h2>
          <ul className="claim-perks">
            <li className="claim-perk">
              <span className="claim-perk-n">PR</span>
              <span className="claim-perk-name">pull request reviews</span>
              <span className="claim-perk-note">Reviews use the existing credits module ({CREDITS} credits on claim). Each one reads the change the way an attacker would.</span>
            </li>
            <li className="claim-perk">
              <span className="claim-perk-n">Deep</span>
              <span className="claim-perk-name">repository scans</span>
              <span className="claim-perk-note">
                Deep scans cover whole repositories and return actionable findings with attack paths and fix guidance.
              </span>
            </li>
            <li className="claim-perk">
              <span className="claim-perk-n">Invite</span>
              <span className="claim-perk-name">tester access</span>
              <span className="claim-perk-note">
                Access is invite-only. Payment and token-based access are being revised and are not advertised as public offers here.
              </span>
            </li>
          </ul>
        </section>

        <section className="section" aria-labelledby="pitch-title">
          <h2 id="pitch-title" className="section-title">
            Find the exploit before someone else does
          </h2>
          <p className="pitch-body">
            Attackers already use abliterated models to scan code for holes. RedNest runs the same models on your
            repos and sends you what it finds. Every finding comes with:
          </p>
          <ul className="pitch-list">
            <li>The attack path, step by step, with file and line</li>
            <li>A proof of concept you can run</li>
            <li>What the fix must guarantee, and what it mustn&rsquo;t break</li>
            <li>A ready-to-run prompt for your coding agent, with a regression test</li>
          </ul>
        </section>

        <HowItWorks />

        <section className="section" aria-labelledby="example-title">
          <h2 id="example-title" className="section-title">
            What a finding looks like
          </h2>
          <FindingStrip />
          <p className="strip-caption">An example. Identifying details are redacted.</p>
        </section>
      </main>

      <HackerAtWork>
        <HeroKey href={CLAIM} track="claim-footer">Claim {CREDITS} free credits</HeroKey>
      </HackerAtWork>
      <SiteFooter />
    </div>
  );
}
