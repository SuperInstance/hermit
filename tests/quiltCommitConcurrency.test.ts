// Tip-race repro for the quilt WAL commit path (Lane D, 2026-09-20).
//
// commit.ts reads (tip, prev) and inserts the chained rows in TWO separate
// batches with no compare-and-swap. Two committers that interleave between
// those batches read the same tip and both chain to the same prev_hash —
// a genuine hash-chain fork that verifyChain() rejects. This harness builds
// that interleave deterministically: both tip reads complete BEFORE either
// insert begins (a barrier between the phases), so the race is reproduced
// on every run, not just when the scheduler feels like it.
//
// Expected posture: FAILS on unfixed main (fork: duplicate prev_hash,
// verifyChain === false), PASSES with the CAS guard + prev_hash unique
// index (drizzle 0014): one winner, losers throw, no fork.
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import {
	commitNominationVoteProjection,
	QuiltChainConflictError
} from "../src/quilt/commit.js"
import {
	verifyChain,
	type VoteProjectionInput,
	type WalRow
} from "../src/quilt/projection.js"
import { SqliteD1Database } from "./helpers/sqliteD1.js"

const migrationPaths = readdirSync("drizzle")
	.filter((file) => /0013_.*\.sql|0014_.*\.sql/.test(file))
	.sort()

const applyMigrations = (database: Database) => {
	for (const path of migrationPaths) {
		const migration = readFileSync(`drizzle/${path}`, "utf8")
		for (const statement of migration.split("--> statement-breakpoint")) {
			const trimmed = statement.trim()
			if (trimmed) {
				database.run(trimmed)
			}
		}
	}
}

// Barrier: lets N committers finish their tip read, then releases them all
// to insert at once. Disabled after first release so the loser's retry
// (on the fixed branch) flows straight through.
const makeBarrier = (size: number) => {
	let arrived = 0
	let released = false
	const waiters: Array<() => void> = []
	return async function arrive() {
		if (released) return
		arrived += 1
		if (arrived >= size) {
			released = true
			const pending = waiters.splice(0)
			for (const resolve of pending) resolve()
			return
		}
		await new Promise<void>((resolve) => waiters.push(resolve))
	}
}

// WalClient that delegates to the real sqlite harness but gates the
// tip-read batch on the barrier. The tip read is the ONLY single-statement
// batch commit.ts issues; everything else is a multi-row insert.
class InterleavingWalClient {
	constructor(
		private readonly inner: SqliteD1Database,
		private readonly arrive: () => Promise<void>
	) {}

	prepare(query: string) {
		return this.inner.prepare(query)
	}

	async batch<T = Record<string, unknown>>(
		statements: unknown[]
	): Promise<Array<{ results: T[] }>> {
		const isTipRead =
			statements.length === 1 &&
			/coalesce\(max\(seq\)/.test(
				String((statements[0] as { query?: unknown })?.query ?? "")
			)
		const results = await this.inner.batch<T>(
			statements as Parameters<SqliteD1Database["batch"]>[0]
		)
		if (isTipRead) await this.arrive()
		return results
	}
}

const voteInput = (
	reviewerId: string,
	mutationId: string
): VoteProjectionInput => ({
	nominationId: 1,
	reviewerId,
	choice: "approve",
	resultKind: "recorded",
	status: "submitted",
	totals: { approvals: 1, declines: 0 },
	completedAt: null,
	mutationId,
	ts: "2026-09-20T00:00:00.000Z"
})

const walRows = (owner: SqliteD1Database): WalRow[] =>
	owner.database
		.query("select * from quilt_wal order by seq")
		.all() as unknown as WalRow[]

describe("quilt WAL commit — tip race (Lane D repro)", () => {
	it("two committers on the same tip keep ONE linear chain", async () => {
		const owner = new SqliteD1Database()
		applyMigrations(owner.database)
		const arrive = makeBarrier(2)
		const clientA = new InterleavingWalClient(owner, arrive)
		const clientB = new InterleavingWalClient(owner, arrive)

		const inputA = voteInput("ct-1", "m-race-A")
		const inputB = voteInput("ct-2", "m-race-B")
		const settled = await Promise.allSettled([
			commitNominationVoteProjection(clientA, inputA),
			commitNominationVoteProjection(clientB, inputB)
		])
		// shipped contract (tests/quiltWalCas.test.ts, commit.ts CAS guard):
		// exactly one writer extends the tip; the loser throws
		// QuiltChainConflictError and appends nothing. The caller
		// (data/nominations.ts) counts the loss; the vote itself is unaffected.
		const won = settled.filter((r) => r.status === "fulfilled")
		const lost = settled.filter((r) => r.status === "rejected")
		expect(won).toHaveLength(1)
		expect(lost).toHaveLength(1)
		expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
			QuiltChainConflictError
		)

		const rows = walRows(owner)
		const prevs = rows.map((row) => row.prev_hash)
		expect(new Set(prevs).size).toBe(prevs.length)
		expect(new Set(rows.map((row) => row.mutation_id)).size).toBe(1)
		expect(verifyChain(rows).ok).toBe(true)
		owner.close()
	})

	it("four committers on the same tip keep ONE linear chain", async () => {
		const owner = new SqliteD1Database()
		applyMigrations(owner.database)
		const arrive = makeBarrier(4)
		const inputs = ["ct-1", "ct-2", "ct-3", "ct-4"].map((reviewerId, index) =>
			voteInput(reviewerId, `m-storm-${index}`)
		)
		const clients = inputs.map(
			() => new InterleavingWalClient(owner, arrive)
		)

		const settled = await Promise.allSettled(
			inputs.map((input, index) =>
				commitNominationVoteProjection(clients[index], input)
			)
		)
		const won = settled.filter((r) => r.status === "fulfilled")
		expect(won).toHaveLength(1)
		for (const r of settled) {
			if (r.status === "rejected") {
				expect(r.reason).toBeInstanceOf(QuiltChainConflictError)
			}
		}

		const rows = walRows(owner)
		const prevs = rows.map((row) => row.prev_hash)
		expect(new Set(prevs).size).toBe(prevs.length)
		expect(new Set(rows.map((row) => row.mutation_id)).size).toBe(1)
		expect(verifyChain(rows).ok).toBe(true)
		owner.close()
	})

	it("sequential commits still chain (no regression)", async () => {
		const owner = new SqliteD1Database()
		applyMigrations(owner.database)
		const passThrough = makeBarrier(1) // releases immediately
		const client = new InterleavingWalClient(owner, passThrough)

		const first = await commitNominationVoteProjection(
			client,
			voteInput("ct-1", "m-seq-1")
		)
		const second = await commitNominationVoteProjection(
			client,
			voteInput("ct-2", "m-seq-2")
		)
		expect(first).toBeGreaterThan(0)
		expect(second).toBeGreaterThan(0)
		expect(verifyChain(walRows(owner)).ok).toBe(true)
		owner.close()
	})
})
