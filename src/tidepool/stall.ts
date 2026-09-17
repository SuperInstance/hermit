// stall.ts — threadLengthMonitor as a PURE function.
//
// The recalled design had an edge function polling thread lengths every 30
// minutes. The decision core is pure: given a length history, a thread
// whose message count stops growing across N consecutive polls becomes a
// "quiet thread" memory. The absence is the information — hermit's P2
// negative-ledger pattern applied to helper threads.

export type ThreadLengthPoll = {
	threadId: string
	ts: string
	messageCount: number
}

export type QuietThread = {
	threadId: string
	silentPolls: number
	lastCount: number
	since: string
	ts: string
}

/**
 * History in, quiet list out — no I/O, no clock (timestamps come from
 * the samples). `window` = consecutive flat polls required (default 3).
 * `since` = ts of the last growth, `ts` = ts of the newest sample.
 */
export const detectQuietThreads = (
	polls: ThreadLengthPoll[],
	{ window = 3 }: { window?: number } = {}
): QuietThread[] => {
	const byThread = new Map<string, ThreadLengthPoll[]>()
	for (const poll of polls) {
		if (!byThread.has(poll.threadId)) byThread.set(poll.threadId, [])
		byThread.get(poll.threadId)!.push(poll)
	}
	const quiet: QuietThread[] = []
	for (const [threadId, samples] of byThread) {
		samples.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
		let flat = 0
		let since = samples[0]?.ts ?? ""
		for (let i = 1; i < samples.length; i += 1) {
			if (samples[i].messageCount > samples[i - 1].messageCount) {
				flat = 0
				since = samples[i].ts
			} else {
				flat += 1
			}
		}
		if (flat >= window - 1 && samples.length >= window) {
			quiet.push({
				threadId,
				silentPolls: flat + 1,
				lastCount: samples[samples.length - 1].messageCount,
				since,
				ts: samples[samples.length - 1].ts
			})
		}
	}
	return quiet
}

/**
 * Crossing-only delta for a 30-minute cron: only threads that JUST crossed
 * the threshold on the most recent poll. Threads already quiet stay in the
 * ocean — silence is remembered once. (Bench extra; pure composition.)
 */
export const newlyQuietThreads = (
	polls: ThreadLengthPoll[],
	{ window = 3 }: { window?: number } = {}
): QuietThread[] =>
	detectQuietThreads(polls, { window }).filter((q) => q.silentPolls === window)
