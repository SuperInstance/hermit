# Quilt Enhancement Audit — where SuperInstance tech greatly enhances hermit

- **Date:** 2026-09-20
- **Branch:** `readme-vision-audit` (docs-only; base `main` @ `adae217`)
- **Scope:** `src/quilt/`, `src/tidepool/`, call sites in `src/data/`, `src/index.ts`, `wrangler.jsonc`, fleet repos (quilt-studio, tidepool, twist-engine, gesture-kit, duke-lab, quilt-canon-cli)
- **Rules:** every claim cites a file actually read, pinned to the ref above. No behavior changes in this branch.

## Suite baseline on `main` @ `adae217`

`bun test`: **296 pass, 22 fail, 16 errors, 1 todo** (319 tests, 49 files). The failures are pre-existing and fall into three buckets:

1. **Broken import (16 errors across 15 test files).** `src/quilt/commit.ts:5-6` imports `projectNominationVote` and `VoteProjectionInput` from `./projection.js`; neither exists in `src/quilt/projection.ts`. Every test file that transitively imports `commit.ts` dies with `SyntaxError: Export named 'projectNominationVote' not found`. The export existed through `6c19e42` and was dropped by merge `707b1d5` (PR #4, "quilt kernel P4: adversarial-review fixes"). Main has been red since that merge.
2. **Test/code drift (2 failures).** `tests/quiltWalHash.test.ts:41,61` expect `verifyChain(rows)` to be `true`; `src/quilt/projection.ts:113` returns a `ChainVerification` object (`{ ok: true, ... }`).
3. **Environmental (4 failures).** The lobster artwork/asset tests shell out to `magick` and `dwebp`, which are absent in the audit sandbox. CI installs ImageMagick 7 and the WebP tools (README, CI/CD section), so these pass in CI.

This branch changes only `README.md` and adds this file; the suite result is unchanged.

---

## F1 — Restore the P1 vote seam and wire the ops spine (D1 write batches → kernel ops)

**Rank: 1** — deploy-blocking, one evening.

**WHAT EXISTS.** The commit seam is built and used: `src/quilt/commit.ts` wraps `appendBatch` in a CAS-guarded chain-tip read with optimistic retry (`QuiltChainConflictError`, single-batch `SELECT … FOR UPDATE` shape per the ledger docs). Call sites: `src/data/nominations.ts:248` (`commitNominationVoteProjection`), `src/data/lobsterEncounters.ts:142,510,573,679` (`commitProjection` for encounter/bind/publication/response), `src/tidepool/index.ts` (`rememberHelperThread`, plus `rememberChannelThreads` — N threads in ONE projection → ONE `mutation_id`, the hermit commit-batch shape). Ops counters: `src/quilt/ops.ts:35-58` (`recordWalCommit`, `recordWalFailure`, `getWalFailureCounts`, `getWalRowsCommitted`, `reconcileTick`). Drift detector: `src/quilt/reconcile.ts` (`reconcileQuiltWal`).

**WHAT'S MISSING.** Three gaps, all surfaced by the baseline above:
- `src/quilt/projection.ts` no longer exports `projectNominationVote` / `VoteProjectionInput` (dropped by `707b1d5`), so the vote path cannot bundle; 16 test errors.
- `recordWalCommit` has **zero callers** in `src/` — the rows-committed gauge is unwired.
- `reconcileTick` exists but is **not wired** into the Worker's `scheduled()` handler (`src/index.ts:167-174` runs expiry, grant recovery, card-sync recovery, and the thread monitor only), despite two crons being configured (`wrangler.jsonc:53` — `*/15 * * * *`, `0 */2 * * *`). The drift detector ships but never runs.
- Minor: the tidepool client counts failures locally (`src/tidepool/index.ts:8,35` — "forward-compatible with `src/quilt/ops.ts`"), but `"tidepool_projection"` is not in the `WalFailureKind` union (`src/quilt/ops.ts:10-18`), so wiring it as-is would be a type error.

**SMALLEST FIRST BUILD (one evening).** Restore the two exports to `src/quilt/projection.ts` (recoverable from git history, e.g. `git show 6c19e42:src/quilt/projection.ts`); align `verifyChain` callers or its return shape; add `"tidepool_projection"` to `WalFailureKind`; wire `reconcileTick(env)` and `recordWalCommit(rows.length)` into `scheduled()` behind the existing `*/15` cron. Suite goes green; the ledger starts reporting its own health.

---

## F2 — Project helper memories into the fleet tidepool (memory vectors → tidepool)

**Rank: 2** — high value, high feasibility, one evening.

**WHAT EXISTS.** `src/tidepool/index.ts:40-118` — the full local client: `rememberHelperThread` dual-writes (ocean markdown + WAL projection, returning the WAL rows read back from the ledger); `rememberChannelThreads` does batch projection; failures are caught and counted, never thrown into the helper path (the P1/P2 risk posture). `src/tidepool/ocean.ts` — append-only markdown ocean with token-overlap recall. `src/tidepool/stall.ts` — `detectQuietThreads` (window = 3 polls), projected as quiet-thread facts. `helper_threads` D1 table as the materialized view. The fleet target is specced: [SuperInstance/tidepool](https://github.com/SuperInstance/tidepool) — `POST /api/remember` (≤200-word distill, fire-and-forget), `GET /api/recall`, Cloudflare Vectorize embedding, `native` 16-number domain fingerprints.

**WHAT'S MISSING.** No HTTP client to the fleet ocean; recall is token-overlap only; there are no embeddings anywhere in hermit (a deliberate constraint, so the projection must distill, not embed).

**SMALLEST FIRST BUILD.** In `rememberHelperThread`'s success path, add a fire-and-forget `POST /api/remember` (kind: `playtest`/`session`, author: `hermit`, body: the thread summary distilled to ≤200 words), gated on an optional `TIDEPOOL_URL` env var. Absence of the var is a no-op — the local ocean stays authoritative. This is exactly the fleet protocol's "WRITE at task end, never blocks" rule.

---

## F3 — `quilt-doctor`: one command that replays the whole ledger (emergent)

**Rank: 3** — high value, very high feasibility, one evening.

**WHAT EXISTS.** All the pieces, tested separately: `verifyChain` (`src/quilt/projection.ts:113`), `reconcileQuiltWal` (`src/quilt/reconcile.ts`), refusal topology `analyzeRefusals` (`src/quilt/projection.ts:311`), `detectQuietThreads` (`src/tidepool/stall.ts`), ops counters (`src/quilt/ops.ts`), and a proven CLI pattern — `src/quilt/canon-ledger.ts` already runs as a script (`bun run src/quilt/canon-ledger.ts [repoPath]`, `import.meta.main` guard).

**WHAT'S MISSING.** No operator-facing digest. The "ledger reports its own health" doctrine (P5) covers the vote path's counters, but nothing replays the WAL end-to-end and prints fleet health; today that knowledge only exists inside per-piece tests.

**SMALLEST FIRST BUILD.** `src/quilt/doctor.ts` with the same CLI shape: replay the WAL, run reconciliation, print chain verification + drift summary + refusal topology + quiet-thread count + ops counters; exit non-zero on any red. Add one CI step. The canon ledger gains a sibling: one verifies the claim, the other verifies the body.

---

## F4 — Cadence surface → `commensurate.mjs` exact-rational tuning

**Rank: 4** — medium-high value, high feasibility, one evening.

**WHAT EXISTS.** The cadence surface: action cooldowns (`src/data/actionCooldowns.ts`, consumed at `src/data/lobsterEncounters.ts:16-19`; refusal rows are first-class negative-ledger facts, `src/data/lobsterEncounters.ts:100`), the stall detector (`src/tidepool/stall.ts`, window 3), Worker crons (`wrangler.jsonc:53` — every 15 minutes and every 2 hours), `THREAD_LENGTH_CHECK_INTERVAL_HOURS` (README Setup). The instrument: `commensurate.mjs` ([SuperInstance/quilt-studio](https://github.com/SuperInstance/quilt-studio), `packages/quilt-floor/src/commensurate.mjs`) — `floatToRat` (f64 bits → exact BigInt rational), Stern–Brocot search, nearest small-denominator rational, exact tie-breaks.

**WHAT'S MISSING.** All cadence constants are raw integers scattered across config, env, and defaults. Nothing checks whether the 15-minute cron and the 2-hour monitor land on commensurate points relative to cooldown expiry — the duke-lab/q16 doctrine (tune against a measured ruler) is unapplied to time.

**SMALLEST FIRST BUILD.** Extract every cadence constant into one table expressed as exact rationals (cooldown seconds, poll intervals, expiry windows) with the poll:cooldown ratios snapped to small denominators via `commensurate.mjs`. Pure config move; no behavior change until ratios are deliberately retuned.

---

## F5 — Reply-honesty metering → twist-engine σ-shear / gesture-kit torsion

**Rank: 5** — high value, medium feasibility (the geometry needs defining without embeddings).

**WHAT EXISTS.** Deterministic reply engines (slap, lobster) whose outputs are seed-reproducible; helper-log response recording; the refusal analyzer (`src/quilt/projection.ts:311`); token-overlap recall (`src/tidepool/ocean.ts`). Instruments: twist-engine's registration R(θ) — mean gaussian alignment, σ-shear at σ = 0.24·s, S = 1 − R, commensuration comb — computed, never asserted ([SuperInstance/twist-engine](https://github.com/SuperInstance/twist-engine)); gesture-kit's order-by-order path geometry ([SuperInstance/gesture-kit](https://github.com/SuperInstance/gesture-kit)) — `arcLength`/`heading` (1st), `bendingEnergy` (2nd), `twistEnergy` (3rd: **torsion**, turning out of the plane).

**WHAT'S MISSING.** No instrument measures whether a bot reply's trajectory through reply-space stays honest to the history it claims to summarize. A reply can be fluent, on-topic, and still leave the plane of the record it cites.

**SMALLEST FIRST BUILD.** A shadow report, not a gate: project each reply and its claimed source thread as `Gesture`s through token-frequency space (hermit deliberately has no embeddings, so the geometry is vocabulary-shaped), compute `gestureDistance(reply, source)` and `twistEnergy(reply)`; flag replies with high torsion relative to their source alignment. Log the digest as a WAL `EFFECT` row. Name the law explicitly: a *twist* is the deliberate offset; *torsion* is the third-order measure of a path leaving its plane — conflating them corrupts both instruments.

---

## Terminology law

**Torsion ≠ twist.** A twist is the deliberate offset between identical layers (twist-engine's law: no new atoms, a new angle). Torsion is gesture-kit's third-order measure — turning *out of* the plane a path already bends in. Hermit's cadences are twists; hermit's replies can be metered for torsion. The two words must not be exchanged anywhere in fleet docs.

## Top 5, ranked

1. **F1** — Restore `projectNominationVote` + wire `reconcileTick`/`recordWalCommit`: main is red, the fix is one evening.
2. **F2** — Fire-and-forget tidepool projection: hermit's memories join the fleet ocean.
3. **F3** — `quilt-doctor` CLI: one command replays the ledger and reports fleet health.
4. **F4** — `commensurate.mjs` cadence tuning: exact rationals for poll/cooldown ratios.
5. **F5** — Reply-honesty metering: σ-shear/torsion digest of reply-vs-history as a shadow WAL effect.
