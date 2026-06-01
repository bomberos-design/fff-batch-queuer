import { backoffSeconds } from "./backoff";
import {
  getJob,
  incrementErrorAttempts,
  incrementSuccessCount,
  insertRun,
  markDone,
  markFailed,
  markPendingForRetry,
  startAttempt,
} from "./db";
import { notifyJobFailed } from "./emailAlerts";
import type { Env, JobMessage, JobRow } from "./types";
import { MAX_BODY_SNAPSHOT_BYTES } from "./types";

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

async function callTarget(row: JobRow): Promise<FetchOutcome> {
  const method = row.method.toUpperCase();
  const payload = parsePayload(row.payload);
  const userHeaders = parseHeaders(row.headers);
  const startedAt = Date.now();

  try {
    const res = await fetch(row.url, {
      method,
      headers: buildHeaders(method, payload, userHeaders),
      body: buildBody(method, payload),
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

  const started = await startAttempt(env.DB, jobId, customerId);
  if (!started) {
    msg.ack();
    return;
  }
  const attemptNo = started.attempts;

  const outcome = await callTarget(existing);
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
    const marked = await markPendingForRetry(
      env.DB,
      jobId,
      customerId,
      attemptNo,
      outcome.status,
      outcome.body,
      null,
    );
    if (!marked) {
      console.warn(
        `[consumer] job ${jobId} attempt ${attemptNo} stale before success retry, acking`,
      );
      msg.ack();
      return;
    }
    const delaySeconds = Math.max(1, existing.success_retry_delay_seconds);
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
