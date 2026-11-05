"use client";

/**
 * THE BACKGROUND-ACTIVITY SCREEN (2026-11): the dock's "open" — a full
 * view of what background agents are doing and what they did.
 *
 * Running: every live extraction run (phase, file, chunk i/N, stage
 * models, steps, tokens, elapsed) and every running sub-agent job, with
 * the same true-cancellation End control as the dock.
 * History: the persisted run ledgers — extraction usage from chat/notes
 * records and terminal jobs — newest first, compact; a row expands into
 * its extractor/auditor breakdown and the notes source's resume progress.
 *
 * Data comes from GET /api/activity/history; refresh is event-driven
 * (activity/jobs/sources channels, 250ms trailing debounce) plus resync,
 * exactly like the dock — no polling of the server.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ActivityIcon, ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, FileTextIcon, SquareIcon, WaypointsIcon } from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { formatElapsed } from "@/components/activity-dock";
import { formatTokens } from "@/components/usage-format";
import { useServerEvent, useServerResync } from "@/components/server-events";
import {
	historyLimit,
	jobTokens,
	stageSummary,
	type ActivityCenter,
	type ActivityHistoryEntry,
	type ActivityLiveExtraction,
	type ActivityLiveJob,
	type ActivityStageSummary,
	type GeneratedView,
} from "@/src/core";

const PAGE_SIZE = 50;
/** Per-request transport bound (the server clamps too) — paging uses offset. */
const MAX_PAGE = 200;

const tokenLabel = (totals: ActivityStageSummary["tokens"] | null): string =>
	totals === null ? "—" : `${formatTokens(totals.total)} tok`;

const stageModels = (stages: { extractor?: ActivityStageSummary | null; auditor?: ActivityStageSummary | null } | undefined): string => {
	if (!stages) return "";
	return [...new Set([stages.extractor?.model, stages.auditor?.model].filter((m): m is string => Boolean(m)))].join(" + ");
};

const stageRows = (stages: { extractor?: ActivityStageSummary | null; auditor?: ActivityStageSummary | null }) => (
	<div className="mt-1 grid gap-1 text-[11px] text-muted-foreground">
		{(["extractor", "auditor"] as const).map((stage) => {
			const s = stages[stage];
			if (!s) return <div key={stage}>{stage}: not reached</div>;
			return (
				<div key={stage} className="flex flex-wrap gap-x-3 gap-y-0.5">
					<span className="w-16 uppercase tracking-widest">{stage}</span>
					<span className="text-card-foreground">{s.model || "—"}</span>
					<span>{s.steps} steps</span>
					<span className="tabular-nums">
						in {formatTokens(s.tokens.input)} · out {formatTokens(s.tokens.output)} · read{" "}
						{formatTokens(s.tokens.cacheRead)} · write {formatTokens(s.tokens.cacheWrite)}
					</span>
				</div>
			);
		})}
	</div>
);

export function ActivityScreen() {
	const [jobs, setJobs] = useState<ActivityLiveJob[]>([]);
	const [extractions, setExtractions] = useState<ActivityLiveExtraction[]>([]);
	const [historyItems, setHistoryItems] = useState<ActivityHistoryEntry[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState<"all" | "extraction" | "job">("all");
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
	const [now, setNow] = useState(() => Date.now());
	const timer = useRef<number | undefined>(undefined);
	const loaded = useRef(PAGE_SIZE);
	// Overlapping loads (mount, events, Load more, abort completion) must not
	// let an older response overwrite a newer one.
	const requestId = useRef(0);

	/** Load the first `targetCount` history entries (offset pages of ≤200);
	 *  a refresh reloads exactly what is already on screen, so "load more"
	 *  survives the event-driven refresh. */
	const load = useCallback(async (targetCount?: number) => {
		const id = ++requestId.current;
		// "Load more" and refreshes can race: never shrink the requested range.
		const target = Math.max(PAGE_SIZE, targetCount ?? 0, loaded.current);
		setLoading(true);
		try {
			const items: ActivityHistoryEntry[] = [];
			let liveJobs: ActivityLiveJob[] = [];
			let liveExtractions: ActivityLiveExtraction[] = [];
			let count = 0;
			let offset = 0;
			while (offset < target) {
				const limit = Math.min(MAX_PAGE, target - offset);
				const res = await fetch(`/api/activity/history?limit=${limit}&offset=${offset}`, { cache: "no-store" });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const page = (await res.json()) as ActivityCenter;
				if (offset === 0) {
					liveJobs = page.jobs;
					liveExtractions = page.extractions;
				}
				items.push(...page.history);
				count = page.total;
				if (page.history.length < limit) break;
				offset += limit;
			}
			if (id !== requestId.current) return; // superseded by a newer load
			loaded.current = items.length;
			setJobs(liveJobs);
			setExtractions(liveExtractions);
			setHistoryItems(items);
			setTotal(count);
			setError(null);
		} catch (err) {
			if (id === requestId.current) setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (id === requestId.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// Event-driven refresh: the same channels the dock listens to.
	const schedule = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = window.setTimeout(() => {
			timer.current = undefined;
			void load();
		}, 250);
	}, [load]);
	useServerEvent("activity-changed", schedule);
	useServerEvent("jobs-changed", schedule);
	useServerEvent("sources-changed", schedule);
	// Chat renames and idle-session deletion change titles/history rows.
	useServerEvent("chats-changed", schedule);
	useServerResync(load);
	useEffect(
		() => () => {
			clearTimeout(timer.current);
		},
		[],
	);

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	const toggle = (id: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const abort = async (process: "extraction" | "job", id: string, label: string) => {
		setStopping((prev) => new Set(prev).add(id));
		try {
			const res = await fetch("/api/activity/abort", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: process, id }),
			});
			// 404/409 = already gone — the desired end state.
			if (!res.ok && res.status !== 404 && res.status !== 409) throw new Error(`HTTP ${res.status}`);
			await load();
		} catch (err) {
			setError(`Could not stop ${label}: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setStopping((prev) => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
		}
	};

	const matches = useCallback(
		(title: string) => query.trim() === "" || title.toLowerCase().includes(query.trim().toLowerCase()),
		[query],
	);

	const visibleJobs = useMemo(
		() => (kind === "extraction" ? [] : jobs.filter((job) => matches(job.title))),
		[jobs, kind, matches],
	);
	const visibleExtractions = useMemo(
		() => (kind === "job" ? [] : extractions.filter((run) => matches(run.title))),
		[extractions, kind, matches],
	);
	const history = useMemo(
		() => historyItems.filter((entry) => (kind === "all" || entry.process === kind) && matches(entry.title)),
		[historyItems, kind, matches],
	);
	const runningCount = visibleJobs.length + visibleExtractions.length;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<TopBar>
				<Link href="/" aria-label="Back to the graph" className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					<ArrowLeftIcon className="size-4" />
				</Link>
				<ActivityIcon className="size-4 text-muted-foreground" />
				<h1 className="text-sm font-medium">Background agents</h1>
				<span className="text-xs tabular-nums text-muted-foreground" data-testid="activity-running-count">
					{runningCount} running · {historyItems.length === total ? `${total} runs` : `${historyItems.length} of ${total} runs`}
				</span>
				<div className="ml-auto flex items-center gap-2">
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search files, sessions, jobs…"
						aria-label="Search background activity"
						className="h-7 w-56 rounded-lg border border-border/70 bg-background/60 px-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-border"
					/>
					<select
						value={kind}
						onChange={(event) => setKind(event.target.value as typeof kind)}
						aria-label="Filter by process"
						className="h-7 rounded-lg border border-border/70 bg-background/60 px-2 text-xs outline-none"
					>
						<option value="all">All</option>
						<option value="extraction">Extraction</option>
						<option value="job">Jobs</option>
					</select>
				</div>
			</TopBar>

			<div data-testid="activity-scroll" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
				{error && (
					<p role="alert" className="mb-3 max-w-full whitespace-pre-wrap break-words text-xs text-red-400">
						{error}
					</p>
				)}

				<section aria-label="Running background agents" className="mb-6">
					<h2 className="mb-2 text-[11px] uppercase tracking-widest text-muted-foreground/70">Running</h2>
					{runningCount === 0 ? (
						<p className="text-xs text-muted-foreground">Nothing running.</p>
					) : (
						<div className="flex flex-col gap-1">
							{visibleExtractions.map((run) => (
								<LiveExtractionRow
									key={run.id}
									run={run}
									now={now}
									open={expanded.has(run.id)}
									stopping={stopping.has(run.id)}
									onToggle={() => toggle(run.id)}
									onStop={() => void abort("extraction", run.chatId, run.title)}
								/>
							))}
							{visibleJobs.map((job) => (
								<LiveJobRow
									key={job.id}
									job={job}
									now={now}
									open={expanded.has(job.id)}
									stopping={stopping.has(job.id)}
									onToggle={() => toggle(job.id)}
									onStop={() => void abort("job", job.id, job.title)}
								/>
							))}
						</div>
					)}
				</section>

				<section aria-label="Background run history">
					<h2 className="mb-2 text-[11px] uppercase tracking-widest text-muted-foreground/70">History</h2>
					{history.length === 0 ? (
						<p className="text-xs text-muted-foreground">No completed runs yet.</p>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full min-w-[820px] border-collapse text-xs">
								<thead>
									<tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-widest text-muted-foreground/70">
										<th className="px-2 py-1.5 font-normal">Status</th>
										<th className="px-2 py-1.5 font-normal">Source</th>
										<th className="px-2 py-1.5 text-right font-normal">Started</th>
										<th className="px-2 py-1.5 text-right font-normal">Duration</th>
										<th className="px-2 py-1.5 font-normal">Model</th>
										<th className="px-2 py-1.5 text-right font-normal">Steps</th>
										<th className="px-2 py-1.5 text-right font-normal">Tokens</th>
										<th className="px-2 py-1.5 font-normal">Result</th>
									</tr>
								</thead>
								<tbody>
									{history.map((entry) => {
										const open = expanded.has(entry.id);
										return (
											<HistoryRow
												key={entry.id}
												entry={entry}
												open={open}
												onToggle={() => toggle(entry.id)}
											/>
										);
									})}
								</tbody>
							</table>
						</div>
					)}
					{historyItems.length < total && (
						<div className="mt-2 flex justify-center">
							<button
								type="button"
								data-testid="activity-load-more"
								onClick={() => void load(loaded.current + PAGE_SIZE)}
								disabled={loading}
								className="rounded-lg border border-border/70 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
							>
								{loading ? "Loading…" : `Load more (${total - historyItems.length} remaining)`}
							</button>
						</div>
					)}
				</section>
			</div>
		</div>
	);
}

function ProcessIcon({ process }: { process: "extraction" | "job" }) {
	return process === "extraction" ? <WaypointsIcon className="size-3.5 shrink-0 text-muted-foreground" /> : <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function LiveExtractionRow({ run, now, open, stopping, onToggle, onStop }: {
	run: ActivityLiveExtraction;
	now: number;
	open: boolean;
	stopping: boolean;
	onToggle: () => void;
	onStop: () => void;
}) {
	const extractor = stageSummary(run.usage.extractor);
	const auditor = stageSummary(run.usage.auditor);
	const totals = [extractor?.tokens, auditor?.tokens].filter((t): t is NonNullable<typeof t> => Boolean(t));
	const steps = totals.reduce((sum, t) => sum + t.steps, 0);
	const merged = totals.reduce((sum, t) => sum + t.total, 0);
	return (
		<div data-testid={`activity-live-extraction-${run.id}`} className="rounded-lg border border-border/50 px-2 py-1.5">
			<div className="flex items-center gap-2 text-xs">
				<ProcessIcon process="extraction" />
				<span className="min-w-0 flex-1 truncate" title={run.title}>{run.title}</span>
				<span className="text-muted-foreground">{run.phase}</span>
				{run.part && <span className="tabular-nums text-muted-foreground">{run.part.i}/{run.part.n}</span>}
				{stageModels({ extractor, auditor }) && <span className="max-w-52 truncate text-muted-foreground">{stageModels({ extractor, auditor })}</span>}
				<span className="tabular-nums text-muted-foreground">{steps} steps</span>
				<span className="tabular-nums text-muted-foreground">{formatTokens(merged)} tok</span>
				<span className="w-16 text-right tabular-nums text-muted-foreground">{formatElapsed(now - run.startedAt)}</span>
				<button type="button" onClick={onStop} disabled={stopping} aria-label={`End ${run.title}`} title="End this run" className="rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
					<SquareIcon className="size-3" />
				</button>
				<button type="button" onClick={onToggle} aria-expanded={open} aria-label={`Details for ${run.title}`} className="rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground">
					{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
				</button>
			</div>
			{open && <div className="mt-1 border-t border-border/40 pt-1">{stageRows({ extractor, auditor })}</div>}
		</div>
	);
}

function LiveJobRow({ job, now, open, stopping, onToggle, onStop }: {
	job: ActivityLiveJob;
	now: number;
	open: boolean;
	stopping: boolean;
	onToggle: () => void;
	onStop: () => void;
}) {
	const tokens = jobTokens(job.usage);
	return (
		<div data-testid={`activity-live-job-${job.id}`} className="rounded-lg border border-border/50 px-2 py-1.5">
			<div className="flex items-center gap-2 text-xs">
				<ProcessIcon process="job" />
				<span className="min-w-0 flex-1 truncate" title={job.title}>{job.title}</span>
				<span className="text-muted-foreground">{job.kind}</span>
				{job.usage?.model && <span className="max-w-52 truncate text-muted-foreground">{job.usage.model}</span>}
				<span className="tabular-nums text-muted-foreground">{job.usage?.steps ?? 0} steps</span>
				<span className="tabular-nums text-muted-foreground">{tokenLabel(tokens)}</span>
				<span className="w-16 text-right tabular-nums text-muted-foreground">{formatElapsed(now - (Date.parse(job.createdAt) || now))}</span>
				<button type="button" onClick={onStop} disabled={stopping} aria-label={`End ${job.title}`} title="End this job" className="rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
					<SquareIcon className="size-3" />
				</button>
				<button type="button" onClick={onToggle} aria-expanded={open} aria-label={`Details for ${job.title}`} className="rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground">
					{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
				</button>
			</div>
			{open && (
				<div className="mt-1 grid gap-1 border-t border-border/40 pt-1 text-[11px] text-muted-foreground">
					<div>{job.activity}</div>
					{job.usage?.model && <div>model: <span className="text-card-foreground">{job.usage.model}</span></div>}
					{tokens && (
						<div className="tabular-nums">
							in {formatTokens(tokens.input)} · out {formatTokens(tokens.output)} · read {formatTokens(tokens.cacheRead)} · write {formatTokens(tokens.cacheWrite)}
						</div>
					)}
					{job.contextLimit !== null && job.usage?.lastStep?.inputTokens !== undefined && (
						<div className="tabular-nums">
							context:{" "}
							{formatTokens(
								job.usage.lastStep.inputTokens +
									(job.usage.lastStep.outputTokens ?? 0) +
									(job.usage.lastStep.cacheReadTokens ?? 0) +
									(job.usage.lastStep.cacheWriteTokens ?? 0),
							)}{" "}
							/ {formatTokens(job.contextLimit)}
						</div>
					)}
					{job.error && <div className="whitespace-pre-wrap break-words text-red-400">{job.error}</div>}
				</div>
			)}
		</div>
	);
}

/** What a run wrote — attributed from the ledgers by merge time + source
 *  provenance (see core/activity-history.ts). Empty groups stay hidden. */
function GeneratedDetail({ generated }: { generated: GeneratedView }) {
	const empty = generated.nodes.length === 0 && generated.chains.length === 0 && generated.linked === 0;
	if (empty) return null;
	return (
		<div className="mt-2 grid gap-1.5 border-t border-border/30 pt-1.5 text-[11px]">
			{generated.nodes.length > 0 && (
				<div>
					<div className="uppercase tracking-widest text-muted-foreground/70">New nodes</div>
					<div className="mt-0.5 flex flex-wrap gap-1">
						{generated.nodes.map((node) => (
							<span key={node.id} title={node.statement} className="max-w-full truncate rounded border border-border/60 px-1.5 py-0.5 text-card-foreground">
								{node.name}
							</span>
						))}
						{generated.omittedNodes > 0 && <span className="text-muted-foreground">+{generated.omittedNodes} more</span>}
					</div>
				</div>
			)}
			{generated.chains.length > 0 && (
				<div>
					<div className="uppercase tracking-widest text-muted-foreground/70">Arguments</div>
					<ul className="mt-0.5 grid gap-0.5">
						{generated.chains.map((chain) => (
							<li key={chain.id} className="text-muted-foreground">
								{chain.premises.join(" ∧ ")} <span className="text-muted-foreground/60">⟹</span>{" "}
								<span className="text-card-foreground">{chain.conclusion}</span>
							</li>
						))}
						{generated.omittedChains > 0 && <li className="text-muted-foreground">+{generated.omittedChains} more</li>}
					</ul>
				</div>
			)}
			{generated.linked > 0 && (
				<div className="text-muted-foreground">
					updated {generated.linked} existing node{generated.linked === 1 ? "" : "s"} (aliases/provenance)
				</div>
			)}
		</div>
	);
}

function HistoryRow({ entry, open, onToggle }: { entry: ActivityHistoryEntry; open: boolean; onToggle: () => void }) {
	const started = entry.startedAt > 0 ? new Date(entry.startedAt).toLocaleString() : "—";
	const models = entry.process === "extraction" ? stageModels(entry.stages) : entry.model ?? "";
	const steps = entry.process === "extraction"
		? (entry.stages.extractor?.steps ?? 0) + (entry.stages.auditor?.steps ?? 0)
		: entry.steps;
	const status = entry.process === "extraction"
		? entry.merged ? "merged" : "no merge"
		: entry.status;
	const result = entry.process === "extraction"
		? entry.merged
			? `+${entry.merged.nodes} nodes · +${entry.merged.chains} chains`
			: "—"
		: entry.error
			? "error"
			: "done";
	return (
		<>
			<tr
				data-testid={`activity-history-${entry.id}`}
				className="cursor-pointer border-b border-border/30 align-top hover:bg-accent/40"
				onClick={onToggle}
				onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); } }}
				tabIndex={0}
				aria-expanded={open}
			>
				<td className="whitespace-nowrap px-2 py-1.5">
					<span className="flex items-center gap-1.5">
						<ProcessIcon process={entry.process} />
						<span className={status === "error" ? "text-red-400" : "text-muted-foreground"}>{status}</span>
					</span>
				</td>
				<td className="max-w-[320px] truncate px-2 py-1.5" title={entry.title}>{entry.title}</td>
				<td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-muted-foreground">{started}</td>
				<td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatElapsed(entry.durationMs)}</td>
				<td className="max-w-[220px] truncate px-2 py-1.5 text-muted-foreground" title={models}>{models || "—"}</td>
				<td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{steps ?? "—"}</td>
				<td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{tokenLabel(entry.tokens)}</td>
				<td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">
					{result}
					{entry.process === "job" && entry.costUsd !== null && <span className="ml-2 tabular-nums">${entry.costUsd.toFixed(4)}</span>}
				</td>
			</tr>
			{open && (
				<tr className="border-b border-border/30 bg-accent/20">
					<td colSpan={8} className="px-3 py-2">
						{entry.process === "extraction" ? (
							<>
								{stageRows(entry.stages)}
								<div className="mt-1 text-[11px] text-muted-foreground">
									{entry.merged
										? `merged ${entry.merged.nodes} nodes, ${entry.merged.chains} chains${entry.merged.droppedChains ? `, ${entry.merged.droppedChains} redundant chains dropped` : ""}`
										: "the stage chain ended before a merge — nothing was written"}
									{entry.progress && ` · file progress: ${entry.progress.linesDone} lines, ${entry.progress.chunksDone} chunks`}
								</div>
								{entry.generated && <GeneratedDetail generated={entry.generated} />}
							</>
						) : (
							<>
								<div className="whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{entry.activity}</div>
								{entry.error && <div className="mt-1 whitespace-pre-wrap break-words text-[11px] text-red-400">{entry.error}</div>}
							</>
						)}
					</td>
				</tr>
			)}
		</>
	);
}
