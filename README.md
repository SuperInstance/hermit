# Hermit (Cloudflare Worker)

Discord bot built with Carbon on Cloudflare Workers.

## Vision

Hermit is the fleet's durable companion: a Discord bot whose memory is a ledger, not a cache. Every vote cast, encounter run, helper thread answered, and cooldown refused is projected as BIND/LINK/EFFECT/VIEW/TICK events into a write-ahead log in D1 — hash-chained, replayable after any restart or deploy. When hermit wakes on a fresh isolate it does not remember because something was kept warm; it reconstructs its state by replaying the kernel. That is the fleet's quilt doctrine applied to a bot: the trace outlives the process. If a conversation mattered, it left rows; if it left rows, it can be audited, reconciled, and fed forward into the canon. Nothing hermit says about its own history is a recollection — it is a replay.

Where it is going: the body grows hands. [PR #14](https://github.com/SuperInstance/hermit/pull/14) (`docs/HARNESS-SYNERGY.md`, open) maps how pincher — the reflex shell — plugs in as hermit's spinal cord, and lever-runner — the trust compiler — as its hand, with every ability lifecycle beat (BIND/EFFECT/VIEW/TICK) appended to the same WAL that already records votes. See [Hermit in the SuperInstance Fleet](#hermit-in-the-superinstance-fleet) below.

## Stack

- `@buape/carbon`
- Cloudflare Workers (`@buape/carbon/adapters/fetch`)
- Gateway forwarding: `forwarder/` Bun process using `GatewayForwarderPlugin`
- Cloudflare D1 + Drizzle ORM

## Setup

1. Install deps:

```bash
bun install
```

2. Create `.env` from `.env.example`.

Required:

```env
BASE_URL=
DEPLOY_SECRET=
DISCORD_CLIENT_ID=
DISCORD_PUBLIC_KEY=
DISCORD_BOT_TOKEN=
```

Optional:

```env
DISCORD_DEV_GUILDS=
FORWARDER_PUBLIC_KEY=
ANSWER_OVERFLOW_API_KEY=
HELPER_THREAD_WELCOME_PARENT_ID=
HELPER_THREAD_WELCOME_TEMPLATE=
THREAD_LENGTH_CHECK_INTERVAL_HOURS=
```

3. Configure `wrangler.jsonc` D1 binding:

- set `d1_databases[0].database_id` to your real D1 database id
- keep `binding = "DB"`

4. Apply D1 migrations:

```bash
bun run db:apply:local
# or
bun run db:apply:remote
```

5. Run locally:

```bash
bun run dev
```

## Helper logs API

`GET /api/events` and `GET /api/threads` require `Authorization: Bearer <DEPLOY_SECRET>`. Update any scripts consuming these endpoints to send that header. Missing or incorrect credentials return HTTP 401; the endpoints also reject requests when `DEPLOY_SECRET` is unset.

The HTML index at `/` remains public and contains only endpoint links and filter documentation.

## Form review notifications

Configure forms in `forms.config.ts`. `reviewRoleId` controls who can accept or deny submissions; optional `reviewPingRoleId` selects the role notified on new submissions and defaults to `reviewRoleId`.

Discord, GitHub, and Reddit appeals plus moderator reports notify `1546936406272778271`, while Community Team (`1477360613125787678`) retains review access. ClawHub notifications and review access use `1509967254870298794`.

## Hermit in the SuperInstance Fleet

Hermit is one node in the [SuperInstance](https://github.com/SuperInstance) fleet. The sections below map how it plugs into the fleet's shared doctrine and instruments.

### The paradigm map

**Quilt — the memory spine.** Hermit's durable memory is the fleet's 5-opcode kernel: `BIND / LINK / EFFECT / VIEW / TICK` ([`src/quilt/reference-kernel.mjs`](src/quilt/reference-kernel.mjs), CONTRACT v5). Domain events — nomination votes, lobster encounters, cooldown refusals, helper threads, responses, publications — are projected into kernel events and appended to the `quilt_wal` D1 table as a hash chain (fnv1a-32, [docs/QUILT_WAL_HASH.md](docs/QUILT_WAL_HASH.md); schema in `drizzle/0013`/`0014`). The WAL is the source of truth: `src/quilt/reconcile.ts` replays it to detect drift, `src/quilt/ops.ts` counts its failures, and `src/quilt/canon-ledger.ts` turns its commits into canon packets. Doctrine and reference implementation: [SuperInstance/quilt-studio](https://github.com/SuperInstance/quilt-studio).

**Tidepool — the memory ocean.** [`src/tidepool/`](src/tidepool) is hermit's local tidepool client. Every helper-thread memory is a dual-write: the ocean markdown is the human-readable memory ([`src/tidepool/ocean.ts`](src/tidepool/ocean.ts)), and the same fact is projected BIND-for-BIND into the quilt WAL ([`src/tidepool/projection.ts`](src/tidepool/projection.ts)) so it can be replayed. Quiet threads are detected by [`src/tidepool/stall.ts`](src/tidepool/stall.ts) and projected as first-class ledger facts. The fleet's vector ocean — distilled artifacts recalled by any agent, embedded in Cloudflare Vectorize — lives at [SuperInstance/tidepool](https://github.com/SuperInstance/tidepool); hermit's projection into it is the open seam (see [docs/QUILT-ENHANCEMENT-AUDIT.md](docs/QUILT-ENHANCEMENT-AUDIT.md), F2).

**Canon — the live claim ledger.** Hermit is a quilt-live-canon node. Its [`CANON.md`](CANON.md) front matter is the claim: what the repo owes (`owed_by`), which feeds it serves. [`src/quilt/canon-ledger.ts`](src/quilt/canon-ledger.ts) parses the claim, replays the git log over the claim's scope (the kernel under `src/quilt/` plus every canonical doc), tags each packet with the claim field it serves, and fails the replay if a canonical doc is removed or the claim drops a feed while kernel commits still exist. The fleet CLI is [SuperInstance/quilt-canon-cli](https://github.com/SuperInstance/quilt-canon-cli) (`canon claim`, `canon drill`, `canon hash`, `canon graph`, `canon paper`).

**The instruments — measured, never asserted.** Three fleet repos supply the measurement grammar hermit's cadences should speak. [SuperInstance/twist-engine](https://github.com/SuperInstance/twist-engine) demonstrates the law across five substrates: a deliberate twist between identical layers, with registration R(θ) measured by gaussian alignment (σ-shear, σ = 0.24·s) and the commensuration comb of small-denominator windows — the quantity is computed, never asserted. [SuperInstance/gesture-kit](https://github.com/SuperInstance/gesture-kit) reads a path's geometry order by order: arc length and heading (1st), bending energy (2nd), and torsion (3rd) — turning out of the plane. Terminology law: a *twist* is the deliberate offset itself; *torsion* is the third-order measure of a path leaving its plane. Different words, different orders. And `commensurate.mjs` ([SuperInstance/quilt-studio](https://github.com/SuperInstance/quilt-studio), `packages/quilt-floor/src/commensurate.mjs`) does exact rational arithmetic — f64 bits to BigInt rationals, Stern–Brocot search, nearest small-denominator rational — so "is this measured ratio commensurate?" has an exact answer.

**duke-lab / q16 — the strain ruler.** [SuperInstance/duke-lab](https://github.com/SuperInstance/duke-lab) is a GAN with words: a generator plays takes, a critic scores them on a sixteen-feature ruler, and σ shrinks along a golden-section grid until the critic can no longer tell. The q16 strain doctrine generalizes: tune parameters against a measured ruler instead of asserting they work. Hermit's analog is its cadence surface — cooldown windows, stall-detector polls, expiry intervals — tuned against the refusal and quiet-thread topology the WAL already records.

**Harness — the body grows hands.** [PR #14](https://github.com/SuperInstance/hermit/pull/14) (`docs/HARNESS-SYNERGY.md`, branch `harness-synergy`, open from the same `adae217` base) is the fleet's application-harness design: hermit stops being a bot with features and becomes a **body with reflexes and hands**. Pincher — the reflex shell, Teach→Match→Execute in <50 ms with no LLM and a veto guard — plugs in as the spinal cord. Lever-runner — the trust compiler, teach a shell command once and run it forever, three gates deep — plugs in as the hand. Every ability beat is a quilt op: BIND (registration, `.nail` manifest as payload), EFFECT (each fire/execution, fuel-metered by confidence or time/trust), VIEW (ability state rendered into Discord + `/api/events` + `/api/threads`), TICK (scheduled reconcile + health). Because abilities ride the existing `src/quilt/commit.ts` CAS-guarded writer, what the fleet's applications *do* becomes as hash-chained, fuel-metered, and replay-verifiable as what they *remember*. Pincher decides *that* you know how to respond; lever-runner decides *how* to safely do the pre-approved thing; hermit is the body that remembers everything either one does.

### Architecture

```
Discord events (forwarder/ Bun process)
        |
        v
+---------------------------------+
| Carbon commands & services      |  src/commands/ · src/services/
+---------------+-----------------+
                | domain events (vote · encounter · refusal · reply · thread)
                v
+---------------------------------+      +------------------------------+
| quilt kernel — 5 opcodes        |      | D1 quilt_wal (drizzle)       |
| BIND · LINK · EFFECT · VIEW ·   |----->| fnv1a-32 hash chain          |
| TICK                            |append| + quilt_wal_lock (CAS guard) |
| src/quilt/reference-kernel.mjs  |      | migrations 0013 / 0014       |
+---------------+-----------------+      +---------------+--------------+
                | events                                 | replay
                v                                        v
+---------------------------------+      +------------------------------+
| projections                     |      | reconcileQuiltWal (drift)    |
| votes · encounters · refusals · |      | ops counters                 |
| threads · responses ·           |      | canon ledger packets         |
| publications                    |      +------------------------------+
+-------+-----------------+-------+
        |                 |
        v                 v
+-------------+   +--------------------+
| tidepool    |   | helper_threads     |
| ocean.md    |   | (D1 view over the  |
| (human mem) |   |  WAL projection)   |
+-------------+   +--------------------+
```

### Migration status — in flight

Quilt PRs #1–#13 are **merged**; `main` @ `adae217` carries the full spine. The genuinely open work: [PR #14](https://github.com/SuperInstance/hermit/pull/14) (the harness design doc, docs-only) and the main-is-red finding below. The table records the landed phases in merge order, then what remains honestly open. README describes `main` as shipped; where a listed item is broken or unwired, it says so.

| Phase | PR / commit | What it landed | Status on `main` |
|-------|-------------|----------------|------------------|
| P1–P4 quilt kernel | #1, #9, #10, #11, #12 | 5-opcode WAL dual-write, encounter shadow + negative ledger, replay-verify reconciliation, D1 claim lock + CAS/retry hardening, honest hash amendment | **Landed — but main is red:** `src/quilt/projection.ts` at `adae217` does not export `projectNominationVote`/`VoteProjectionInput`, which `src/quilt/commit.ts:5-6` imports — `bun test` dies with `SyntaxError: Export named 'projectNominationVote' not found` in ~15 test files. Verified by local clone + test run (remote `raw.githubusercontent.com` cross-checked). Fix is one evening: see [docs/QUILT-ENHANCEMENT-AUDIT.md](docs/QUILT-ENHANCEMENT-AUDIT.md) F1 |
| P5 ops counters | aa0ebd6 (PR #5) | `recordWalFailure` / `recordWalCommit` / `reconcileTick` | **Landed** — `recordWalCommit` has no callers; `reconcileTick` is not wired into the Worker `scheduled()` handler |
| P6 tidepool v1 | 64e6eaf (PR #6) | ocean + WAL projection + stall detector + `helper_threads` view | **Landed** — failure path uses a local counter; `"tidepool_projection"` is not yet in the ops `WalFailureKind` union |
| P7 canon ledger | b84ec12, #13 | Layer H ledger + Layer C ACK in CANON.md | **Landed** |
| sha256 witness upgrade | — | Algo-tagged SHA-256 rows verifying alongside fnv1a-32 history | **Todo** — [docs/QUILT_WAL_HASH.md](docs/QUILT_WAL_HASH.md); todo-marked test in `tests/quiltWalHash.test.ts` |
| Fleet tidepool projection | — | Distill helper memories into the vector ocean ([SuperInstance/tidepool](https://github.com/SuperInstance/tidepool)) | **Not started** — audit F2 |

Further seams and ranked builds: [docs/QUILT-ENHANCEMENT-AUDIT.md](docs/QUILT-ENHANCEMENT-AUDIT.md).

## Doc index

| Doc | What it is |
|-----|------------|
| [docs/QUILT-ENHANCEMENT-AUDIT.md](docs/QUILT-ENHANCEMENT-AUDIT.md) | Top-5 quilt-powered enhancements beyond the merged spine — cited file:line, WHAT EXISTS / WHAT'S MISSING / SMALLEST BUILD (this branch) |
| [docs/QUILT_LEDGER_FINDINGS.md](docs/QUILT_LEDGER_FINDINGS.md) | The adversarial-audit findings (tip race, spec drift) that forced PRs #9–#12's hardening |
| [docs/QUILT_WAL_HASH.md](docs/QUILT_WAL_HASH.md) | The fnv1a-32 witness-chain spec + the honest sha256 amendment path |
| [PR #14 — HARNESS-SYNERGY.md](https://github.com/SuperInstance/hermit/pull/14) | The harness design: hermit × pincher × lever-runner (open, docs-only) |
| [docs/clawhub-search-intelligence.md](docs/clawhub-search-intelligence.md) | The ClawHub weekly search-intelligence receiver (`/api/clawhub-search-intelligence/weekly`) |
| [docs/lobster-command-prd.md](docs/lobster-command-prd.md), [docs/lobster-v2-prd.md](docs/lobster-v2-prd.md) | Lobster encounters: command PRD + v2 expansion |
| [PRD.md](PRD.md) | Shell Society nomination review — the product hermit was built around |
| [progress.txt](progress.txt) | Lobster encounters running progress log |

## Scripts

- `bun run dev` → `wrangler dev --env-file .env`
- `bun run deploy` → deploy worker locally with `.env`
- `bun run deploy:cf` → apply remote D1 migrations, then deploy Worker for Cloudflare Builds
- `bun run deploy:dry-run` → validate the Worker bundle without deploying
- `bun run cf-typegen` → regenerate `worker-configuration.d.ts`
- `bun run typecheck` → TypeScript check
- `bun run test` → generate Forms styles, then run the test suite (requires ImageMagick and the WebP CLI tools)
- `bun run db:generate` → generate Drizzle SQL
- `bun run db:apply:local` / `db:apply:remote` → apply D1 migrations

## CI/CD

GitHub Actions runs frozen installs and typechecks for both Bun packages, a Worker dry-run build, and the full test suite on pull requests and pushes to `main`. These checks share one Ubuntu job with a 20-minute timeout; CI installs ImageMagick 7 and the WebP tools needed by the artwork tests. The workflow does not deploy or require deployment secrets.

Cloudflare Workers Builds deploys pushes to `main`. The deploy command should apply D1 migrations before deploying the Worker:

```bash
bun run deploy:cf
```

Drizzle only generates SQL migrations. Wrangler applies them to D1:

```bash
bun run db:generate
bun run db:apply:remote
```

## Clawtributor claim review

If saving a rejection fails, Hermit does not notify the applicant and restores the review buttons for another attempt. If Discord also rejects the message update, the reviewer receives an error explaining that the review could not be reopened automatically and needs moderator recovery.

## Gateway forwarder

The main bot runs as a Cloudflare Worker. Gateway events are forwarded by the Bun app in `forwarder/`, usually running on Krill's machine.

Forwarder setup:

```bash
cd forwarder
bun install
bun run dev
```

Forwarder production start:

```bash
cd forwarder
bun run start
```

Forwarder env:

```env
BASE_URL=
DEPLOY_SECRET=
DISCORD_CLIENT_ID=
DISCORD_PUBLIC_KEY=
DISCORD_BOT_TOKEN=
FORWARDER_PRIVATE_KEY=
```

The Worker must have the matching public key:

```bash
bunx wrangler secret put FORWARDER_PUBLIC_KEY
```

## Automod webhooks

Concurrent automod events in the same Worker instance share the channel webhook lookup and creation. Failed attempts are cleared so a later event can retry; successful webhooks retain the existing 15-minute cache. Separate Worker instances still manage their own caches.

## Notes

- Answer Overflow base URL is hardcoded to `https://www.answeroverflow.com`.
- Helper thread monitor runs via Worker cron (`wrangler.jsonc` `triggers.crons`).
- The old Cloudflare Gateway Durable Object path is not the active gateway setup.

## ClawHub ban appeals

Appeal submissions keep only configured input fields; account and moderation context comes from the signed-in GitHub account. Before accepting an appeal, Hermit rechecks that its stored ClawHub account ID still belongs to that GitHub applicant. This also protects pending appeals submitted before intake validation was added. A missing or mismatched binding leaves the appeal pending without sending an unban request; ask the applicant to submit a new appeal. A temporary ClawHub lookup failure can be retried.

## GitHub summaries

GitHub summary requests accept repository names made from letters, digits, dots, underscores, and hyphens, excluding `.` and `..`. Path separators, URL escapes, query strings, and fragments are rejected before authentication or a GitHub request. Valid repositories retain the configured GitHub App installation authentication, with the existing anonymous fallback when no token is available.
