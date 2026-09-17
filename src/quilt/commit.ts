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

// Project a vote into kernel ops and append the hash-chained WAL rows in
// ONE batch. Returns the number of rows committed. Throws only on D1
// failure — callers in the vote path catch and log (dual-write posture).
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
		client.prepare(
			`select coalesce(max(seq), 0) as tip,
				(select hash from quilt_wal order by seq desc limit 1) as prev
			 from quilt_wal`
		)
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
