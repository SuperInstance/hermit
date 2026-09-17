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
		if (event.cell === null) continue // tick/load carry no cell state
		seq += 1
		const op = event.kind === "unbind" ? "unbind" : event.kind
		const value =
			event.value === null || event.value === undefined
				? null
				: JSON.stringify(event.value)
		const hash = fnv1a(
			`${prevHash}|${seq}|${event.cell}|${op}|${value ?? ""}|${context.ts}|${context.mutationId}`
		)
		rows.push({
			seq,
			mutation_id: context.mutationId,
			ts: context.ts,
			cell: event.cell,
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
