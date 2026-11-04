import { dashboardScans, visibleRepos } from "@sandchest/db";
import type { Metadata } from "next";
import { QuickScanForm } from "@/components/app/quick-scan-form";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { quickScanAllowance } from "@/server/quick-scan-action";
import { PAGE, parse, ScansView, type Query } from "./scans-view";

export const metadata: Metadata = { title: "Scans · RedNest" };

export default async function ScansPage({ searchParams }: { searchParams: Promise<Query> }) {
  const [user, query] = await Promise.all([viewer(), searchParams]);
  const current = parse(query);
  const [list, repos, allowance] = await Promise.all([
    dashboardScans(db(), user.id, { kind: current.kind, repoId: current.repo, before: current.before }, PAGE),
    visibleRepos(db(), user.id),
    quickScanAllowance(user.id),
  ]);
  return (
    <PageShape id="scans">
      <ScansView current={current} list={list} repos={repos} quickScan={<QuickScanForm freeAvailable={allowance.freeAvailable} />} />
    </PageShape>
  );
}
