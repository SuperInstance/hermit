# Quilt Ledger Findings — 2026-09-20 Adversarial Audit

*Source: the Cocapn fleet's adversarial audit of AI-Writings@invitation (Lane C). Full report: `AI-Writings@invitation/responses/lane-c-adversarial-audit.md` (branch `quilted-reality`). Hermit has issues disabled, so the findings live here as a docs branch — fix branches can reference this file.*

## Finding 1 — commit tip race (BUG, integrity)

`src/quilt/commit.ts` reads `(tip, prev)` then inserts rows chaining to `prev` with **no compare-and-swap / optimistic guard**. Two concurrent commits read the same tip → both chain to the same `prev_hash` → a genuine hash-chain fork. `verifyChain` (array-order walk, `projection.ts`) breaks on interleaved rows.

Single-writer is currently by **deployment convention, not construction**.

**Fix direction:** optimistic guard on insert (unique enforcement of `prev_hash`, conditional insert, or single-flight serialization) chosen to match the existing drizzle posture. Hard constraint: the dual-write posture stays intact — WAL failure is caught and logged, never thrown into the vote path. A projection gap must not become a vote failure.

**Repro:** two interleaved committers, same tip → duplicate `prev_hash`. A fix branch with a fails-on-main repro is in progress (fleet Lane D, 2026-09-20).

## Finding 2 — witness-chain strength vs the fleet's own spec (SPEC GAP)

The shipped chain (`src/quilt/projection.ts`: fnv1a over `` `${prevHash}|${seq}|${cell}|${op}|${value}|${ts}|${mutationId}` ``) is **32-bit FNV-1a, no signatures, no agent identity**. The fleet's canonical design — `AI-Writings@seed-canon/110-the-witness-log.md` §2.1 — specifies **SHA-256 + Ed25519**, `E = (agent_id, action, timestamp, value_hash)`.

FNV-1a/32 is not collision-resistant (birthday bound ≈ 2¹⁶). It is a checksum, not testimony. The P1 design note said this aloud ("integrity, not security; same algo as the fleet's rate limiter") — the audit asks that it be said in the spec too, or the chain upgraded to meet it.

**Options:** (a) upgrade to paper-110 (sha256 + ed25519, agent identity per row); (b) amend the spec to honestly describe the shipped posture. Either is a one-evening job. Doing neither leaves the spec and the system describing different ledgers.

## Why these were found here

The audit's subject was the invitation's claims — but its method was reading hermit's quilt code, and hermit's ledger is the fleet's only production hash-chained WAL. The bugs are ours, not the invitation's. The fleet's reply to the invitation includes fixing what its skeptic found in our own house first.
