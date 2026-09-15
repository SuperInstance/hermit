import { Container, TextDisplay, serializePayload } from "@buape/carbon"
import {
	count,
	fields,
	parseDigest,
	record,
	string,
	timestamp,
	validUrl,
	type Digest,
	type Row
} from "./contract.js"

type Scope = "catalog" | "shelf" | "legacy"
type ScopedRow = Row & { scope: Scope }
type Recommendation = {
	artifactKind: "plugin" | "skill"
	id: string
	displayName: string
	url: string
	category: string | null
	support: "both" | "search-only" | "adoption-only"
	metadataCheckedAt: number
	search: null | {
		matchedSearches7d: number
		previous7d: number
		searches30d: number
		queries: {
			query: string
			scope: Scope
			searches7d: number
			previous7d: number
			searches30d: number
		}[]
		omittedQueries: number
		periodStart: number
		periodEnd: number
		dataThrough: number | null
		collectionStartedAt: number | null
	}
	adoption: null | {
		source:
			| "package-trending"
			| "clawhub-trending"
			| "clawhub-rising"
			| "skills-sh-trending"
		rank: number | null
		snapshotId: string | null
		rankingVersion: string | null
		periodStart: number | null
		periodEnd: number | null
		generatedAt: number | null
		sourceObservedAt: number | null
		downloads: number | null
		installs: number | null
		bookmarks: number | null
		lifetimeInstalls: number | null
	}
}
type Catalog = Pick<
	Digest,
	| "totalSearches"
	| "sourceCounts"
	| "coverage"
	| "classificationStatus"
	| "currentMetadataStatus"
> & {
	adoption: {
		status: "available" | "unavailable"
		generatedAt: number | null
		periodStart: number | null
		periodEnd: number | null
		snapshotId: string | null
		rankingVersion: string | null
		totalItems: number
		inspectedItems: number
		truncated: boolean
	}
	companyOpportunities: (ScopedRow & {
		companyProductName?: string
		confidence: number
	})[]
	officialGaps: ScopedRow[]
	movers: ScopedRow[]
	recommendations: Recommendation[]
}
export type EvidenceDigest = {
	kind: "search_intelligence_weekly_v2"
	weekStart: number
	weekEnd: number
	minimumSearches: 3
	dashboardUrl: string
	truncated: boolean
	catalogs: { plugins: Catalog; skills: Catalog }
}
const scope = (value: unknown) =>
	value === "catalog" || value === "shelf" || value === "legacy"
const nullable = (value: unknown, validate: (value: unknown) => boolean) =>
	value === null || validate(value)
const period = (start: unknown, end: unknown) =>
	nullable(start, timestamp) &&
	nullable(end, timestamp) &&
	(start === null || end === null || (start as number) < (end as number))

const validAdoptionSummary = (value: unknown) =>
	fields(value, [
		"status",
		"generatedAt",
		"periodStart",
		"periodEnd",
		"snapshotId",
		"rankingVersion",
		"totalItems",
		"inspectedItems",
		"truncated"
	]) &&
	(value.status === "available" || value.status === "unavailable") &&
	nullable(value.generatedAt, timestamp) &&
	period(value.periodStart, value.periodEnd) &&
	nullable(value.snapshotId, (item) => string(item, 256)) &&
	nullable(value.rankingVersion, (item) => string(item, 120)) &&
	count(value.totalItems) &&
	count(value.inspectedItems) &&
	value.inspectedItems <= value.totalItems &&
	typeof value.truncated === "boolean"

const validRecommendation = (
	value: unknown,
	kind: "plugin" | "skill",
	origins: string[],
	weekStart: number,
	weekEnd: number,
	totalSearches: number
) => {
	if (
		!fields(value, [
			"artifactKind",
			"id",
			"displayName",
			"url",
			"category",
			"support",
			"metadataCheckedAt",
			"search",
			"adoption"
		]) ||
		value.artifactKind !== kind ||
		!string(value.id, 256) ||
		!string(value.displayName, 120) ||
		!validUrl(value.url, origins) ||
		!nullable(value.category, (item) => string(item, 120)) ||
		!timestamp(value.metadataCheckedAt)
	)
		return false
	const search = value.search
	if (search !== null) {
		if (
			!fields(search, [
				"matchedSearches7d",
				"previous7d",
				"searches30d",
				"queries",
				"omittedQueries",
				"periodStart",
				"periodEnd",
				"dataThrough",
				"collectionStartedAt"
			]) ||
			!count(search.matchedSearches7d) ||
			search.matchedSearches7d > totalSearches ||
			!count(search.previous7d) ||
			!count(search.searches30d) ||
			search.searches30d < search.matchedSearches7d + search.previous7d ||
			!count(search.omittedQueries) ||
			search.periodStart !== weekStart ||
			search.periodEnd !== weekEnd ||
			!nullable(search.dataThrough, timestamp) ||
			!nullable(search.collectionStartedAt, timestamp) ||
			!Array.isArray(search.queries) ||
			search.queries.length > 3 ||
			!search.queries.every(
				(query) =>
					fields(query, [
						"query",
						"scope",
						"searches7d",
						"previous7d",
						"searches30d"
					]) &&
					string(query.query, 256) &&
					scope(query.scope) &&
					count(query.searches7d) &&
					query.searches7d >= 3 &&
					query.searches7d <= (search.matchedSearches7d as number) &&
					count(query.previous7d) &&
					count(query.searches30d) &&
					query.searches30d >= query.searches7d + query.previous7d
			)
		)
			return false
		const queries = search.queries as NonNullable<
			Recommendation["search"]
		>["queries"]
		if (
			new Set(queries.map((query) => `${query.scope}\0${query.query}`)).size !==
				queries.length ||
			queries.reduce((sum, query) => sum + query.searches7d, 0) >
				search.matchedSearches7d ||
			queries.reduce((sum, query) => sum + query.previous7d, 0) >
				search.previous7d ||
			queries.reduce((sum, query) => sum + query.searches30d, 0) >
				search.searches30d
		)
			return false
	}
	const adoption = value.adoption
	if (adoption !== null) {
		if (
			!fields(adoption, [
				"source",
				"rank",
				"snapshotId",
				"rankingVersion",
				"periodStart",
				"periodEnd",
				"generatedAt",
				"sourceObservedAt",
				"downloads",
				"installs",
				"bookmarks",
				"lifetimeInstalls"
			]) ||
			typeof adoption.source !== "string" ||
			!(kind === "plugin"
				? adoption.source === "package-trending"
				: ["clawhub-trending", "clawhub-rising", "skills-sh-trending"].includes(
						adoption.source
					)) ||
			!nullable(adoption.rank, (item) => count(item) && item > 0) ||
			!nullable(adoption.snapshotId, (item) => string(item, 256)) ||
			!nullable(adoption.rankingVersion, (item) => string(item, 120)) ||
			!period(adoption.periodStart, adoption.periodEnd) ||
			!nullable(adoption.generatedAt, timestamp) ||
			!nullable(adoption.sourceObservedAt, timestamp) ||
			![
				adoption.downloads,
				adoption.installs,
				adoption.bookmarks,
				adoption.lifetimeInstalls
			].every((item) => nullable(item, count))
		)
			return false
	}
	if (value.support === "search-only")
		return (
			record(search) &&
			(search.matchedSearches7d as number) >= 3 &&
			adoption === null
		)
	if (value.support === "both")
		return (
			record(search) &&
			(search.matchedSearches7d as number) > 0 &&
			adoption !== null
		)
	return value.support === "adoption-only" && adoption !== null
}

export const parseEvidenceDigest = (
	value: unknown,
	origins: string[]
): EvidenceDigest | null => {
	if (
		!fields(value, [
			"kind",
			"weekStart",
			"weekEnd",
			"minimumSearches",
			"dashboardUrl",
			"truncated",
			"catalogs"
		]) ||
		value.kind !== "search_intelligence_weekly_v2" ||
		!fields(value.catalogs, ["plugins", "skills"]) ||
		new TextEncoder().encode(JSON.stringify(value)).byteLength > 30_000
	)
		return null
	for (const [name, kind] of [
		["plugins", "plugin"],
		["skills", "skill"]
	] as const) {
		const catalog = value.catalogs[name]
		if (
			!fields(catalog, [
				"totalSearches",
				"sourceCounts",
				"coverage",
				"classificationStatus",
				"currentMetadataStatus",
				"adoption",
				"companyOpportunities",
				"officialGaps",
				"movers",
				"recommendations"
			]) ||
			!validAdoptionSummary(catalog.adoption)
		)
			return null
		const unscoped: Record<string, unknown[]> = {}
		for (const section of [
			"companyOpportunities",
			"officialGaps",
			"movers"
		] as const) {
			const rows = catalog[section]
			if (
				!Array.isArray(rows) ||
				rows.length > 5 ||
				!rows.every(
					(row) =>
						record(row) &&
						scope(row.scope) &&
						(section !== "companyOpportunities" || row.scope === "catalog")
				)
			)
				return null
			unscoped[section] = rows.map(({ scope: _scope, ...row }) => row)
		}
		// The unchanged legacy validator owns shared weekly count, coverage, URL and
		// section invariants. V2 adds catalog identity and recommendation evidence.
		const summary = parseDigest(
			{
				kind: "plugin_search_weekly",
				weekStart: value.weekStart,
				weekEnd: value.weekEnd,
				minimumSearches: value.minimumSearches,
				dashboardUrl: value.dashboardUrl,
				truncated: value.truncated,
				totalSearches: catalog.totalSearches,
				sourceCounts: catalog.sourceCounts,
				coverage: catalog.coverage,
				classificationStatus: catalog.classificationStatus,
				currentMetadataStatus: catalog.currentMetadataStatus,
				...unscoped,
				featuredCandidates: []
			},
			origins
		)
		if (
			!summary ||
			!Array.isArray(catalog.recommendations) ||
			catalog.recommendations.length > 5 ||
			!catalog.recommendations.every((candidate) =>
				validRecommendation(
					candidate,
					kind,
					origins,
					summary.weekStart,
					summary.weekEnd,
					summary.totalSearches
				)
			) ||
			new Set(catalog.recommendations.map((candidate) => candidate.id)).size !==
				catalog.recommendations.length ||
			((catalog.adoption as Catalog["adoption"]).status === "unavailable" &&
				catalog.recommendations.some(
					(candidate) => candidate.adoption !== null
				))
		)
			return null
	}
	return value as unknown as EvidenceDigest
}

const safe = (value: string) =>
	value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/([\\`*_~|>\[\]()#])/g, "\\$1")
		.replace(/@/g, "@\u200b")
const brief = (value: string) =>
	safe(value.length > 80 ? `${value.slice(0, 79)}…` : value)
const link = (value: string) =>
	`<${new URL(value).toString().replace(/</g, "%3C").replace(/>/g, "%3E")}>`
const time = (value: number | null) =>
	value === null ? "unknown" : new Date(value).toISOString().slice(0, 16) + "Z"
const adoptionMetrics = (adoption: NonNullable<Recommendation["adoption"]>) => {
	const metrics = [
		["downloads", adoption.downloads],
		["installs", adoption.installs],
		["bookmarks", adoption.bookmarks],
		["lifetime installs", adoption.lifetimeInstalls]
	] as const
	return (
		metrics
			.filter(([, value]) => value !== null)
			.map(([label, value]) => `${value} ${label}`)
			.join(" · ") || "Adoption counts unavailable"
	)
}
const recommendationText = (row: Recommendation) => {
	const search = row.search
	const adoption = row.adoption
	return [
		`[${brief(row.displayName)}](${link(row.url)}) · ${row.support}${row.category ? ` · ${brief(row.category)}` : ""}`,
		search
			? `${search.matchedSearches7d} matched-query searches (previous ${search.previous7d}; 30d ${search.searches30d}); ${time(search.periodStart)} – ${time(search.periodEnd)}`
			: "Search evidence unavailable.",
		...(search?.queries.map(
			(query) =>
				`${brief(query.query)} (${query.scope}): ${query.searches7d} searches`
		) ?? []),
		...(search?.omittedQueries
			? [`${search.omittedQueries} query details omitted.`]
			: []),
		adoption
			? `${adoptionMetrics(adoption)}; ${time(adoption.periodStart)} – ${time(adoption.periodEnd)}; snapshot ${time(adoption.generatedAt)}${adoption.sourceObservedAt === null ? "" : `; source observed ${time(adoption.sourceObservedAt)}`} (${adoption.source}${adoption.rank === null ? "" : ` #${adoption.rank}`})`
			: "Adoption evidence unavailable.",
		`Metadata checked ${time(row.metadataCheckedAt)}.`
	].join("\n")
}

export const renderEvidenceDigest = (digest: EvidenceDigest) => {
	const preview = ["localhost", "127.0.0.1", "[::1]"].includes(
		new URL(digest.dashboardUrl).hostname
	)
	const header = `### ${preview ? "LOCAL PREVIEW · " : ""}ClawHub weekly intelligence\n${time(digest.weekStart)} – ${time(digest.weekEnd)} (UTC, end exclusive)\n[Open intelligence dashboard](${link(digest.dashboardUrl)})`
	const footer =
		"Human quality review, security and category-coverage review remain required. Company classification is advisory. Query details require at least 3 searches; matched-query searches are separate from adoption."
	const sections: {
		title: string
		rows: string[]
		empty?: string
		omitted: boolean
	}[] = []
	const rowText = (row: ScopedRow) =>
		`[${brief(row.query)}](${link(row.searchUrl)}) (${row.scope}) · ${row.searches} searches · ${row.officialGaps} gaps · previous ${row.previousSearches}`
	for (const [name, catalog] of [
		["Plugins", digest.catalogs.plugins],
		["Skills", digest.catalogs.skills]
	] as const) {
		const coverage = catalog.coverage
		const incomplete =
			coverage.dataThrough === null ||
			coverage.dataThrough < digest.weekEnd ||
			coverage.collectionStartedAt === null ||
			coverage.collectionStartedAt > digest.weekStart ||
			coverage.gapStart !== null
		sections.push({
			title: `**${name}** · ${catalog.totalSearches} searches (Web ${catalog.sourceCounts.clawhubWeb}, Control UI ${catalog.sourceCounts.openclawControlUi})\nData through ${time(coverage.dataThrough)}; collection started ${time(coverage.collectionStartedAt)}.${incomplete ? " Incomplete collection history." : ""}\nClassification ${catalog.classificationStatus}; adoption ${catalog.adoption.status}; search metadata ${catalog.currentMetadataStatus}.\nAdoption snapshot ${time(catalog.adoption.generatedAt)}; ${time(catalog.adoption.periodStart)} – ${time(catalog.adoption.periodEnd)}; inspected ${catalog.adoption.inspectedItems}/${catalog.adoption.totalItems}${catalog.adoption.truncated ? " (capped)" : ""}.`,
			rows: [],
			omitted: false
		})
		for (const [title, rows, empty] of [
			[
				`${name} Featured recommendations`,
				catalog.recommendations.map(recommendationText),
				"No qualifying recommendations."
			],
			[
				`${name} company opportunities`,
				catalog.companyOpportunities.map(
					(row) =>
						`${rowText(row)}${row.companyProductName ? ` · ${brief(row.companyProductName)}` : ""} · ${Math.round(row.confidence * 100)}% classifier confidence`
				),
				"No qualifying company opportunities."
			],
			[
				`${name} official gaps`,
				catalog.officialGaps.map(rowText),
				"No qualifying official gaps."
			],
			[`${name} movers`, catalog.movers.map(rowText), "No qualifying movers."]
		] as const)
			sections.push({
				title: `**${title}**`,
				rows: [...rows],
				empty,
				omitted: false
			})
	}
	const text = (section: (typeof sections)[number]) =>
		[
			section.title,
			...section.rows,
			...(!section.rows.length && !section.omitted && section.empty
				? [section.empty]
				: []),
			...(section.omitted ? ["More evidence on the dashboard."] : [])
		].join("\n")
	const renderedLength = () =>
		header.length + footer.length + sections.map(text).join("\n").length + 80
	// Drop whole rows from the longest remaining section; never cut a URL or
	// re-rank the canonical recommendations just to fit Discord's text budget.
	while (renderedLength() > 3900) {
		const longest = sections
			.filter((section) => section.rows.length)
			.sort((a, b) => b.rows.join("\n").length - a.rows.join("\n").length)[0]
		if (!longest) break
		longest.rows.pop()
		longest.omitted = true
	}
	return serializePayload({
		components: [
			new Container([
				new TextDisplay(header),
				...sections.map((section) => new TextDisplay(text(section))),
				new TextDisplay(
					`${footer}${digest.truncated ? " Input capped; more evidence on the dashboard." : ""}`
				)
			])
		],
		allowedMentions: { parse: [] }
	})
}
