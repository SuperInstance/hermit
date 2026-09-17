// Minimal L1 types for the vendored reference kernel (src/quilt/reference-kernel.mjs,
// copied byte-identical from SuperInstance/quilt-studio). tsc needs these because
// allowJs is off and the vendored file is intentionally left untouched.

export type QuiltEvent = {
	kind: "bind" | "unbind" | "link" | "unlink" | "effect" | "apply" | "undo" | "tick" | "load"
	cell: string | null
	value: unknown
	ts: number
}

export type QuiltLink = { id: string; from: string; to: string; type: string }

export declare class QuiltKernel {
	constructor(): QuiltKernel
	on(fn: (ev: QuiltEvent) => void): () => boolean
	subscribe(fn: (ev: QuiltEvent) => void): () => boolean
	emit(kind: string, cell: string | null, value: unknown): QuiltEvent
	bind(name: string, value?: unknown, meta?: unknown): QuiltKernel
	unbind(name: string): QuiltKernel
	view<T = unknown>(name: string): T | null
	cells(): string[]
	link(from: string, to: string, type: string): string
	unlink(id: string): QuiltKernel
	links(): QuiltLink[]
	effect(
		name: string,
		opName: string,
		forward: (before: unknown) => unknown,
		backward?: (after: unknown) => unknown
	): QuiltKernel
	apply(name: string, opName: string): unknown
	undo(): string | null
	queueEffect(name: string, opName: string): QuiltKernel
	tick(ts?: number | null): QuiltKernel
	snapshot(): {
		cells: Record<string, unknown>
		links: QuiltLink[]
		ts: number
		historyDepth: number
	}
	load(snapshot: {
		cells?: Record<string, unknown>
		links?: QuiltLink[]
		meta?: Record<string, unknown>
	}): QuiltKernel
}
