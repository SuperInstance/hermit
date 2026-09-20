import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
	commitNominationVoteProjection,
	QuiltChainConflictError
} from "../src/quilt/commit.js"
import { verifyChain, type WalRow } from "../src/quilt/projection.js"
import { SqliteD1Database } from "./helpers/sqliteD1.js"

// Lane C audit (2026-09-20), bug #1 proof: two writers racing the chain
// tip must never fork the hash chain. The loser must throw
// QuiltChainConflictError and append ZERO rows.
//
// Harness: same migration set as quiltKernelReplay (0002, 0004-0009, 0013)
// plus 0014 (the prev_hash unique backstop), over a FILE-backed sqlite so
// two SqliteD1Database connections are genuinely independent connections.

const migrationPaths = readdirSync("drizzle")
	.filter((file) => /0002_.*\.sql|000[4-9]_.*\.sql|0013_.*\.sql|0014_.*\.sql/.test(file))
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

const voteInput = (mutationId: string) => ({
	nominationId: 1,
	reviewerId: mutationId,
	choice: "approve" as const,
	resultKind: "recorded" as const,
	status: "open",
	totals: { approvals: 1, declines: 0 },
	completedAt: null,
	mutationId,
	ts: new Date().toISOString()
})

const walRows = (owner: SqliteD1Database): WalRow[] =>
	owner.database
		.query("select * from quilt_wal order by seq")
		.all() as unknown as WalRow[]

// Wraps a SqliteD1Database and pauses every batch() call after the first
// (the chain-tip read), until resume(). Simulates a writer stalled at
// exactly the window the old two-batch commit left open.
class GatedClient {
	paused = false
	private batchCount = 0
	private waiters: Array<() => void> = []
	private resolveBlocked: (() => void) | null = null
	readonly blocked: Promise<void>

	constructor(readonly inner: SqliteD1Database) {
		this.blocked = new Promise<void>((resolve) => {
			this.resolveBlocked = resolve
		})
	}

	prepare(query: string) {
		return this.inner.prepare(query)
	}

	async batch<T = Record<string, unknown>>(statements: unknown[]) {
		this.batchCount += 1
		if (this.paused && this.batchCount >= 2) {
			this.resolveBlocked?.()
			await new Promise<void>((resolve) => this.waiters.push(resolve))
		}
		return this.inner.batch<T>(
			statements as Parameters<SqliteD1Database["batch"]>[0]
		)
	}

	resume() {
		this.paused = false
		for (const release of this.waiters) release()
		this.waiters = []
	}
}

const tempDb = (name: string) => {
	const path = join(tmpdir(), `hermit-quilt-cas-${name}-${Date.now()}.sqlite`)
	rmSync(path, { force: true })
	return path
}

describe("quilt WAL CAS guard — Lane C bug #1", () => {
	it("mid-flight race: loser throws conflict and appends zero rows", async () => {
		const path = tempDb("race")
		const writer = new SqliteD1Database(path)
		applyMigrations(writer.database)
		// second, independent connection to the same database file
		const winner = new SqliteD1Database(path)
		const gated = new GatedClient(new SqliteD1Database(path))
		gated.paused = true

		const loserPromise = commitNominationVoteProjection(
			gated as never,
			voteInput("mutation-loser")
		)
		// wait until the loser is parked between tip-read and insert —
		// precisely the window the old commit.ts left open
		await gated.blocked

		// the winner commits a full chain while the loser is parked
		const winnerRows = await commitNominationVoteProjection(
			winner as never,
			voteInput("mutation-winner")
		)
		expect(winnerRows).toBeGreaterThan(0)

		gated.resume()
		let loserError: unknown = null
		try {
			await loserPromise
		} catch (error) {
			loserError = error
		}
		expect(loserError).toBeInstanceOf(QuiltChainConflictError)

		const rows = walRows(writer)
		expect(verifyChain(rows)).toBe(true)
		// zero partial rows from the loser — no fork, no orphan tail
		expect(rows.some((row) => row.mutation_id === "mutation-loser")).toBe(false)
		expect(rows.filter((row) => row.mutation_id === "mutation-winner").length).toBe(
			winnerRows
		)
		// unique backstop held: every prev_hash consumed exactly once
		const prevCounts = new Map<string, number>()
		for (const row of rows) {
			prevCounts.set(row.prev_hash, (prevCounts.get(row.prev_hash) ?? 0) + 1)
		}
		for (const count of prevCounts.values()) expect(count).toBe(1)

		writer.close()
		winner.close()
		gated.inner.close()
		rmSync(path, { force: true })
	})

	it("sequential commits still chain: guard is not a turnstile", async () => {
		const owner = new SqliteD1Database()
		applyMigrations(owner.database)

		const first = await commitNominationVoteProjection(
			owner as never,
			voteInput("mutation-first")
		)
		const second = await commitNominationVoteProjection(
			owner as never,
			voteInput("mutation-second")
		)
		expect(first).toBeGreaterThan(0)
		expect(second).toBeGreaterThan(0)

		const rows = walRows(owner)
		expect(rows.length).toBe(first + second)
		expect(verifyChain(rows)).toBe(true)
		expect(rows[0].prev_hash).toBe("GENESIS")
		// each mutation chained its own anchor from the live tip
		expect(rows[first].prev_hash).toBe(rows[first - 1].hash)

		owner.close()
	})
})
