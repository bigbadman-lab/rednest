"use client";
import { useActionState } from "react";
import { acceptScanSponsorship, type SponsorOutcome } from "@/server/actions";
import { Submit } from "./submit";

/** Explicit scan-sponsor acceptance for a GitHub App admin. */
export function AcceptSponsorshipForm({ orgId, orgLogin }: { orgId: string; orgLogin: string }) {
  const [state, action] = useActionState<SponsorOutcome, FormData>(acceptScanSponsorship.bind(null, orgId), {});
  return (
    <form action={action} className="settings-form">
      <p className="field-legend">Scan sponsorship</p>
      <p className="field-help">
        {orgLogin} has no scan sponsor. Automatic pull-request reviews and repository mapping use the sponsor’s personal RedNest scan
        allowance. Accepting makes you the sponsor for this account.
      </p>
      <div className="form-foot">
        <Submit className="key key-primary" pending="Accepting…" track="settings-accept-sponsor">
          Accept scan sponsorship
        </Submit>
        {state.accepted && <span role="status">You’re the scan sponsor.</span>}
        {state.error && (
          <span role="alert" data-error="">
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
