"use client";

import { useActionState } from "react";
import { submitQuickScan, type QuickScanFormState } from "@/server/quick-scan-action";

const initial: QuickScanFormState = {};

/** Minimal public-URL Quick Scan entry: URL field, entitlement note, submit. */
export function QuickScanForm({ freeAvailable }: { freeAvailable: boolean }) {
  const [state, action, pending] = useActionState(submitQuickScan, initial);

  return (
    <form action={action} className="quick-scan">
      <div className="text-field">
        <label className="text-field-label" htmlFor="quick-scan-url">
          Public repository URL
        </label>
        <input
          id="quick-scan-url"
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://github.com/owner/repository"
          defaultValue={state.url ?? ""}
          disabled={pending}
          required
        />
        <p className="field-help">
          {freeAvailable
            ? "Your free lifetime scan is available. No GitHub App install required for public repos."
            : "Your free scan is used. Additional scans will require an eligible wallet holding 50,000 $NEST once holder access launches."}
        </p>
      </div>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      <button type="submit" className="key key-primary" disabled={pending}>
        <span className="key-face">{pending ? "Starting…" : "Quick Scan"}</span>
      </button>
    </form>
  );
}
