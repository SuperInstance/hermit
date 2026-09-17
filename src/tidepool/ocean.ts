// ocean.ts — the tidepool ocean: a markdown memory file with a recall index.
//
// Port of the tidepool v1 bench contract (/tmp/tidepool/README.md): helper
// thread summaries are stored as `## thread:<id>` sections; recall is
// deterministic token-overlap scoring so WAL replay reproduces it
// bit-for-bit (no embeddings — hermit has no vector dependency).
//
// rememberBotAction oaths (enforced by API shape, audited by stats()):
//   1. NEVER modify messages — the ocean exposes no edit/delete API.
//   2. ALWAYS append-only — re-remembering appends a NEW section; the old
//      one stays (a memory of a memory is itself a memory).
//   3. ALWAYS include timestamps — every section carries rememberedAt,
//      every bot-action line carries an ISO ts.

import { appendFile, readFile } from "node:fs/promises"

export type OceanEntry = {
	id: string
	guildId: string
	channelId: string
	userId: string
	helperKey: string
	helperName: string
	questionText: string
	responseText: string
	thinkingLevel: string
	responseLength: number
	createdAt: string
	authorTag: string
	authorUsername: string
	lastMessageId: string
	rememberedAt: string
}

export type HelperThreadSummary = Omit<OceanEntry, "rememberedAt">

const SECTION_RE = /^## thread:([^\n]+)$/gm

const tokenize = (text: string): string[] =>
	String(text ?? "")
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((t) => t.length >= 2)

export class TidepoolOcean {
	readonly path: string | null
	private readonly now: () => string
	markdown: string
	/** threadId -> recall entry (latest memory wins) */
	index = new Map<string, OceanEntry>()
	private actionCount = 0

	constructor({
		path = null,
		now = () => new Date().toISOString()
	}: { path?: string | null; now?: () => string } = {}) {
		this.path = path
		this.now = now
		this.markdown =
			"# Tidepool Ocean\n\n<!-- append-only: never modify, never delete. every section carries rememberedAt. -->\n"
	}

	// The ONLY write path — oath-checked append.
	private async append(text: string): Promise<void> {
		this.markdown += text
		if (this.path) {
			await appendFile(this.path, text, "utf8")
		}
	}

	/** Remember one thread summary: new section + index upsert. */
	async remember(thread: HelperThreadSummary): Promise<{ section: string; entry: OceanEntry }> {
		const ts = this.now()
		const entry: OceanEntry = { ...thread, rememberedAt: ts }
		const section =
			`## thread:${thread.id}\n` +
			`rememberedAt: ${ts}\n` +
			`helper: ${thread.helperName} (${thread.helperKey})\n` +
			`channel: ${thread.channelId} guild: ${thread.guildId}\n` +
			`author: ${thread.authorUsername} (${thread.authorTag})\n` +
			`thinking: ${thread.thinkingLevel} responseChars: ${thread.responseLength}\n` +
			`question: ${thread.questionText}\n` +
			`response: ${thread.responseText}\n` +
			`lastMessage: ${thread.lastMessageId}\n\n`
		await this.append(section)
		this.index.set(thread.id, entry)
		return { section, entry }
	}

	/** Channel sweep shape: remember several summaries (one WAL mutation upstream). */
	async rememberAll(
		threads: HelperThreadSummary[]
	): Promise<Array<{ section: string; entry: OceanEntry }>> {
		const out: Array<{ section: string; entry: OceanEntry }> = []
		for (const thread of threads) {
			out.push(await this.remember(thread))
		}
		return out
	}

	/**
	 * Top `limit` (default 5, clamped 3..5) relevant entries.
	 * helperName/question matches weigh 2, response/meta matches weigh 1;
	 * ties break to the most recently remembered. Deterministic.
	 */
	async recall(query: string, { limit = 5 }: { limit?: number } = {}): Promise<OceanEntry[]> {
		const clamped = Math.max(3, Math.min(5, limit))
		const tokens = tokenize(query)
		if (tokens.length === 0) return []
		const scored: Array<{ entry: OceanEntry; score: number }> = []
		for (const entry of this.index.values()) {
			const weighted = {
				q: tokenize(`${entry.helperName} ${entry.questionText}`),
				r: tokenize(
					`${entry.responseText} ${entry.helperKey} ${entry.authorUsername} ${entry.thinkingLevel}`
				)
			}
			let score = 0
			for (const token of tokens) {
				if (weighted.q.includes(token)) score += 2
				if (weighted.r.includes(token)) score += 1
			}
			if (score > 0) scored.push({ entry, score })
		}
		scored.sort(
			(a, b) =>
				b.score - a.score ||
				String(b.entry.rememberedAt).localeCompare(String(a.entry.rememberedAt))
		)
		return scored.slice(0, clamped).map((s) => s.entry)
	}

	/** Oath log: append-only, timestamped, immutable. */
	async botAction(action: string): Promise<{ ts: string; action: string }> {
		const ts = this.now()
		const line = `- ${ts} ${String(action).replace(/[\n\r]+/g, " ")}\n`
		if (this.actionCount === 0) {
			await this.append("\n## bot-actions\n")
		}
		await this.append(line)
		this.actionCount += 1
		return { ts, action: line.trim() }
	}

	/** Oath audit: every thread section carries rememberedAt. */
	stats(): {
		threadSections: number
		indexEntries: number
		botActionLines: number
		oathViolations: number
		bytes: number
	} {
		const sections = [...this.markdown.matchAll(SECTION_RE)]
		let oathViolations = 0
		for (const match of sections) {
			const rest = this.markdown.slice(match.index)
			const end = rest.indexOf("\n## ", 4)
			const body = end === -1 ? rest : rest.slice(0, end)
			if (!/^rememberedAt: \S+/m.test(body)) oathViolations += 1
		}
		return {
			threadSections: sections.length,
			indexEntries: this.index.size,
			botActionLines: this.actionCount,
			oathViolations,
			bytes: Buffer.byteLength(this.markdown)
		}
	}

	/** Load an existing ocean file back (latest section per thread wins). */
	async load(): Promise<this> {
		if (!this.path) throw new Error("ocean has no path")
		this.markdown = await readFile(this.path, "utf8")
		this.index.clear()
		this.actionCount = 0
		const sections = [...this.markdown.matchAll(SECTION_RE)]
		for (const match of sections) {
			const rest = this.markdown.slice(match.index)
			const end = rest.indexOf("\n## ", 4)
			const body = (end === -1 ? rest : rest.slice(0, end)).split("\n")
			const id = match[1].trim()
			const get = (prefix: string): string => {
				const line = body.find((l) => l.startsWith(prefix))
				return line ? line.slice(prefix.length).trim() : ""
			}
			const helper = get("helper: ").match(/^(.*) \((.*)\)$/)
			const channel = get("channel: ").match(/^(.*) guild: (.*)$/)
			const author = get("author: ").match(/^(.*) \((.*)\)$/)
			const thinking = get("thinking: ").match(/^(.*) responseChars: (.*)$/)
			this.index.set(id, {
				id,
				rememberedAt: get("rememberedAt: "),
				helperName: helper?.[1] ?? "",
				helperKey: helper?.[2] ?? "",
				channelId: channel?.[1] ?? "",
				guildId: channel?.[2] ?? "",
				authorUsername: author?.[1] ?? "",
				authorTag: author?.[2] ?? "",
				thinkingLevel: thinking?.[1] ?? "",
				responseLength: Number(thinking?.[2] ?? 0),
				questionText: get("question: "),
				responseText: get("response: "),
				lastMessageId: get("lastMessage: "),
				userId: "",
				createdAt: ""
			})
		}
		return this
	}
}
