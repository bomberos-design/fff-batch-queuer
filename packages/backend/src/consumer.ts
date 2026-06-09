import { backoffSeconds } from "./backoff";
import {
  getJob,
  incrementErrorAttempts,
  incrementSuccessCount,
  insertRun,
  markDone,
  markFailed,
  markPendingForRetry,
  markPendingForSuccessRetry,
  startAttempt,
} from "./db";
import { getExpectedNextRunAtMs, isQueueDeliveryDue } from "./schedule";
import { notifyJobFailed } from "./emailAlerts";
import type { Env, JobMessage, JobRow } from "./types";
import { MAX_BODY_SNAPSHOT_BYTES } from "./types";

const DEFAULT_TARGET_FETCH_TIMEOUT_MS = 120_000;

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function getTargetFetchTimeoutMs(env: Env): number {
  return parsePositiveInt(env.TARGET_FETCH_TIMEOUT_MS) ?? DEFAULT_TARGET_FETCH_TIMEOUT_MS;
}

interface FetchOutcome {
  status: number | null;
  body: string | null;
  parsed: unknown;
  error: string | null;
  requestDurationMs: number | null;
}

function isTextBasedContentType(contentType: string | null): boolean {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  if (normalized.startsWith("text/")) return true;
  return (
    normalized.includes("application/json") ||
    normalized.includes("application/xml") ||
    normalized.includes("application/javascript") ||
    normalized.includes("application/x-www-form-urlencoded") ||
    normalized.includes("+json") ||
    normalized.includes("+xml")
  );
}

function getSnapshotBody(response: Response, rawText: string): string | null {
  if (!isTextBasedContentType(response.headers.get("content-type"))) {
    return null;
  }
  if (rawText.length <= MAX_BODY_SNAPSHOT_BYTES) {
    return rawText;
  }
  return rawText.slice(0, MAX_BODY_SNAPSHOT_BYTES);
}

function parseHeaders(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, string>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function parsePayload(raw: string | null): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildBody(method: string, payload: unknown): BodyInit | undefined {
  if (payload === undefined) return undefined;
  if (method === "GET" || method === "HEAD") return undefined;
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload);
}

function buildHeaders(
  method: string,
  payload: unknown,
  user: Record<string, string> | undefined,
): HeadersInit {
  const headers: Record<string, string> = {};
  if (user) {
    for (const [k, v] of Object.entries(user)) headers[k] = v;
  }
  const hasBody =
    payload !== undefined && method !== "GET" && method !== "HEAD";
  if (hasBody && typeof payload !== "string") {
    const hasCt = Object.keys(headers).some(
      (h) => h.toLowerCase() === "content-type",
    );
    if (!hasCt) headers["content-type"] = "application/json";
  }
  return headers;
}

async function callTarget(row: JobRow, env: Env): Promise<FetchOutcome> {
  const method = row.method.toUpperCase();
  const payload = parsePayload(row.payload);
  const userHeaders = parseHeaders(row.headers);
  const startedAt = Date.now();
  const timeoutMs = getTargetFetchTimeoutMs(env);

  try {
    const res = await fetch(row.url, {
      method,
      headers: buildHeaders(method, payload, userHeaders),
      body: buildBody(method, payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    const snapshotBody = getSnapshotBody(res, text);
    let parsed: unknown = undefined;
    try {
      parsed = text.length ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    return {
      status: res.status,
      body: snapshotBody,
      parsed,
      error: null,
      requestDurationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: null,
      body: null,
      parsed: undefined,
      error: `fetch failed: ${message}`,
      requestDurationMs: Date.now() - startedAt,
    };
  }
}

function isStop(parsed: unknown): boolean {
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    "stop" in (parsed as Record<string, unknown>) &&
    (parsed as Record<string, unknown>).stop === true
  );
}

function hasErrorKey(parsed: unknown): boolean {
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    "error" in (parsed as Record<string, unknown>)
  );
}

export async function processJobMessage(
  msg: Message<JobMessage>,
  env: Env,
): Promise<void> {
  const { jobId, customerId } = msg.body ?? ({} as JobMessage);
  if (!jobId || !customerId) {
    console.warn("[consumer] message missing jobId/customerId, acking");
    msg.ack();
    return;
  }

  const existing = await getJob(env.DB, jobId, customerId);
  if (!existing) {
    console.warn(`[consumer] job ${jobId} not found, acking`);
    msg.ack();
    return;
  }
  if (
    existing.status === "done" ||
    existing.status === "failed" ||
    existing.status === "paused"
  ) {
    msg.ack();
    return;
  }

  if (existing.status === "pending" && !isQueueDeliveryDue(existing, Date.now())) {
    console.log(
      `[consumer] job ${jobId} acking duplicate or early queue delivery (scheduled message will run when due)`,
    );
    msg.ack();
    return;
  }

  const started = await startAttempt(env.DB, jobId, customerId);
  if (!started) {
    const fresh = await getJob(env.DB, jobId, customerId);
    if (
      fresh &&
      fresh.status === "pending" &&
      !isQueueDeliveryDue(fresh, Date.now())
    ) {
      console.log(
        `[consumer] job ${jobId} acking after claim miss (duplicate or early delivery; scheduled message will run when due)`,
      );
      msg.ack();
      return;
    }
    msg.ack();
    return;
  }
  const attemptNo = started.attempts;

  const outcome = await callTarget(existing, env);
  await insertRun(env.DB, {
    jobId,
    responseStatus: outcome.status,
    responsePayload: outcome.body,
    requestDurationMs: outcome.requestDurationMs,
  });

  if (isStop(outcome.parsed)) {
    const marked = await markDone(
      env.DB,
      jobId,
      customerId,
      attemptNo,
      outcome.status as number,
      outcome.body,
    );
    if (!marked) {
      console.warn(
        `[consumer] job ${jobId} attempt ${attemptNo} stale after stop response, acking`,
      );
    }
    msg.ack();
    return;
  }

  const isHttpError =
    outcome.status === null || outcome.status < 200 || outcome.status >= 300;
  const payloadHasError = hasErrorKey(outcome.parsed);
  const isError = outcome.error !== null || isHttpError || payloadHasError;

  if (!isError) {
    const successState = await incrementSuccessCount(
      env.DB,
      jobId,
      customerId,
      attemptNo,
    );
    if (!successState) {
      console.warn(
        `[consumer] job ${jobId} attempt ${attemptNo} stale after success response, acking`,
      );
      msg.ack();
      return;
    }
    const reachedSuccessLimit =
      successState.successLimit !== -1 &&
      successState.successCount >= successState.successLimit;
    if (reachedSuccessLimit) {
      const marked = await markDone(
        env.DB,
        jobId,
        customerId,
        attemptNo,
        outcome.status as number,
        outcome.body,
      );
      if (!marked) {
        console.warn(
          `[consumer] job ${jobId} attempt ${attemptNo} stale after success limit, acking`,
        );
      }
      msg.ack();
      return;
    }
    const delaySeconds = Math.max(1, existing.success_retry_delay_seconds);
    const nextRunAtMs = Date.now() + delaySeconds * 1000;
    const marked = await markPendingForSuccessRetry(
      env.DB,
      jobId,
      customerId,
      attemptNo,
      outcome.status,
      outcome.body,
      nextRunAtMs,
    );
    if (!marked) {
      console.warn(
        `[consumer] job ${jobId} attempt ${attemptNo} stale before success retry, acking`,
      );
      msg.ack();
      return;
    }
    console.log(
      `[consumer] retrying job ${jobId} attempt=${started.attempts} delaySeconds=${delaySeconds} mode=fixed reason="success iteration ${successState.successCount}/${successState.successLimit}"`,
    );
    // Use a fresh queue message instead of msg.retry() so success iterations do not
    // consume the queue max_retries budget (otherwise high successLimit can DLQ and mark failed).
    await env.JOB_QUEUE.send(
      { jobId, customerId },
      { delaySeconds },
    );
    msg.ack();
    return;
  }

  const reason =
    outcome.error ??
    (isHttpError ? `HTTP ${outcome.status}` : "response payload contains error key");

  const errorState = await incrementErrorAttempts(
    env.DB,
    jobId,
    customerId,
    attemptNo,
  );
  if (!errorState) {
    console.warn(
      `[consumer] job ${jobId} attempt ${attemptNo} stale after error response, acking`,
    );
    msg.ack();
    return;
  }

  const reachedErrorLimit =
    errorState.errorAttempts >= errorState.errorAttemptLimit;
  if (reachedErrorLimit) {
    const marked = await markFailed(
      env.DB,
      jobId,
      customerId,
      reason,
      outcome.status,
      outcome.body,
      attemptNo,
    );
    if (marked) {
      await notifyJobFailed(env, {
        jobId,
        customerId,
        jobName: existing.name,
        reason,
        source: "error_limit",
      });
    } else {
      console.warn(
        `[consumer] job ${jobId} attempt ${attemptNo} stale at error limit, acking`,
      );
    }
    msg.ack();
    return;
  }

  const marked = await markPendingForRetry(
    env.DB,
    jobId,
    customerId,
    attemptNo,
    outcome.status,
    outcome.body,
    reason,
  );
  if (!marked) {
    console.warn(
      `[consumer] job ${jobId} attempt ${attemptNo} stale before error retry, acking`,
    );
    msg.ack();
    return;
  }

  const delaySeconds = backoffSeconds(errorState.errorAttempts);

  console.log(
    `[consumer] retrying job ${jobId} attempt=${started.attempts} delaySeconds=${delaySeconds} mode=exponential reason="${reason}" errorAttempts=${errorState.errorAttempts}/${errorState.errorAttemptLimit}`,
  );
  msg.retry({ delaySeconds });
}

export async function processDlqMessage(
  msg: Message<JobMessage>,
  env: Env,
): Promise<void> {
  const { jobId, customerId } = msg.body ?? ({} as JobMessage);
  if (!jobId || !customerId) {
    msg.ack();
    return;
  }
  const existing = await getJob(env.DB, jobId, customerId);
  if (!existing) {
    msg.ack();
    return;
  }
  if (
    existing.status === "done" ||
    existing.status === "failed" ||
    existing.status === "paused"
  ) {
    msg.ack();
    return;
  }

  // A poison queue message can DLQ while the job row is still healthy (e.g. duplicate
  // deliveries). Do not mark the job failed in that case; discard the message and
  // re-enqueue only when no scheduled delivery is still expected.
  if (existing.status === "running") {
    console.warn(
      `[dlq] discarding poison message for running job ${jobId}; recovery will handle stale running`,
    );
    msg.ack();
    return;
  }

  if (existing.last_error == null) {
    console.warn(
      `[dlq] discarding poison message for healthy pending job ${jobId}; not marking failed`,
    );
    const nowMs = Date.now();
    const expected = getExpectedNextRunAtMs(existing);
    if (expected == null || expected <= nowMs) {
      const delaySeconds = Math.max(1, existing.success_retry_delay_seconds);
      await env.JOB_QUEUE.send({ jobId, customerId }, { delaySeconds });
      console.log(
        `[dlq] re-queued job ${jobId} after discarding poison message delaySeconds=${delaySeconds}`,
      );
    }
    msg.ack();
    return;
  }

  if (existing.error_attempts < existing.max_attempts) {
    const delaySeconds = backoffSeconds(existing.error_attempts);
    console.warn(
      `[dlq] re-queuing error-path job ${jobId} after poison message delaySeconds=${delaySeconds} errorAttempts=${existing.error_attempts}/${existing.max_attempts}`,
    );
    await env.JOB_QUEUE.send({ jobId, customerId }, { delaySeconds });
    msg.ack();
    return;
  }

  await markFailed(
    env.DB,
    jobId,
    customerId,
    "dead-lettered after Queues max_retries",
    existing.last_status,
    existing.last_body,
  );
  await notifyJobFailed(env, {
    jobId,
    customerId,
    jobName: existing.name,
    reason: "dead-lettered after Queues max_retries",
    source: "dlq",
  });
  msg.ack();
}
