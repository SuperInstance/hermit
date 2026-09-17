// quiltKernelReconcile.test.ts — replay-verify reconciliation: the
// detector for the dual-write window. Drift IS the deliverable.
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../src/db/schema.js"
import { setRuntimeEnv, type HermitEnv } from "../src/runtime/env.js"
import {
	getNominationReviewState,
	recordNominationVote,
	type NominationDatabase
} from "../src/data/nominations.js"
import {
	createLobsterEncounter,
	getLobsterEncounter,
	type CreateLobsterEncounterInput,
	type LobsterDatabase
} from "../src/data/lobsterEncounters.js"
import { reconcileQuiltWal } from "../src/quilt/reconcile.js"
import { verifyChain, type WalRow } from "../src/quilt/projection.js"
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
	// reconcile's readers use the default database — route it home
	setRuntimeEnv({ DB: owner as unknown as never } as HermitEnv)
	const database = drizzle(owner as unknown as never, {
		schema
	}) as NominationDatabase & LobsterDatabase
	return { owner, database }
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

const encounterInput = (
	overrides: Partial<CreateLobsterEncounterInput>
): CreateLobsterEncounterInput => ({
	interactionId: `interaction-${Math.random().toString(36).slice(2, 10)}`,
	guildId: "guild-1",
	channelId: "channel-1",
	actorId: "actor-1",
	targetId: "target-1",
	targetIsBot: false,
	taxonomySnapshotId: "snapshot-1",
	speciesAphiaId: 107176,
	speciesAcceptedName: "Homarus gammarus",
	speciesDisplayName: "European lobster",
	speciesFamily: "Nephropidae",
	sceneId: "scene-reef-1",
	assetUrl: "https://example.test/lobster.png",
	assetChecksum: "checksum-1",
	headline: "A lobster appears",
	narrative: "Claws up, antennae sweeping the current.",
	metrics: { weightKg: 1.5 },
	accessibilityDescription: "A blue lobster on a rocky reef.",
	...overrides
})

const insertNomination = (owner: SqliteD1Database) => {
	owner.database
		.query(
			`insert into nominations (
				guild_id, channel_id, nominee_id, nominator_id, reason,
				target_role_id, required_approvals, status, expires_at
			) values (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`
		)
		.run("guild-1", "channel-1", "nominee-1", "nominator-1", "reason",
			"role-1", 3, null)
	return Number(
		owner.database
			.query(`select max(id) as id from nominations`)
			.get()?.id
	)
}

const readers = {
	getNominationReviewState,
	getLobsterEncounter
}

describe("quilt kernel — reconciliation", () => {
	it("clean traffic reconciles with zero mismatches", async () => {
		const { owner, database } = createHarness()
		const t0 = new Date("2026-09-17T00:00:00Z")
		const nominationId = insertNomination(owner)
		await recordNominationVote(
			nominationId, "ct-1", "approve", t0, database
		)
		const created = await createLobsterEncounter(
			encounterInput({ interactionId: "ix-clean" }), t0, database
		)
		if (created.kind !== "created") throw new Error("setup failed")
		// one refusal: negative-ledger row must NOT become an entity
		await createLobsterEncounter(
			encounterInput({
				interactionId: "ix-clean-denied",
				actorId: "actor-1",
				targetId: "actor-9",
				channelId: "channel-9"
			}),
			t0,
			database
		)

		const rows = await readWalRows(owner)
		expect(verifyChain(rows).ok).toBe(true)
		const result = await reconcileQuiltWal(database, rows, readers)
		if (!result.ok) throw new Error("chain should verify")
		expect(result.checked.nominations).toBe(1)
		expect(result.checked.encounters).toBe(1)
		expect(result.mismatches).toEqual([])
		owner.close()
	})

	it("flags drift: a D1 row changed behind the ledger's back", async () => {
		const { owner, database } = createHarness()
		const t0 = new Date("2026-09-17T00:00:00Z")
		const created = await createLobsterEncounter(
			encounterInput({ interactionId: "ix-drift" }), t0, database
		)
		if (created.kind !== "created") throw new Error("setup failed")

		// simulate the window: someone updates D1 without a WAL row
		owner.database
			.query(
				`update lobster_encounters
				 set publication_status = 'published', message_id = 'msg-x'
				 where id = ?`
			)
			.run(created.encounter.id)

		const rows = await readWalRows(owner)
		const result = await reconcileQuiltWal(database, rows, readers)
		if (!result.ok) throw new Error("chain should verify")
		expect(result.mismatches.length).toBeGreaterThan(0)
		const publication = result.mismatches.find(
			(m) => m.entity === "encounter" && m.field === "publication"
		)
		expect(publication?.wal).toBe("pending")
		expect(publication?.d1).toBe("published")
		owner.close()
	})

	it("refuses to reconcile a tampered chain and points at the break", async () => {
		const { owner, database } = createHarness()
		const t0 = new Date("2026-09-17T00:00:00Z")
		const nominationId = insertNomination(owner)
		await recordNominationVote(
			nominationId, "ct-1", "approve", t0, database
		)
		owner.database
			.query(
				`update quilt_wal set value = '"decline"'
				 where cell like '%.vote.%' limit 1`
			)
			.run()

		const rows = await readWalRows(owner)
		const verification = verifyChain(rows)
		expect(verification.ok).toBe(false)
		if (!verification.ok) {
			expect(verification.firstBadSeq).toBeGreaterThan(0)
		}
		const result = await reconcileQuiltWal(database, rows, readers)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.reason).toBe("chain_broken")
		}
		owner.close()
	})

	it("flags vote drift between ledger and tally", async () => {
		const { owner, database } = createHarness()
		const t0 = new Date("2026-09-17T00:00:00Z")
		const nominationId = insertNomination(owner)
		await recordNominationVote(
			nominationId, "ct-1", "approve", t0, database
		)
		// drift on the D1 side: a vote row appears with no WAL row
		owner.database
			.query(
				`insert into nomination_approvals (
					nomination_id, approver_id, vote_choice, created_at
				) values (?, 'ct-2', 'approve', ?)`
			)
			.run(nominationId, t0.toISOString())

		const rows = await readWalRows(owner)
		const result = await reconcileQuiltWal(database, rows, readers)
		if (!result.ok) throw new Error("chain should verify")
		const voteMismatch = result.mismatches.find(
			(m) => m.entity === "nomination" && m.field === "votes"
		)
		expect(voteMismatch).toBeDefined()
		owner.close()
	})
})
