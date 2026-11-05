import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildActivityHistory, historyLimit, jobTokens, stageSummary } from "../src/core/activity-history.ts";
import type { CallUsage, ExtractionRunUsage } from "../src/core/contracts/chat.ts";
import type { JobRecord } from "../src/core/contracts/jobs.ts";

const call = (input: number, output: number, read = 0, write = 0, reasoning = 0): CallUsage => ({
	inputTokens: input,
	outputTokens: output,
	cacheReadTokens: read,
	cacheWriteTokens: write,
	reasoningTokens: reasoning,
});

const run = (over: Partial<ExtractionRunUsage> = {}): ExtractionRunUsage => ({
	startedAt: 1_000,
	at: new Date(1_000).toISOString(),
	durationMs: 500,
	stages: {
		extractor: { model: "zai:glm", steps: [call(10, 5), call(20, 5)] },
		auditor: { model: "zai:glm", steps: [call(30, 2, 100, 7)] },
	},
	...over,
});

const job = (over: Partial<JobRecord> = {}): JobRecord => ({
	id: "job-1",
	kind: "research",
	chatId: "c1",
	toolCallId: "t1",
	status: "done",
	activity: "web_search",
	createdAt: new Date(2_000).toISOString(),
	updatedAt: new Date(5_000).toISOString(),
	...over,
});

describe("activity history fold", () => {
	it("sums a stage's steps into token totals (absent provider fields count 0)", () => {
		const summary = stageSummary({ model: "zai:glm", steps: [call(10, 5), call(20, undefined as unknown as number)] });
		assert.equal(summary?.tokens.input, 30);
		assert.equal(summary?.tokens.output, 5);
		assert.equal(summary?.tokens.steps, 2);
		assert.equal(summary?.tokens.total, 35);
		assert.equal(stageSummary(undefined), null);
	});

	it("folds extraction runs: merged stats, both stages, progress, and 'no merge' when the chain died", () => {
		const { entries: [ok, dead] } = buildActivityHistory(
			{
				extractions: [
					{
						sourceId: "src_a",
						kind: "notes",
						title: "notes.md",
						usage: run({ stats: { nodes: 3, chains: 2 } }),
						progress: { linesDone: 12, chunksDone: 1 },
					},
					{ sourceId: "c1", kind: "chat", title: "Lesson", usage: run({ startedAt: 500 }) },
				],
				jobs: [],
			},
			{ limit: 50 },
		);
		assert.equal(ok!.process, "extraction");
		assert.deepEqual(ok!.process === "extraction" ? ok!.merged : null, { nodes: 3, chains: 2 });
		assert.equal(ok!.process === "extraction" ? ok!.progress?.linesDone : null, 12);
		const extractor = ok!.process === "extraction" ? ok!.stages.extractor : null;
		assert.equal(extractor?.tokens.input, 30);
		assert.equal(ok!.process === "extraction" ? ok!.tokens?.total : null, 30 + 10 + 30 + 2 + 100 + 7);
		assert.equal(dead!.process === "extraction" ? dead!.merged : undefined, null, "no stats → no merge line");
	});

	it("folds terminal jobs, skips running ones, and keeps cost/tokens", () => {
		const { entries } = buildActivityHistory(
			{
				extractions: [],
				jobs: [
					{ job: job({ id: "running", status: "running" }), title: "Lesson", costUsd: null },
					{ job: job(), title: "Lesson", costUsd: 0.002 },
				],
			},
			{ limit: 50 },
		);
		assert.equal(entries.length, 1, "running jobs belong to the live section");
		const entry = entries[0]!;
		assert.equal(entry.process, "job");
		assert.equal(entry.process === "job" ? entry.status : null, "done");
		assert.equal(entry.durationMs, 3_000);
		assert.equal(entry.process === "job" ? entry.costUsd : null, 0.002);
	});

	it("uses the worker's terminal stamp for job duration, not delivery bookkeeping", () => {
		const { entries } = buildActivityHistory(
			{
				extractions: [],
				jobs: [
					{ job: job({ createdAt: new Date(2_000).toISOString(), finishedAt: new Date(5_000).toISOString(), updatedAt: new Date(9_000_000).toISOString() }), title: "Lesson", costUsd: null },
					{ job: job({ id: "legacy", createdAt: new Date(2_000).toISOString(), updatedAt: new Date(6_000).toISOString() }), title: "Lesson", costUsd: null },
				],
			},
			{ limit: 50 },
		);
		assert.equal(entries[0]!.durationMs, 3_000, "finishedAt wins over a later delivery ack");
		assert.equal(entries[1]!.durationMs, 4_000, "legacy records fall back to updatedAt");
	});

	it("caps attribution at the next run of the same source", () => {
		const at = (ms: number) => new Date(ms).toISOString();
		const nodeLine = (id: string, name: string, chatId: string, createdAt: number) => ({
			id, name, statement: name, aliases: [], createdAt: at(createdAt), provenance: [{ chatId, messageId: "" }],
		});
		const nodes = [
			nodeLine("n_early", "Early", "src_a", 1_500),
			nodeLine("n_late", "Late", "src_a", 3_000),
		];
		const { entries } = buildActivityHistory(
			{
				extractions: [
					{ sourceId: "src_a", kind: "notes", title: "a.md", usage: run({ startedAt: 1_000, durationMs: 500, stats: { nodes: 1, chains: 0 } }) },
					{ sourceId: "src_a", kind: "notes", title: "a.md", usage: run({ startedAt: 2_000, durationMs: 500, stats: { nodes: 1, chains: 0 } }) },
				],
				jobs: [],
				nodes,
				chains: [],
			},
			{ limit: 50 },
		);
		const first = entries.find((entry) => entry.startedAt === 1_000)!;
		const second = entries.find((entry) => entry.startedAt === 2_000)!;
		const firstNames = first.process === "extraction" ? first.generated?.nodes.map((n) => n.name) : [];
		const secondNames = second.process === "extraction" ? second.generated?.nodes.map((n) => n.name) : [];
		assert.deepEqual(firstNames, ["Early"], "the clock-slack tail never claims the next run's node");
		assert.deepEqual(secondNames, ["Late"]);
	});

	it("newest first, then the limit trims the fold", () => {
		const extractions = [1_000, 3_000, 2_000].map((startedAt, i) => ({
			sourceId: `src_${i}`,
			kind: "notes" as const,
			title: `n${i}`,
			usage: run({ startedAt }),
		}));
		const all = buildActivityHistory({ extractions, jobs: [] }, { limit: 50 });
		assert.deepEqual(all.entries.map((e) => e.startedAt), [3_000, 2_000, 1_000]);
		assert.equal(all.total, 3, "total is the unpaged fold");
		const limited = buildActivityHistory({ extractions, jobs: [] }, { limit: 2 });
		assert.equal(limited.entries.length, 2);
		assert.equal(limited.entries[0]!.startedAt, 3_000);
		const page = buildActivityHistory({ extractions, jobs: [] }, { offset: 1, limit: 1 });
		assert.deepEqual(page.entries.map((e) => e.startedAt), [2_000], "offset pages the same sorted fold");
		assert.equal(page.total, 3);
	});

	it("attributes a run's generated nodes and chains by merge time + source, counting link appends", () => {
		const at = (ms: number) => new Date(ms).toISOString();
		const nodeLine = (id: string, name: string, chatId: string, createdAt: number) => ({
			id, name, statement: name, aliases: [], createdAt: at(createdAt), provenance: [{ chatId, messageId: "" }],
		});
		const nodes = [
			nodeLine("n_old", "Old", "src_other", 0),
			nodeLine("n_old", "Old", "src_a", 2_000), // link-append inside the window
			nodeLine("n_a", "Alpha", "src_a", 1_500),
			nodeLine("n_b", "Beta", "src_a", 1_600),
			nodeLine("n_c", "Gamma", "src_b", 1_700), // another source
			nodeLine("n_late", "Late", "src_a", 9_000), // outside [start, end]
		];
		const chains = [
			{ id: "arg_1", premises: ["n_a"], conclusion: "n_b", provenance: [{ chatId: "src_a", messageId: "" }], createdAt: at(2_500) },
			{ id: "arg_x", premises: ["n_b"], conclusion: "n_c", provenance: [{ chatId: "src_b", messageId: "" }], createdAt: at(2_600) },
		];
		const { entries } = buildActivityHistory(
			{
				extractions: [{ sourceId: "src_a", kind: "notes", title: "a.md", usage: run({ stats: { nodes: 2, chains: 1 } }) }],
				jobs: [],
				nodes,
				chains,
			},
			{ limit: 50 },
		);
		const generated = entries[0]!.process === "extraction" ? entries[0]!.generated : undefined;
		assert.deepEqual(generated?.nodes.map((n) => n.name), ["Alpha", "Beta"]);
		assert.deepEqual(generated?.chains.map((c) => `${c.premises.join(" ∧ ")} ⟹ ${c.conclusion}`), ["Alpha ⟹ Beta"]);
		assert.equal(generated?.linked, 1, "the re-encounter line is an update, not a new node");
		assert.equal(generated?.omittedNodes, 0);
	});

	it("caps the expanded detail per group and reports the remainder", () => {
		const at = new Date(1_500).toISOString();
		const nodes = Array.from({ length: 30 }, (_, i) => ({
			id: `n_${i}`, name: `N${i}`, statement: `N${i}`, aliases: [], createdAt: at,
			provenance: [{ chatId: "src_a", messageId: "" }],
		}));
		const { entries } = buildActivityHistory(
			{ extractions: [{ sourceId: "src_a", kind: "notes", title: "a.md", usage: run({ stats: { nodes: 30, chains: 0 } }) }], jobs: [], nodes, chains: [] },
			{ limit: 50 },
		);
		const generated = entries[0]!.process === "extraction" ? entries[0]!.generated : undefined;
		assert.equal(generated?.nodes.length, 25);
		assert.equal(generated?.omittedNodes, 5);
	});

	it("nulls job tokens when usage is absent (never a fake zero) and clamps the limit", () => {
		assert.equal(jobTokens(undefined), null);
		assert.equal(historyLimit(undefined), 50);
		assert.equal(historyLimit(0), 1);
		assert.equal(historyLimit(10_000), 200);
	});
});
