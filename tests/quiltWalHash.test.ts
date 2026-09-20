// Hash-posture pins for the quilt WAL — the executable half of
// docs/QUILT_WAL_HASH.md (Lane C finding 2, spec amendment).
//
// The fleet's paper-110 spec (AI-Writings seed-canon 110-the-witness-log.md
// §2.1) calls for SHA-256 + Ed25519 with agent identity per row. We ship
// FNV-1a/32, no signatures, no per-row agent identity — a checksum chain,
// not testimony. That deviation is now documented on purpose; these tests
// keep the documentation and the code from drifting apart.
import { describe, expect, it } from "bun:test"
import {
	buildWalRows,
	GENESIS,
	verifyChain,
	WAL_HASH_ALGORITHM,
	type WalRow
} from "../src/quilt/projection.js"

const event = (cell: string, value: unknown) => ({ kind: "bind", cell, value })

describe("quilt WAL hash posture", () => {
	it("pins the shipped algorithm identifier", () => {
		expect(WAL_HASH_ALGORITHM).toBe("fnv1a-32")
	})

	it("emits 32-bit FNV-shaped hashes (8 hex chars), tagged nowhere else", () => {
		const rows = buildWalRows(
			[event("nomination.1.status", "granting"), event("nomination.1.totals", { approvals: 1, declines: 0 })],
			{ mutationId: "m-1", ts: "2026-09-20T07:00:00Z", tip: 0, prevHash: null }
		)
		expect(rows).toHaveLength(2)
		for (const row of rows) expect(row.hash).toMatch(/^[0-9a-f]{8}$/)
		// chain links: row 2 chains onto row 1's hash, not GENESIS
		expect(rows[1].prev_hash).toBe(rows[0].hash)
	})

	it("chain verifies end-to-end and rejects a tampered value", () => {
		const rows = buildWalRows(
			[event("nomination.1.status", "granting"), event("nomination.1.completedAt", "2026-09-20")],
			{ mutationId: "m-2", ts: "2026-09-20T07:05:00Z", tip: 0, prevHash: null }
		)
		expect(verifyChain(rows)).toBe(true)
		const tampered: WalRow[] = rows.map((row, index) =>
			index === 1 ? { ...row, value: '"forged"' } : row
		)
		expect(verifyChain(tampered)).toBe(false)
	})

	it("genesis continuity: rows built on an existing tip chain onto its prev", () => {
		const first = buildWalRows([event("a.cell", 1)], {
			mutationId: "m-3",
			ts: "2026-09-20T07:10:00Z",
			tip: 0,
			prevHash: null
		})
		const second = buildWalRows([event("a.cell", 2)], {
			mutationId: "m-4",
			ts: "2026-09-20T07:11:00Z",
			tip: first[0].seq,
			prevHash: first[0].hash
		})
		expect(verifyChain([...first, ...second])).toBe(true)
	})

	it.todo(
		"upgrade (docs/QUILT_WAL_HASH.md): algo-tagged sha256 rows verify by tag alongside fnv1a32 history"
	)
})
