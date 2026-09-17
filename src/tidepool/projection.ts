// projection.ts — tidepool's quilt WAL projection.
//
// The tidepool-specific projectors follow the hermit P1/P2 patterns:
// projectHelperThread mirrors projectNominationVote / projectLobsterEncounter
// (BIND-for-BIND, link endpoints must exist — L1 law); projectQuietThread
// mirrors the P2 `.refused` negative ledger — a quiet thread is an absence,
// and the absence is the information.
//
// Import, never duplicate: hash-chain primitives live in src/quilt/*.

import type { QuiltKernel } from "../quilt/reference-kernel.mjs"
import type { WalRow } from "../quilt/projection.js"
import type { HelperThreadSummary, OceanEntry } from "./ocean.js"
import type { QuietThread } from "./stall.js"

export type OceanIndexEntry = OceanEntry & {
	quiet?: {
		silentPolls: number
		lastCount: number
		since: string
		ts: string
	} | null
}

/**
 * Helper-thread memory projected BIND-for-BIND. The thread is a cell,
 * every field is a cell, the thread LINKs to its channel and helper
 * (endpoints bound first — L1 law), and the rememberedAt bind carries
 * {ts} meta provenance. One call = one mutation's worth of kernel events.
 */
export const projectHelperThread = (
	kernel: QuiltKernel,
	thread: HelperThreadSummary,
	ts: string
): void => {
	const base = `thread.${thread.id}`
	const channelCell = `channel.${thread.channelId}`
	kernel.bind(channelCell, { kind: "channel", guildId: thread.guildId })
	const helperCell = `helper.${thread.helperKey}`
	kernel.bind(helperCell, { kind: "helper", helperName: thread.helperName })

	kernel.bind(base, {
		kind: "helper-thread",
		id: thread.id,
		guildId: thread.guildId,
		channelId: thread.channelId,
		userId: thread.userId,
		helperKey: thread.helperKey,
		helperName: thread.helperName,
		createdAt: thread.createdAt
	})
	kernel.bind(`${base}.question`, thread.questionText)
	kernel.bind(`${base}.response`, thread.responseText)
	kernel.bind(`${base}.meta`, {
		thinkingLevel: thread.thinkingLevel,
		responseLength: thread.responseLength,
		authorTag: thread.authorTag,
		authorUsername: thread.authorUsername
	})
	kernel.bind(`${base}.lastMessage`, thread.lastMessageId)
	kernel.bind(`${base}.rememberedAt`, ts, { ts })
	kernel.link(base, channelCell, "lives-in")
	kernel.link(base, helperCell, "served-by")
}

/**
 * The negative ledger for the ocean: a thread whose message count stopped
 * growing. Mirrors hermit's P2 `.refused` cells — live D1 (helper_threads)
 * has no row for this; the WAL sees what the live table cannot.
 */
export const projectQuietThread = (
	kernel: QuiltKernel,
	quiet: QuietThread,
	ts: string
): void => {
	kernel.bind(`thread.${quiet.threadId}.quiet`, {
		silentPolls: quiet.silentPolls,
		lastCount: quiet.lastCount,
		since: quiet.since,
		ts
	})
}

/**
 * Replay the recall index from WAL rows ALONE. Only BINDs carry state; the
 * latest bind of each cell wins, so re-remembered threads refresh and
 * `.quiet` state survives alongside. (Pattern: replayNominationFromWal /
 * replayEncounterFromWal.) Pass rows read with readWalRowsSince for tip
 * continuation — replay(rows) is a pure fold.
 */
export const replayThreadIndexFromWal = (
	rows: WalRow[]
): Map<string, OceanIndexEntry> => {
	const cells = new Map<string, unknown>()
	for (const row of rows) {
		if (row.op !== "bind") continue
		cells.set(row.cell, row.value === null ? null : JSON.parse(row.value))
	}
	const index = new Map<string, OceanIndexEntry>()
	for (const [name, value] of cells) {
		if (!name.startsWith("thread.")) continue
		const rest = name.slice("thread.".length)
		const dot = rest.indexOf(".")
		const threadId = dot === -1 ? rest : rest.slice(0, dot)
		if (!index.has(threadId)) {
			index.set(threadId, { id: threadId } as OceanIndexEntry)
		}
		const entry = index.get(threadId)!
		if (dot === -1) {
			Object.assign(entry, (value ?? {}) as object)
		} else {
			const field = rest.slice(dot + 1)
			if (field === "question") entry.questionText = value as string
			else if (field === "response") entry.responseText = value as string
			else if (field === "meta") Object.assign(entry, (value ?? {}) as object)
			else if (field === "lastMessage") entry.lastMessageId = value as string
			else if (field === "rememberedAt") entry.rememberedAt = value as string
			else if (field === "quiet") entry.quiet = value as OceanIndexEntry["quiet"]
		}
	}
	return index
}

// ---- WAL read-back -------------------------------------------------------
//
// The public API returns the rows it actually wrote. The honest source is
// the WAL itself (the WAL is the source of truth), so we read back by
// mutation / by tip. The client adapter tolerates both SqliteD1Database
// (sync .all() -> T[]) and Cloudflare D1 (async .all() -> {results}).

type BoundStatement = {
	all: () => unknown
}
export type WalReadClient = {
	prepare: (query: string) => { bind: (...values: unknown[]) => BoundStatement }
}

const unwrap = (out: unknown): Array<Record<string, unknown>> => {
	if (Array.isArray(out)) return out as Array<Record<string, unknown>>
	const results = (out as { results?: Array<Record<string, unknown>> } | null)
		?.results
	return Array.isArray(results) ? results : []
}

export const readWalRowsByMutation = async (
	client: WalReadClient,
	mutationId: string
): Promise<WalRow[]> => {
	const stmt = client
		.prepare(
			`select seq, mutation_id, ts, cell, op, value, prev_hash, hash
			 from quilt_wal where mutation_id = ? order by seq`
		)
		.bind(mutationId)
	const out = await Promise.resolve(stmt.all())
	return unwrap(out) as unknown as WalRow[]
}

/** Tip continuation: rows strictly after `sinceSeq`, in chain order. */
export const readWalRowsSince = async (
	client: WalReadClient,
	sinceSeq: number
): Promise<WalRow[]> => {
	const stmt = client
		.prepare(
			`select seq, mutation_id, ts, cell, op, value, prev_hash, hash
			 from quilt_wal where seq > ? order by seq`
		)
		.bind(sinceSeq)
	const out = await Promise.resolve(stmt.all())
	return unwrap(out) as unknown as WalRow[]
}
