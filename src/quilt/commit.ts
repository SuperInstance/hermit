// commit.ts — dual-write state transitions into the quilt WAL.
import { QuiltKernel, type QuiltEvent } from "./reference-kernel.mjs"
import {
	buildWalRows,
	type WalRow
} from "./projection.js"

export type WalClient = {
	batch<T = Record<string, unknown>>(
		statements: unknown[]
	): Promise<Array<{ results: T[] }>>
	prepare(query: string): {
		bind(...values: unknown[]): unknown
	}
}

export type ChainTip = { tip: number; prev: string | null }

export type CommitContext = {
	mutationId: string
	ts: string
}

// Generic projector: run `project` against a fresh kernel, drain the
// events, append hash-chained WAL rows in ONE batch. Returns rows written.
export const commitProjection = async (
	client: WalClient,
	context: CommitContext,
	project: (kernel: QuiltKernel) => void
): Promise<number> => {
	const kernel = new QuiltKernel()
	const events: QuiltEvent[] = []
	const unsubscribe = kernel.subscribe((event) => {
		events.push(event)
	})
	project(kernel)
	unsubscribe()

	const [tipResult] = await client.batch<ChainTip>([
		client.prepare(
			`select coalesce(max(seq), 0) as tip,
				(select hash from quilt_wal order by seq desc limit 1) as prev
			 from quilt_wal`
		)
	])
	const tipRow = tipResult?.results?.[0] ?? { tip: 0, prev: null }
	const rows = buildWalRows(events, {
		mutationId: context.mutationId,
		ts: context.ts,
		tip: Number(tipRow.tip ?? 0),
		prevHash: tipRow.prev ?? null
	})
	if (rows.length === 0) return 0

	await client.batch(
		rows.map((row: WalRow) =>
			client
				.prepare(
					`insert into quilt_wal
						(mutation_id, ts, cell, op, value, prev_hash, hash)
					 values (?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					row.mutation_id,
					row.ts,
					row.cell,
					row.op,
					row.value,
					row.prev_hash,
					row.hash
				)
		)
	)
	return rows.length
}

// P1 entry point — kept for src/data/nominations.ts.
export const commitNominationVoteProjection = (
	client: WalClient,
	input: {
		nominationId: number
		reviewerId: string
		choice: "approve" | "decline"
		resultKind:
			| "recorded"
			| "switched"
			| "granting"
			| "declined"
			| "expired"
		status: string
		totals: { approvals: number; declines: number }
		completedAt: string | null
		mutationId: string
		ts: string
	}
): Promise<number> =>
	commitProjection(client, { mutationId: input.mutationId, ts: input.ts }, (kernel) => {
		const base = `nomination.${input.nominationId}`
		// the nomination itself is a cell — link endpoints must exist (L1 law)
		kernel.bind(base, { id: input.nominationId, kind: "nomination" })
		kernel.bind(`${base}.mutation`, input.mutationId, { ts: input.ts })
		kernel.bind(`${base}.status`, input.status)
		kernel.bind(`${base}.totals`, input.totals)
		kernel.bind(`${base}.completedAt`, input.completedAt)
		if (input.resultKind !== "expired") {
			const voteCell = `${base}.vote.${input.reviewerId}`
			kernel.bind(voteCell, input.choice, { ts: input.ts })
			kernel.link(voteCell, base, "cast")
		}
	})
