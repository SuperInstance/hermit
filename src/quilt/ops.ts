// ops.ts — the ledger reports its own health.
//
// Review finding #2 (the half that is code, not ops): every WAL projection
// failure reduced to a console.warn, and nothing in production ever reads
// quilt_wal — so the mirror could die at deploy and nobody would know for
// a week. This module turns "logged and forgotten" into counted and
// exported: failure counters incremented at every catch site, a rows-
// committed gauge, and reconcileTick — a cron-ready wrapper around the
// reconciliation pass that returns a summary instead of throwing.
// Posture unchanged: the user path never sees an exception from the mirror.

export type WalFailureKind =
	| "nomination_projection"
	| "encounter_projection"
	| "bind_projection"
	| "publication_projection"
	| "response_projection"
	| "lock_exhausted"
	| "reconcile_tick"

const failureCounts = new Map<WalFailureKind, number>()
let rowsCommitted = 0

// Called from every silent catch. Increments the kind's counter and logs
// once — the log line is for humans tailing, the counter is for alerting.
export const recordWalFailure = (
	kind: WalFailureKind,
	error: unknown
): void => {
	failureCounts.set(kind, (failureCounts.get(kind) ?? 0) + 1)
	console.warn(`quilt wal failure [${kind}]`, error)
}

// Called from commitProjection on success — the mirror liveness gauge.
export const recordWalCommit = (rows: number): void => {
	rowsCommitted += rows
}

export const getWalFailureCounts = (): Record<string, number> =>
	Object.fromEntries(failureCounts)

export const getWalRowsCommitted = (): number => rowsCommitted

// Test hook — production never resets.
export const resetWalOps = (): void => {
	failureCounts.clear()
	rowsCommitted = 0
}

export type ReconcileTickSummary = {
	ranAt: string
	ok: boolean
	checked: { nominations: number; encounters: number }
	mismatchCount: number
	chainOk: boolean
	breakAt?: number
	failureCounts: Record<string, number>
	rowsCommitted: number
}

// Cron-ready wrapper around the reconciliation pass. Scheduled handlers
// (wrangler: [triggers] crons = ["*/15 * * * *"]) call this; it never
// throws — a failed tick is itself a counted failure. Wire alerting on
// failureCounts.reconcile_tick > 0 or mismatchCount > 0.
export const reconcileTick = async (
	reconcile: () => Promise<{
		checked: { nominations: number; encounters: number }
		mismatches: unknown[]
		chain: { ok: boolean; breakAt?: number }
	}>
): Promise<ReconcileTickSummary> => {
	try {
		const result = await reconcile()
		return {
			ranAt: new Date().toISOString(),
			ok: true,
			checked: result.checked,
			mismatchCount: result.mismatches.length,
			chainOk: result.chain.ok,
			breakAt: result.chain.breakAt,
			failureCounts: getWalFailureCounts(),
			rowsCommitted: getWalRowsCommitted()
		}
	} catch (error) {
		recordWalFailure("reconcile_tick", error)
		return {
			ranAt: new Date().toISOString(),
			ok: false,
			checked: { nominations: 0, encounters: 0 },
			mismatchCount: 0,
			chainOk: false,
			failureCounts: getWalFailureCounts(),
			rowsCommitted: getWalRowsCommitted()
		}
	}
}
