// reconcile.ts — replay-verify reconciliation between the quilt WAL and
// live D1. The dual-write is two sequential batches: D1 commits, then the
// WAL commits. The window between them is where drift can live. This
// module is the detector that closes the loop: replay the ledger, diff
// against the rows, report every divergence field-by-field.
//
// Posture: reconciliation never mutates and never throws on mismatch —
// a mismatch IS the deliverable. A broken chain, though, voids the
// ledger's testimony: refuse to reconcile against tampered history.
import {
	replayEncounterFromWal,
	replayNominationFromWal,
	verifyChain,
	type WalRow
} from "./projection.js"
import type { NominationDatabase } from "../data/nominations.js"
import type { LobsterDatabase } from "../data/lobsterEncounters.js"

export type WalMismatch = {
	entity: "nomination" | "encounter"
	id: number
	field: string
	wal: unknown
	d1: unknown
}

export type ReconcileResult =
	| {
			ok: true
			checked: { nominations: number; encounters: number }
			mismatches: WalMismatch[]
	  }
	| { ok: false; reason: "chain_broken"; firstBadSeq: number | null }

// Entity discovery uses the bare-cell bind's kind field, never regexes on
// ids: production interaction ids are numeric snowflakes, so cell shape
// alone cannot distinguish attempt cells from entity cells.
const discoverEntities = (rows: WalRow[]) => {
	const nominations = new Set<number>()
	const encounters = new Set<number>()
	for (const row of rows) {
		if (row.op !== "bind") continue
		// sub-cells (a.b.c) are properties, not the bare entity bind
		if (row.cell.split(".").length !== 2) continue
		let value: { kind?: string; id?: number } = {}
		try {
			value = JSON.parse(row.value ?? "{}")
		} catch {
			continue
		}
		if (value.kind === "nomination" && Number.isInteger(value.id)) {
			nominations.add(Number(value.id))
		} else if (
			value.kind === "lobster-encounter" &&
			Number.isInteger(value.id)
		) {
			encounters.add(Number(value.id))
		}
	}
	return { nominations, encounters }
}

const byReviewer = <T extends { reviewerId: string }>(votes: T[]) =>
	[...votes].sort((a, b) => a.reviewerId.localeCompare(b.reviewerId))

export const reconcileQuiltWal = async (
	database: NominationDatabase & LobsterDatabase,
	walRows: WalRow[],
	readers: {
		getNominationReviewState: (
			id: number
		) => Promise<{
			nomination: { status: string; completedAt: string | null }
			votes: Array<{ reviewerId: string; choice: string }>
			totals: { approvals: number; declines: number }
		} | null>
		getLobsterEncounter: (
			id: number
		) => Promise<{
			actorId: string
			targetId: string
			speciesDisplayName: string
			publicationStatus: string
			messageId: string | null
			responseStatus: string
			responseType: string | null
			interactionId: string
		} | null>
	}
): Promise<ReconcileResult> => {
	const chain = verifyChain(walRows)
	if (!chain.ok) {
		return { ok: false, reason: "chain_broken", firstBadSeq: chain.firstBadSeq }
	}

	const { nominations, encounters } = discoverEntities(walRows)
	const mismatches: WalMismatch[] = []

	for (const id of nominations) {
		const replayed = replayNominationFromWal(walRows, id)
		const live = await readers.getNominationReviewState(id)
		if (!replayed || !live) {
			mismatches.push({
				entity: "nomination",
				id,
				field: "presence",
				wal: replayed ? "present" : "absent",
				d1: live ? "present" : "absent"
			})
			continue
		}
		const push = (field: string, wal: unknown, d1: unknown) => {
			if (JSON.stringify(wal) !== JSON.stringify(d1)) {
				mismatches.push({ entity: "nomination", id, field, wal, d1 })
			}
		}
		push("status", replayed.status, live.nomination.status)
		push("completedAt", replayed.completedAt, live.nomination.completedAt)
		push("totals.approvals", replayed.totals.approvals, live.totals.approvals)
		push("totals.declines", replayed.totals.declines, live.totals.declines)
		push(
			"votes",
			byReviewer(replayed.votes),
			byReviewer(live.votes)
		)
	}

	for (const id of encounters) {
		const replayed = replayEncounterFromWal(walRows, id)
		const live = await readers.getLobsterEncounter(id)
		if (!replayed || !live) {
			mismatches.push({
				entity: "encounter",
				id,
				field: "presence",
				wal: replayed ? "present" : "absent",
				d1: live ? "present" : "absent"
			})
			continue
		}
		const push = (field: string, wal: unknown, d1: unknown) => {
			if (JSON.stringify(wal) !== JSON.stringify(d1)) {
				mismatches.push({ entity: "encounter", id, field, wal, d1 })
			}
		}
		push("actorId", replayed.actorId, live.actorId)
		push("targetId", replayed.targetId, live.targetId)
		push("species", replayed.species, live.speciesDisplayName)
		push("publication", replayed.publication, live.publicationStatus)
		push("message", replayed.message, live.messageId)
		push(
			"response",
			replayed.response?.type ?? null,
			live.responseStatus === "responded" ? live.responseType : null
		)
		push("interactionId", replayed.interactionId, live.interactionId)
	}

	return {
		ok: true,
		checked: { nominations: nominations.size, encounters: encounters.size },
		mismatches
	}
}
