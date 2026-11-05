/**
 * The background-activity screen's pure layer (2026-11): folds the
 * persisted run ledgers (chat + notes extraction usage, sub-agent job
 * records) into one newest-first history, and projects per-stage token
 * totals for the live registry. No fs, no stores — the composition root
 * (server/observability.ts) feeds it; the client renders it.
 *
 * The wire contract also lives here so the server and the screen share
 * ONE shape: `ActivityCenter` is what GET /api/activity/history returns.
 * Everything is derived from records that already exist (`extractions`
 * arrays, job files, the running-run registry) — no migration.
 */

import type { CallUsage, ExtractionRunUsage, ExtractionStageUsage } from "./contracts/chat.ts";
import type { GraphChain, GraphNode } from "./contracts/graph.ts";
import type { JobKind, JobRecord, JobUsage } from "./contracts/jobs.ts";

/** Absent token fields stay absent in the source data; totals sum only
 *  what providers reported (`undefined` contributes 0, never a fake 0
 *  line — the money-channel doctrine). */
export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	/** input + output + cache read + cache write — the meter's footprint. */
	total: number;
	steps: number;
}

export interface ActivityStageSummary {
	model: string;
	steps: number;
	tokens: TokenTotals;
}

export interface ActivityProgress {
	linesDone: number;
	chunksDone: number;
}

/** What one persisted run wrote, attributed by merge timestamp + source
 *  provenance (the ledger lines a run appends carry `createdAt` = merge
 *  time; chunks of one source run serially, so the window is exact). */
export interface GeneratedView {
	/** Nodes whose FIRST line (birth) landed in this run. */
	nodes: GeneratedNode[];
	/** Arguments this run asserted (names resolved from node lines). */
	chains: GeneratedChain[];
	/** Re-encounter lines for nodes born elsewhere (aliases/provenance). */
	linked: number;
	/** Items beyond the display cap. */
	omittedNodes: number;
	omittedChains: number;
}

export interface GeneratedNode {
	id: string;
	name: string;
	statement: string;
}

export interface GeneratedChain {
	id: string;
	/** Node NAMES in premise order; unresolved ids pass through. */
	premises: string[];
	conclusion: string;
}

export type ActivityHistoryEntry =
	| {
		process: "extraction";
		/** `${sourceId}:${startedAt}` — stable React key. */
		id: string;
		sourceId: string;
		/** Which front door persisted the run. */
		sourceKind: "chat" | "notes";
		title: string;
		startedAt: number;
		durationMs: number;
		/** null = the stage chain died before any merge (failed/aborted). */
		merged: { nodes: number; chains: number; droppedChains?: number } | null;
		stages: { extractor: ActivityStageSummary | null; auditor: ActivityStageSummary | null };
		tokens: TokenTotals | null;
		/** Notes door only: the source's persisted resume checkpoint. */
		progress?: ActivityProgress;
		/** Present when the caller supplied the ledgers (the screen does):
		 *  what this run actually wrote. */
		generated?: GeneratedView;
	}
	| {
		process: "job";
		id: string;
		jobKind: JobKind;
		chatId: string;
		title: string;
		startedAt: number;
		durationMs: number;
		status: "done" | "error";
		activity: string;
		error?: string;
		model?: string;
		steps?: number;
		tokens: TokenTotals | null;
		costUsd: number | null;
	};

/** One LIVE extraction run (the registry), richer than the dock's feed:
 *  the screen shows the stage breakdown. */
export interface ActivityLiveExtraction {
	id: string;
	chatId: string;
	kind: "chat" | "notes";
	label?: string;
	part?: { i: number; n: number };
	title: string;
	phase: string;
	startedAt: number;
	usage: { extractor?: ExtractionStageUsage; auditor?: ExtractionStageUsage };
}

/** One LIVE sub-agent job (the dock feed's shape). */
export interface ActivityLiveJob extends JobRecord {
	costUsd: number | null;
	title: string;
	contextLimit: number | null;
}

export interface ActivityCenter {
	jobs: ActivityLiveJob[];
	extractions: ActivityLiveExtraction[];
	/** One PAGE of history (offset/limit), newest first. */
	history: ActivityHistoryEntry[];
	/** Total persisted runs, before paging — the screen's "load more" bound. */
	total: number;
}

export interface ExtractionHistoryInput {
	sourceId: string;
	kind: "chat" | "notes";
	title: string;
	usage: ExtractionRunUsage;
	progress?: ActivityProgress;
}

export interface JobHistoryInput {
	job: JobRecord;
	title: string;
	costUsd: number | null;
}

/** Per-group display cap in the expanded run detail. */
export const GENERATED_VIEW_LIMIT = 25;

/** Sum one stage's model calls. A stage with zero steps or no model is
 *  still a stage (the pipeline records it) — totals read 0, model "". */
export function stageSummary(stage: ExtractionStageUsage | undefined): ActivityStageSummary | null {
	if (!stage) return null;
	const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, steps: 0 };
	for (const call of stage.steps) {
		tokens.input += call.inputTokens ?? 0;
		tokens.output += call.outputTokens ?? 0;
		tokens.cacheRead += call.cacheReadTokens ?? 0;
		tokens.cacheWrite += call.cacheWriteTokens ?? 0;
		tokens.reasoning += call.reasoningTokens ?? 0;
		tokens.steps++;
	}
	tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
	return { model: stage.model, steps: tokens.steps, tokens };
}

/** Job usage is already cumulative (JobUsage) — no steps to fold. */
export function jobTokens(usage: JobUsage | undefined): TokenTotals | null {
	if (!usage) return null;
	const totals: TokenTotals = {
		input: usage.inputTokens ?? 0,
		output: usage.outputTokens ?? 0,
		cacheRead: usage.cacheReadTokens ?? 0,
		cacheWrite: usage.cacheWriteTokens ?? 0,
		reasoning: usage.reasoningTokens ?? 0,
		steps: usage.steps,
		total: 0,
	};
	totals.total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	return totals;
}

const addTotals = (a: TokenTotals | null, b: TokenTotals | null): TokenTotals | null => {
	if (!a) return b;
	if (!b) return a;
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		reasoning: a.reasoning + b.reasoning,
		total: a.total + b.total,
		steps: a.steps + b.steps,
	};
};

/** One page's size: 50 by default, 1..200 per request (the screen pages
 *  with offset — this bound is transport, not a display cap). */
export function historyLimit(raw: number | undefined): number {
	const n = raw === undefined || !Number.isFinite(raw) ? 50 : Math.floor(raw);
	return Math.min(200, Math.max(1, n));
}

/** One page of the fold + the unpaged total. */
export interface ActivityHistoryPage {
	entries: ActivityHistoryEntry[];
	total: number;
}

/** Fold persisted runs into one newest-first history. Persisted usage
 *  entries exist only after a job ended (success, failure or abort), so
 *  this never duplicates the live section. */
export function buildActivityHistory(
	input: {
		extractions: readonly ExtractionHistoryInput[];
		jobs: readonly JobHistoryInput[];
		/** Ledger lines (append order). Omitted → no generated view. */
		nodes?: readonly GraphNode[];
		chains?: readonly GraphChain[];
	},
	range: { offset?: number; limit?: number } = {},
): ActivityHistoryPage {
	const attribution = input.nodes !== undefined || input.chains !== undefined;
	// Per-source run starts: attribution windows must not overlap the NEXT
	// run of the same source (chunks start immediately after the previous
	// one ends, inside the clock-slack tail).
	const startsBySource = new Map<string, number[]>();
	for (const { sourceId, usage } of input.extractions) {
		const list = startsBySource.get(sourceId);
		if (list) list.push(usage.startedAt);
		else startsBySource.set(sourceId, [usage.startedAt]);
	}
	for (const list of startsBySource.values()) list.sort((a, b) => a - b);
	const firstLine = new Map<string, GraphNode>();
	const nodeName = new Map<string, string>();
	const nodesBySource = new Map<string, GraphNode[]>();
	for (const line of input.nodes ?? []) {
		if (!firstLine.has(line.id)) {
			firstLine.set(line.id, line);
			nodeName.set(line.id, line.name);
		}
		for (const point of line.provenance) {
			const bucket = nodesBySource.get(point.chatId);
			if (bucket) bucket.push(line);
			else nodesBySource.set(point.chatId, [line]);
		}
	}
	const chainsBySource = new Map<string, GraphChain[]>();
	for (const line of input.chains ?? []) {
		for (const point of line.provenance) {
			const bucket = chainsBySource.get(point.chatId);
			if (bucket) bucket.push(line);
			else chainsBySource.set(point.chatId, [line]);
		}
	}

	const entries: ActivityHistoryEntry[] = [];
	for (const { sourceId, kind, title, usage, progress } of input.extractions) {
		const extractor = stageSummary(usage.stages?.extractor);
		const auditor = stageSummary(usage.stages?.auditor);
		let generated: GeneratedView | undefined;
		if (attribution) {
			// The merge that wrote the lines happens inside [startedAt,
			// startedAt + durationMs]; a small tail covers clock granularity.
			const from = usage.startedAt;
			const nextStart = startsBySource.get(sourceId)?.find((at) => at > usage.startedAt);
			const to = Math.min(
				usage.startedAt + usage.durationMs + 5_000,
				nextStart === undefined ? Number.POSITIVE_INFINITY : nextStart - 1,
			);
			const inWindow = (iso: string) => {
				const at = Date.parse(iso);
				return Number.isFinite(at) && at >= from && at <= to;
			};
			const born: GeneratedNode[] = [];
			const bornIds = new Set<string>();
			let linked = 0;
			for (const line of nodesBySource.get(sourceId) ?? []) {
				if (!inWindow(line.createdAt)) continue;
				if (firstLine.get(line.id) === line) {
					if (bornIds.has(line.id)) continue;
					bornIds.add(line.id);
					born.push({ id: line.id, name: line.name, statement: line.statement });
				} else linked += 1;
			}
			const argumentsSeen = new Set<string>();
			const argumentsWritten: GeneratedChain[] = [];
			for (const line of chainsBySource.get(sourceId) ?? []) {
				if (!inWindow(line.createdAt)) continue;
				const key = `${[...line.premises].sort().join("\u0000")}=>${line.conclusion}`;
				if (argumentsSeen.has(key)) continue;
				argumentsSeen.add(key);
				argumentsWritten.push({
					id: line.id,
					premises: line.premises.map((id) => nodeName.get(id) ?? id),
					conclusion: nodeName.get(line.conclusion) ?? line.conclusion,
				});
			}
			generated = {
				nodes: born.slice(0, GENERATED_VIEW_LIMIT),
				chains: argumentsWritten.slice(0, GENERATED_VIEW_LIMIT),
				linked,
				omittedNodes: Math.max(0, born.length - GENERATED_VIEW_LIMIT),
				omittedChains: Math.max(0, argumentsWritten.length - GENERATED_VIEW_LIMIT),
			};
		}
		entries.push({
			process: "extraction",
			id: `${sourceId}:${usage.startedAt}`,
			sourceId,
			sourceKind: kind,
			title,
			startedAt: usage.startedAt,
			durationMs: usage.durationMs,
			merged: usage.stats
				? { nodes: usage.stats.nodes, chains: usage.stats.chains ?? 0, ...(usage.stats.droppedChains ? { droppedChains: usage.stats.droppedChains } : {}) }
				: null,
			stages: { extractor, auditor },
			tokens: addTotals(extractor?.tokens ?? null, auditor?.tokens ?? null),
			...(progress ? { progress } : {}),
			...(generated ? { generated } : {}),
		});
	}
	for (const { job, title, costUsd } of input.jobs) {
		// Running jobs belong to the live section (the caller filters too —
		// this keeps the fold honest for any caller).
		if (job.status === "running") continue;
		const startedAt = Date.parse(job.createdAt) || 0;
		// finishedAt is the worker's terminal stamp; updatedAt also moves on
		// delivery acknowledgements, which can be hours later.
		const finishedAt = Date.parse(job.finishedAt ?? job.updatedAt) || startedAt;
		entries.push({
			process: "job",
			id: job.id,
			jobKind: job.kind,
			chatId: job.chatId,
			title,
			startedAt,
			durationMs: Math.max(0, finishedAt - startedAt),
			status: job.status === "error" ? "error" : "done",
			activity: job.activity,
			...(job.error ? { error: job.error } : {}),
			...(job.usage?.model ? { model: job.usage.model } : {}),
			...(job.usage ? { steps: job.usage.steps } : {}),
			tokens: jobTokens(job.usage),
			costUsd,
		});
	}
	entries.sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id));
	const offset = Math.max(0, Math.floor(range.offset ?? 0));
	const limit = historyLimit(range.limit);
	return { entries: entries.slice(offset, offset + limit), total: entries.length };
}
