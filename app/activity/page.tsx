import { ActivityScreen } from "@/components/activity-screen";

/**
 * THE BACKGROUND-ACTIVITY PAGE (2026-11): /activity — live extractions and
 * sub-agent jobs with their stage usage, plus the persisted run history.
 * The dock's header links here; the data comes from
 * GET /api/activity/history (see server/observability.ts).
 */
export const dynamic = "force-dynamic";

export default function ActivityPage() {
	return <ActivityScreen />;
}
