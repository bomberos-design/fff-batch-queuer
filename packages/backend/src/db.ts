import type { CustomerRow, JobInput, JobRow, JobStatus, RunRow } from "./types";
import { MAX_BODY_SNAPSHOT_BYTES } from "./types";

function now(): number {
  return Date.now();
}

function truncate(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (value.length <= MAX_BODY_SNAPSHOT_BYTES) return value;
  return value.slice(0, MAX_BODY_SNAPSHOT_BYTES);
}

export async function insertJob(
  db: D1Database,
  id: string,
  input: JobInput,
): Promise<JobRow> {
  const ts = now();
  const payload = input.payload === undefined ? null : JSON.stringify(input.payload);
  const headers = input.headers === undefined ? null : JSON.stringify(input.headers);
  const errorAttemptLimit = input.errorAttemptLimit ?? 1000;
  const successLimit = input.successLimit ?? 1;
  const successRetryDelaySeconds = input.successRetryDelaySeconds ?? 30;

  await db
    .prepare(
      `INSERT INTO jobs (id, customer_id, name, description_note, url, method, payload, headers, status,
                         attempts, error_attempts, max_attempts, success_count, success_limit,
                         success_retry_delay_seconds, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, 0, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.customerId,
      input.name,
      input.descriptionNote ?? null,
      input.url,
      input.method,
      payload,
      headers,
      errorAttemptLimit,
      successLimit,
      successRetryDelaySeconds,
      ts,
      ts,
    )
    .run();

  const row = await getJob(db, id, input.customerId);
  if (!row) throw new Error("insertJob: row missing after insert");
  return row;
}

export async function hasResumableJobWithSameName(
  db: D1Database,
  customerId: string,
  name: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1
       FROM jobs
       WHERE customer_id = ?
         AND name = ?
         AND status IN ('pending', 'running')
       LIMIT 1`,
    )
    .bind(customerId, name)
    .first<{ 1: number }>();
  return row != null;
}

export async function getJob(
  db: D1Database,
  id: string,
  customerId?: string,
): Promise<JobRow | null> {
  if (customerId) {
    const row = await db
      .prepare(`SELECT * FROM jobs WHERE id = ? AND customer_id = ?`)
      .bind(id, customerId)
      .first<JobRow>();
    return row ?? null;
  }
  const row = await db
    .prepare(`SELECT * FROM jobs WHERE id = ?`)
    .bind(id)
    .first<JobRow>();
  return row ?? null;
}

export interface ListJobsOptions {
  customerId: string;
  status?: JobStatus | JobStatus[];
  name?: string;
  limit?: number;
  offset?: number;
}

export interface ListAllJobsOptions {
  customerId?: string;
  status?: JobStatus | JobStatus[];
  name?: string;
  limit?: number;
  offset?: number;
}

export interface JobWithCustomerRow extends JobRow {
  customer_name: string;
}

export async function listJobs(
  db: D1Database,
  opts: ListJobsOptions,
): Promise<JobRow[]> {
  const clauses: string[] = ["customer_id = ?"];
  const binds: unknown[] = [opts.customerId];
  const statuses = opts.status
    ? Array.isArray(opts.status)
      ? opts.status
      : [opts.status]
    : [];
  if (statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
    binds.push(...statuses);
  }
  if (opts.name) {
    clauses.push("name = ?");
    binds.push(opts.name);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sql = `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<JobRow>();
  return result.results ?? [];
}

export async function listAllJobs(
  db: D1Database,
  opts: ListAllJobsOptions,
): Promise<JobWithCustomerRow[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (opts.customerId) {
    clauses.push("j.customer_id = ?");
    binds.push(opts.customerId);
  }
  const statuses = opts.status
    ? Array.isArray(opts.status)
      ? opts.status
      : [opts.status]
    : [];
  if (statuses.length > 0) {
    clauses.push(`j.status IN (${statuses.map(() => "?").join(", ")})`);
    binds.push(...statuses);
  }
  if (opts.name) {
    clauses.push("j.name = ?");
    binds.push(opts.name);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sql = `SELECT j.*, c.name AS customer_name
               FROM jobs j
               JOIN customers c ON c.id = j.customer_id
               ${where}
               ORDER BY j.created_at DESC
               LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<JobWithCustomerRow>();
  return result.results ?? [];
}

export async function countAllJobs(
  db: D1Database,
  opts: Omit<ListAllJobsOptions, "limit" | "offset">,
): Promise<number> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (opts.customerId) {
    clauses.push("j.customer_id = ?");
    binds.push(opts.customerId);
  }
  const statuses = opts.status
    ? Array.isArray(opts.status)
      ? opts.status
      : [opts.status]
    : [];
  if (statuses.length > 0) {
    clauses.push(`j.status IN (${statuses.map(() => "?").join(", ")})`);
    binds.push(...statuses);
  }
  if (opts.name) {
    clauses.push("j.name = ?");
    binds.push(opts.name);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM jobs j
       JOIN customers c ON c.id = j.customer_id
       ${where}`,
    )
    .bind(...binds)
    .first<{ total: number }>();
  return result?.total ?? 0;
}

export async function updateJobForObservability(
  db: D1Database,
  id: string,
  input: {
    name?: string;
    descriptionNote?: string | null;
    status?: JobStatus;
    url?: string;
    method?: JobRow["method"];
    payload?: unknown | null;
    headers?: Record<string, string> | null;
    errorAttemptLimit?: number;
    successLimit?: number;
    successRetryDelaySeconds?: number;
  },
): Promise<JobRow | null> {
  const updates: string[] = [];
  const binds: unknown[] = [];

  if (input.name !== undefined) {
    updates.push("name = ?");
    binds.push(input.name);
  }
  if (input.descriptionNote !== undefined) {
    updates.push("description_note = ?");
    binds.push(input.descriptionNote);
  }
  if (input.status !== undefined) {
    updates.push("status = ?");
    binds.push(input.status);
    if (input.status === "paused" || input.status === "done" || input.status === "failed") {
      updates.push("completed_at = ?");
      binds.push(now());
    } else if (input.status === "pending") {
      updates.push("completed_at = NULL");
    }
  }
  if (input.url !== undefined) {
    updates.push("url = ?");
    binds.push(input.url);
  }
  if (input.method !== undefined) {
    updates.push("method = ?");
    binds.push(input.method);
  }
  if (input.payload !== undefined) {
    updates.push("payload = ?");
    binds.push(input.payload == null ? null : JSON.stringify(input.payload));
  }
  if (input.headers !== undefined) {
    updates.push("headers = ?");
    binds.push(input.headers == null ? null : JSON.stringify(input.headers));
  }
  if (input.errorAttemptLimit !== undefined) {
    updates.push("max_attempts = ?");
    binds.push(input.errorAttemptLimit);
  }
  if (input.successLimit !== undefined) {
    updates.push("success_limit = ?");
    binds.push(input.successLimit);
  }
  if (input.successRetryDelaySeconds !== undefined) {
    updates.push("success_retry_delay_seconds = ?");
    binds.push(input.successRetryDelaySeconds);
  }

  updates.push("updated_at = ?");
  binds.push(now());
  binds.push(id);

  const row = await db
    .prepare(`UPDATE jobs SET ${updates.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...binds)
    .first<JobRow>();
  return row ?? null;
}

export async function listCustomers(db: D1Database): Promise<CustomerRow[]> {
  const result = await db
    .prepare(`SELECT * FROM customers ORDER BY name ASC`)
    .all<CustomerRow>();
  return result.results ?? [];
}

export async function getCustomerById(
  db: D1Database,
  customerId: string,
): Promise<CustomerRow | null> {
  const row = await db
    .prepare(`SELECT * FROM customers WHERE id = ? LIMIT 1`)
    .bind(customerId)
    .first<CustomerRow>();
  return row ?? null;
}

export async function updateCustomer(
  db: D1Database,
  customerId: string,
  input: {
    name?: string;
    isActive?: boolean;
    tokenHash?: string;
  },
): Promise<CustomerRow | null> {
  const updates: string[] = [];
  const binds: unknown[] = [];

  if (input.name !== undefined) {
    updates.push("name = ?");
    binds.push(input.name);
  }
  if (input.isActive !== undefined) {
    updates.push("is_active = ?");
    binds.push(input.isActive ? 1 : 0);
  }
  if (input.tokenHash !== undefined) {
    updates.push("token_hash = ?");
    binds.push(input.tokenHash);
  }
  updates.push("updated_at = ?");
  binds.push(now());
  binds.push(customerId);

  const row = await db
    .prepare(`UPDATE customers SET ${updates.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...binds)
    .first<CustomerRow>();
  return row ?? null;
}

export async function deleteCustomerWithJobs(
  db: D1Database,
  customerId: string,
): Promise<void> {
  await db.prepare(`DELETE FROM jobs WHERE customer_id = ?`).bind(customerId).run();
  await db.prepare(`DELETE FROM customers WHERE id = ?`).bind(customerId).run();
}

export async function deleteJobById(db: D1Database, jobId: string): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM jobs WHERE id = ?`)
    .bind(jobId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function insertRun(
  db: D1Database,
  input: {
    jobId: string;
    responseStatus: number | null;
    responsePayload: string | null;
    requestDurationMs: number | null;
  },
): Promise<RunRow> {
  const id = crypto.randomUUID();
  const runAt = now();
  const row = await db
    .prepare(
      `INSERT INTO runs (id, job_id, run_at, response_status, response_payload, request_duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .bind(
      id,
      input.jobId,
      runAt,
      input.responseStatus,
      truncate(input.responsePayload),
      input.requestDurationMs,
    )
    .first<RunRow>();
  if (!row) throw new Error("insertRun: row missing after insert");
  return row;
}

export async function countRunsByJobId(
  db: D1Database,
  jobId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS total FROM runs WHERE job_id = ?`)
    .bind(jobId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function listRunsByJobId(
  db: D1Database,
  jobId: string,
  limit = 500,
  offset = 0,
): Promise<RunRow[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 2000);
  const safeOffset = Math.max(offset, 0);
  const result = await db
    .prepare(
      `SELECT *
       FROM runs
       WHERE job_id = ?
       ORDER BY run_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(jobId, safeLimit, safeOffset)
    .all<RunRow>();
  return result.results ?? [];
}

/**
 * Atomically increments the attempt counter and flips the row to running.
 * Returns the new attempt count, or null if the row no longer exists or is
 * not claimable (already running or terminal) - the caller should ack and exit.
 */
export async function startAttempt(
  db: D1Database,
  id: string,
  customerId: string,
): Promise<{
  attempts: number;
  errorAttempts: number;
  errorAttemptLimit: number;
  successCount: number;
  successLimit: number;
} | null> {
  const ts = now();
  const result = await db
    .prepare(
      `UPDATE jobs
         SET attempts = attempts + 1,
             status = 'running',
             updated_at = ?
       WHERE id = ?
         AND customer_id = ?
         AND status = 'pending'
      RETURNING attempts, error_attempts, max_attempts, success_count, success_limit`,
    )
    .bind(ts, id, customerId)
    .first<{
      attempts: number;
      error_attempts: number;
      max_attempts: number;
      success_count: number;
      success_limit: number;
    }>();

  if (!result) return null;
  return {
    attempts: result.attempts,
    errorAttempts: result.error_attempts,
    errorAttemptLimit: result.max_attempts,
    successCount: result.success_count,
    successLimit: result.success_limit,
  };
}

export async function incrementErrorAttempts(
  db: D1Database,
  id: string,
  customerId: string,
  attemptNo: number,
): Promise<{ errorAttempts: number; errorAttemptLimit: number } | null> {
  const ts = now();
  const result = await db
    .prepare(
      `UPDATE jobs
         SET error_attempts = error_attempts + 1,
             updated_at = ?
       WHERE id = ?
         AND customer_id = ?
         AND status = 'running'
         AND attempts = ?
       RETURNING error_attempts, max_attempts`,
    )
    .bind(ts, id, customerId, attemptNo)
    .first<{ error_attempts: number; max_attempts: number }>();
  if (!result) return null;
  return {
    errorAttempts: result.error_attempts,
    errorAttemptLimit: result.max_attempts,
  };
}

export async function incrementSuccessCount(
  db: D1Database,
  id: string,
  customerId: string,
  attemptNo: number,
): Promise<{ successCount: number; successLimit: number } | null> {
  const ts = now();
  const result = await db
    .prepare(
      `UPDATE jobs
         SET success_count = success_count + 1,
             updated_at = ?
       WHERE id = ?
         AND customer_id = ?
         AND status = 'running'
         AND attempts = ?
       RETURNING success_count, success_limit`,
    )
    .bind(ts, id, customerId, attemptNo)
    .first<{ success_count: number; success_limit: number }>();
  if (!result) return null;
  return {
    successCount: result.success_count,
    successLimit: result.success_limit,
  };
}

export async function recordAttemptOutcome(
  db: D1Database,
  id: string,
  customerId: string,
  attemptNo: number,
  outcome: {
    lastStatus: number | null;
    lastBody: string | null;
    lastError: string | null;
    nextStatus: Extract<JobStatus, "pending" | "done" | "failed">;
  },
): Promise<boolean> {
  const ts = now();
  const completedAt = outcome.nextStatus === "pending" ? null : ts;

  const result = await db
    .prepare(
      `UPDATE jobs
         SET status = ?,
             last_status = ?,
             last_body = ?,
             last_error = ?,
             updated_at = ?,
             completed_at = COALESCE(?, completed_at)
       WHERE id = ?
         AND customer_id = ?
         AND status = 'running'
         AND attempts = ?`,
    )
    .bind(
      outcome.nextStatus,
      outcome.lastStatus,
      truncate(outcome.lastBody),
      outcome.lastError,
      ts,
      completedAt,
      id,
      customerId,
      attemptNo,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markDone(
  db: D1Database,
  id: string,
  customerId: string,
  attemptNo: number,
  lastStatus: number,
  lastBody: string | null,
): Promise<boolean> {
  return recordAttemptOutcome(db, id, customerId, attemptNo, {
    lastStatus,
    lastBody,
    lastError: null,
    nextStatus: "done",
  });
}

export async function markFailed(
  db: D1Database,
  id: string,
  customerId: string,
  reason: string,
  lastStatus: number | null = null,
  lastBody: string | null = null,
  attemptNo?: number,
): Promise<boolean> {
  if (attemptNo != null) {
    return recordAttemptOutcome(db, id, customerId, attemptNo, {
      lastStatus,
      lastBody,
      lastError: reason,
      nextStatus: "failed",
    });
  }

  const ts = now();
  const result = await db
    .prepare(
      `UPDATE jobs
         SET status = 'failed',
             last_status = ?,
             last_body = ?,
             last_error = ?,
             updated_at = ?,
             completed_at = ?
       WHERE id = ?
         AND customer_id = ?
         AND status NOT IN ('done', 'failed', 'paused')`,
    )
    .bind(
      lastStatus,
      truncate(lastBody),
      reason,
      ts,
      ts,
      id,
      customerId,
    )
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markPendingForRetry(
  db: D1Database,
  id: string,
  customerId: string,
  attemptNo: number,
  lastStatus: number | null,
  lastBody: string | null,
  lastError: string | null,
): Promise<boolean> {
  return recordAttemptOutcome(db, id, customerId, attemptNo, {
    lastStatus,
    lastBody,
    lastError,
    nextStatus: "pending",
  });
}

export interface RecoveredJobRow {
  id: string;
  customer_id: string;
}

/**
 * Moves stale "running" jobs back to "pending" so they can be processed again.
 * Returns the jobs that were recovered.
 */
export async function recoverStaleRunningJobs(
  db: D1Database,
  olderThanMs: number,
  limit: number,
): Promise<RecoveredJobRow[]> {
  const safeOlderThanMs = Math.max(1, olderThanMs);
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const ts = now();
  const cutoff = ts - safeOlderThanMs;
  const result = await db
    .prepare(
      `UPDATE jobs
         SET status = 'pending',
             updated_at = ?
       WHERE id IN (
         SELECT id
         FROM jobs
         WHERE status = 'running'
           AND updated_at <= ?
         ORDER BY updated_at ASC
         LIMIT ?
       )
      RETURNING id, customer_id`,
    )
    .bind(ts, cutoff, safeLimit)
    .all<RecoveredJobRow>();
  return result.results ?? [];
}

export interface RecoverStalePendingOpts {
  /** Re-enqueue if a job was created/reset to pending and never claimed (`attempts = 0`) after this many ms. */
  initialPendingMs: number;
  /** Extra wait beyond the expected queue delay before treating the row as orphaned. */
  pendingGraceMs: number;
  /** Upper bound on error-path `msg.retry` delay (`backoffSeconds` cap + jitter). */
  errorRetryUpperBoundMs: number;
  limit: number;
}

/**
 * Finds pending jobs whose next queue delivery is overdue: initial enqueue dropped,
 * or `msg.retry({ delaySeconds })` never arrived after success/error backoff.
 * Atomically bumps `updated_at` so repeated recovery scans do not re-enqueue the
 * same row before the grace window elapses again.
 * Sending another message is safe: {@link startAttempt} only claims `pending` rows.
 */
export async function recoverStalePendingJobs(
  db: D1Database,
  nowMs: number,
  opts: RecoverStalePendingOpts,
): Promise<RecoveredJobRow[]> {
  const safeLimit = Math.min(Math.max(opts.limit, 1), 500);
  const initialCutoff = nowMs - opts.initialPendingMs;
  const successPathCutoff = nowMs - opts.pendingGraceMs;
  const errorPathCutoff = nowMs - opts.pendingGraceMs - opts.errorRetryUpperBoundMs;
  const ts = now();
  const result = await db
    .prepare(
      `UPDATE jobs
         SET updated_at = ?
       WHERE id IN (
         SELECT id
         FROM jobs
         WHERE status = 'pending'
           AND (
             (attempts = 0 AND updated_at <= ?)
             OR (attempts > 0 AND last_error IS NULL
                 AND updated_at <= ? - success_retry_delay_seconds * 1000)
             OR (attempts > 0 AND last_error IS NOT NULL
                 AND updated_at <= ?)
           )
         ORDER BY updated_at ASC
         LIMIT ?
       )
      RETURNING id, customer_id`,
    )
    .bind(ts, initialCutoff, successPathCutoff, errorPathCutoff, safeLimit)
    .all<RecoveredJobRow>();
  return result.results ?? [];
}

/**
 * Returns pending jobs that should be safe to re-enqueue after process restarts.
 * This does not mutate the rows; it only selects candidates.
 */
export async function listResumablePendingJobs(
  db: D1Database,
  limit: number,
): Promise<RecoveredJobRow[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const result = await db
    .prepare(
      `SELECT id, customer_id
       FROM jobs
       WHERE status = 'pending'
       ORDER BY updated_at ASC
       LIMIT ?`,
    )
    .bind(safeLimit)
    .all<RecoveredJobRow>();
  return result.results ?? [];
}

export async function getActiveCustomerByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<CustomerRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM customers
       WHERE token_hash = ?
         AND is_active = 1
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<CustomerRow>();
  return row ?? null;
}

export async function createCustomer(
  db: D1Database,
  customer: { id: string; name: string; tokenHash: string; isActive?: boolean },
): Promise<void> {
  const ts = now();
  const isActive = customer.isActive === false ? 0 : 1;
  await db
    .prepare(
      `INSERT INTO customers (id, name, token_hash, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(customer.id, customer.name, customer.tokenHash, isActive, ts, ts)
    .run();
}
