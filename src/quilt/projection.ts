// projection.ts — the quilt kernel's first tenant in hermit.
//
// Revolution P1 (see docs/REVOLUTION.md when it lands): every durable
// ledger becomes a quilt cell-graph; D1 becomes the kernel's WAL. The
// nomination vote batch is the proof — the fleet's most safety-critical
// state machine, projected BIND-for-BIND into the 5-opcode spine, hash
// chained, replayable.
//
// Risk posture: the projection is a DUAL-WRITE. The existing guarded
// UPDATEs remain the source of truth; a WAL failure is caught and logged,
// never thrown into the vote path. The replay test is the referee.

// fnv1a — same algorithm the fleet's own rate limiter uses (tidepool).
// This is an INTEGRITY chain (detect gaps/tampering), not a security
// signature; P2 can upgrade to sha256 via crypto.subtle.
const fnv1a = (input: string): string => {
	let hash = 0x811c9dc5
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash.toString(16).padStart(8, "0")
}

export const GENESIS = "GENESIS"

export type WalRow = {
	seq: number
	mutation_id: string
	ts: string
	cell: string
	op: string
	value: string | null
	prev_hash: string
	hash: string
}

export type VoteProjectionInput = {
	nominationId: number
	reviewerId: string
	choice: "approve" | "decline"
	resultKind:
		| "recorded"
		| "switched"
		| "granting"
		| "declined"
		| "expired"
	status: string
	totals: { approvals: number; declines: number }
	completedAt: string | null
	mutationId: string
	ts: string
}

export type KernelLike = {
	bind(name: string, value?: unknown, meta?: unknown): unknown
	link(from: string, to: string, type: string): string
	unsubscribe?: () => void
}

// Mirror one recordNominationVote transition into kernel ops. Every write
// is a BIND; the voter's cell LINKs to the nomination cell ('cast').
export const projectNominationVote = (
	kernel: KernelLike,
	input: VoteProjectionInput
): void => {
	const base = `nomination.${input.nominationId}`
	// the nomination itself is a cell — link endpoints must exist (L1 law)
	kernel.bind(base, { id: input.nominationId, kind: "nomination" })
	kernel.bind(`${base}.mutation`, input.mutationId, { ts: input.ts })
	kernel.bind(`${base}.status`, input.status)
	kernel.bind(`${base}.totals`, input.totals)
	kernel.bind(`${base}.completedAt`, input.completedAt)
	if (input.resultKind !== "expired") {
		const voteCell = `${base}.vote.${input.reviewerId}`
		kernel.bind(voteCell, input.choice, { ts: input.ts })
		kernel.link(voteCell, base, "cast")
	}
}

// Turn drained kernel events into hash-chained WAL rows, continuing the
// chain from `tip` (0 for genesis) and `prevHash`.
export const buildWalRows = (
	events: Array<{ kind: string; cell: string | null; value: unknown }>,
	context: { mutationId: string; ts: string; tip: number; prevHash: string | null }
): WalRow[] => {
	const rows: WalRow[] = []
	let prevHash = context.prevHash ?? GENESIS
	let seq = context.tip
	for (const event of events) {
		// structural events carry no cell — synthesize an edge row so the
		// graph survives the WAL (replay ignores non-bind ops)
		let cell = event.cell
		let op = event.kind
		let value =
			event.value === null || event.value === undefined
				? null
				: JSON.stringify(event.value)
		if (cell === null) {
			const edge = event.value as { from?: string; to?: string; type?: string; id?: string } | null
			if (
				(event.kind === "link" || event.kind === "unlink") &&
				edge?.from &&
				edge?.to
			) {
				cell = `${edge.from}->${edge.to}`
				op = event.kind
				value = JSON.stringify({ id: edge.id ?? `${edge.from}->${edge.to}:${edge.type ?? ""}`, type: edge.type ?? null })
			} else {
				continue // tick/load carry no state
			}
		}
		seq += 1
		const hash = fnv1a(
			`${prevHash}|${seq}|${cell}|${op}|${value ?? ""}|${context.ts}|${context.mutationId}`
		)
		rows.push({
			seq,
			mutation_id: context.mutationId,
			ts: context.ts,
			cell,
			op,
			value,
			prev_hash: prevHash,
			hash
		})
		prevHash = hash
	}
	return rows
}

export const verifyChain = (rows: WalRow[]): boolean => {
	let prevHash = GENESIS
	for (const row of rows) {
		const expected = fnv1a(
			`${prevHash}|${row.seq}|${row.cell}|${row.op}|${row.value ?? ""}|${row.ts}|${row.mutation_id}`
		)
		if (row.prev_hash !== prevHash || row.hash !== expected) return false
		prevHash = row.hash
	}
	return true
}

// Replay the WAL for ONE nomination back into review-state shape, to diff
// against the live D1 rows. Only BINDs carry state; links are structural.
export type ReplayedNomination = {
	status: string
	totals: { approvals: number; declines: number }
	completedAt: string | null
	votes: Array<{ reviewerId: string; choice: "approve" | "decline" }>
	mutationId: string | null
}

export const replayNominationFromWal = (
	rows: WalRow[],
	nominationId: number
): ReplayedNomination | null => {
	const prefix = `nomination.${nominationId}.`
	const cells = new Map<string, unknown>()
	for (const row of rows) {
		if (row.op !== "bind" || !row.cell.startsWith(prefix)) continue
		cells.set(row.cell, row.value === null ? null : JSON.parse(row.value))
	}
	if (cells.size === 0) return null
	const status = cells.get(`${prefix}status`)
	if (typeof status !== "string") return null
	const votes: ReplayedNomination["votes"] = []
	for (const [name, value] of cells) {
		if (!name.startsWith(`${prefix}vote.`)) continue
		if (value === "approve" || value === "decline") {
			votes.push({ reviewerId: name.slice(prefix.length + 5), choice: value })
		}
	}
	const totals = cells.get(`${prefix}totals`)
	return {
		status,
		totals:
			totals && typeof totals === "object"
				? (totals as ReplayedNomination["totals"])
				: { approvals: 0, declines: 0 },
		completedAt: (cells.get(`${prefix}completedAt`) as string | null) ?? null,
		votes,
		mutationId: (cells.get(`${prefix}mutation`) as string | null) ?? null
	}
}

// ─── P2: the encounter machine, including its negative space ─────────────
//
// createLobsterEncounter gates the encounter insert on changes()=1 across a
// quadruple NOT EXISTS guard (actor / target / channel / already-exists).
// Most attempts in the wild are REFUSALS. The negative ledger makes a
// refusal a first-class WAL row: the reef of encounters that never were.
// H(N) > H(R): the absent encounters carry more structure than the
// present ones — the refusal rows ARE the cooldown topology.

export type EncounterProjectionInput = {
	resultKind: "created" | "existing" | "publication_failed" | "cooldown"
	interactionId: string
	attempt: {
		guildId: string
		channelId: string
		actorId: string
		targetId: string
	}
	// present when kind === "created"
	encounter?: {
		id: number
		speciesDisplayName: string
		publicationStatus: string
	}
	// present when kind === "cooldown": which guards fired
	refusedBy?: Array<"actor" | "target" | "channel">
	remaining?: Array<{ kind: string; remainingSeconds: number }>
	ts: string
}

export const projectLobsterEncounter = (
	kernel: KernelLike,
	input: EncounterProjectionInput
): void => {
	const base = `encounter.${input.interactionId}`
	kernel.bind(base, {
		kind: "lobster-encounter-attempt",
		guildId: input.attempt.guildId,
		channelId: input.attempt.channelId,
		actorId: input.attempt.actorId,
		targetId: input.attempt.targetId
	})

	if (input.resultKind === "cooldown") {
		// The negative ledger: this encounter does not exist, and that is
		// the information. The guard dimensions that fired are the payload.
		kernel.bind(`${base}.refused`, {
			refusedBy: input.refusedBy ?? [],
			remaining: input.remaining ?? [],
			ts: input.ts
		})
		return
	}

	if (input.resultKind === "created" && input.encounter) {
		const cell = `encounter.${input.encounter.id}`
		kernel.bind(cell, { id: input.encounter.id, kind: "lobster-encounter" })
		// the attempt cell and the encounter cell are one identity — the
		// kernel LINK is the changes()=1 linkage, made traversable
		kernel.link(base, cell, "resolved")
		kernel.bind(`${cell}.actor`, input.attempt.actorId)
		kernel.bind(`${cell}.target`, input.attempt.targetId)
		kernel.bind(`${cell}.species`, input.encounter.speciesDisplayName)
		kernel.bind(`${cell}.publication`, input.encounter.publicationStatus)
		kernel.bind(`${cell}.interaction`, input.interactionId)
		kernel.bind(`${cell}.createdAt`, input.ts)
		return
	}

	// existing / publication_failed: an idempotent retry. Presence of this
	// row marks the revisit; live D1 row remains the authority on status.
	kernel.bind(`${base}.retried`, input.ts)
}

export type ResponseProjectionInput = {
	encounterId: number
	responseType: "return_to_sender" | "offer_butter"
	responderId: string
	ts: string
}

export const projectLobsterResponse = (
	kernel: KernelLike,
	input: ResponseProjectionInput
): void => {
	const base = `encounter.${input.encounterId}`
	kernel.bind(`${base}.response`, {
		type: input.responseType,
		responderId: input.responderId,
		ts: input.ts
	})
}

export type PublicationProjectionInput = {
	encounterId: number
	kind: "bound" | "already_bound" | "publication_failed"
	messageId?: string
	failure?: string
	ts: string
}

export const projectLobsterPublication = (
	kernel: KernelLike,
	input: PublicationProjectionInput
): void => {
	const base = `encounter.${input.encounterId}`
	if (input.kind === "bound") {
		kernel.bind(`${base}.message`, input.messageId ?? null)
		kernel.bind(`${base}.publication`, "published")
	} else if (input.kind === "already_bound") {
		kernel.bind(`${base}.message`, input.messageId ?? null)
	} else {
		kernel.bind(`${base}.publication`, "publication_failed")
		kernel.bind(`${base}.failure`, input.failure ?? null)
	}
}

export type RefusalRecord = {
	interactionId: string
	actorId: string
	targetId: string
	channelId: string
	refusedBy: string[]
	remaining: Array<{ kind: string; remainingSeconds: number }>
	ts: string
}

// The negative-space instrument: walk the WAL and return every refused
// encounter attempt. This query is IMPOSSIBLE against live D1 — refusals
// leave no rows there. The ledger sees what the reef cannot.
export const analyzeRefusals = (
	rows: WalRow[],
	guildId?: string
): RefusalRecord[] => {
	const records: RefusalRecord[] = []
	for (const row of rows) {
		if (row.op !== "bind" || !row.cell.endsWith(".refused")) continue
		const payload = JSON.parse(row.value ?? "{}") as {
			refusedBy?: string[]
			remaining?: Array<{ kind: string; remainingSeconds: number }>
			ts?: string
		}
		const parts = row.cell.split(".")
		const interactionId = parts[1]
		const attemptRow = rows.find(
			(candidate) =>
				candidate.op === "bind" &&
				candidate.cell === `encounter.${interactionId}` &&
				candidate.seq < row.seq
		)
		const attempt = JSON.parse(attemptRow?.value ?? "{}") as {
			guildId?: string
			channelId?: string
			actorId?: string
			targetId?: string
		}
		if (guildId && attempt.guildId !== guildId) continue
		records.push({
			interactionId,
			actorId: attempt.actorId ?? "",
			targetId: attempt.targetId ?? "",
			channelId: attempt.channelId ?? "",
			refusedBy: payload.refusedBy ?? [],
			remaining: payload.remaining ?? [],
			ts: payload.ts ?? row.ts
		})
	}
	return records
}

// Replay an encounter's positive state from the WAL (created/bound/
// responded path). Refusals never reach here — that is the point.
export type ReplayedEncounter = {
	actorId: string | null
	targetId: string | null
	species: string | null
	publication: string | null
	message: string | null
	response: { type: string; responderId: string; ts: string } | null
	createdAt: string | null
	interactionId: string | null
}

export const replayEncounterFromWal = (
	rows: WalRow[],
	encounterId: number
): ReplayedEncounter | null => {
	const prefix = `encounter.${encounterId}.`
	const cells = new Map<string, unknown>()
	for (const row of rows) {
		if (row.op !== "bind" || !row.cell.startsWith(prefix)) continue
		cells.set(row.cell, row.value === null ? null : JSON.parse(row.value))
	}
	if (cells.size === 0) return null
	return {
		actorId: (cells.get(`${prefix}actor`) as string | null) ?? null,
		targetId: (cells.get(`${prefix}target`) as string | null) ?? null,
		species: (cells.get(`${prefix}species`) as string | null) ?? null,
		publication:
			(cells.get(`${prefix}publication`) as string | null) ?? null,
		message: (cells.get(`${prefix}message`) as string | null) ?? null,
		response:
			(cells.get(`${prefix}response`) as ReplayedEncounter["response"]) ??
			null,
		createdAt: (cells.get(`${prefix}createdAt`) as string | null) ?? null,
		interactionId:
			(cells.get(`${prefix}interaction`) as string | null) ?? null
	}
}
