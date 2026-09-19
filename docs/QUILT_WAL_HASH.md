# Quilt WAL Hash — Honest Spec Amendment (2026-09-20)

*Lane C of the fleet's adversarial audit (AI-Writings@invitation) found the
shipped witness chain and the fleet's own canonical spec describing two
different ledgers. This document is option (b) from
`docs/QUILT_LEDGER_FINDINGS.md` finding 2: **amend the spec honestly** so
the system and the spec stop lying to each other. Finding 1 (tip race) is
handled separately in PR #10.*

## What is shipped (this repo, today)

- `src/quilt/projection.ts` — 32-bit FNV-1a (unsigned, hex-padded to 8)
  over the canonical string
  `` `${prevHash}|${seq}|${cell}|${op}|${value}|${ts}|${mutationId}` ``
- No signatures. No per-row agent identity (`mutation_id` is a vote-batch
  id, not an agent key).
- `verifyChain` re-derives the same FNV string walk in array order.
- Algorithm pinned in code: `WAL_HASH_ALGORITHM = "fnv1a-32"`.

## What the fleet's spec says

`AI-Writings@seed-canon/110-the-witness-log.md` §2.1 specifies **SHA-256 +
Ed25519**, witness envelope `E = (agent_id, action, timestamp, value_hash)`.

That is a *signature chain* — testimony that survives adversaries. What
hermit ships is a *checksum chain* — it detects gaps, reordering, and
accidental tampering; it does not survive an attacker who can recompute
FNV-1a. Birthday bound ≈ 2¹⁶ rows.

## Why the deviation exists (said aloud, on purpose)

1. **The WAL is a dual-write.** The vote path catches WAL failure and logs
   it; it never throws into the vote. The chain's consumer is the replay
   referee (`tests/quiltKernelReplay.test.ts`), an integrity tool.
2. **Sync vs async.** FNV-1a is synchronous; the spec's SHA-256 +
   Ed25519 path is async (`crypto.subtle`). The P1 projection was built
   sync-on-purpose so the dual-write could not stall the vote path.
3. The P1 design note already said "integrity, not security" — the audit's
   ask was only that the spec say it where a reader will find it. This doc
   is that place.

## New risk, introduced by our own fix (load-bearing, not cosmetic)

PR #10 adds `UNIQUE INDEX quilt_wal_prev_hash_uidx` (drizzle 0014) to close
the tip-race fork. Side effect: **the first 32-bit FNV collision turns from
silent ambiguity into a hard insert deadlock.** With the birthday bound at
≈ 65k rows, the SHA-256 upgrade stops being hygiene and becomes the
ceiling on chain growth. Do not merge/deploy PR #10 without scheduling the
upgrade below.

## Upgrade path (the actual design, one switch)

Pinned at `WAL_HASH_ALGORITHM` in `src/quilt/projection.ts`:

1. **Algo-tagged hashes.** New rows carry `"fnv1a32:<hex>"` →
   `"sha256:<hex>"`; the tag is part of the hashed string for its own row
   only (prev_hash is carried verbatim, whatever its tag).
2. **Dispatch, not replace.** `verifyChain` walks per-row by tag — old rows
   still verify FNV, so existing D1 chains survive the transition without
   backfill.
3. **Async boundary moves once.** `buildWalRows` / `verifyChain` become
   async at the upgrade commit; the commit call-site already lives behind
   `await` in `commit.ts`, and the replay referee is test-side.
4. **Signatures last, optional, separate column.** Ed25519 agent identity
   is a schema addition (`agent_key`, `sig`), not a hash change — do it in
   the same migration only if cheap, otherwise as its own PR. The spec's
   envelope `E` is then satisfiable without another chain rewrite.

## Decision record

- **2026-09-20 — amend now (this doc), upgrade next.** The amendment is
  zero-risk to the vote path; the upgrade touches every hash in the chain
  and deserves its own PR with the fails-on-main repro pattern used by
  PR #10.
- The audit's full context: `AI-Writings@quilted-reality`
  `invitation/responses/lane-c-adversarial-audit.md`.
