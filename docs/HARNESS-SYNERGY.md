# HARNESS-SYNERGY — hermit × pincher × lever-runner

**Lane AC design doc · 2026-09-20 · branch `harness-synergy` (from `main` @ `adae217`)**

> **HONEST STATUS (read this first):** All three repos are real and substantive — nothing here is designed against vapor. Two caveats, stated plainly:
> 1. **pincher is in maintenance.** Its last commit (`02ae9bd`, 2026-08-21) is a docs commit whose entire message is *"docs: point to quilt-pincher — the reflexes live on as reactive cells"* (pincher/README.md line 9 carries the same banner). The engine is complete (Rust workspace, 40 test-bearing files, e2e runtime test) but the fleet's active reflex work has moved to `quilt-pincher`. This doc treats pincher as the reference implementation of the reflex ability and flags where the quilt-pincher continuation changes the seam.
> 2. **hermit's quilt spine is already merged.** The task brief referenced "open PRs #1/#5/#6" — on GitHub those PRs are now closed/merged (issues are disabled on the repo). The 5-opcode spine + WAL, ops counters, and tidepool projections are all on `main` today (merge commits for PR #6 and PR #8 sit on `main`; `src/quilt/` and 10 quilt test files exist at `adae217`). Sequencing below is written against what is *merged*, not against PR states.
>
> Citation discipline: every claim cites a file at a pinned ref. Refs: hermit `adae217`, pincher `02ae9bd`, lever-runner `fbf447a`, the-tap `red-queen-design` branch (design doc self-verifies against `master @ 2528752`).

---

## 1. THE HARNESS PICTURE

Hermit is not a Discord bot that *could* have abilities. It is already the application's living surface: conversational memory (helper threads, tracked threads, D1 + Drizzle persistence), a quilt-kernel spine (`src/quilt/` — a hash-chained WAL over the five fleet opcodes BIND/LINK/EFFECT/VIEW/TICK, replayed and reconciled on cron), and a tidepool ocean (helper-thread memory projections). What it lacks is *hands*. Pincher and lever-runner are two mature, complementary abilities sitting one repo over: pincher is the **reflex shell** — intent meets pattern in <50 ms, no LLM, confidence-scored, veto-guarded; lever-runner is the **trust compiler** — teach a shell command once, run it forever by intent, three gates deep, LLM never sees the shell. The harness picture: hermit remains the surface and the ledger; pincher and lever-runner plug in as abilities whose every lifecycle beat — registration, invocation, state render, health — becomes a quilt op appended to the same WAL that already records nomination votes. The bot stops being a bot with features and becomes a **body with reflexes and hands**, where every reflex fire and every lever pull is hash-chained, fuel-metered, and replay-verifiable like every vote already is.

```
                    ┌────────────────────────────────────────────────────┐
                    │                    hermit                          │
                    │        the application's living surface            │
                    │                                                    │
                    │  conversational memory · helper threads (D1)       │
                    │  quilt WAL spine  src/quilt/  BIND LINK EFFECT     │
                    │                   VIEW TICK  hash-chained, CAS     │
                    │  tidepool ocean · helper-thread memories           │
                    │  surfaces: Discord · /api/events · /api/threads    │
                    └───────┬───────────────────────▲──────────────────┘
                            │ invoke (seam)         │ project (WAL rows)
              ┌─────────────┴──────────┐   ┌────────┴─────────┐
              │   ABILITY: pincher     │   │ ABILITY: lever-  │
              │   the reflex shell     │   │   runner         │
              │                        │   │   the trust      │
              │  Teach→Match→Execute   │   │   compiler       │
              │  <50ms, no LLM         │   │                  │
              │  confidence + veto     │   │  teach once,     │
              │  sqlite-vec 384-d      │   │  run forever     │
              │  .nail = agent bundle  │   │  3 gates, sandbox│
              └───────────┬────────────┘   │  trust-scored    │
                          │                └────────┬─────────┘
                   ┌──────▼──────┐          ┌───────▼───────┐
                   │ reflexes.db │          │ lever.lancedb │
                   │ (sqlite-vec)│          │ per-chat tbls │
                   └─────────────┘          └───────────────┘
```

The two abilities are complementary, not redundant: **pincher decides *that* you know how to respond; lever-runner decides *how* to safely *do* the pre-approved thing.** Pincher's MatchType bands (Exact ≥0.80 / Similar 0.55–0.80 / Novel <0.55, pincher/ARCHITECTURE.md §"Reflex Engine") are a routing decision; lever-runner's three gates (Rust fastloop 50µs → Python cache 200µs → LLM intent phrase 500ms, lever-runner/README.md "The insight") are an execution pipeline. In the harness, pincher is the spinal cord, lever-runner is the hand, hermit is the body that remembers everything either one does.

---

## 2. THE SEAM per ability

### 2.1 pincher — the reflex shell

**WHAT EXISTS (verified at `02ae9bd`):**
- Rust workspace, three members: `pincher-core`, `pincher-cli`, `hybrid-bridge` (pincher/Cargo.toml, `[workspace]`).
- Core engine in `pincher-core/src/reflex/`: `ReflexEngine` (Teach→Match→Execute), `Reflex`, `MatchType`, `MatchThresholds`, `Execution` (pincher/ARCHITECTURE.md §"Core Components").
- Embedding in `pincher-core/src/embed/`: ONNX Runtime (all-MiniLM-L6-v2) + hash fallback, 384-dimensional vectors (same doc).
- Persistence in `pincher-core/src/db/`: SQLite + sqlite-vec; `reflexes` table holds intents, embeddings, confidence, `invoke_count`, `action_sql`; plus sessions, actions, shell fingerprints (same doc).
- Safety: sandboxed execution (bubblewrap, Landlock) with a veto engine blocking dangerous patterns (pincher/ARCHITECTURE.md "Design Goals" #4). Additional modules present on disk: `sandbox/`, `security/`, `immunology/`, `kernel/`, `rpc/`, `carapace/`, `daemon.rs`, `updater.rs` under `pincher-core/src/`.
- Surfaces: `pincher-cli/src/main.rs` (CLI); `hybrid-bridge/src/` (`bridge.rs`, `engine.rs`, `chaos.rs`, `mock_matrix.rs`, `mock_room.rs`, `mock_veto.rs`, `ternary_bridge.rs`) — the bridge already speaks Matrix-shaped room protocols, which is hermit's native habitat shape (a Discord-bot worker).
- Portability: `.nail` file = tar.zst packing the entire agent identity (pincher/ARCHITECTURE.md "Design Goals" #3). lever-runner's `export_nail.py` produces `.nail` archives (manifest.json + reflexes.db + identity.json + config.toml) that it describes as "fully compatible with pincherOS's migration format" (lever-runner/README.md §"pincherOS Integration") — a de-facto fleet interchange format already.
- Tests: 40 Rust files containing `#[test]` (repo-wide grep), `tests/e2e_runtime_test.rs`, `pincher-core/tests/integration_tests.rs`, three hybrid-bridge test files, runnable examples (`teach_and_do.rs`, `kernel_bench.rs`).

**THE INTEGRATION SHAPE (chosen):** **sub-process over the existing CLI, with `.nail` bundles as the BIND payload.** Hermit is a Cloudflare Worker (package.json: `@buape/carbon`, wrangler) — it cannot embed a Rust runtime, and WASM is explicitly deferred (pincher's own successor `quilt-pincher` is where the cell-native reflex engine lives). The honest seam: hermit's `forwarder/` Bun process (the always-on companion that already forwards gateway events, hermit/README.md §"Gateway forwarder") shells out to `pincher-cli` for teach/match and consumes JSON. This matches how hermit already runs its long-lived companion. Rationale: zero new infrastructure, ability is versioned by its CLI, `.nail` bundles travel through the same WAL rows as everything else.

**DATA CONTRACT (quilt-shaped):**
- **In:** `{guild_id, channel_id, intent_text, author_id}` → pincher match request. Guild/channel map naturally onto pincher's session concept (reflexes.db `sessions`).
- **Out:** `{match_type: "exact"|"similar"|"novel", confidence, action_sql, veto: "pass"|"block", execution?: {exit_code, stdout_ms}}` — Execution shape is already first-class in the engine.
- **WAL projection:** one EFFECT row per fire: `{ability: "pincher", op: "EFFECT", fuel: 1 - confidence, payload: {match_type, invoke_count_delta}}`. invoke_count is already a column in the reflexes table — fuel-metering is a read of existing state, not new instrumentation.

### 2.2 lever-runner — the trust compiler

**WHAT EXISTS (verified at `fbf447a`):**
- Python package `lever_runner` (`pyproject.toml`, hatchling, Python ≥3.10). Last commit `fbf447a` "update store.py" (2026-08-08).
- Orchestrator API: `do()`, `teach()`, `status()`, `list_commands()` (src/lever_runner/orchestrator.py:42,199,220,225).
- **HTTP API already shipping:** `POST /run {request, chat_id}`, `POST /teach`, `GET /status?chat_id`, `GET /healthz`, stdlib `http.server`, default bind `127.0.0.1:8765`, optional bearer token, 60 rpm loopback rate limit (src/lever_runner/http_api.py module docstring + `PORT`/`BIND`/`API_TOKEN` at lines ≈38–41).
- Store: LanceDB, per-chat tables `commands_<chat_id>`, seed pack on first use, all-MiniLM-L6-v2 embeddings (src/lever_runner/store.py module docstring + `LANCEDB_PATH`, `LANCEDB_TABLE_PREFIX`).
- Executor: per-session sandbox `/tmp/lever-runner/<session_id>`, 30 s hard timeout, rlimits (CPU 30 s, AS 512 MB), minimal PATH, metacharacter blocklist, env whitelist (src/lever_runner/executor.py:26–45).
- Portability: `export_nail.py` → tar.zst (manifest + reflexes.db + identity.json + config.toml), .nail-compatible with the pincher ecosystem.
- Tests: 212 `def test_` across tests/ (repo-wide grep; the README badge still says 160 — the badge is stale, the count is real).
- Forward vision doc: `docs/FUTURE-INTEGRATION.md` already names the room-as-codespace direction and maps Gate 1/2/3 onto construct-core's BareMetal/Sync/Async tiers.

**THE INTEGRATION SHAPE (chosen):** **HTTP, loopback, via the forwarder — no new transport.** lever-runner ships an authenticated HTTP API; hermit's forwarder is a Bun process on the same machine class as the existing deployment ("usually running on Krill's machine", hermit/README.md). The forwarder calls `POST /run` with the Discord-derived `chat_id` (guild-scoped), relays `{command, exit_code, stdout}` back into the Worker response. This is strictly simpler than the pincher seam because lever-runner already *is* a server. Deferred: `lever-runner-wasm` exists in the org for browser deployment; irrelevant to hermit's worker.

**DATA CONTRACT (quilt-shaped):**
- **In:** `{guild_id → chat_id, request_text, author_id}`.
- **Out:** `GET /status?chat_id` → per-chat command/trust stats (VIEW source); `POST /run` → `{command, exit_code, stdout, stderr, duration_ms, trust_delta}`.
- **WAL projection:** one EFFECT row per execution: `{ability: "lever-runner", op: "EFFECT", fuel: duration_ms (or a normalized cost), payload: {trust_delta, exit_code}}`. Trust is already double-entry-ish (success +Δ / failure −Δ in the executor docstring) — the WAL makes it *triple*: what hermit saw, what lever did, what the chain hash proves.

---

## 3. QUILT INTEGRATION — the ability lifecycle as ops

All four beats reuse machinery already on `main` at `adae217`:

| Beat | What it does | hermit machinery it rides |
|------|--------------|---------------------------|
| **BIND** (register ability) | Ability declares itself to hermit; its identity (.nail manifest, or /healthz + version) is written as the first WAL rows | `src/quilt/commit.ts` `commitNominationVoteProjection` is the single existing writer pattern — ability commits add sibling projection builders in `src/quilt/projection.ts` |
| **EFFECT** (invoke, fuel-metered) | Every fire/execution appends hash-chained WAL rows; fuel = confidence spend (pincher) or time/trust (lever-runner) | The CAS-guarded single-batch chain (`commit.ts` — `WHERE NOT EXISTS` anchor guard, post-batch tip re-verify throwing `QuiltChainConflictError`, migration 0014's `UNIQUE INDEX` on prev_hash as durable backstop) extends to ability rows with **zero new concurrency semantics** |
| **VIEW** (state rendered) | Ability state surfaces in hermit's Discord + `/api/events` + `/api/threads` | Helper-logs server already exists (src/server/helperLogsServer.ts); ops counters `getWalFailureCounts()` / `getWalRowsCommitted()` (src/quilt/ops.ts) become the ability-health gauge |
| **TICK** (cadence/health) | Scheduled reconcile + self-improvement passes | `reconcileTick` is **already cron-ready** — ops.ts: "Scheduled handlers (`wrangler: [triggers] crons`) call this; it never throws" — and lever-runner already runs its own hourly `auto_promote.py` cron |

**Honest sequencing (against merged reality, not PR fantasy):**
1. **Now (post-PR #1, merged):** EFFECT seam for lever-runner. The WAL writer exists, the HTTP API exists. First ability rows land behind the existing `commit.ts` CAS machinery — a new `commitAbilityEffectProjection` next to `commitNominationVoteProjection`.
2. **Next (post-PR #5 ops counters, merged as `ops.ts`):** VIEW + TICK for both abilities. `recordWalFailure` / `recordWalCommit` already count per-kind; add `pincher_effect` / `lever_effect` kinds to `WalFailureKind` — the alerting story ("wire alerting on failureCounts.reconcile_tick > 0", ops.ts) then covers abilities for free.
3. **Then (post-PR #6 tidepool, merged as `quiltKernelTidepool.test.ts` + projections):** BIND archives. Ability registrations and `.nail` manifests join helper-thread memories in the tidepool ocean — an ability's history becomes queryable context for the conversational surface.
4. **Continuous:** Layer H canon-ledger (`src/quilt/canon-ledger.ts`) already replays the git log against CANON.md with an FNV-1a 64 replay hash; ability bundles versioned in-repo ride the same replay-verification. Drift in ability state becomes "one string, not a feeling" (canon-ledger.ts docstring).

---

## 4. THE EMERGENT TOOLING — what none of the three can do alone

**1. Ability breeding via the Red Queen archive.** the-tap PR #6 (`red-queen-design`, OPEN, design-only) specifies a MAP-Elites quality-diversity archive over room lineages: 5×5 grid on candor-measured strain μ × re-twist ρ, displacement = D1 death (sealed, relocated to `achieved/`, never deleted), crossing under niche exogamy (parents from distinct cells). None of the three repos in this seam has *selection* — pincher's reflexes accumulate but are never bred; lever-runner's commands are taught but never crossed; hermit records but never chooses. The harness makes the archive concrete: pincher `.nail` reflex bundles and lever-runner `.jsonl` skill packs are the *individuals*; a reflex bundle that holds a cell against challengers earns reproduction rights; a displaced bundle seals its WAL hash and moves to `achieved/`. The Red Queen doc's smallest-build (three pure never-throwing modules + JSON persistence) is one evening on top of hermit's existing WAL.

**2. Ability honesty metering via candor.** candor v0 (cited within RED-QUEEN-DESIGN.md at SuperInstance/candor `e4a85f3`: `candor.mjs` thresholds `RT_T=0.75`, signatures `{shear, re-twist, flat}`) reads transcripts as material physics. Applied to the harness: hermit's Discord transcripts of ability invocations become the corpus; an ability that *claims* a reflex fired (log line) but whose transcript shows re-twist signature is lying about its own health — the `ops.ts` counters currently trust every catch site. Terminology law, stated once and obeyed: **torsion is the load applied to the material; twist is the instrument's reading of it; torsion ≠ twist**, and neither is the twist-engine's commensuration — this doc uses candor/candor only. The honesty spectrometer turns "the mirror could die at deploy and nobody would know" (ops.ts docstring, the exact failure PR #5 fixed for the WAL) from a WAL-only fix into an ability-level instrument.

**3. The trust ledger — double-entry ability accounting.** lever-runner scores trust (±Δ per execution); pincher scores confidence (per invoke). Today those ledgers live inside each ability's own DB, unauditable from outside. In the harness, every ±Δ is appended as a WAL row by the *caller* (hermit), not the ability — the ability proposes, hermit disposes, the hash chain proves. This is the saddle repo's pattern (double-entry ledger per cell) applied to abilities, and it composes with the existing reconcile pass (`src/quilt/reconcile.ts`) to detect drift between what pincher *claims* its invoke_count is and what the WAL *records* — the drift detector already exists as a test (`quiltKernelReconcile.test.ts`).

---

## 5. SMALLEST FIRST BUILD — one-evening v0 (hermit ↔ lever-runner)

**Goal:** a Discord message in a guild channel causes a pre-approved, pre-taught lever-runner command to execute, and the invocation lands as a hash-chained WAL row queryable from `/api/events`. One evening. No new services.

1. **Hour 0–1 — forwarder seam.** In `forwarder/`, add a lever client: `POST http://127.0.0.1:8765/run` with `chat_id = guild:<guild_id>` and bearer token from env (`HTTP_API_TOKEN`). Map Discord message → `request`. Wire one command (`/lever <words>` slash-style or a prefix message handler in `src/index.ts` → forwarder).
2. **Hour 1–2 — WAL projection.** Add `src/quilt/ability.ts`: `commitAbilityEffectProjection(client, input)` cloned from the `commitNominationVoteProjection` shape (import `QuiltKernel` from `reference-kernel.mjs`, build rows via a new `projectAbilityEffect` in `projection.ts`, single guarded batch, throw `QuiltChainConflictError` on tip loss). Payload: `{ability:"lever-runner", request, command, exit_code, duration_ms, trust_delta, guild_id}`. Extend `WalFailureKind` with `"ability_effect_projection"`.
3. **Hour 2–3 — VIEW.** Extend `helperLogsServer.ts` `/api/events` with `type=ability` filter; surface `GET /status?chat_id=guild:<id>` result as a Discord embed ( Carbon components already exist — mirror `nominationButtons.ts` patterns).
4. **Hour 3–4 — test + reconcile.** One test file `quiltAbilityEffect.test.ts` modeled on `quiltKernelOps.test.ts`; run the existing suite (`bun test` — ImageMagick/WebP needed for artwork tests, per README CI notes); run `reconcileTick` manually once to see the summary shape. Commit, push branch, PR.
5. **Explicitly NOT in v0:** pincher seam (hour-order harder: Rust build + .nail plumbing), Red Queen archive (design exists, deps don't), candor wiring (candor isn't a fleet dependency yet — the Red Queen doc says the seam is designed now, wired later).

**Acceptance:** `bun test` green; one real Discord `!lever disk usage` message returns `df -h` output; `select * from quilt_wal where json_extract(payload,'$.ability')='lever-runner'` returns the row; replay (`quiltKernelReplay.test.ts` machinery) reproduces the same hash chain.

---

## 6. TOP-5 INTEGRATIONS — VALUE × FEASIBILITY × SEQUENCE

| # | Integration | Value | Feasibility | Sequence | One-liner |
|---|-------------|-------|-------------|----------|-----------|
| 1 | **hermit ↔ lever-runner EFFECT seam** (§5) | ★★★★★ — first real ability in the WAL; the harness thesis proven | ★★★★★ — HTTP API + WAL writer both exist; one evening | Now | `POST /run` → `commitAbilityEffectProjection` → `/api/events`; the whole harness in miniature |
| 2 | **ops.ts ability counters + TICK** | ★★★★ — ability health becomes alertable on day one | ★★★★★ — extend `WalFailureKind`, cron already documented | Now+1 | pincher/lever failure kinds ride the PR-#5 counter + `reconcileTick` machinery |
| 3 | **.nail ↔ tidepool BIND archive** | ★★★★ — ability history becomes conversational context; versioned, replay-verified | ★★★ — new projection + tidepool join; .nail format already exists on both sides | After #1–2 | ability registrations and `.nail` manifests join helper-thread memories in the ocean |
| 4 | **pincher reflex shell via CLI sub-process** | ★★★★ — <50 ms reflexes in Discord; LLM only on Novel | ★★★ — Rust build in forwarder env, CLI JSON contract to define | After #1 | `pincher-cli` teach/match/exec behind the forwarder, `.nail` bundles as BIND payloads |
| 5 | **Red Queen ability breeding + candor metering** | ★★★★★ — selection where today there is only accumulation; the fleet's stated gap (midden ch.3: "nobody decides which constitutions deserve to recombine") | ★★ — design v0.1 exists (the-tap PR #6), candor not yet a dependency | After #3–4 | MAP-Elites over ability bundles, candor reads hermit transcripts, displacement seals WAL hashes |

---

## Appendix — pinned refs & verification

| Repo | Ref | What was read |
|------|-----|---------------|
| SuperInstance/hermit | `adae217` (main) | README.md, package.json, src/quilt/ops.ts (full), src/quilt/commit.ts (head), src/quilt/canon-ledger.ts (head), tests/ listing, CANON.md exists at root, PR list via `gh` |
| SuperInstance/pincher | `02ae9bd` (main) | README.md, ARCHITECTURE.md (head), Cargo.toml, src tree, test-file grep (40 Rust), git log |
| SuperInstance/lever-runner | `fbf447a` (main) | README.md (full), src/lever_runner/http_api.py, executor.py, store.py, export_nail.py (heads), docs/FUTURE-INTEGRATION.md (head), orchestrator.py symbols, pyproject.toml, test grep (212) |
| SuperInstance/the-tap | branch `red-queen-design` | docs/RED-QUEEN-DESIGN.md via `gh api` (self-verifies against `master @ 2528752`; cites candor @ `e4a85f3` — candor itself read secondhand, marked as such) |
