// index.ts — the hermit-facing tidepool v1 API.
//
// Every write is a DUAL-WRITE: the ocean markdown is the human-readable
// memory; the quilt WAL is the replayable ledger (contract: /tmp/tidepool
// README). WAL failures are caught and counted, never thrown into the
// helper path — the P1/P2 risk posture. When PR #5 (ops counters) lands,
// the local counter below wires into recordWalFailure("tidepool_projection").

import { commitProjection, type WalClient } from "../quilt/commit.js"
import type { WalRow } from "../quilt/projection.js"
import {
	TidepoolOcean,
	type HelperThreadSummary,
	type OceanEntry
} from "./ocean.js"
import {
	projectHelperThread,
	projectQuietThread,
	readWalRowsByMutation
} from "./projection.js"
import type { QuietThread } from "./stall.js"

// Local failure counter (forward-compatible with src/quilt/ops.ts).
let walFailureCount = 0
export const getTidepoolWalFailures = (): number => walFailureCount
export const resetTidepoolWalFailures = (): void => {
	walFailureCount = 0
}

/**
 * Remember one helper-thread summary: append to the ocean AND project
 * BIND-for-BIND into the quilt WAL (one mutation). Returns the WAL rows
 * read back from the ledger — the WAL is the source of truth.
 */
export const rememberHelperThread = async (
	ocean: TidepoolOcean,
	walClient: WalClient,
	thread: HelperThreadSummary,
	ctx: { mutationId: string; ts: string }
): Promise<{ section: string; entry: OceanEntry; walRows: WalRow[] }> => {
	const { section, entry } = await ocean.remember(thread)
	let walRows: WalRow[] = []
	try {
		await commitProjection(walClient, ctx, (kernel) => {
			projectHelperThread(kernel, thread, ctx.ts)
		})
		walRows = await readWalRowsByMutation(
			walClient as unknown as Parameters<typeof readWalRowsByMutation>[0],
			ctx.mutationId
		)
	} catch (error) {
		walFailureCount += 1
		console.warn("quilt wal tidepool projection failed", error)
	}
	return { section, entry, walRows }
}

/**
 * Channel sweep: remember N threads in ONE projection → ONE mutation_id,
 * ONE WAL batch (the hermit commit-batch shape).
 */
export const rememberChannelThreads = async (
	ocean: TidepoolOcean,
	walClient: WalClient,
	threads: HelperThreadSummary[],
	ctx: { mutationId: string; ts: string }
): Promise<{ remembered: Array<{ section: string; entry: OceanEntry }>; walRows: WalRow[] }> => {
	const remembered = await ocean.rememberAll(threads)
	let walRows: WalRow[] = []
	try {
		await commitProjection(walClient, ctx, (kernel) => {
			for (const thread of threads) {
				projectHelperThread(kernel, thread, ctx.ts)
			}
		})
		walRows = await readWalRowsByMutation(
			walClient as unknown as Parameters<typeof readWalRowsByMutation>[0],
			ctx.mutationId
		)
	} catch (error) {
		walFailureCount += 1
		console.warn("quilt wal tidepool projection failed", error)
	}
	return { remembered, walRows }
}

/** Top 3–5 relevant thread memories. Deterministic, replay-reproducible. */
export const recallHelperContext = (
	ocean: TidepoolOcean,
	query: string,
	{ limit = 5 }: { limit?: number } = {}
): Promise<OceanEntry[]> => ocean.recall(query, { limit })

/** The oath log: append-only, timestamped, immutable. */
export const rememberBotAction = (
	ocean: TidepoolOcean,
	action: string
): Promise<{ ts: string; action: string }> => ocean.botAction(action)

/**
 * threadLengthMonitor's negative ledger: drain detected quiet threads into
 * the WAL. Absence is the information (P2 `.refused` pattern) — no
 * helper_threads row is touched.
 */
export const drainQuietThreads = async (
	walClient: WalClient,
	quietList: QuietThread[],
	ctx: { mutationId: string; ts: string }
): Promise<{ walRows: WalRow[] }> => {
	if (quietList.length === 0) return { walRows: [] }
	let walRows: WalRow[] = []
	try {
		await commitProjection(walClient, ctx, (kernel) => {
			for (const quiet of quietList) {
				projectQuietThread(kernel, quiet, ctx.ts)
			}
		})
		walRows = await readWalRowsByMutation(
			walClient as unknown as Parameters<typeof readWalRowsByMutation>[0],
			ctx.mutationId
		)
	} catch (error) {
		walFailureCount += 1
		console.warn("quilt wal tidepool projection failed", error)
	}
	return { walRows }
}
