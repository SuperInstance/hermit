// quiltKernelOps.test.ts — the ledger reports its own health (review
// finding #2, code half). Every silent catch now counts; reconcileTick is
// the cron-ready observer that never throws.
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../src/db/schema.js"
import { recordNominationVote } from "../src/data/nominations.js"
import {
	getWalFailureCounts,
	getWalRowsCommitted,
	reconcileTick,
	recordWalFailure,
	resetWalOps
} from "../src/quilt/ops.js"
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

describe("quilt kernel — ops", () => {
	it("counts a real projection failure and the vote still records", async () => {
		resetWalOps()
		const { owner } = createHarness()
		const database = drizzle(owner as never, { schema })
		owner.database
			.query(
				`insert into nominations (
					guild_id, channel_id, nominee_id, nominator_id, reason,
					target_role_id, required_approvals, status, expires_at
				) values (?, ?, ?, ?, ?, ?, 1, 'submitted', ?)`
			)
			.run("guild-1", "channel-1", "nominee-1", "nominator-1", "reason", "role-1", null)
		const nominationId = Number(
			owner.database.query("select max(id) as id from nominations").get()?.id
		)
		// the deploy-time failure mode: WAL table missing in this env
		owner.database.run(`drop table quilt_wal`)

		const result = await recordNominationVote(
			nominationId,
			"ct-1",
			"approve",
			new Date(),
			database as never
		)
		// user path untouched — the mirror failed, the vote did not
		expect(result.kind).toBe("granting")
		const counts = getWalFailureCounts()
		expect(counts.nomination_projection).toBe(1)
		owner.close()
	})

	it("counts lock exhaustion as its own failure kind", async () => {
		resetWalOps()
		const { owner } = createHarness()
		owner.database
			.query(
				`insert into quilt_wal_lock (id, holder, acquired_at)
				 values (1, 'stuck', ?)`
			)
			.run(new Date().toISOString())
		// a commit under an unbreakable lock returns 0 and counts
		const { commitProjection } = await import("../src/quilt/commit.js")
		const written = await commitProjection(
			owner as never,
			{ mutationId: "m-x", ts: "2026-09-17T00:00:00.000Z" },
			(kernel) => {
				kernel.bind("nomination.9", { id: 9, kind: "nomination" })
			}
		)
		expect(written).toBe(0)
		expect(getWalFailureCounts().lock_exhausted).toBe(1)
		owner.close()
	})

	it("gauges rows committed on success", async () => {
		resetWalOps()
		const { owner } = createHarness()
		const { commitProjection } = await import("../src/quilt/commit.js")
		await commitProjection(
			owner as never,
			{ mutationId: "m-gauge", ts: "2026-09-17T00:00:00.000Z" },
			(kernel) => {
				kernel.bind("nomination.5", { id: 5, kind: "nomination" })
				kernel.bind("nomination.5.status", "submitted")
			}
		)
		expect(getWalRowsCommitted()).toBe(2)
		expect(Object.keys(getWalFailureCounts())).toHaveLength(0)
		owner.close()
	})

	it("reconcileTick carries the summary and never throws", async () => {
		resetWalOps()
		const good = await reconcileTick(async () => ({
			checked: { nominations: 3, encounters: 2 },
			mismatches: [{ kind: "status" }],
			chain: { ok: true }
		}))
		expect(good.ok).toBe(true)
		expect(good.checked).toEqual({ nominations: 3, encounters: 2 })
		expect(good.mismatchCount).toBe(1)
		expect(good.chainOk).toBe(true)

		const bad = await reconcileTick(async () => {
			throw new Error("d1 exploded")
		})
		expect(bad.ok).toBe(false)
		expect(bad.chainOk).toBe(false)
		expect(getWalFailureCounts().reconcile_tick).toBe(1)
	})

	it("recordWalFailure is total over weird errors", () => {
		resetWalOps()
		recordWalFailure("reconcile_tick", new Error("x"))
		recordWalFailure("reconcile_tick", "string error")
		recordWalFailure("reconcile_tick", undefined)
		expect(getWalFailureCounts().reconcile_tick).toBe(3)
		resetWalOps()
		expect(Object.keys(getWalFailureCounts())).toHaveLength(0)
	})
})
