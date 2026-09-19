// commit.ts — dual-write one vote transition into the quilt WAL.
import { QuiltKernel, type QuiltEvent } from "./reference-kernel.mjs"
import {
	buildWalRows,
	projectNominationVote,
	type VoteProjectionInput,
	type WalRow
} from "./projection.js"

type WalClient = {
	batch<T = Record<string, unknown>>(
		statements: unknown[]
	): Promise<Array<{ results: T[] }>>
	prepare(query: string): {
		bind(...values: unknown[]): unknown
	}
}

export type ChainTip = { tip: number; prev: string | null }

// Lane C audit (2026-09-20), bug #1: the tip read and the row insert used
// to be two independent batch() calls with no guard between them, so two
// concurrent commits could both read tip T and both chain a row from the
// same prev_hash — a genuine hash-chain fork. Single-writer was a
// deployment convention, not a construction.
//
// Fix, three layers deep:
//   1. every row's INSERT is guarded and all rows land in ONE batch:
//      the anchor row refuses a prev_hash that is already chained
//      (`WHERE NOT EXISTS`), and each following row requires its
//      predecessor's hash to exist (`WHERE EXISTS`) — so if the anchor
//      loses the race, the whole chain transitively appends nothing;
//   2. the tip is re-verified against our final hash after the batch — a
//      losing writer throws QuiltChainConflictError instead of silently
//      returning success for a chain it never extended;
//   3. migration 0014's UNIQUE INDEX on prev_hash is the durable backstop:
//      even if both layers above are somehow defeated, the database
//      refuses the fork loudly. (prev_hash is NOT NULL — genesis rows
//      store the literal GENESIS — so the index also enforces a single
//      genesis anchor.)
export class QuiltChainConflictError extends Error {
	readonly expectedPrevHash: string

	constructor(expectedPrevHash: string) {
		super(
			`quilt WAL chain conflict: prev_hash ${expectedPrevHash} was already consumed by another commit`
		)
		this.name = "QuiltChainConflictError"
		this.expectedPrevHash = expectedPrevHash
	}
}

const TIP_QUERY = `select coalesce(max(seq), 0) as tip,
	(select hash from quilt_wal order by seq desc limit 1) as prev
 from quilt_wal`

// Project a vote into kernel ops and append the hash-chained WAL rows.
// Returns the number of rows committed. Throws QuiltChainConflictError if
// another writer won the tip between our read and our insert; throws only
// on D1 failure otherwise — callers in the vote path catch and log
// (dual-write posture).
export const commitNominationVoteProjection = async (
	client: WalClient,
	input: VoteProjectionInput
): Promise<number> => {
	const kernel = new QuiltKernel()
	const events: QuiltEvent[] = []
	const unsubscribe = kernel.subscribe((event) => {
		events.push(event)
	})
	projectNominationVote(kernel, input)
	unsubscribe()

	const [tipResult] = await client.batch<ChainTip>([
		client.prepare(TIP_QUERY)
	])
	const tipRow = tipResult?.results?.[0] ?? { tip: 0, prev: null }
	const rows = buildWalRows(events, {
		mutationId: input.mutationId,
		ts: input.ts,
		tip: Number(tipRow.tip ?? 0),
		prevHash: tipRow.prev ?? null
	})
	if (rows.length === 0) return 0

	await client.batch(
		rows.map((row: WalRow, index: number) =>
			client
				.prepare(
					// guarded chain, one batch. Anchor row: refuse to consume a
					// prev_hash that is already chained. Every later row requires
					// its predecessor's hash to be present — so if the anchor
					// loses the race, the whole batch transitively appends
					// nothing, never a partial fork.
					`insert into quilt_wal
						(mutation_id, ts, cell, op, value, prev_hash, hash)
					 select ?, ?, ?, ?, ?, ?, ?
					 where ${
						index === 0
							? `not exists (
								select 1 from quilt_wal where prev_hash = ?
							)`
							: `exists (
								select 1 from quilt_wal where hash = ?
							)`
					}`
				)
				.bind(
					row.mutation_id,
					row.ts,
					row.cell,
					row.op,
					row.value,
					row.prev_hash,
					row.hash,
					// guard parameter: the row's prev_hash in both flavors
					row.prev_hash
				)
		)
	)

	// Re-verify the tip: our chain landed iff the current tip hash is our
	// final hash and the sequence advanced by exactly our row count. Any
	// other outcome means another writer won the race (or the batch
	// partially applied) — refuse to report success for a chain we never
	// extended.
	const [afterResult] = await client.batch<ChainTip>([
		client.prepare(TIP_QUERY)
	])
	const afterRow = afterResult?.results?.[0]
	const expectedTip = Number(tipRow.tip ?? 0) + rows.length
	const finalHash = rows[rows.length - 1].hash
	if (
		!afterRow ||
		Number(afterRow.tip ?? 0) !== expectedTip ||
		(afterRow.prev ?? null) !== finalHash
	) {
		throw new QuiltChainConflictError(rows[0].prev_hash)
	}
	return rows.length
}
