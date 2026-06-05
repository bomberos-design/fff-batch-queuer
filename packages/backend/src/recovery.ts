import {
  listDuplicateActiveUrls,
  recoverStalePendingJobs,
  recoverStaleRunningJobs,
} from "./db";
import {
  DEFAULT_INITIAL_PENDING_MS,
  DEFAULT_STALE_PENDING_GRACE_MS,
  DEFAULT_STALE_RUNNING_MS,
  ERROR_RETRY_UPPER_BOUND_MS,
} from "./schedule";
import type { Env } from "./types";

const DEFAULT_RECOVERY_SCAN_LIMIT = 100;
const RECOVERY_CHECK_INTERVAL_MS = 15_000;

let lastRecoveryAt = 0;
let recoveryInFlight: Promise<void> | null = null;

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function getRecoveryConfig(env: Env): {
  staleRunningMs: number;
  scanLimit: number;
} {
  const staleRunningMs =
    parsePositiveInt(env.RECOVERY_STALE_RUNNING_MS) ?? DEFAULT_STALE_RUNNING_MS;
  const scanLimit =
    parsePositiveInt(env.RECOVERY_SCAN_LIMIT) ?? DEFAULT_RECOVERY_SCAN_LIMIT;
  return { staleRunningMs, scanLimit };
}

export async function recoverOrphanedRunningJobs(
  env: Env,
  opts?: { force?: boolean },
): Promise<void> {
  const now = Date.now();
  if (!opts?.force && now - lastRecoveryAt < RECOVERY_CHECK_INTERVAL_MS) return;
  if (recoveryInFlight) return recoveryInFlight;

  recoveryInFlight = (async () => {
    const { staleRunningMs, scanLimit } = getRecoveryConfig(env);
    const now = Date.now();
    const duplicateUrls = await listDuplicateActiveUrls(env.DB, scanLimit);
    if (duplicateUrls.length) {
      for (const row of duplicateUrls) {
        console.warn(
          `[recovery] ${row.job_count} active jobs share customer=${row.customer_id} url=${row.url} — parallel target calls are likely; pause or delete duplicates`,
        );
      }
    }
    const recoveredRunning = await recoverStaleRunningJobs(env.DB, staleRunningMs, scanLimit);
    if (recoveredRunning.length) {
      console.log(`[recovery] recovered ${recoveredRunning.length} stale running job(s)`);
      for (const row of recoveredRunning) {
        await env.JOB_QUEUE.send({ jobId: row.id, customerId: row.customer_id });
      }
    }
    const recoveredPending = await recoverStalePendingJobs(env.DB, now, {
      initialPendingMs: DEFAULT_INITIAL_PENDING_MS,
      pendingGraceMs: DEFAULT_STALE_PENDING_GRACE_MS,
      errorRetryUpperBoundMs: ERROR_RETRY_UPPER_BOUND_MS,
      limit: scanLimit,
    });
    if (recoveredPending.length) {
      console.log(
        `[recovery] re-queued ${recoveredPending.length} stale pending job(s) (lost/delayed queue delivery)`,
      );
      for (const row of recoveredPending) {
        await env.JOB_QUEUE.send({ jobId: row.id, customerId: row.customer_id });
      }
    }
  })()
    .catch((err) => {
      console.error("[recovery] failed to recover running jobs", err);
    })
    .finally(() => {
      lastRecoveryAt = Date.now();
      recoveryInFlight = null;
    });

  return recoveryInFlight;
}
