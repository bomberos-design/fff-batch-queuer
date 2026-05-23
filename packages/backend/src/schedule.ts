import type { JobRow } from "./types";

/** First queue message never arrived or consumer never claimed the job. */
export const DEFAULT_INITIAL_PENDING_MS = 10 * 60 * 1000;
/** Slack after the scheduled delay before treating pending as orphaned. */
export const DEFAULT_STALE_PENDING_GRACE_MS = 15 * 60 * 1000;
/** `backoffSeconds` is capped at 300s plus jitter; stay above that when detecting stale error retries. */
export const ERROR_RETRY_UPPER_BOUND_MS = 360 * 1000;
/** Must exceed worst-case target HTTP latency. */
export const DEFAULT_STALE_RUNNING_MS = 300_000;

export type PendingStaleKind =
  | "overdue_pending_initial"
  | "overdue_pending_success_retry"
  | "overdue_pending_error_retry";

export interface PendingStaleOpts {
  initialPendingMs: number;
  pendingGraceMs: number;
  errorRetryUpperBoundMs: number;
}

type ScheduleJobFields = Pick<
  JobRow,
  | "status"
  | "attempts"
  | "last_error"
  | "updated_at"
  | "success_retry_delay_seconds"
  | "error_attempts"
>;

/** Deterministic upper-bound estimate (backend adds up to 1s jitter). */
export function estimateErrorRetryDelaySeconds(errorAttempts: number): number {
  const baseMs = 5_000;
  const maxMs = 300_000;
  const safeAttempt = Math.max(1, Math.floor(errorAttempts));
  const expMs = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
  return Math.max(1, Math.ceil(expMs / 1000));
}

/** When a pending job should next run, or null if not pending. */
export function getExpectedNextRunAtMs(job: ScheduleJobFields): number | null {
  if (job.status !== "pending") return null;
  if (job.attempts === 0) return job.updated_at;

  const isErrorRetry = Boolean(job.last_error);
  const delaySeconds = isErrorRetry
    ? estimateErrorRetryDelaySeconds(job.error_attempts)
    : Math.max(1, job.success_retry_delay_seconds);
  return job.updated_at + delaySeconds * 1000;
}

export function isStaleRunningJob(
  job: Pick<JobRow, "status" | "updated_at">,
  nowMs: number,
  staleRunningMs: number,
): boolean {
  return job.status === "running" && job.updated_at <= nowMs - staleRunningMs;
}

export function getPendingStaleKind(
  job: ScheduleJobFields,
  nowMs: number,
  opts: PendingStaleOpts,
): PendingStaleKind | null {
  if (job.status !== "pending") return null;

  const initialCutoff = nowMs - opts.initialPendingMs;
  const successPathCutoff = nowMs - opts.pendingGraceMs;
  const errorPathCutoff = nowMs - opts.pendingGraceMs - opts.errorRetryUpperBoundMs;

  if (job.attempts === 0 && job.updated_at <= initialCutoff) {
    return "overdue_pending_initial";
  }
  if (
    job.attempts > 0 &&
    job.last_error == null &&
    job.updated_at <= successPathCutoff - job.success_retry_delay_seconds * 1000
  ) {
    return "overdue_pending_success_retry";
  }
  if (job.attempts > 0 && job.last_error != null && job.updated_at <= errorPathCutoff) {
    return "overdue_pending_error_retry";
  }
  return null;
}

export function getOverdueByMs(
  job: ScheduleJobFields,
  nowMs: number,
  kind: PendingStaleKind | "stale_running",
  opts: PendingStaleOpts & { staleRunningMs: number },
): number {
  if (kind === "stale_running") {
    return nowMs - job.updated_at - opts.staleRunningMs;
  }
  if (kind === "overdue_pending_initial") {
    return nowMs - job.updated_at - opts.initialPendingMs;
  }
  const expected = getExpectedNextRunAtMs(job) ?? job.updated_at;
  const graceMs =
    kind === "overdue_pending_error_retry"
      ? opts.pendingGraceMs + opts.errorRetryUpperBoundMs
      : opts.pendingGraceMs;
  return nowMs - expected - graceMs;
}

export function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  if (safeMs < 60_000) return `${Math.round(safeMs / 1000)}s`;
  if (safeMs < 3_600_000) return `${Math.round(safeMs / 60_000)}m`;
  return `${(safeMs / 3_600_000).toFixed(1)}h`;
}

export function describeAnomalyKind(kind: string): string {
  switch (kind) {
    case "stale_running":
      return "stuck in running";
    case "overdue_pending_initial":
      return "pending, never started";
    case "overdue_pending_success_retry":
      return "pending, success retry overdue";
    case "overdue_pending_error_retry":
      return "pending, error retry overdue";
    case "duplicate_active_name":
      return "duplicate active job name";
    default:
      return kind;
  }
}
