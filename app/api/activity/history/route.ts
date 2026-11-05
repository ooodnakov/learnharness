/**
 * GET /api/activity/history — the background-activity screen's payload
 * (2026-11): live runs with per-stage usage + the persisted run history
 * (extraction usage from chat/notes records, terminal sub-agent jobs).
 * Composition only — the fold lives in core/activity-history.ts, the
 * stores join in server/observability.ts. `limit` bounds the history
 * (default 50, hard-capped at 200).
 */
import { activityCenter } from "@/src/server";
import { historyLimit } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const params = new URL(request.url).searchParams;
	const limit = params.get("limit");
	const offset = params.get("offset");
	return Response.json(
		activityCenter(
			historyLimit(limit === null ? undefined : Number(limit)),
			Math.max(0, Math.floor(Number(offset ?? 0)) || 0),
		),
	);
}
