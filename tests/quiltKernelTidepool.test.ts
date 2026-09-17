// quiltKernelTidepool.test.ts — the helper-thread memory ocean joins the
// ledger. Contract: /tmp/tidepool/README.md (the bench is the spec; the
// README wins wherever implementations diverged).
import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { readdirSync, readFileSync } from "node:fs"
import { verifyChain } from "../src/quilt/projection.js"
import { TidepoolOcean, type HelperThreadSummary } from "../src/tidepool/ocean.js"
import {
	detectQuietThreads,
	newlyQuietThreads,
	type ThreadLengthPoll
} from "../src/tidepool/stall.js"
import {
	replayThreadIndexFromWal,
	readWalRowsSince
} from "../src/tidepool/projection.js"
import {
	drainQuietThreads,
	getTidepoolWalFailures,
	recallHelperContext,
	rememberBotAction,
	rememberChannelThreads,
	rememberHelperThread,
	resetTidepoolWalFailures
} from "../src/tidepool/index.js"
import { SqliteD1Database } from "./helpers/sqliteD1.js"

const migrationPaths = readdirSync("drizzle")
	.filter((file) =>
		/0002_.*\.sql|000[4-9]_.*\.sql|001[01345]_.*\.sql/.test(file)
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

const TS = "2026-09-17T00:00:00.000Z"
const thread = (over: Partial<HelperThreadSummary> = {}): HelperThreadSummary => ({
	id: "thread-1",
	guildId: "guild-1",
	channelId: "channel-1",
	userId: "user-1",
	helperKey: "kimi",
	helperName: "Kimi",
	questionText: "how does the quilt hash chain work",
	responseText: "fnv1a over prev seq cell op value ts mutation",
	thinkingLevel: "high",
	responseLength: 48,
	createdAt: TS,
	authorTag: "casey#1",
	authorUsername: "casey",
	lastMessageId: "msg-1",
	...over
})

let tmpDirs: string[] = []
afterEach(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
	tmpDirs = []
	resetTidepoolWalFailures()
})

describe("tidepool — ocean + ledger", () => {
	it("remember dual-writes: ocean section + WAL chain, read-back verified", async () => {
		const { owner } = createHarness()
		const ocean = new TidepoolOcean({ now: () => TS })
		const t = thread()
		const { section, entry, walRows } = await rememberHelperThread(
			ocean, owner as never, t, { mutationId: "remember:1", ts: TS }
		)
		expect(section).toContain(`## thread:${t.id}`)
		expect(entry.rememberedAt).toBe(TS)
		expect(walRows.length).toBeGreaterThan(0)
		// chain verifies against hermit's own verifier
		expect(verifyChain(walRows).ok).toBe(true)
		// L1 law: channel + helper endpoints bound before the thread links them
		expect(walRows[0].cell).toBe(`channel.${t.channelId}`)
		expect(walRows[1].cell).toBe(`helper.${t.helperKey}`)
		const cells = walRows.map((r) => r.cell)
		expect(cells).toContain(`thread.${t.id}.question`)
		expect(cells).toContain(`thread.${t.id}.response`)
		expect(cells).toContain(`thread.${t.id}.rememberedAt`)
		owner.close()
	})

	it("channel sweep: one mutation_id, one batch, all threads", async () => {
		const { owner } = createHarness()
		const ocean = new TidepoolOcean()
		const threads = [
			thread({ id: "a", questionText: "q-a" }),
			thread({ id: "b", questionText: "q-b" }),
			thread({ id: "c", questionText: "q-c" })
		]
		const { remembered, walRows } = await rememberChannelThreads(
			ocean, owner as never, threads, { mutationId: "remember:sweep1", ts: TS }
		)
		expect(remembered).toHaveLength(3)
		expect(new Set(walRows.map((r) => r.mutation_id)).size).toBe(1)
		expect(verifyChain(walRows).ok).toBe(true)
		expect(walRows.filter((r) => r.op === "link")).toHaveLength(6)
		owner.close()
	})

	it("recall: weighted scoring, tie to most recent, clamp 3..5, deterministic", async () => {
		let call = 0
		const stamps = ["2026-09-17T00:00:00.000Z", "2026-09-17T00:01:00.000Z", "2026-09-17T00:02:00.000Z"]
		const ocean = new TidepoolOcean({ now: () => stamps[call++] ?? TS })
		await ocean.remember(
			thread({ id: "q1", questionText: "quilt hash chain question" })
		)
		await ocean.remember(
			thread({
				id: "r1",
				questionText: "something else entirely",
				responseText: "the quilt hash chain answer"
			})
		)
		await ocean.remember(
			thread({ id: "old", questionText: "quilt hash chain", helperName: "Old" })
		)
		// question match weighs 2, response match weighs 1; tie breaks to most recent
		const top = await recallHelperContext(ocean, "quilt hash chain", { limit: 3 })
		expect(top.map((e) => e.id)).toEqual(["old", "q1", "r1"])
		// determinism — same query, same order
		const again = await recallHelperContext(ocean, "quilt hash chain", { limit: 3 })
		expect(again.map((e) => e.id)).toEqual(top.map((e) => e.id))
		// clamp: limit 99 → 5, limit 1 → 3
		expect((await recallHelperContext(ocean, "quilt", { limit: 99 })).length).toBeLessThanOrEqual(5)
		// no-match query returns nothing
		expect(await recallHelperContext(ocean, "zzz-no-such-token")).toEqual([])
	})

	it("quiet detection: pure, windowed, growth resets, unsorted input", () => {
		const polls: ThreadLengthPoll[] = [
			{ threadId: "t1", ts: "2026-09-17T03:00:00Z", messageCount: 7 },
			{ threadId: "t1", ts: "2026-09-17T02:00:00Z", messageCount: 7 },
			{ threadId: "t1", ts: "2026-09-17T00:00:00Z", messageCount: 5 },
			{ threadId: "t1", ts: "2026-09-17T01:00:00Z", messageCount: 7 },
			{ threadId: "t2", ts: "2026-09-17T00:00:00Z", messageCount: 1 },
			{ threadId: "t2", ts: "2026-09-17T01:00:00Z", messageCount: 2 }
		]
		const quiet = detectQuietThreads(polls)
		expect(quiet).toHaveLength(1)
		expect(quiet[0].threadId).toBe("t1")
		expect(quiet[0].silentPolls).toBe(3)
		expect(quiet[0].lastCount).toBe(7)
		expect(quiet[0].since).toBe("2026-09-17T01:00:00Z")
		// custom window
		expect(detectQuietThreads(polls, { window: 4 })).toHaveLength(0)
	})

	it("newlyQuietThreads: crossing-only — silence is remembered once", () => {
		const history: ThreadLengthPoll[] = [
			{ threadId: "fresh", ts: "2026-09-17T00:00:00Z", messageCount: 3 },
			{ threadId: "fresh", ts: "2026-09-17T01:00:00Z", messageCount: 3 },
			{ threadId: "fresh", ts: "2026-09-17T02:00:00Z", messageCount: 3 },
			{ threadId: "long", ts: "2026-09-17T00:00:00Z", messageCount: 9 },
			{ threadId: "long", ts: "2026-09-17T01:00:00Z", messageCount: 9 },
			{ threadId: "long", ts: "2026-09-17T02:00:00Z", messageCount: 9 },
			{ threadId: "long", ts: "2026-09-17T03:00:00Z", messageCount: 9 },
			{ threadId: "long", ts: "2026-09-17T04:00:00Z", messageCount: 9 }
		]
		const events = newlyQuietThreads(history)
		expect(events.map((e) => e.threadId)).toEqual(["fresh"])
	})

	it("drain: .quiet cells land in the WAL; helper_threads untouched", async () => {
		const { owner } = createHarness()
		await rememberHelperThread(
			new TidepoolOcean(), owner as never, thread(),
			{ mutationId: "remember:1", ts: TS }
		)
		const { walRows } = await drainQuietThreads(
			owner as never,
			[
				{
					threadId: "thread-1",
					silentPolls: 4,
					lastCount: 7,
					since: "2026-09-17T01:00:00Z",
					ts: "2026-09-17T04:00:00Z"
				}
			],
			{ mutationId: "stall-monitor:1", ts: "2026-09-17T04:00:00Z" }
		)
		expect(walRows).toHaveLength(1)
		expect(walRows[0].cell).toBe("thread.thread-1.quiet")
		expect(JSON.parse(walRows[0].value!)).toEqual({
			silentPolls: 4,
			lastCount: 7,
			since: "2026-09-17T01:00:00Z",
			ts: "2026-09-17T04:00:00Z"
		})
		// negative ledger: the live table has no row for an absence
		const rows = owner.database
			.query("select count(*) as n from helper_threads")
			.get() as { n: number }
		expect(rows.n).toBe(0)
		owner.close()
	})

	it("replay from WAL alone rebuilds the index; quiet survives alongside", async () => {
		const { owner } = createHarness()
		const ocean = new TidepoolOcean()
		await rememberHelperThread(
			ocean, owner as never, thread(),
			{ mutationId: "remember:1", ts: TS }
		)
		await drainQuietThreads(
			owner as never,
			[
				{
					threadId: "thread-1",
					silentPolls: 3,
					lastCount: 7,
					since: TS,
					ts: "2026-09-17T03:00:00Z"
				}
			],
			{ mutationId: "stall-monitor:1", ts: "2026-09-17T03:00:00Z" }
		)
		const all = owner.database
			.query(
				`select seq, mutation_id, ts, cell, op, value, prev_hash, hash
				 from quilt_wal order by seq`
			)
			.all() as never[]
		const replayed = replayThreadIndexFromWal(all)
		expect(replayed.size).toBe(1)
		const entry = replayed.get("thread-1")!
		expect(entry.questionText).toBe(thread().questionText)
		expect(entry.helperName).toBe("Kimi")
		expect(entry.userId).toBe("user-1") // WAL replay keeps what markdown drops
		expect(entry.quiet?.silentPolls).toBe(3)
		owner.close()
	})

	it("restart parity: markdown load and WAL replay agree on recall fields", async () => {
		const dir = mkdtempSync(`${tmpdir()}/tidepool-`)
		tmpDirs.push(dir)
		const path = `${dir}/ocean.md`
		const { owner } = createHarness()
		const ocean = new TidepoolOcean({ path, now: () => TS })
		await rememberHelperThread(
			ocean, owner as never, thread({ id: "t-parity" }),
			{ mutationId: "remember:1", ts: TS }
		)
		// byte-identical restart: markdown file reloaded
		const reloaded = await new TidepoolOcean({ path, now: () => TS }).load()
		expect(reloaded.stats().oathViolations).toBe(0)
		expect(reloaded.index.get("t-parity")?.questionText).toBe(
			thread({ id: "t-parity" }).questionText
		)
		// WAL replay agrees on every recall-relevant field
		const all = owner.database
			.query(
				`select seq, mutation_id, ts, cell, op, value, prev_hash, hash
				 from quilt_wal order by seq`
			)
			.all() as never[]
		const replayed = replayThreadIndexFromWal(all).get("t-parity")!
		const loaded = reloaded.index.get("t-parity")!
		for (const field of [
			"questionText",
			"responseText",
			"helperName",
			"helperKey",
			"channelId",
			"guildId",
			"rememberedAt"
		] as const) {
			expect(loaded[field]).toBe(replayed[field])
		}
		owner.close()
	})

	it("tip continuation: rows after a seq replay without duplication", async () => {
		const { owner } = createHarness()
		const ocean = new TidepoolOcean()
		await rememberHelperThread(
			ocean, owner as never, thread({ id: "t1" }),
			{ mutationId: "remember:1", ts: TS }
		)
		const tip = (
			owner.database.query("select max(seq) as tip from quilt_wal").get() as {
				tip: number
			}
		).tip
		await drainQuietThreads(
			owner as never,
			[
				{
					threadId: "t1",
					silentPolls: 3,
					lastCount: 7,
					since: TS,
					ts: "2026-09-17T03:00:00Z"
				}
			],
			{ mutationId: "stall-monitor:1", ts: "2026-09-17T03:00:00Z" }
		)
		const fresh = await readWalRowsSince(owner as never, tip)
		expect(fresh).toHaveLength(1)
		expect(fresh[0].cell).toBe("thread.t1.quiet")
		owner.close()
	})

	it("WAL failure posture: the memory survives, the failure is counted", async () => {
		const { owner } = createHarness()
		owner.database.run(`drop table quilt_wal`)
		const ocean = new TidepoolOcean()
		const { section, entry, walRows } = await rememberHelperThread(
			ocean, owner as never, thread(),
			{ mutationId: "remember:1", ts: TS }
		)
		expect(section).toContain("## thread:thread-1")
		expect(entry.helperName).toBe("Kimi")
		expect(walRows).toEqual([])
		expect(getTidepoolWalFailures()).toBe(1)
		owner.close()
	})

	it("oaths: append-only double-remember, timestamp audit, bot-action log", async () => {
		const ocean = new TidepoolOcean({ now: () => TS })
		await ocean.remember(thread({ questionText: "first version" }))
		await ocean.remember(thread({ questionText: "second version" }))
		const stats = ocean.stats()
		expect(stats.threadSections).toBe(2) // memory of a memory stays
		expect(stats.indexEntries).toBe(1) // latest wins for recall
		expect(ocean.index.get("thread-1")?.questionText).toBe("second version")
		expect(stats.oathViolations).toBe(0)
		const { ts, action } = await rememberBotAction(ocean, "swept channel-1")
		expect(ts).toBe(TS)
		expect(action).toContain(TS)
		expect(ocean.markdown).toContain("## bot-actions")
	})
})
