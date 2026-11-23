// Copied from the admin panel (core-frontend src/components/layout/EnvironmentStrip.tsx,
// PR #144) so every product marks the sandbox alike. Goes away once skylcn-ui's AppShell
// takes an `environment` (top bar standard, S1; Kaan).

/**
 * A thin band across the top of every page in the sandbox, so no one works in
 * the wrong one; production draws nothing. It sits over the page and takes no
 * clicks. Under the top bar it is the line alone (the bar carries the badge);
 * without the bar (inside SkyApp) it hangs its own "Sandbox" tab.
 */
export function EnvironmentStrip({ sandbox, withLabel = true }: { sandbox: boolean; withLabel?: boolean }) {
  if (!sandbox) return null;
  return (
    <div
      role={withLabel ? "note" : undefined}
      aria-label={withLabel ? "Ortam: Sandbox" : undefined}
      aria-hidden={withLabel ? undefined : true}
      className="pointer-events-none fixed inset-x-0 top-0 z-60 flex justify-center"
    >
      <div className="bg-warning absolute inset-x-0 top-0 h-0.5" />
      {withLabel ? (
        <span className="bg-warning text-background rounded-b-md px-2.5 pb-0.5 text-xs leading-4 font-semibold">
          Sandbox
        </span>
      ) : null}
    </div>
  );
}

/**
 * The environment in the top bar, beside the account: drawn only in the sandbox. skylcn's
 * `Badge tone="warning"` in its own classes: Account Center does not load badge.css yet
 * (theme-contract.test.ts, `notScannedYet`).
 */
export function EnvironmentBadge({ sandbox }: { sandbox: boolean }) {
  if (!sandbox) return null;
  return (
    <span
      role="note"
      aria-label="Ortam: Sandbox"
      className="border-warning/35 bg-warning/10 text-warning inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap"
    >
      Sandbox
    </span>
  );
}
