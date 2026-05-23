import { listAllJobs, type JobWithCustomerRow } from "./db";
import { notifyHealthCheckDigest } from "./emailAlerts";
import { recoverOrphanedRunningJobs } from "./recovery";
import {
  DEFAULT_INITIAL_PENDING_MS,
  DEFAULT_STALE_PENDING_GRACE_MS,
  DEFAULT_STALE_RUNNING_MS,
  ERROR_RETRY_UPPER_BOUND_MS,
  describeAnomalyKind,
  formatDuration,
  formatTimestamp,
  getExpectedNextRunAtMs,
  getOverdueByMs,
  getPendingStaleKind,
  isStaleRunningJob,
} from "./schedule";
import type { Env, JobStatus } from "./types";

export type HealthAnomalyKind =
  | "stale_running"
  | "overdue_pending_initial"
  | "overdue_pending_success_retry"
  | "overdue_pending_error_retry"
  | "duplicate_active_name";

export interface HealthAnomaly {
  kind: HealthAnomalyKind;
  jobId: string;
  customerId: string;
  jobName: string;
  customerName: string;
  status: JobStatus;
  expectedNextRunAtMs: number | null;
  overdueByMs: number | null;
}

export interface HealthCheckResult {
  checkedAtMs: number;
  scannedJobs: number;
  anomalies: HealthAnomaly[];
  autoHealEnabled: boolean;
  autoHealRan: boolean;
}

interface HealthCheckConfig {
  staleRunningMs: number;
  initialPendingMs: number;
  pendingGraceMs: number;
  errorRetryUpperBoundMs: number;
  scanLimit: number;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return defaultValue;
}

function getHealthCheckConfig(env: Env): HealthCheckConfig {
  return {
    staleRunningMs:
      parsePositiveInt(env.RECOVERY_STALE_RUNNING_MS) ?? DEFAULT_STALE_RUNNING_MS,
    initialPendingMs:
      parsePositiveInt(env.HEALTH_INITIAL_PENDING_MS) ?? DEFAULT_INITIAL_PENDING_MS,
    pendingGraceMs:
      parsePositiveInt(env.HEALTH_PENDING_GRACE_MS) ?? DEFAULT_STALE_PENDING_GRACE_MS,
    errorRetryUpperBoundMs: ERROR_RETRY_UPPER_BOUND_MS,
    scanLimit: parsePositiveInt(env.RECOVERY_SCAN_LIMIT) ?? 100,
  };
}

function classifyJob(
  job: JobWithCustomerRow,
  nowMs: number,
  config: HealthCheckConfig,
): HealthAnomaly | null {
  const scheduleOpts = {
    initialPendingMs: config.initialPendingMs,
    pendingGraceMs: config.pendingGraceMs,
    errorRetryUpperBoundMs: config.errorRetryUpperBoundMs,
    staleRunningMs: config.staleRunningMs,
  };

  if (isStaleRunningJob(job, nowMs, config.staleRunningMs)) {
    return {
      kind: "stale_running",
      jobId: job.id,
      customerId: job.customer_id,
      jobName: job.name,
      customerName: job.customer_name,
      status: job.status,
      expectedNextRunAtMs: job.updated_at,
      overdueByMs: getOverdueByMs(job, nowMs, "stale_running", scheduleOpts),
    };
  }

  const pendingKind = getPendingStaleKind(job, nowMs, scheduleOpts);
  if (!pendingKind) return null;

  return {
    kind: pendingKind,
    jobId: job.id,
    customerId: job.customer_id,
    jobName: job.name,
    customerName: job.customer_name,
    status: job.status,
    expectedNextRunAtMs: getExpectedNextRunAtMs(job),
    overdueByMs: getOverdueByMs(job, nowMs, pendingKind, scheduleOpts),
  };
}

async function findDuplicateActiveJobAnomalies(
  db: D1Database,
  limit: number,
): Promise<HealthAnomaly[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const result = await db
    .prepare(
      `SELECT j.id, j.customer_id, j.name, j.status, j.updated_at, c.name AS customer_name
       FROM jobs j
       JOIN customers c ON c.id = j.customer_id
       WHERE j.status IN ('pending', 'running')
         AND EXISTS (
           SELECT 1
           FROM jobs j2
           WHERE j2.customer_id = j.customer_id
             AND j2.name = j.name
             AND j2.status IN ('pending', 'running')
             AND j2.id != j.id
         )
       ORDER BY j.customer_id ASC, j.name ASC, j.updated_at ASC
       LIMIT ?`,
    )
    .bind(safeLimit)
    .all<JobWithCustomerRow>();

  return (result.results ?? []).map((job) => ({
    kind: "duplicate_active_name" as const,
    jobId: job.id,
    customerId: job.customer_id,
    jobName: job.name,
    customerName: job.customer_name,
    status: job.status,
    expectedNextRunAtMs: getExpectedNextRunAtMs(job),
    overdueByMs: null,
  }));
}

export async function findHealthAnomalies(
  db: D1Database,
  nowMs: number,
  config: HealthCheckConfig,
): Promise<{ scannedJobs: number; anomalies: HealthAnomaly[] }> {
  const activeJobs = await listAllJobs(db, {
    status: ["pending", "running"],
    limit: config.scanLimit,
  });

  const anomalies: HealthAnomaly[] = [];
  const seenJobIds = new Set<string>();

  for (const job of activeJobs) {
    const anomaly = classifyJob(job, nowMs, config);
    if (!anomaly) continue;
    anomalies.push(anomaly);
    seenJobIds.add(job.id);
  }

  const duplicates = await findDuplicateActiveJobAnomalies(db, config.scanLimit);
  for (const anomaly of duplicates) {
    if (seenJobIds.has(anomaly.jobId)) continue;
    anomalies.push(anomaly);
    seenJobIds.add(anomaly.jobId);
  }

  anomalies.sort((a, b) => {
    const overdueA = a.overdueByMs ?? 0;
    const overdueB = b.overdueByMs ?? 0;
    if (overdueB !== overdueA) return overdueB - overdueA;
    return a.jobName.localeCompare(b.jobName);
  });

  return { scannedJobs: activeJobs.length, anomalies };
}

export function formatHealthCheckDigest(result: HealthCheckResult): string {
  const lines = [
    `Checked at: ${formatTimestamp(result.checkedAtMs)} UTC`,
    `Active jobs scanned: ${result.scannedJobs}`,
    `Anomalies found: ${result.anomalies.length}`,
    "",
  ];

  if (!result.anomalies.length) {
    lines.push("No inconsistencies detected.");
    return lines.join("\n");
  }

  for (const anomaly of result.anomalies) {
    lines.push(`- ${anomaly.jobName} (${anomaly.customerName})`);
    lines.push(`  Job ID: ${anomaly.jobId}`);
    lines.push(`  Status: ${anomaly.status}`);
    lines.push(`  Issue: ${describeAnomalyKind(anomaly.kind)}`);
    if (anomaly.expectedNextRunAtMs != null) {
      lines.push(`  Expected next run: ${formatTimestamp(anomaly.expectedNextRunAtMs)} UTC`);
    }
    if (anomaly.overdueByMs != null) {
      lines.push(`  Overdue by: ${formatDuration(anomaly.overdueByMs)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export async function runDailyHealthCheck(env: Env): Promise<HealthCheckResult> {
  const enabled = parseBoolean(env.HEALTH_CHECK_ENABLED, true);
  const autoHeal = parseBoolean(env.HEALTH_AUTO_HEAL, false);
  const alertOnlyOnIssues = parseBoolean(env.HEALTH_ALERT_ONLY_ON_ISSUES, true);
  const checkedAtMs = Date.now();
  const config = getHealthCheckConfig(env);

  if (!enabled) {
    console.info("[health] daily check skipped: HEALTH_CHECK_ENABLED=false");
    return {
      checkedAtMs,
      scannedJobs: 0,
      anomalies: [],
      autoHealEnabled: autoHeal,
      autoHealRan: false,
    };
  }

  const { scannedJobs, anomalies } = await findHealthAnomalies(env.DB, checkedAtMs, config);
  const result: HealthCheckResult = {
    checkedAtMs,
    scannedJobs,
    anomalies,
    autoHealEnabled: autoHeal,
    autoHealRan: false,
  };

  console.info(
    `[health] daily check complete scanned=${scannedJobs} anomalies=${anomalies.length}`,
  );
  if (anomalies.length) {
    console.info(`[health] digest\n${formatHealthCheckDigest(result)}`);
  }

  const shouldAlert = anomalies.length > 0 || !alertOnlyOnIssues;
  if (shouldAlert) {
    await notifyHealthCheckDigest(env, {
      checkedAtMs: result.checkedAtMs,
      scannedJobs: result.scannedJobs,
      anomalyCount: result.anomalies.length,
      body: formatHealthCheckDigest(result),
    });
  }

  if (autoHeal) {
    await recoverOrphanedRunningJobs(env, { force: true });
    result.autoHealRan = true;
    console.info("[health] auto-heal recovery finished");
  }

  return result;
}
