# Rescue Branch Triage — Lane AJ, 2026-09-21

Repos inspected: `SuperInstance/hermit` (default `main`), `SuperInstance/the-tap` (default `master`), `SuperInstance/quilt-live-canon` (default `main`).
Canon-repo probe per brief: `git ls-remote .../quilt-live-canon.git` → **quilt-live-canon exists**.
Method: full `git fetch --all` per clone, then `git log/diff <default>...rescue/<name>`, ancestry checks (`merge-base --is-ancestor`), and cross-check against open PRs (`gh pr list/view`).
Rules honored: no pushes, no merges, max 1 PR per branch. **Net result: 0 new PRs — every candidate was already landed or already has an open PR.**

---

## 1. hermit — `rescue/readme-vision-audit-20260921` → PR ALREADY EXISTS (dedupe; do not re-open)

- Tip: `e93f947` — **NOT in main** (the only hermit rescue ref with unmerged content).
- Commits vs `main`:
  - `1ac24ff` kimi1 — docs: README fleet section + Vision + quilt-enhancement audit
  - `e93f947` CCC — docs: verify all citations against adae217 — fix fabricated refs, honest PR status, evidence-cited F1
- Files: `README.md` (+86), `docs/QUILT-ENHANCEMENT-AUDIT.md` (+123). 209 insertions, 0 deletions.
- **Dedupe finding:** byte-identical to branch `readme-vision-audit` (zero commits either direction, zero content diff), which is the head of **open PR #15**: "docs: README fleet section + Vision + quilt-enhancement audit" (base `main`, headRefOid `e93f947` — exact same commit).
- **Verdict: PR-worthy content, but PR #15 already covers it.** Opening a second PR would duplicate. Leave rescue ref for Casey to delete after #15 merges.
- Existing PR: https://github.com/SuperInstance/hermit/pull/15

## 2. hermit — `rescue/quilt-commit-tip-guard-20260921` → JUNK (already landed)

- Tip: `9a59e73` — **ancestor of main**; `git log main..rescue` is empty (nothing unique).
- Commits carried: `48530bd` (deterministic tip-race repro test) + `9a59e73` (fix(quilt): guard the WAL commit tip-race with a prev_hash UNIQUE index).
- Files: `drizzle/0014_quilt_wal_prev_hash_unique.sql`, `drizzle/meta/_journal.json`, `src/db/schema.ts`, `src/quilt/commit.ts`, `tests/quiltKernelReplay.test.ts`.
- Landed on main via merge `de55d4d` ("PR #10 - WAL commit tip-race guard (prev_hash UNIQUE index + tests)"); main then went further with `acd3899` ("PR #11 - CAS-guarded single-batch chain closes tip race").
- **Verdict: JUNK** — content fully merged and since superseded by the CAS guard. Rescue ref is a stale pointer; delete at will.

## 3. hermit — `rescue/deploy-status-20260921` → JUNK (exact duplicate ref of #2, mislabeled)

- Tip: `9a59e73` — **the same SHA as branch #2**. Someone pushed one tip under two names during the rescue.
- Despite the name, it contains **no deploy-status docs** — only the WAL tip-guard commits above.
- **Verdict: JUNK / dedupe confirmed** — duplicate of #2, already in main. Name/content mismatch worth flagging (see Casey notes).

## 4. the-tap — `rescue/readme-vision-audit-20260921` → JUNK (already landed, mislabeled)

- Tip: `f1e7904` — **fully in master**; `git log master..rescue` = 0 commits, diffstat empty.
- Commits carried:
  - `c854d03` Lane H — fix wrangler binding mismatches (pincher/level-runner) + workers-types v5 peer conflict
  - `bd96aae` kimi1 — docs: DEPLOY-STATUS.md — the audited, reproducible deploy state
  - `f1e7904` kimi1 — docs: Casey's no-delete doctrine — stale log moves to docs/achieved/, never deleted
- Landed on master via merges `5c8fb1b` ("PR #3 - DEPLOY-STATUS.md + Casey's no-delete doctrine") and `2528752` ("PR #1 - CANON.md"). Verified on master: `docs/DEPLOY-STATUS.md` exists (61 lines); `c854d03` is an ancestor of master.
- Despite the name, content is deploy-status/wrangler work, not README/Vision.
- **Verdict: JUNK** — stale pointer to merged work.

## 5. canon repo — `rescue/canon-whirlpool-acks-20260921` → JUNK (lives on hermit; already merged there)

- Brief's repo pointer was wrong: **quilt-live-canon has no rescue branches at all** (checked `ls-remote --heads` + full fetch; branches: canon-71-full-corpus, canon-stub, lane-p-verify-gate, main, master).
- The named branch actually lives on **hermit**: tip `21e53d3` ("CANON.md: acknowledge feeds: quilt (refs quilt-canon-cli#4)", 1 file / 1 line).
- Already merged into hermit `main` via **PR #13** (merge `adae217`, merged by Casey).
- quilt-live-canon's own `CANON.md` is separate content (feeds: live-canon-npm/pypi/gh) and was not touched by this branch — no cherry-pick needed there.
- **Verdict: JUNK** — stale pointer on hermit; nothing to do in quilt-live-canon.

---

## Summary table

| # | Repo | Branch | Unique vs default? | Verdict | PR |
|---|------|--------|--------------------|---------|-----|
| 1 | hermit | rescue/readme-vision-audit-20260921 | Yes (2 commits) | DEDUPE — already open as PR #15 (identical SHA) | existing: #15 |
| 2 | hermit | rescue/quilt-commit-tip-guard-20260921 | No | JUNK — landed via PR #10, superseded by PR #11 | none |
| 3 | hermit | rescue/deploy-status-20260921 | No | JUNK — same SHA as #2, mislabeled name | none |
| 4 | the-tap | rescue/readme-vision-audit-20260921 | No | JUNK — landed via the-tap PR #3 + #1 | none |
| 5 | hermit (not quilt-live-canon) | rescue/canon-whirlpool-acks-20260921 | No | JUNK — landed via hermit PR #13 | none |

## For Casey's eyes

1. **PR #15 is the only live item**: hermit docs (README fleet section, Vision, citation audit against adae217 incl. fabricated-ref fixes). It needs your review; the rescue ref is a duplicate of its head branch.
2. **Rescue-time naming was scrambled**: `hermit/rescue/deploy-status-20260921` contains WAL-guard code (dup of #2), and `the-tap/rescue/readme-vision-audit-20260921` contains deploy-status/wrangler work. Names cannot be trusted; SHAs above are authoritative.
3. **Deletable stale refs** (all content verified landed): the 4 hermit rescue refs + 1 the-tap rescue ref. Left up per doctrine.
4. **Brief correction**: branch 5's canon repo pointer was wrong — quilt-live-canon exists but holds no rescue branch; the branch is on hermit and is merged.
5. No pushes, no merges, no new PRs opened (all candidates deduped against existing/open PRs).
