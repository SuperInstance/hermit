import {
	Container,
	LinkButton,
	Row,
	TextDisplay,
	serializePayload
} from "@buape/carbon"
import { count, fields, record, string, timestamp } from "./contract.js"
import type {
	Catalog,
	FeaturedLineup,
	LineupDigest,
	LineupRecommendation
} from "./evidence.js"

type Adoption = {
	source: "package-daily-installs" | "skill-daily-installs"
	rank: number
	installs30d: number
	installs7d: number
	importedRows: number
	importDatasetVersions: string[]
}
type Recommendation = Omit<LineupRecommendation, "adoption"> & {
	slot: number
	selectionBasis: "editorial" | "telemetry"
	reason: string
	adoption: Adoption | null
}
type Reservation = {
	slot: number
	id: string | null
	name: string | null
	displayName: string | null
	reason: string | null
	status: "ready" | "pending"
	pendingReasons: string[]
}
type Lineup = Omit<FeaturedLineup, "targetSize"> & {
	targetSize: 16
	reservedSlots: number
	telemetryTarget: number
	pendingCount: number
	telemetryShortfall: number
	editorialRevision: number
	currentEditorialRevision: number
	staleEditorial: boolean
	reservations: Reservation[]
}
type MonthlyCatalog = Omit<Catalog, "recommendations" | "adoption"> & {
	recommendations: Recommendation[]
	lineup: Lineup
	adoption: Catalog["adoption"] & {
		collectionStartedAt: number
		periodStart7d: number
		scannedRows: number
		importedRows: number
		importDatasetVersions: string[]
	}
}
export type MonthlyDigest = Omit<LineupDigest, "kind" | "catalogs"> & {
	kind: "search_intelligence_weekly_v4"
	catalogs: { plugins: MonthlyCatalog; skills: MonthlyCatalog }
}
const versions = (value: unknown) =>
	Array.isArray(value) &&
	value.length <= 100 &&
	value.every((entry) => string(entry, 256)) &&
	new Set(value).size === value.length
export const validMonthlyAdoption = (
	value: unknown,
	kind: "plugin" | "skill"
) =>
	fields(value, [
		"source",
		"rank",
		"installs30d",
		"installs7d",
		"importedRows",
		"importDatasetVersions"
	]) &&
	value.source ===
		(kind === "plugin" ? "package-daily-installs" : "skill-daily-installs") &&
	count(value.rank) &&
	value.rank > 0 &&
	count(value.installs30d) &&
	count(value.installs7d) &&
	value.installs30d >= value.installs7d &&
	count(value.importedRows) &&
	versions(value.importDatasetVersions)

export const validMonthlySummary = (value: unknown, end: number) =>
	record(value) &&
	value.periodEnd === end &&
	value.periodStart === end - 30 * 86400000 &&
	value.periodStart7d === end - 7 * 86400000 &&
	timestamp(value.collectionStartedAt) &&
	(value.generatedAt === null ||
		(timestamp(value.generatedAt) &&
			value.generatedAt >= value.collectionStartedAt)) &&
	count(value.scannedRows) &&
	count(value.importedRows) &&
	value.importedRows <= value.scannedRows &&
	versions(value.importDatasetVersions)

export const validMonthlyLineup = (
	value: unknown,
	candidates: unknown[],
	kind: "plugin" | "skill"
) => {
	if (
		!record(value) ||
		value.reservedSlots !== (kind === "plugin" ? 8 : 0) ||
		value.telemetryTarget !== (kind === "plugin" ? 8 : 16) ||
		!count(value.pendingCount) ||
		!count(value.telemetryShortfall) ||
		!count(value.editorialRevision) ||
		!count(value.currentEditorialRevision) ||
		value.staleEditorial !==
			(value.editorialRevision !== value.currentEditorialRevision) ||
		!Array.isArray(value.reservations) ||
		value.reservations.length !== value.reservedSlots ||
		!value.reservations.every(
			(entry, slot) =>
				fields(entry, [
					"slot",
					"id",
					"name",
					"displayName",
					"reason",
					"status",
					"pendingReasons"
				]) &&
				entry.slot === slot &&
				(entry.id === null || string(entry.id, 256)) &&
				(entry.name === null || string(entry.name, 256)) &&
				(entry.displayName === null || string(entry.displayName, 120)) &&
				(entry.reason === null || string(entry.reason, 500)) &&
				(entry.status === "ready" || entry.status === "pending") &&
				Array.isArray(entry.pendingReasons) &&
				entry.pendingReasons.length <= 12 &&
				entry.pendingReasons.every((reason) => string(reason, 256))
		) ||
		!candidates.every(
			(entry) =>
				record(entry) &&
				count(entry.slot) &&
				entry.slot < 16 &&
				string(entry.reason, 500) &&
				(entry.selectionBasis === "editorial" ||
					entry.selectionBasis === "telemetry")
		)
	)
		return false
	const lineup = value as unknown as Lineup
	const rows = candidates as Recommendation[]
	const assigned = lineup.reservations.filter((entry) => entry.id !== null)
	const telemetry = rows.filter((entry) => entry.selectionBasis === "telemetry")
	return (
		new Set(assigned.map((entry) => entry.id)).size === assigned.length &&
		lineup.pendingCount ===
			lineup.reservations.filter((entry) => entry.status === "pending")
				.length &&
		lineup.telemetryShortfall === lineup.telemetryTarget - telemetry.length &&
		rows.every(
			(entry, index) =>
				(index === 0 || rows[index - 1].slot < entry.slot) &&
				(entry.selectionBasis === "editorial"
					? entry.slot < lineup.reservedSlots
					: entry.slot >= lineup.reservedSlots &&
						entry.adoption !== null &&
						entry.adoption.installs30d > 0)
		) &&
		lineup.reservations.every((entry) => {
			const candidate = rows.find((row) => row.slot === entry.slot)
			return entry.status === "ready"
				? entry.id !== null &&
						entry.name !== null &&
						entry.reason !== null &&
						entry.pendingReasons.length === 0 &&
						candidate?.selectionBasis === "editorial" &&
						candidate.id === entry.id &&
						candidate.reason === entry.reason
				: candidate === undefined && entry.pendingReasons.length > 0
		})
	)
}

class DashboardLink extends LinkButton {
	label = "Review complete report"
	constructor(public url: string) {
		super()
	}
}
const safe = (value: string) =>
	value.replace(/([\\`*_~|>\[\]()#])/g, "\\$1").replace(/@/g, "@\u200b")
const time = (value: number | null) =>
	value === null ? "unknown" : new Date(value).toISOString()
const day = (value: number | null) =>
	value === null ? "unknown" : new Date(value).toISOString().slice(0, 10)

export const renderMonthlyDigest = (digest: MonthlyDigest) => {
	const preview = ["localhost", "127.0.0.1", "[::1]"].includes(
		new URL(digest.dashboardUrl).hostname
	)
	const blocks: string[] = []
	for (const [name, catalog] of [
		["Plugins", digest.catalogs.plugins],
		["Skills", digest.catalogs.skills]
	] as const) {
		const { lineup, adoption } = catalog
		blocks.push(
			`### ${name}: ${catalog.recommendations.length}/16 ready\nInstalls: 30 completed UTC days ${day(adoption.periodStart)} – ${day(adoption.periodEnd)} (end exclusive); final 7 days from ${day(adoption.periodStart7d)}. Counts below: 30d / 7d.\n${lineup.pendingCount} pending editorial; ${lineup.telemetryShortfall} telemetry shortfall. ${lineup.removals.length} proposed removals. Editorial revision ${lineup.editorialRevision}${lineup.staleEditorial ? ` is stale (current ${lineup.currentEditorialRevision}); regenerate before approval.` : "."}\nAggregate scan ${new Date(adoption.collectionStartedAt).toISOString()} – ${adoption.generatedAt === null ? "unknown" : new Date(adoption.generatedAt).toISOString()}; ${adoption.importedRows} imported rows. ${adoption.status === "unavailable" ? "Adoption unavailable." : ""}`
		)
		if (adoption.truncated)
			blocks.push(
				`${name} adoption metadata limited; inspected ${adoption.inspectedItems} of ${adoption.totalItems} candidates.`
			)
		for (let slot = 0; slot < 16; slot++) {
			const candidate = catalog.recommendations.find(
				(entry) => entry.slot === slot
			)
			const reservation = lineup.reservations[slot]
			if (candidate)
				blocks.push(
					`${name} ${slot + 1}. **${safe(candidate.displayName)}** · ${safe(candidate.id)}\n${candidate.selectionBasis} · ${candidate.adoption ? `${candidate.adoption.installs30d} / ${candidate.adoption.installs7d}` : "counts unavailable"} · Metadata checked ${time(candidate.metadataCheckedAt)}\n${safe(candidate.reason)}`
				)
			else if (reservation)
				blocks.push(
					`${name} ${slot + 1}. ${reservation.id ? safe(reservation.id) : "Unassigned"} · editorial PENDING\n${reservation.reason ? safe(reservation.reason) + "\n" : ""}${reservation.pendingReasons.map(safe).join("\n")}`
				)
		}
		const { coverage } = catalog
		const incomplete =
			coverage.dataThrough === null ||
			coverage.dataThrough < digest.weekEnd ||
			coverage.collectionStartedAt === null ||
			coverage.collectionStartedAt > digest.weekStart ||
			coverage.gapStart !== null
		blocks.push(
			`### ${name} weekly search context\n${catalog.totalSearches} searches · Web ${catalog.sourceCounts.clawhubWeb} · Control UI ${catalog.sourceCounts.openclawControlUi}\nData through ${time(coverage.dataThrough)}; collection started ${time(coverage.collectionStartedAt)}.${incomplete ? " Incomplete collection history." : ""}${coverage.gapStart !== null ? ` Gap ${time(coverage.gapStart)} – ${time(coverage.gapEnd)}.` : ""}\nClassification ${catalog.classificationStatus}; search metadata ${catalog.currentMetadataStatus}. Search counts do not affect monthly install rank.`
		)
		for (const [title, rows] of [
			["company opportunities", catalog.companyOpportunities],
			["official gaps", catalog.officialGaps],
			["movers", catalog.movers]
		] as const) {
			blocks.push(
				`**${name} ${title}**${rows.length ? "" : "\nNone qualified."}`
			)
			for (const row of rows)
				blocks.push(
					`${safe(row.query)} (${row.scope}): ${row.searches} searches · previous ${row.previousSearches} · ${row.officialGaps} official gaps${"companyProductName" in row && row.companyProductName ? ` · ${safe(row.companyProductName)}` : ""}${"confidence" in row ? ` · ${Math.round(row.confidence * 100)}% classifier confidence` : ""}`
				)
		}
	}
	// Retain every slot and rationale. A valid 30KB report can exceed one
	// message; pack deterministically before claiming any delivery receipts.
	const pages: string[] = []
	for (const block of blocks) {
		const chunks = block.length <= 3400 ? [block] : block.split("\n")
		for (const chunk of chunks) {
			if (
				!pages.length ||
				pages[pages.length - 1].length + chunk.length + 1 > 3400
			)
				pages.push(chunk)
			else pages[pages.length - 1] += "\n" + chunk
		}
	}

	const dashboardUrl =
		digest.dashboardUrl.length <= 512
			? digest.dashboardUrl
			: new URL(
					`/management?view=search-insights&endDay=${digest.weekEnd}`,
					digest.dashboardUrl
				).href
	return pages.map((page, index) =>
		serializePayload({
			components: [
				new Container([
					new TextDisplay(
						`### ${preview ? "LOCAL PREVIEW · " : ""}ClawHub monthly Featured review · ${index + 1}/${pages.length}\nAdvisory; approval required. Search context ${day(digest.weekStart)} – ${day(digest.weekEnd)} is separate from install ranking. Full search links and removal reasons remain on the dashboard.${digest.truncated ? "\nSome evidence details omitted; all proposed slots retained." : ""}`
					),
					new TextDisplay(page),
					new Row([new DashboardLink(dashboardUrl)])
				])
			],
			allowedMentions: { parse: [] }
		})
	)
}
