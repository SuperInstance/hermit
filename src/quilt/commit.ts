// commit.ts — dual-write state transitions into the quilt WAL.
//
// Review finding #1 (BLOCKER): the tip-read and the insert were separate
// D1 batches. Two interleaved writers both read the same tip, then both
// insert — the hash chain self-invalidates permanently, silently, and
// nothing throws. An in-memory mutex cannot hold across Cloudflare Worker
// isolates, so the commit serializer lives in D1: a single-row claim lock
// with a stale-holder TTL. Claim → read tip → insert → release, all under
// the lock. The lock is best-effort: on claim exhaustion the projection
// is SKIPPED (mirror posture — the user flow never breaks), which is now
// a loud, countable event rather than silent corruption.
import { QuiltKernel, type QuiltEvent } from "./reference-kernel.mjs"
import {
	buildWalRows,
	type WalRow
} from "./projection.js"
import { recordWalCommit, recordWalFailure } from "./ops.js"

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

const LOCK_TTL_MS = 30_000
const LOCK_ATTEMPTS = 8
const seed = Date.now().toString(36)
let nonce = 0
const nextHolder = (mutationId: string) =>
	`${mutationId}:${seed}:${(nonce += 1)}`

const sleep = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms))

const claimWalLock = async (
	client: WalClient,
	holder: string,
	now: Date
): Promise<boolean> => {
	const nowIso = now.toISOString()
	const staleBefore = new Date(now.getTime() - LOCK_TTL_MS).toISOString()
	await client.batch([
		client.prepare(
			`insert or ignore into quilt_wal_lock (id, holder, acquired_at)
			 values (1, '', '')`
		)
	])
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		const [claimed] = await client.batch<{ id: number }>([
			client
				.prepare(
					`update quilt_wal_lock
					 set holder = ?, acquired_at = ?
					 where id = 1 and (holder = '' or acquired_at < ?)
					 returning id`
				)
				.bind(holder, nowIso, staleBefore)
		])
		if (claimed?.results?.[0]) return true
		await sleep(Math.min(200, 5 * 2 ** attempt) + Math.floor(Math.random() * 10))
	}
	return false
}

const releaseWalLock = async (
	client: WalClient,
	holder: string
): Promise<void> => {
	await client.batch([
		client
			.prepare(
				`update quilt_wal_lock
				 set holder = '', acquired_at = ''
				 where id = 1 and holder = ?`
			)
			.bind(holder)
	])
}

// Generic projector: run `project` against a fresh kernel, drain the
// events, append hash-chained WAL rows serialized by the D1 claim lock.
// Returns rows written (0 when lock acquisition fails or no events).
export const commitProjection = async (
	client: WalClient,
	context: CommitContext,
	project: (kernel: QuiltKernel) => void
): Promise<number> => {
	const holder = nextHolder(context.mutationId)
	const acquired = await claimWalLock(client, holder, new Date())
	if (!acquired) {
		recordWalFailure(
			"lock_exhausted",
			new Error(`projection skipped for ${context.mutationId}`)
		)
		return 0
	}
	try {
		const kernel = new QuiltKernel()
		const events: QuiltEvent[] = []
		const unsubscribe = kernel.subscribe((event) => {
			events.push(event)
		})
		project(kernel)
		unsubscribe()
		if (events.length === 0) return 0

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

		recordWalCommit(rows.length)
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
	} finally {
		await releaseWalLock(client, holder).catch(() => {})
	}
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
