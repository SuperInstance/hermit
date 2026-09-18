import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPackets, loadClaim, parseClaim, replayHash, verify } from "../src/quilt/canon-ledger"

let repo: string

const git = (...args: string[]) =>
	execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "test-crab",
			GIT_AUTHOR_EMAIL: "crab@fleet.test",
			GIT_COMMITTER_NAME: "test-crab",
			GIT_COMMITTER_EMAIL: "crab@fleet.test",
		},
	})

const commit = (message: string) => {
	git("add", "-A")
	git("commit", "-m", message, "--quiet")
	return git("rev-parse", "HEAD").trim()
}

const write = (path: string, body: string) => {
	const full = join(repo, path)
	mkdirSync(join(full, ".."), { recursive: true })
	writeFileSync(full, body)
}

const CANON = `---
canon: 1
name: fixture
mission: "test fixture"
state: active
family: applications
vessel: CCC
born_from: []
feeds: [tidepool]
owed_by: []
canonical_docs: [README.md]
ledger: git-log
verified: 2026-09-18
---
`

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "canon-ledger-"))
	git("init", "--quiet", "-b", "main")
})

afterEach(() => {
	rmSync(repo, { recursive: true, force: true })
})

describe("parseClaim", () => {
	it("parses the 12-line Layer C front matter", () => {
		const claim = parseClaim(CANON)
		expect(claim).not.toBeNull()
		expect(claim?.name).toBe("fixture")
		expect(claim?.feeds).toEqual(["tidepool"])
		expect(claim?.canonical_docs).toEqual(["README.md"])
	})

	it("returns null without front matter", () => {
		expect(parseClaim("# just a readme\nno front matter here")).toBeNull()
	})
})

describe("verify — explicit claim", () => {
	it("replays the ledger clean when the claim holds", () => {
		write("README.md", "# fixture\n")
		commit("docs: seed")
		write("CANON.md", CANON)
		commit("canon: claim the fixture")
		write("src/quilt/kernel.mjs", "export const spine = []\n")
		commit("quilt kernel: fixture spine")
		const report = verify(repo)
		expect(report.implicit).toBe(false)
		expect(report.packets.length).toBe(3)
		expect(report.failures).toEqual([])
		expect(report.claim?.feeds).toContain("tidepool")
	})

	it("fails when a canonical doc is removed", () => {
		write("README.md", "# fixture\n")
		write("CANON.md", CANON)
		commit("seed with claim")
		rmSync(join(repo, "README.md"))
		commit("docs: drop the readme")
		const report = verify(repo)
		expect(report.failures.length).toBe(1)
		expect(report.failures[0].reason).toContain("canonical doc removed: README.md")
	})

	it("fails when the claim drops the tidepool feed while kernel commits exist", () => {
		write("README.md", "# fixture\n")
		write("CANON.md", CANON)
		write("src/quilt/kernel.mjs", "export const spine = []\n")
		commit("seed with claim and kernel")
		write("CANON.md", CANON.replace("feeds: [tidepool]", "feeds: []"))
		commit("canon: mistakenly drop the feed ack")
		const report = verify(repo)
		expect(report.failures.length).toBeGreaterThan(0)
		expect(report.failures.map((p) => p.reason).join("\n")).toContain(
			"kernel commit but claim no longer feeds: [tidepool]",
		)
	})

	it("tags kernel packets with the claim field they serve", () => {
		write("README.md", "# fixture\n")
		write("CANON.md", CANON)
		commit("seed")
		write("src/quilt/kernel.mjs", "export const spine = []\n")
		commit("quilt kernel: spine")
		const report = verify(repo)
		const kernelPacket = report.packets.find((p) => p.subject.includes("spine"))
		expect(kernelPacket?.affects).toContain("feeds:tidepool")
	})
})

describe("verify — implicit claim", () => {
	it("runs unscoped with a warning when CANON.md is absent", () => {
		write("src/quilt/kernel.mjs", "export const spine = []\n")
		commit("quilt kernel: spine before the claim")
		const report = verify(repo)
		expect(report.implicit).toBe(true)
		expect(report.claim).toBeNull()
		expect(report.failures).toEqual([])
		expect(report.packets.every((p) => p.reason.includes("implicit"))).toBe(true)
	})
})

describe("replay determinism", () => {
	it("rebuilding the packet log yields the same replay hash", () => {
		write("README.md", "# fixture\n")
		write("CANON.md", CANON)
		write("src/quilt/kernel.mjs", "export const spine = []\n")
		commit("seed all")
		const first = verify(repo)
		const second = verify(repo)
		expect(first.replayHash).toBe(second.replayHash)
		expect(first.replayHash).toMatch(/^[0-9a-f]{16}$/)
	})

	it("any ledger growth changes the replay hash", () => {
		write("README.md", "# fixture\n")
		write("CANON.md", CANON)
		commit("seed")
		const before = verify(repo).replayHash
		write("src/quilt/kernel.mjs", "export const spine = []\n")
		commit("quilt kernel: spine")
		const after = verify(repo).replayHash
		expect(after).not.toBe(before)
	})
})

describe("loadClaim", () => {
	it("reads CANON.md from the repo root", () => {
		write("CANON.md", CANON)
		commit("canon: claim")
		expect(loadClaim(repo)?.name).toBe("fixture")
	})

	it("returns null when CANON.md is missing", () => {
		expect(loadClaim(repo)).toBeNull()
	})
})
