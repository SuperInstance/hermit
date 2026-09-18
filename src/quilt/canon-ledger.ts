// Layer H — the repo ledger.
//
// Canon doctrine (SuperInstance/fleet-canon): the repo's git log IS the
// ledger. verify(t) replays the log and verifies every packet entry
// against the canon claim (Layer C, CANON.md at the repo root). Replay
// determinism is the invariant: rebuilding the packet log from the same
// commit must produce the same packets, or the ledger is forked.
//
// v1 scope (hermit-internal, per the p7 spec):
//   - parse the Layer C claim (CANON.md front matter)
//   - replay the git log over the claim's scope (canonical docs + kernel)
//   - verify every packet: kernel commits must map to a claimed scope;
//     canonical docs must never be removed by a packet
//   - report a replay hash (FNV-1a 64, the fleet's standard) so drift is
//     one string, not a feeling
//
// CLI: bun run src/quilt/canon-ledger.ts [repoPath]   (exit 1 on failure)

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"

export interface CanonClaim {
	name: string
	mission: string
	feeds: string[]
	owed_by: string[]
	canonical_docs: string[]
	verified: string
}

export interface Packet {
	commit: string
	ts: number
	subject: string
	files: string[]
	affects: string[]
	ok: boolean
	reason: string
}

export interface LedgerReport {
	claim: CanonClaim | null
	implicit: boolean
	packets: Packet[]
	failures: Packet[]
	replayHash: string
}

const KERNEL_SCOPE = "src/quilt/"

const git = (repoPath: string, args: string[]): string =>
	execFileSync("git", ["-C", repoPath, ...args], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	})

/** Parse the Layer C claim out of CANON.md front matter. Null if absent/unparseable. */
export function parseClaim(md: string): CanonClaim | null {
	const m = md.match(/^---\n([\s\S]*?)\n---\n?/)
	if (!m) return null
	const doc = parseYaml(m[1])
	if (!doc || typeof doc !== "object") return null
	const c = doc as Record<string, unknown>
	if (typeof c.name !== "string") return null
	return {
		name: c.name,
		mission: typeof c.mission === "string" ? c.mission : "",
		feeds: Array.isArray(c.feeds) ? c.feeds.filter((x): x is string => typeof x === "string") : [],
		owed_by: Array.isArray(c.owed_by) ? c.owed_by.filter((x): x is string => typeof x === "string") : [],
		canonical_docs: Array.isArray(c.canonical_docs)
			? c.canonical_docs.filter((x): x is string => typeof x === "string")
			: [],
		verified: typeof c.verified === "string" ? c.verified : "",
	}
}

export function loadClaim(repoPath: string): CanonClaim | null {
	const path = join(repoPath, "CANON.md")
	if (!existsSync(path)) return null
	return parseClaim(readFileSync(path, "utf8"))
}

const treeHas = (repoPath: string, commit: string, path: string): boolean => {
	try {
		execFileSync("git", ["-C", repoPath, "cat-file", "-e", `${commit}:${path}`], { stdio: "ignore" })
		return true
	} catch {
		return false
	}
}

interface RawCommit {
	commit: string
	ts: number
	subject: string
	files: string[]
}

/** Replay the git log over the claim's scope. Newest first from git; we return oldest first. */
function replayLog(repoPath: string, scope: string[]): RawCommit[] {
	const args = [
		"log",
		"--pretty=format:CANON\x1e%H\x1f%ct\x1f%s",
		"--name-only",
		"--no-merges",
		"--",
		...scope,
	]
	const out = git(repoPath, args)
	const commits: RawCommit[] = []
	let current: RawCommit | null = null
	for (const line of out.split("\n")) {
		if (line.startsWith("CANON\x1e")) {
			const [, rest] = line.split("\x1e")
			const [commit, ct, subject = ""] = rest.split("\x1f")
			current = { commit, ts: Number(ct), subject, files: [] }
			commits.push(current)
		} else if (current && line.trim()) {
			current.files.push(line.trim())
		}
	}
	return commits.reverse() // oldest first: the ledger reads forward in time
}

/** Which claim fields does this packet touch? */
function affectsOf(files: string[], claim: CanonClaim | null): string[] {
	const affects = new Set<string>()
	for (const f of files) {
		if (f === "CANON.md") affects.add("claim")
		if (f.startsWith(KERNEL_SCOPE)) affects.add("feeds:tidepool")
		if (claim?.canonical_docs.includes(f)) affects.add(`canonical_docs:${f}`)
	}
	return [...affects]
}

/** Build the packet log for a repo. Without a claim, scope = kernel only (implicit mode). */
export function buildPackets(repoPath: string, claim: CanonClaim | null): Packet[] {
	const scope = claim
		? [...new Set([...claim.canonical_docs, "CANON.md", KERNEL_SCOPE])]
		: [KERNEL_SCOPE]
	return replayLog(repoPath, scope).map((c) => {
		const affects = affectsOf(c.files, claim)
		let ok = true
		let reason = "ok"
		if (!claim) {
			ok = true
			reason = "implicit claim — kernel unscoped, CANON.md pending"
		} else {
			const kernelTouched = c.files.some((f) => f.startsWith(KERNEL_SCOPE))
			if (kernelTouched && !claim.feeds.includes("tidepool")) {
				ok = false
				reason = "kernel commit but claim no longer feeds: [tidepool]"
			}
			const removed = claim.canonical_docs.filter((d) => {
				if (!c.files.includes(d)) return false
				if (treeHas(repoPath, c.commit, d)) return false
				return treeHas(repoPath, `${c.commit}^`, d)
			})
			if (ok && removed.length > 0) {
				ok = false
				reason = `canonical doc removed: ${removed.join(", ")}`
			}
		}
		return { commit: c.commit, ts: c.ts, subject: c.subject, files: c.files, affects, ok, reason }
	})
}

/** FNV-1a 64 over the canonical packet serialization — the fleet's hash, same as the rate limiter. */
export function replayHash(packets: Packet[]): string {
	let h = 0xcbf29ce484222325n
	const feed = (s: string) => {
		for (let i = 0; i < s.length; i++) {
			h ^= BigInt(s.charCodeAt(i))
			h = (h * 0x100000001b3n) & 0xffffffffffffffffn
		}
		h ^= 0xffn
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn
	}
	for (const p of packets) {
		feed(p.commit)
		feed(String(p.ts))
		feed(p.subject)
		for (const f of [...p.files].sort()) feed(f)
		for (const a of p.affects) feed(a)
		feed(p.ok ? "1" : "0")
		feed(p.reason)
	}
	return h.toString(16).padStart(16, "0")
}

/** Layer H verify(t): replay the ledger and check it against the claim. */
export function verify(repoPath = "."): LedgerReport {
	const claim = loadClaim(repoPath)
	const packets = buildPackets(repoPath, claim)
	const failures = packets.filter((p) => !p.ok)
	return {
		claim,
		implicit: claim === null,
		packets,
		failures,
		replayHash: replayHash(packets),
	}
}

const fmt = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10)

export function renderReport(report: LedgerReport): string {
	const lines: string[] = []
	const claim = report.claim
	lines.push(
		claim
			? `claim: ${claim.name} (verified ${claim.verified || "?"})`
			: "claim: IMPLICIT — CANON.md not on this ref (Layer C pending merge)",
	)
	lines.push(`packets: ${report.packets.length}  failures: ${report.failures.length}`)
	lines.push(`replay: ${report.replayHash}`)
	for (const p of report.packets) {
		const mark = p.ok ? "ok  " : "FAIL"
		lines.push(`${mark} ${p.commit.slice(0, 8)} ${fmt(p.ts)} ${p.subject}  [${p.affects.join(", ") || "unscoped"}]`)
		if (!p.ok) lines.push(`       ↳ ${p.reason}`)
	}
	return lines.join("\n")
}

if (import.meta.main) {
	const repoPath = process.argv[2] ?? "."
	const report = verify(repoPath)
	console.log(renderReport(report))
	process.exit(report.failures.length > 0 ? 1 : 0)
}
