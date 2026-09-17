// quiltKernelReviewFixes.test.ts — regression tests for the adversarial
// review findings. Finding #1's probe (two interleaved commits) lived in
// the reviewer's hands, not in the suite; it lives here now.
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../src/db/schema.js"
import { commitProjection } from "../src/quilt/commit.js"
import {
	analyzeRefusals,
	replayEncounterFromWal,
	verifyChain,
	type WalRow
} from "../src/quilt/projection.js"
import { SqliteD1Database } from "./helpers/sqliteD1.js"

const migrationPaths = readdirSync("drizzle")
	.filter((file) =>
		/0002_.*\.sql|000[4-9]_.*\.sql|001[0134]_.*\.sql/.test(file)
	)
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

const createHarness = () => {
	const owner = new SqliteD1Database()
	applyMigrations(owner.database)
	return { owner }
}

const readWalRows = async (owner: SqliteD1Database): Promise<WalRow[]> => {
	const result = await owner
		.prepare(
			`select seq, mutation_id, ts, cell, op, value, prev_hash, hash
			 from quilt_wal order by seq asc`
		)
		.all<WalRow>()
	return (result.results ?? []).map((row) => ({
		seq: Number(row.seq),
		mutation_id: row.mutation_id,
		ts: row.ts,
		cell: row.cell,
		op: row.op,
		value: row.value,
		prev_hash: row.prev_hash,
		hash: row.hash
	}))
}

describe("quilt kernel — review fixes", () => {
	it("finding #1: interleaved commits keep a valid chain (the probe)", async () => {
		const { owner } = createHarness()
		const client = owner as unknown as Parameters<
			typeof commitProjection
		>[0]
		const ts = "2026-09-17T00:00:00.000Z"

		// fire both WITHOUT awaiting the first — the interleaving that
		// broke the chain before the claim lock existed
		const first = commitProjection(
			client,
			{ mutationId: "m-A", ts },
			(kernel) => {
				kernel.bind("nomination.1", { id: 1, kind: "nomination" })
				kernel.bind("nomination.1.status", "submitted")
			}
		)
		const second = commitProjection(
			client,
			{ mutationId: "m-B", ts },
			(kernel) => {
				kernel.bind("nomination.2", { id: 2, kind: "nomination" })
				kernel.bind("nomination.2.status", "submitted")
			}
		)
		const [rowsA, rowsB] = await Promise.all([first, second])
		expect(rowsA + rowsB).toBe(4)

		const rows = await readWalRows(owner)
		const verification = verifyChain(rows)
		expect(verification.ok).toBe(true)
		const lock = await owner
			.prepare(`select holder from quilt_wal_lock where id = 1`)
			.all<{ holder: string }>()
		expect(lock.results?.[0]?.holder).toBe("")
		owner.close()
	})

	it("finding #3: replay is order-independent in the caller", async () => {
		const { owner } = createHarness()
		const client = owner as unknown as Parameters<
			typeof commitProjection
		>[0]
		const ts = "2026-09-17T00:00:00.000Z"
		await commitProjection(client, { mutationId: "m-1", ts }, (kernel) => {
			kernel.bind("encounter.7", { id: 7, kind: "lobster-encounter" })
			kernel.bind("encounter.7.publication", "pending")
			kernel.bind("encounter.7.publication", "published")
		})
		const rows = await readWalRows(owner)
		const forward = replayEncounterFromWal(rows, 7)
		const backward = replayEncounterFromWal([...rows].reverse(), 7)
		expect(forward?.publication).toBe("published")
		expect(backward?.publication).toBe("published")
		owner.close()
	})

	it("finding #7: unbind removes the cell from replay", async () => {
		const { owner } = createHarness()
		const client = owner as unknown as Parameters<
			typeof commitProjection
		>[0]
		const ts = "2026-09-17T00:00:00.000Z"
		await commitProjection(client, { mutationId: "m-1", ts }, (kernel) => {
			kernel.bind("encounter.9", { id: 9, kind: "lobster-encounter" })
			kernel.bind("encounter.9.message", "msg-1")
			kernel.unbind("encounter.9.message")
		})
		const rows = await readWalRows(owner)
		const replayed = replayEncounterFromWal(rows, 9)
		expect(replayed).not.toBeNull()
		expect(replayed?.message).toBeNull()
		owner.close()
	})

	it("finding #4: analyzeRefusals survives corrupt rows and dotted ids", async () => {
		const { owner } = createHarness()
		const client = owner as unknown as Parameters<
			typeof commitProjection
		>[0]
		const ts = "2026-09-17T00:00:00.000Z"
		await commitProjection(
			client,
			{ mutationId: "m-dotted", ts },
			(kernel) => {
				kernel.bind("encounter.ix.with.dots", {
					kind: "lobster-encounter-attempt",
					guildId: "g-1",
					actorId: "a-1",
					targetId: "t-1",
					channelId: "c-1"
				})
				kernel.bind("encounter.ix.with.dots.refused", {
					refusedBy: ["actor"],
					remaining: [{ kind: "actor", remainingSeconds: 12 }],
					ts
				})
			}
		)
		// one deliberately corrupt payload row
		owner.database
			.query(
				`insert into quilt_wal
					(mutation_id, ts, cell, op, value, prev_hash, hash)
				 values ('m-corrupt', ?, 'encounter.bogus.refused', 'bind',
					'{not json', 'x', 'y')`
			)
			.run(ts)

		const rows = await readWalRows(owner)
		expect(() => analyzeRefusals(rows)).not.toThrow()
		const records = analyzeRefusals(rows, "g-1")
		expect(records).toHaveLength(1)
		expect(records[0]?.interactionId).toBe("ix.with.dots")
		expect(records[0]?.refusedBy).toEqual(["actor"])
		owner.close()
	})

	it("lock posture: unbreakable lock skips the projection, never corrupts", async () => {
		const { owner } = createHarness()
		const client = owner as unknown as Parameters<
			typeof commitProjection
		>[0]
		const ts = "2026-09-17T00:00:00.000Z"
		// a live holder with a FRESH timestamp: every claim attempt bounces
		owner.database
			.query(
				`insert into quilt_wal_lock (id, holder, acquired_at)
				 values (1, 'stuck-holder', ?)`
			)
			.run(new Date().toISOString())

		const written = await commitProjection(
			client,
			{ mutationId: "m-skipped", ts },
			(kernel) => {
				kernel.bind("nomination.3", { id: 3, kind: "nomination" })
			}
		)
		expect(written).toBe(0)
		const rows = await readWalRows(owner)
		expect(rows).toHaveLength(0)
		owner.close()
	})

	it("lock posture: a stale holder is broken and the commit proceeds", async () => {
		const { owner } = createHarness()
		const client = owner as unknown as Parameters<
			typeof commitProjection
		>[0]
		const ts = "2026-09-17T00:00:00.000Z"
		owner.database
			.query(
				`insert into quilt_wal_lock (id, holder, acquired_at)
				 values (1, 'dead-holder', ?)`
			)
			.run(new Date(Date.now() - 60_000).toISOString())

		const written = await commitProjection(
			client,
			{ mutationId: "m-stale", ts },
			(kernel) => {
				kernel.bind("nomination.4", { id: 4, kind: "nomination" })
			}
		)
		expect(written).toBe(1)
		const rows = await readWalRows(owner)
		expect(verifyChain(rows).ok).toBe(true)
		owner.close()
	})
})
