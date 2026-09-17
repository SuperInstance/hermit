import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { drizzle } from "drizzle-orm/d1"
import {
	getNominationReviewState,
	recordNominationVote,
	type NominationDatabase
} from "../src/data/nominations.js"
import * as schema from "../src/db/schema.js"
import { setRuntimeEnv, type HermitEnv } from "../src/runtime/env.js"
import {
	GENESIS,
	replayNominationFromWal,
	verifyChain,
	type WalRow
} from "../src/quilt/projection.js"
import { SqliteD1Database } from "./helpers/sqliteD1.js"

// P1 proof harness: 0002 (form_submissions, which 0012-era statements
// reference), the 0004-0009 nomination machine, and 0013 (the WAL).
// Existing suites filter 000[4-9] and never see 0013 — unchanged suites
// stay honest.
const migrationPaths = readdirSync("drizzle")
	.filter((file) => /0002_.*\.sql|000[4-9]_.*\.sql|001[34]_.*\.sql/.test(file))
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
	setRuntimeEnv({ DB: owner as unknown as D1Database } as HermitEnv)
	const database = drizzle(owner as unknown as D1Database, {
		schema
	}) as NominationDatabase
	return { owner, database }
}

const insertNomination = (
	owner: SqliteD1Database,
	requiredApprovals = 3,
	expiresAt: string | null = null
) => {
	owner.database
		.query(
			`insert into nominations (
				guild_id, channel_id, nominee_id, nominator_id, reason,
				target_role_id, required_approvals, status, expires_at
			) values (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`
		)
		.run("guild-1", "channel-1", "nominee-1", "nominator-1", "reason", "role-1",
			requiredApprovals, expiresAt)
	return Number(
		owner.database.query("select max(id) as id from nominations").get()?.id
	)
}

const walRows = (owner: SqliteD1Database): WalRow[] =>
	owner.database
		.query("select * from quilt_wal order by seq")
		.all() as unknown as WalRow[]

describe("quilt kernel P1 — nomination WAL projection", () => {
	it("projects every mutating vote into a valid hash chain", async () => {
		const { owner, database } = createHarness()
		const id = insertNomination(owner)
		const first = await recordNominationVote(id, "ct-1", "approve", new Date(), database)
		expect(first.kind).toBe("recorded")

		const rows = walRows(owner)
		expect(rows.length).toBeGreaterThan(0)
		expect(verifyChain(rows).ok).toBe(true)

		const cells = new Set(rows.map((row) => row.cell))
		expect(cells.has(`nomination.${id}.status`)).toBe(true)
		expect(cells.has(`nomination.${id}.vote.ct-1`)).toBe(true)
		owner.close()
	})

	it("replay-from-WAL equals live D1 state on the granting path", async () => {
		const { owner, database } = createHarness()
		const id = insertNomination(owner)
		await recordNominationVote(id, "ct-1", "approve", new Date(), database)
		await recordNominationVote(id, "ct-2", "approve", new Date(), database)
		const third = await recordNominationVote(id, "ct-3", "approve", new Date(), database)
		expect(third.kind).toBe("granting")

		const rows = walRows(owner)
		expect(verifyChain(rows).ok).toBe(true)
		const replayed = replayNominationFromWal(rows, id)
		expect(replayed).not.toBeNull()
		expect(replayed?.status).toBe("granting")
		expect(replayed?.totals).toEqual({ approvals: 3, declines: 0 })

		const live = await getNominationReviewState(id)
		expect(replayed?.status).toBe(live?.nomination.status)
		expect(replayed?.votes).toEqual(live?.votes)
		expect(replayed?.totals).toEqual(live?.totals)
		owner.close()
	})

	it("replay-from-WAL equals live D1 state on the decline path", async () => {
		const { owner, database } = createHarness()
		const id = insertNomination(owner)
		await recordNominationVote(id, "ct-1", "decline", new Date(), database)
		await recordNominationVote(id, "ct-2", "decline", new Date(), database)
		const third = await recordNominationVote(id, "ct-3", "decline", new Date(), database)
		expect(third.kind).toBe("declined")

		const rows = walRows(owner)
		const replayed = replayNominationFromWal(rows, id)
		expect(replayed?.status).toBe("declined")
		expect(replayed?.completedAt).toBe(third.nomination.completedAt)

		const live = await getNominationReviewState(id)
		expect(replayed?.votes).toEqual(live?.votes)
		owner.close()
	})

	it("switching a vote re-binds the cell; replay shows the final choice", async () => {
		const { owner, database } = createHarness()
		const id = insertNomination(owner)
		await recordNominationVote(id, "ct-1", "approve", new Date(), database)
		const switched = await recordNominationVote(id, "ct-1", "decline", new Date(), database)
		expect(switched.kind).toBe("switched")

		const replayed = replayNominationFromWal(walRows(owner), id)
		expect(replayed?.votes).toEqual([{ reviewerId: "ct-1", choice: "decline" }])
		expect(replayed?.totals).toEqual({ approvals: 0, declines: 1 })
		owner.close()
	})

	it("non-mutating calls project nothing (unchanged/closed leave no WAL rows)", async () => {
		const { owner, database } = createHarness()
		const id = insertNomination(owner)
		await recordNominationVote(id, "ct-1", "approve", new Date(), database)
		const again = await recordNominationVote(id, "ct-1", "approve", new Date(), database)
		expect(again.kind).toBe("unchanged")

		const votes = walRows(owner).filter(
			(row) => row.op === "bind" && row.cell.includes(".vote.")
		)
		expect(votes.length).toBe(1)
		owner.close()
	})

	it("chain is gap-sensitive: tampering breaks verification", async () => {
		const { owner, database } = createHarness()
		const id = insertNomination(owner)
		await recordNominationVote(id, "ct-1", "approve", new Date(), database)
		const rows = walRows(owner)
		const voteRowIndex = rows.findIndex((row) =>
			row.cell.endsWith(".vote.ct-1")
		)
		expect(voteRowIndex).toBeGreaterThan(-1)
		const tampered = rows.map((row, index) =>
			index === voteRowIndex ? { ...row, value: '"decline"' } : row
		)
		expect(verifyChain(tampered).ok).toBe(false)

		const replayed = replayNominationFromWal(tampered, id)
		expect(replayed?.votes[0]?.choice).toBe("decline")
		owner.close()
	})

	it("expired nominations project status without a vote cell", async () => {
		const { owner, database } = createHarness()
		const past = new Date(Date.now() - 60_000).toISOString()
		const id = insertNomination(owner, 3, past)
		const expired = await recordNominationVote(id, "ct-1", "approve", new Date(), database)
		expect(expired.kind).toBe("expired")

		const rows = walRows(owner)
		expect(verifyChain(rows).ok).toBe(true)
		expect(rows.some((row) => row.cell.endsWith(".vote.ct-1"))).toBe(false)
		const replayed = replayNominationFromWal(rows, id)
		expect(replayed?.status).toBe("expired")
		owner.close()
	})

	it("genesis anchor: the first row chains from GENESIS", async () => {
		const { owner, database } = createHarness()
		const id = insertNomination(owner)
		await recordNominationVote(id, "ct-1", "approve", new Date(), database)
		const first = walRows(owner)[0]
		expect(first.prev_hash).toBe(GENESIS)
		owner.close()
	})
})
