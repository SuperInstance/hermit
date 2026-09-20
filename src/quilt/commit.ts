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

// Lane D (2026-09-20): the tip read and the row insert are two separate
// batches, so two concurrent commits can read the SAME tip and both chain
// to the SAME prev_hash — a genuine hash-chain fork. Drizzle 0014 adds a
// UNIQUE index on quilt_wal.prev_hash that turns that race into a hard
// constraint error; here we treat the error as a lost compare-and-swap and
// re-read the tip + rechain (optimistic retry). Genuine D1 failures still
// throw — the vote path's catch-and-log dual-write posture is unchanged.
const MAX_CHAIN_ATTEMPTS = 8

const isChainConflict = (error: unknown): boolean => {
	const message = error instanceof Error ? error.message : String(error)
	return /UNIQUE constraint failed: quilt_wal\.prev_hash/.test(message)
}

const TIP_READ = `select coalesce(max(seq), 0) as tip,
			(select hash from quilt_wal order by seq desc limit 1) as prev
		 from quilt_wal`

const ROW_INSERT = `insert into quilt_wal
					(mutation_id, ts, cell, op, value, prev_hash, hash)
				 values (?, ?, ?, ?, ?, ?, ?)`

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

	let lastConflict: unknown = null
	for (let attempt = 0; attempt < MAX_CHAIN_ATTEMPTS; attempt += 1) {
		const [tipResult] = await client.batch<ChainTip>([
			client.prepare(TIP_READ)
		])
		const tipRow = tipResult?.results?.[0] ?? { tip: 0, prev: null }
		const rows = buildWalRows(events, {
			mutationId: input.mutationId,
			ts: input.ts,
			tip: Number(tipRow.tip ?? 0),
			prevHash: tipRow.prev ?? null
		})
		if (rows.length === 0) return 0

		try {
			await client.batch(
				rows.map((row: WalRow) =>
					client
						.prepare(ROW_INSERT)
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
		} catch (error) {
			if (!isChainConflict(error)) throw error
			lastConflict = error
		}
	}
	throw lastConflict instanceof Error
		? lastConflict
		: new Error("quilt WAL commit exhausted chain attempts")
}
