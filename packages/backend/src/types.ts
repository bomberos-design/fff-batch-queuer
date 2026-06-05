/** Cloudflare Send Email binding (`send_email` in wrangler). */
export interface SendEmailBinding {
  send(message: {
    from: string;
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
  }): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  JOB_QUEUE: Queue<JobMessage>;
  /** Present when `send_email` is configured in wrangler. */
  SEND_EMAIL?: SendEmailBinding;
  OBSERVABILITY_TOKEN?: string;
  /** When set with ADMIN_PASSWORD, admin UI login is required for /observability/*. */
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  CORS_ORIGIN?: string;
  RECOVERY_STALE_RUNNING_MS?: string;
  RECOVERY_SCAN_LIMIT?: string;
  RECOVERY_PENDING_BOOT_REQUEUE_LIMIT?: string;
  /** Upper bound on outbound target fetch time in ms. Default: 120000 (2 minutes). */
  TARGET_FETCH_TIMEOUT_MS?: string;
  /** Verified sender on your zone (Email Routing). Required with JOB_FAILURE_ALERT_TO to send failure alerts. */
  JOB_FAILURE_ALERT_FROM?: string;
  /** Inbox that receives job failure notifications. */
  JOB_FAILURE_ALERT_TO?: string;
  /** Set to "false" to skip the daily cron health check. Default: enabled. */
  HEALTH_CHECK_ENABLED?: string;
  /** When "true", the daily health check also runs stale-job recovery. Default: false. */
  HEALTH_AUTO_HEAL?: string;
  /** When "true" (default), email only when anomalies are found. When "false", send a daily all-clear digest too. */
  HEALTH_ALERT_ONLY_ON_ISSUES?: string;
  /** Override sender for health digests; falls back to JOB_FAILURE_ALERT_FROM. */
  HEALTH_ALERT_FROM?: string;
  /** Override recipient for health digests; falls back to JOB_FAILURE_ALERT_TO. */
  HEALTH_ALERT_TO?: string;
  /** Grace after expected pending delivery before flagging as overdue. Default: 15 minutes. */
  HEALTH_PENDING_GRACE_MS?: string;
  /** Grace before flagging never-started pending jobs. Default: 10 minutes. */
  HEALTH_INITIAL_PENDING_MS?: string;
}

export type JobStatus = "pending" | "running" | "done" | "failed" | "paused";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface JobMessage {
  jobId: string;
  customerId: string;
}

export interface JobRow {
  id: string;
  customer_id: string;
  name: string;
  description_note: string | null;
  url: string;
  method: HttpMethod;
  payload: string | null;
  headers: string | null;
  status: JobStatus;
  attempts: number;
  error_attempts: number;
  max_attempts: number;
  success_count: number;
  success_limit: number;
  success_retry_delay_seconds: number;
  last_status: number | null;
  last_body: string | null;
  last_error: string | null;
  /** Earliest time (ms) a pending success-iteration retry may claim the job. */
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface JobInput {
  customerId: string;
  name: string;
  descriptionNote?: string | null;
  url: string;
  method: HttpMethod;
  payload?: unknown;
  headers?: Record<string, string>;
  errorAttemptLimit?: number;
  successLimit?: number;
  successRetryDelaySeconds?: number;
}

export interface RunRow {
  id: string;
  job_id: string;
  run_at: number;
  response_status: number | null;
  response_payload: string | null;
  request_duration_ms: number | null;
}

export const QUEUE_NAMES = {
  main: "fff-bq-queue",
  dlq: "fff-bq-dlq",
} as const;

export const MAX_BODY_SNAPSHOT_BYTES = 4096;

export interface CustomerRow {
  id: string;
  name: string;
  token_hash: string;
  is_active: number;
  created_at: number;
  updated_at: number;
}
