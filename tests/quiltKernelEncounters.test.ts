// quiltKernelEncounters.test.ts — the encounter machine's kernel shadow,
// including the negative ledger: refusals as first-class WAL rows.
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../src/db/schema.js"
import {
	analyzeRefusals,
	replayEncounterFromWal,
	verifyChain,
	type WalRow
} from "../src/quilt/projection.js"
import {
	createLobsterEncounter,
	bindLobsterMessage,
	markLobsterPublicationFailed,
	recordLobsterResponse,
	type CreateLobsterEncounterInput,
	type LobsterDatabase
} from "../src/data/lobsterEncounters.js"
import { SqliteD1Database } from "./helpers/sqliteD1.js"

// Same proof-harness contract as quiltKernelReplay.test.ts, plus 0010
// (slap_events, which 0011's GC references) and 0011 (the encounter
// machine's own tables). Existing suites filter 000[4-9]
// and never see 0013 — unchanged suites stay honest.
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
	const database = drizzle(owner as unknown as never, {
		schema
	}) as LobsterDatabase
	return { owner, database }
}

const readWalRows = async (
	owner: SqliteD1Database
): Promise<WalRow[]> => {
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

describe("quilt kernel — lobster encounter shadow", () => {
	it("projects a created encounter; replay matches the D1 row", async () => {
		const { owner, database } = createHarness()
		const input = encounterInput({ interactionId: "ix-created" })
		const result = await createLobsterEncounter(
			input,
			new Date("2026-09-17T00:00:00Z"),
			database
		)
		expect(result.kind).toBe("created")
		if (result.kind !== "created") return

		const rows = await readWalRows(owner)
		expect(rows.length).toBeGreaterThan(0)
		const cells = new Set(rows.map((row) => row.cell))
		const cell = `encounter.${result.encounter.id}`
		expect(cells.has(`encounter.ix-created`)).toBe(true)
		expect(cells.has(`${cell}.species`)).toBe(true)
		expect(cells.has(`${cell}.publication`)).toBe(true)
		// the changes()=1 linkage, made traversable: attempt -> encounter
		expect(cells.has(`encounter.ix-created->${cell}`)).toBe(true)
		expect(verifyChain(rows)).toBe(true)

		const replayed = replayEncounterFromWal(rows, result.encounter.id)
		expect(replayed).not.toBeNull()
		expect(replayed?.actorId).toBe("actor-1")
		expect(replayed?.targetId).toBe("target-1")
		expect(replayed?.species).toBe("European lobster")
		expect(replayed?.publication).toBe("pending")
		expect(replayed?.interactionId).toBe("ix-created")
	})

	it("records cooldown refusals in the negative ledger — invisible to D1", async () => {
		const { owner, database } = createHarness()
		const t0 = new Date("2026-09-17T00:00:00Z")
		const first = await createLobsterEncounter(
			encounterInput({
				interactionId: "ix-first",
				actorId: "actor-A",
				targetId: "target-B",
				channelId: "channel-C"
			}),
			t0,
			database
		)
		expect(first.kind).toBe("created")

		// same actor, different target and channel → actor guard fires
		const byActor = await createLobsterEncounter(
			encounterInput({
				interactionId: "ix-denied-actor",
				actorId: "actor-A",
				targetId: "target-D",
				channelId: "channel-E"
			}),
			t0,
			database
		)
		expect(byActor.kind).toBe("cooldown")
		if (byActor.kind === "cooldown") {
			expect(byActor.cooldowns.map((c) => c.kind)).toEqual(["actor"])
		}

		// different actor, same target → target guard fires
		const byTarget = await createLobsterEncounter(
			encounterInput({
				interactionId: "ix-denied-target",
				actorId: "actor-F",
				targetId: "target-B",
				channelId: "channel-E"
			}),
			t0,
			database
		)
		expect(byTarget.kind).toBe("cooldown")
		if (byTarget.kind === "cooldown") {
			expect(byTarget.cooldowns.map((c) => c.kind)).toEqual(["target"])
		}

		// different actor and target, same channel → channel guard fires
		const byChannel = await createLobsterEncounter(
			encounterInput({
				interactionId: "ix-denied-channel",
				actorId: "actor-F",
				targetId: "target-G",
				channelId: "channel-C"
			}),
			t0,
			database
		)
		expect(byChannel.kind).toBe("cooldown")
		if (byChannel.kind === "cooldown") {
			expect(byChannel.cooldowns.map((c) => c.kind)).toEqual(["channel"])
		}

		// the negative-space instrument: three refusals, one per guard
		const rows = await readWalRows(owner)
		const refusals = analyzeRefusals(rows, "guild-1")
		expect(refusals).toHaveLength(3)
		const byDimension = refusals
			.map((record) => record.refusedBy[0])
			.sort()
		expect(byDimension).toEqual(["actor", "channel", "target"])
		const actorRefusal = refusals.find((r) =>
			r.refusedBy.includes("actor")
		)
		expect(actorRefusal?.interactionId).toBe("ix-denied-actor")
		expect(actorRefusal?.remaining?.[0]?.remainingSeconds).toBeGreaterThan(0)

		// H(N) > H(R), verified: live D1 holds ONE encounter; the WAL saw four
		const liveCount = await owner
			.prepare(`select count(*) as n from lobster_encounters`)
			.all<{ n: number }>()
		expect(Number(liveCount.results?.[0]?.n ?? 0)).toBe(1)
		expect(verifyChain(rows)).toBe(true)
	})

	it("records an idempotent retry as a retried row", async () => {
		const { owner, database } = createHarness()
		const t0 = new Date("2026-09-17T00:00:00Z")
		const input = encounterInput({ interactionId: "ix-retry" })
		const first = await createLobsterEncounter(input, t0, database)
		expect(first.kind).toBe("created")
		const retry = await createLobsterEncounter(input, t0, database)
		expect(retry.kind).toBe("existing")

		const rows = await readWalRows(owner)
		const retried = rows.find(
			(row) => row.cell === "encounter.ix-retry.retried"
		)
		expect(retried?.op).toBe("bind")
		expect(verifyChain(rows)).toBe(true)
	})

	it("projects bind → response; replay shows the full lifecycle", async () => {
		const { owner, database } = createHarness()
		const t0 = new Date("2026-09-17T00:00:00Z")
		const created = await createLobsterEncounter(
			encounterInput({ interactionId: "ix-life" }),
			t0,
			database
		)
		if (created.kind !== "created") throw new Error("setup failed")
		const id = created.encounter.id

		const bound = await bindLobsterMessage(
			id, "guild-1", "channel-1", "msg-1", t0, database
		)
		expect(bound.kind).toBe("bound")

		const responded = await recordLobsterResponse(
			{
				encounterId: id,
				guildId: "guild-1",
				channelId: "channel-1",
				messageId: "msg-1",
				responderId: "target-1",
				responderIsBot: false,
				responseType: "offer_butter",
				responseResult: { buttered: true }
			},
			t0,
			database
		)
		expect(responded.kind).toBe("recorded")

		const rows = await readWalRows(owner)
		const replayed = replayEncounterFromWal(rows, id)
		expect(replayed?.publication).toBe("published")
		expect(replayed?.message).toBe("msg-1")
		expect(replayed?.response?.type).toBe("offer_butter")
		expect(replayed?.response?.responderId).toBe("target-1")
		expect(verifyChain(rows)).toBe(true)
	})

	it("projects publication failure and the replay shows it", async () => {
		const { owner, database } = createHarness()
		const t0 = new Date("2026-09-17T00:00:00Z")
		const created = await createLobsterEncounter(
			encounterInput({ interactionId: "ix-pubfail" }),
			t0,
			database
		)
		if (created.kind !== "created") throw new Error("setup failed")

		const failed = await markLobsterPublicationFailed(
			created.encounter.id, "discord 500", t0, database
		)
		expect(failed.kind).toBe("marked_failed")

		const rows = await readWalRows(owner)
		const replayed = replayEncounterFromWal(rows, created.encounter.id)
		expect(replayed?.publication).toBe("publication_failed")
		expect(verifyChain(rows)).toBe(true)
	})

	it("keeps the chain valid across mixed traffic", async () => {
		const { owner, database } = createHarness()
		const t0 = new Date("2026-09-17T00:00:00Z")
		await createLobsterEncounter(
			encounterInput({
				interactionId: "ix-mix-1",
				actorId: "actor-M",
				targetId: "target-N",
				channelId: "channel-O"
			}),
			t0,
			database
		)
		await createLobsterEncounter(
			encounterInput({
				interactionId: "ix-mix-denied",
				actorId: "actor-M",
				targetId: "target-P",
				channelId: "channel-Q"
			}),
			t0,
			database
		)
		const rows = await readWalRows(owner)
		expect(rows.length).toBeGreaterThan(8)
		const seqs = rows.map((row) => row.seq)
		expect(new Set(seqs).size).toBe(seqs.length)
		expect(verifyChain(rows)).toBe(true)
	})
})
