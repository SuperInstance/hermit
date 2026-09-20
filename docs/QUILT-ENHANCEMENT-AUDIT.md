# Quilt Enhancement Audit — beyond the merged spine

*Lane AB² · 2026-09-20 · branch `readme-vision-audit` (from `main @ adae217`). Every claim was re-verified by local-clone grep and `bun test` in the Lane AB² sandbox — not via `gh code search`, whose index is stale on this repo (a warning worth repeating: one earlier verification pass believed `projectNominationVote` present on main because code search said so; the local clone and the test suite prove otherwise — see F1).*

**Method:** clone at pinned ref `adae217` → `bun install` → `bun test` → grep every claim. No code changes on this branch — every fix here is a recipe, not a commit.

---

## Test baseline at `adae217` (verified this audit, Lane AB² sandbox)

Command: `bun install && bun test` (fresh sandbox: deps installed, `forms:css` codegen not run, ImageMagick/WebP absent).

Bun's summary: **262 pass · 25 fail · 19 errors · 1 todo — 288 tests across 49 files.**

Error taxonomy (the 19 file-level errors):

| Bucket | Count | Cause |
|--------|-------|-------|
| Missing-export `SyntaxError` | ~15 files | `src/quilt/commit.ts:5` imports `projectNominationVote` / `VoteProjectionInput` from `./projection.js`; `src/quilt/projection.ts` at `adae217` (415 lines, 19 exports) has neither. Affects every quilt-kernel suite plus the nomination suites (`quiltKernelOps`, `quiltKernelReplay`, `quiltKernelReconcile`, `quiltKernelEncounters`, `quiltKernelTidepool`, `quiltKernelReviewFixes`, `quiltCommitConcurrency`, `nominationVoting`, `nominationRoleGrant`, `nominationExpiry`, `nominationCardSync`, `nominationReviewCard`, `nominateCommand`, …) |
| Missing forms build artifact | remainder | `Cannot find module '../styles.generated.js'` (`src/forms/components/Layout.tsx:2`) — fixed by `bun run forms:css` (package.json:20). Sandbox-only; CI and a normal dev setup run the codegen |

Named failures (the 6 unique `(fail)` lines):

| Test | File:line | Cause |
|------|-----------|-------|
| chain verifies end-to-end / genesis continuity | `tests/quiltWalHash.test.ts:41,61` | `verifyChain` returns a `ChainVerification` object (`{ok:true}` / `{ok:false,firstBadSeq}`, `src/quilt/projection.ts:113-127`); the tests assert `.toBe(true/false)`. Real test/code drift — F1's build fixes it |
| 4 lobster-art failures | `tests/lobster*.test.ts` | `magick`/`dwebp` binaries absent in this sandbox. CI installs both (`.github/workflows/ci.yml`, step "Install artwork test tools") — environmental, not defects |

**Conclusion: `main` is red, and the red is structural, not environmental.** The missing export is a load-time `SyntaxError`: any import of `src/quilt/commit.ts` (i.e., every nomination vote write path) throws before first use.

---

## F1 — Restore the vote projection seam (P0; one commit)

**WHAT EXISTS.** `commitNominationVoteProjection` is the vote-path projection entrypoint (`src/quilt/commit.ts`), called from `src/data/nominations.ts:248` on every vote write. It is fully implemented and imported.

**WHAT'S MISSING.** Its row-builder. `src/quilt/commit.ts:3-7` imports `buildWalRows, projectNominationVote, type VoteProjectionInput, type WalRow` from `./projection.js`, but `src/quilt/projection.ts` at `adae217` exports neither `projectNominationVote` nor `VoteProjectionInput` (19 exports, verified by grep; remote cross-checked via `raw.githubusercontent.com/SuperInstance/hermit/adae217/src/quilt/projection.ts` — identical 415-line file, so the clone is not the artifact). Both existed at `cb8a35c` (`VoteProjectionInput` line 46, `projectNominationVote` line 71) and `6c19e42` — the merge chain that produced `adae217` dropped them.

**SMALLEST BUILD (one commit, before F2–F5 matter):**

```
git show cb8a35c:src/quilt/projection.ts        # recovery source
```

Re-add `VoteProjectionInput` + `projectNominationVote` from `cb8a35c:src/quilt/projection.ts` (lines 46–95) into the current file — **surgical re-add, not a wholesale file restore**: current `projection.ts` carries newer `buildWalRows` edge-synthesis and `verifyChain` shape that must not be reverted. Then either adapt `verifyChain`'s return to the tests' boolean expectation (`tests/quiltWalHash.test.ts:41,61`) or update those two assertions to `.toEqual({ok:true})` / `{ok:false, firstBadSeq:…}` — the object shape is newer and richer, so amending the tests is the honest direction. Acceptance: `bun test` green except the sandbox-environment buckets above.

**Why this ranks first:** main is red. Every other enhancement rides a green suite.

---

## F2 — Memory vectors: tidepool ocean → fleet tidepool + Vectorize

**WHAT EXISTS.** `src/tidepool/index.ts` (the hermit-facing tidepool v1 API: `rememberHelperThread`, dual-write to ocean markdown + quilt WAL, lines 35-62), `src/tidepool/ocean.ts`, `src/tidepool/projection.ts` (`projectHelperThread`, `projectQuietThread`, `readWalRowsByMutation`), `src/tidepool/stall.ts` (quiet-thread detector). The fleet target is specced in [SuperInstance/tidepool](https://github.com/SuperInstance/tidepool): `POST /api/remember {kind, author, title, body, native?, repo?, run?}` with a ≤200-word distill at task end (README lines 13-15), `GET /api/recall?q=...` hybrid recall (line 17), Cloudflare Vectorize indexes `tidepool-native` (16-dim structural fingerprints, `wrangler vectorize create tidepool-native --dimensions=16 --metric=cosine`) and `tidepool-semantic` (768-dim BGE at write time).

**WHAT'S MISSING.** Hermit's tidepool never leaves the machine: ocean markdown lives in-repo, `src/tidepool/index.ts:35` (`let walFailureCount = 0`) counts WAL projection failures into a local counter whose own docstring (lines 8-10) says it wires into `recordWalFailure("tidepool_projection")` "when PR #5 lands" — PR #5 **has** landed (`src/quilt/ops.ts`), but the `WalFailureKind` union (`src/quilt/ops.ts:10-18`) still lacks `"tidepool_projection"`, so the counter still goes nowhere. No Vectorize binding exists in `wrangler.jsonc`; nothing embeds helper-thread memory bodies.

**SMALLEST BUILD (one evening):** add `"tidepool_projection"` to the `WalFailureKind` union and call `recordWalFailure("tidepool_projection", e)` at the catch site (`src/tidepool/index.ts:51`, the `rememberHelperThread` catch whose local counter sits at :35), replacing the local counter — the seam the file's own comment already promises. Then a `client → /api/remember` relay behind the existing bearer-token posture (mirror `src/server/helperLogsServer.ts:66-82`): `kind:"helper_thread"`, `body` = the ≤200-word distill of the thread, `native` = the 16-number domain fingerprint the ocean already derives per section. Binds `hermit-tidepool` + `tidepool-native`/`tidepool-semantic` Vectorize indexes in `wrangler.jsonc`. Test: extend `tests/quiltKernelTidepool.test.ts` to assert the failure kind increments once per forced projection throw.

**Why this ranks second:** it converts hermit's conversational memory from write-only journaling into the fleet's recallable ocean — the "memory surface" half of the mission statement, made true.

---

## F3 — Ship the ops counters: wire `reconcileTick` into cron + export health (P0; one cron line + one handler)

**WHAT EXISTS.** `src/quilt/ops.ts` is complete and honest: `recordWalFailure(kind, error)` (line 36), `getWalFailureCounts()` (line 45), `recordWalCommit(rows)` (line 53), `getWalRowsCommitted()` (line 60), and `reconcileTick(client)` (line 66) — a cron-ready wrapper around the reconciliation pass that returns a summary instead of throwing. Its docstring names the intended caller: "Scheduled handlers (`wrangler: [triggers] crons`) call this."

**WHAT'S MISSING.** Nothing calls them. `grep -rn "recordWalCommit" src/` finds zero call sites outside `ops.ts`; `reconcileTick` is not wired into the `scheduled()` handler (`src/index.ts:167-176` runs nomination expiry/recovery/card-sync + thread-length monitor only); `wrangler.jsonc:52-54` fires `"*/15 * * * *"` and `"0 */2 * * *"` with no quilt reconcile beat. The counters are a dashboard no cron ever reads. Also unwired: `src/quilt/canon-ledger.ts` (canon upkeep — candidate (d) below) runs only as a manual script (`import.meta.main`, line 227; `process.exit(1)` on failure, line 231) with no CI step (`.github/workflows/ci.yml` has no canon step; package.json has no canon script).

**SMALLEST BUILD (one evening):** (1) in `src/index.ts` `scheduled()`, add `ctx.waitUntil(reconcileTick(client))` on the 2-hour cron (`controller.cron === "0 */2 * * *"`); (2) extend `src/server/helperLogsServer.ts` with `/api/quilt/health` returning `{failureCounts, rowsCommitted, lastReconcile}` from the ops getters, bearer-gated like `/api/events`; (3) add a CI step running `bun run src/quilt/canon-ledger.ts` so canon drift fails the build — one line, subsumes candidate (d). No schema change; no new table. Test: one test asserting `reconcileTick` runs on the 2-hour tick and increments `getWalRowsCommitted()`.

**Why this ranks third:** it turns the spine's health from "log and forget" into an alertable signal — and it is the cheapest possible build on this list.

---

## F4 — Helper-thread cadence: a commensurate pattern for cooldown + stall intervals

**WHAT EXISTS.** The cadence machinery is real and tunable-but-unmeasured: action cooldowns as chosen constants (`src/data/actionCooldowns.ts:1-15` — `actionCooldownDurations`, `actionCooldownExpiries`), the thread-length monitor's poll horizon (`src/services/threadLengthMonitor.ts:26` — `THREAD_LENGTH_CHECK_INTERVAL_HOURS`, env-tunable, asserted), the quiet-thread stall detector (`src/tidepool/stall.ts:28` — `detectQuietThreads`, `{window = 3}` asserted), and refusal outcomes (`src/services/slapEngine.ts:46,187`) that are already first-class WAL rows (`src/quilt/projection.ts:186-228` — *"the reef of encounters that never were"*). The fleet's doctrine source is [SuperInstance/twist-engine](https://github.com/SuperInstance/twist-engine): *"Five substrates, one law… each with a live ledger measuring the emergent quantity instead of asserting it"* (README). Its TWIST substrate measures registration R(θ) *"computed, never asserted… kept honest by `tests/sim.test.js`"* and derives the **commensuration comb** — evenly spaced teeth where the supercell revives.

**WHAT'S MISSING.** Hermit has no commensurate instrument. No script reads the WAL's own cadence topology (refusal rows, stall clusters, TICK beats) to tune `actionCooldownDurations`, the monitor horizon, or the stall window — all three are asserted values sitting on top of a ledger that already records the material they govern. The fleet's exactness tool for the tooth-spacing question already exists: [SuperInstance/quilt-studio](https://github.com/SuperInstance/quilt-studio) `packages/quilt-floor/src/commensurate.mjs` (verified: f64 bits → exact BigInt rational via `floatToRat`, Stern–Brocot search to the nearest small-denominator rational, tie-broken exactly) — the cadence report should borrow that arithmetic, not re-derive it with float tolerance.

**SMALLEST BUILD (one evening):** `scripts/cadence-report.mjs` — offline analysis over `quilt_wal`: bin refusal/EFFECT/TICK rows by window (1h/6h/24h), fit the cadence comb's tooth spacing with commensurate.mjs's exact rational arithmetic (vendored or imported — it is one file), and write `docs/cadence-report.md` with recommended cooldown/interval values plus the measured residue. Run weekly; adopt a value only when the report supports it. Test: extend `tests/quiltKernelOps.test.ts` with a fixture WAL where a known cadence produces a known recommendation. No runtime dependency on twist-engine or quilt-studio — the doctrine and the arithmetic are imported, the instrument is hermit's own.

> **Audit integrity note.** An earlier draft of this finding cited `commensurate.mjs` inside twist-engine with a 12-field reading schema. Verified against every branch of that repo: absent. The schema belonged to gesture-kit; the arithmetic belongs to quilt-studio; the doctrine belongs to twist-engine. All three citations above are verified at their real homes.

**Why this ranks fourth:** cheap, offline, and it makes every other cadence decision on this list defensible — values tuned against the ledger instead of asserted over it.

---

## F5 — Reply honesty: an instrument channel over the refusal ledger

**WHAT EXISTS.** The material is already honest: refusal rows are first-class WAL citizens (*"the refusal rows ARE the cooldown topology"*, `src/quilt/projection.ts:186-228`), refusal outcomes are scored in the engines (`src/services/slapEngine.ts:46,187`; `src/services/lobsterEngine.ts`), quiet threads are detected on a fixed window (`src/tidepool/stall.ts:28`), and the thread monitor runs on its env-tunable horizon (`src/services/threadLengthMonitor.ts:26`). Everything hermit needs to *measure* conversational strain is in the ledger; what it does with it is nothing — the cadences stay fixed regardless.

**WHAT'S MISSING.** The instrument channel. The fleet doctrine (twist-engine README) is *computed, never asserted* — the ledger measures the emergent quantity and the instrument reads the same quantity the curve claims. Hermit asserts reply cadence health; it never computes it from the refusal/stall material it already records.

**SMALLEST BUILD (one evening):** `scripts/reply-honesty.mjs` — offline; reads refusal/stall/EFFECT topology per thread window from `quilt_wal` as an ordered sequence of numeric vectors (refusal rate, stall flag, effect burst size per tick) and runs [SuperInstance/gesture-kit](https://github.com/SuperInstance/gesture-kit)'s path geometry over it (verified API: `g.arcLength()`/`g.heading()` 1st order, `g.bendingEnergy()` 2nd, `g.twistEnergy()` 3rd — torsion, turning that leaves the plane). Flags threads where 3rd-order torsion diverges from the cadence expectation and writes `docs/reply-honesty.md` with per-thread flags + the aggregate residue. Test: fixture WAL with known divergence → known flag, asserted via `bun test`. No runtime dependency — offline analysis only, like F4.

> **Audit integrity note.** An earlier draft attributed the field names (`twistEnergy`, `bendingEnergy`) to twist-engine. They are gesture-kit's methods (verified in its README); twist-engine contributes the *computed, never asserted* doctrine. Cited at their real homes above.

**Why this ranks fifth:** it closes the loop between what hermit does (replies on cadence) and what its own ledger says the material did (strained or not) — the honesty layer the fleet's doctrine demands.

---

## Candidates evaluated and deferred

The brief's candidates (d) canon-ledger upkeep and (e) guild forms → VIEW projections were verified in-tree and deferred — with reasons, per the audit's rules:

**(d) Canon-ledger upkeep — deferred, folded into F3.** Verified: `src/quilt/canon-ledger.ts` runs as a manual script (`import.meta.main:227`, `exit(1)` on replay failure:231) against `CANON.md` front matter (`canon:1`, `feeds:[tidepool, duke-lab]`, `owed_by:[quilt]`, `canonical_docs:[README.md, drizzle/0013_quilt_kernel_wal.sql, src/quilt/commit.ts]`), replaying the git log with an FNV-1a 64 hash. It fails the replay if a canonical doc is removed or a claim drops a feed while kernel commits still exist. But nothing runs it: no CI step (`.github/workflows/ci.yml`), no package.json script. Rather than rank it alone, its one-line CI build rides F3 — same step, same evening.

**(e) Guild forms → VIEW projections — deferred, rank #6.** Verified: the forms surface is real and busy (`forms.config.ts` — ban/mute appeals, ClawHub appeals, moderator reports, review roles), but `grep -rn "quilt\|wal" src/forms/` returns nothing: form submissions, reviews, accept/deny transitions write D1 rows and never touch the ledger. The seam is a VIEW projection per form lifecycle beat (submission → review → verdict) riding `commitProjection` exactly like encounters do (`src/data/lobsterEncounters.ts:142,510,573,679`). Deferred because the review semantics (what does a denied appeal *mean* in WAL terms — EFFECT? a negative ledger entry like encounters' shadow?) deserve a design pass before a build, and F1–F5 all outrank it on value×feasibility today. If picked up: start with moderator reports only — the smallest form with the crispest lifecycle.

---

## Summary — top 5, ranked

| # | Enhancement | One line |
|---|-------------|----------|
| F1 | Restore the vote projection seam | `main` is red: re-add `projectNominationVote`/`VoteProjectionInput` from `cb8a35c` — surgical, one commit |
| F2 | Memory vectors → fleet tidepool | WAL failure counter → `recordWalFailure("tidepool_projection")`; relay distilled helper memories to `/api/remember` + Vectorize |
| F3 | Ship the ops counters | `reconcileTick` on the 2-hour cron + `/api/quilt/health` + canon-ledger CI step |
| F4 | Cadence via commensurate pattern | Offline `scripts/cadence-report.mjs` tunes cooldown/interval constants against measured WAL topology |
| F5 | Reply honesty via torsion instrument | Offline `scripts/reply-honesty.mjs` flags threads where instrument reading disagrees with reply cadence |

*Deferred (verified, rank #6): guild forms → VIEW projections. Folded into F3: canon-ledger CI step.*
