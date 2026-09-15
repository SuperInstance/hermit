export type Row = {
	query: string
	searches: number
	previousSearches: number
	officialGaps: number
	searchUrl: string
}
export type Digest = {
	kind: "plugin_search_weekly"
	weekStart: number
	weekEnd: number
	minimumSearches: 3
	dashboardUrl: string
	totalSearches: number
	sourceCounts: { clawhubWeb: number; openclawControlUi: number }
	classificationStatus: "available" | "partial" | "unavailable"
	currentMetadataStatus: "available" | "unavailable"
	truncated: boolean
	coverage: {
		dataThrough: number | null
		collectionStartedAt: number | null
		gapStart: number | null
		gapEnd: number | null
	}
	companyOpportunities: (Row & {
		companyProductName?: string
		confidence: number
	})[]
	officialGaps: Row[]
	featuredCandidates: (Row & {
		package: { name: string; displayName: string; url: string }
	})[]
	movers: Row[]
}
export const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value)
export const fields = (
	value: unknown,
	required: string[],
	optional: string[] = []
): value is Record<string, unknown> =>
	record(value) &&
	required.every((key) => Object.hasOwn(value, key)) &&
	Object.keys(value).every(
		(key) => required.includes(key) || optional.includes(key)
	)
export const count = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0
export const timestamp = (value: unknown): value is number =>
	count(value) && value <= 8_640_000_000_000_000
export const string = (value: unknown, max: number): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.trim() === value &&
	value.length <= max &&
	!/[\u0000-\u001f\u007f]/.test(value)
export const validUrl = (value: unknown, origins: string[]) => {
	if (!string(value, 2048)) return false
	try {
		const url = new URL(value)
		return (
			["http:", "https:"].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			origins.includes(url.origin) &&
			url.toString().length <= 2048
		)
	} catch {
		return false
	}
}
export const parseDigest = (
	value: unknown,
	origins: string[]
): Digest | null => {
	if (
		!fields(value, [
			"kind",
			"weekStart",
			"weekEnd",
			"minimumSearches",
			"dashboardUrl",
			"totalSearches",
			"sourceCounts",
			"classificationStatus",
			"currentMetadataStatus",
			"truncated",
			"coverage",
			"companyOpportunities",
			"officialGaps",
			"featuredCandidates",
			"movers"
		])
	)
		return null
	if (
		value.kind !== "plugin_search_weekly" ||
		value.minimumSearches !== 3 ||
		!timestamp(value.weekStart) ||
		!timestamp(value.weekEnd) ||
		value.weekEnd - value.weekStart !== 604_800_000 ||
		value.weekEnd % 86_400_000 !== 0 ||
		new Date(value.weekEnd).getUTCDay() !== 1 ||
		!validUrl(value.dashboardUrl, origins) ||
		!count(value.totalSearches) ||
		typeof value.truncated !== "boolean"
	)
		return null
	if (
		typeof value.classificationStatus !== "string" ||
		!["available", "partial", "unavailable"].includes(
			value.classificationStatus
		) ||
		typeof value.currentMetadataStatus !== "string" ||
		!["available", "unavailable"].includes(value.currentMetadataStatus)
	)
		return null
	const sources = value.sourceCounts
	if (
		!fields(sources, ["clawhubWeb", "openclawControlUi"]) ||
		!count(sources["clawhubWeb"]) ||
		!count(sources["openclawControlUi"]) ||
		sources["clawhubWeb"] + sources["openclawControlUi"] !== value.totalSearches
	)
		return null
	const coverage = value.coverage
	if (
		!fields(coverage, [
			"dataThrough",
			"collectionStartedAt",
			"gapStart",
			"gapEnd"
		]) ||
		!Object.values(coverage).every(
			(time) => time === null || timestamp(time)
		) ||
		(coverage.gapStart === null) !== (coverage.gapEnd === null) ||
		(typeof coverage.gapStart === "number" &&
			typeof coverage.gapEnd === "number" &&
			coverage.gapStart >= coverage.gapEnd)
	)
		return null
	const rowFields = [
		"query",
		"searches",
		"previousSearches",
		"officialGaps",
		"searchUrl"
	]
	const validRows = (
		rows: unknown,
		kind: "company" | "gap" | "featured" | "mover"
	) =>
		Array.isArray(rows) &&
		rows.length <= 5 &&
		rows.every((row) => {
			if (
				!fields(
					row,
					[
						...rowFields,
						...(kind === "company"
							? ["confidence"]
							: kind === "featured"
								? ["package"]
								: [])
					],
					kind === "company" ? ["companyProductName"] : []
				) ||
				!string(row.query, 256) ||
				!count(row.searches) ||
				row.searches > (value.totalSearches as number) ||
				!count(row.previousSearches) ||
				!count(row.officialGaps) ||
				row.officialGaps > row.searches ||
				!validUrl(row.searchUrl, origins)
			)
				return false
			if (
				(kind === "mover"
					? Math.max(row.searches, row.previousSearches)
					: row.searches) < 3
			)
				return false
			if ((kind === "company" || kind === "gap") && row.officialGaps < 3)
				return false
			if (
				kind === "company" &&
				(typeof row.confidence !== "number" ||
					!Number.isFinite(row.confidence) ||
					row.confidence < 0.8 ||
					row.confidence > 1 ||
					(row.companyProductName !== undefined &&
						!string(row.companyProductName, 120)))
			)
				return false
			if (
				kind === "featured" &&
				(!fields(row.package, ["name", "displayName", "url"]) ||
					!string(row.package.name, 160) ||
					!string(row.package.displayName, 120) ||
					!validUrl(row.package.url, origins))
			)
				return false
			return true
		})
	if (
		!validRows(value.companyOpportunities, "company") ||
		!validRows(value.officialGaps, "gap") ||
		!validRows(value.featuredCandidates, "featured") ||
		!validRows(value.movers, "mover")
	)
		return null
	if (
		(value.classificationStatus === "unavailable" &&
			(value.companyOpportunities as unknown[]).length) ||
		(value.currentMetadataStatus === "unavailable" &&
			(value.featuredCandidates as unknown[]).length)
	)
		return null
	return value as unknown as Digest
}
