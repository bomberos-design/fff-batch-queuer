import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  countAllJobs,
  createCustomer,
  deleteJobById,
  deleteCustomerWithJobs,
  getCustomerById,
  getActiveCustomerByTokenHash,
  getJob,
  hasResumableJobWithSameName,
  hasResumableJobWithSameUrl,
  insertJob,
  countRunsByJobId,
  listRunsByJobId,
  listAllJobs,
  listCustomers,
  listJobs,
  markFailed,
  updateJobForObservability,
  updateCustomer,
} from "./db";
import type { CustomerRow, Env, JobRow, JobStatus } from "./types";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const JOB_STATUSES = ["pending", "running", "done", "failed", "paused"] as const;

const jobRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createJobSchema = z.object({
  name: z.string().min(1).max(200),
  descriptionNote: z.string().trim().max(4000).nullable().optional(),
  url: z.string().url(),
  method: z.enum(HTTP_METHODS).default("POST"),
  payload: z.unknown().nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  errorAttemptLimit: z.number().int().positive().max(100_000).optional(),
  maxAttempts: z.number().int().positive().max(100_000).optional(),
  successLimit: z
    .number()
    .int()
    .max(1_000_000)
    .refine((v) => v === -1 || v > 0, {
      message: "successLimit must be -1 or a positive integer",
    })
    .optional(),
  successRetryDelaySeconds: z.number().int().positive().max(86_400).optional(),
});

const listQuerySchema = z.object({
  name: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const listStatusSchema = z.array(z.enum(JOB_STATUSES));

const updateCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  rotateToken: z.boolean().optional(),
});

const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  isActive: z.boolean().optional(),
});

const createObservabilityJobSchema = z.object({
  customerId: z.string().min(1),
  name: z.string().min(1).max(200),
  descriptionNote: z.string().trim().max(4000).nullable().optional(),
  url: z.string().url(),
  method: z.enum(HTTP_METHODS).default("POST"),
  payload: z.unknown().nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  errorAttemptLimit: z.number().int().positive().max(100_000).optional(),
  maxAttempts: z.number().int().positive().max(100_000).optional(),
  successLimit: z
    .number()
    .int()
    .max(1_000_000)
    .refine((v) => v === -1 || v > 0, {
      message: "successLimit must be -1 or a positive integer",
    })
    .optional(),
  successRetryDelaySeconds: z.number().int().positive().max(86_400).optional(),
});

const updateObservabilityJobSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  descriptionNote: z.string().trim().max(4000).nullable().optional(),
  status: z.enum(JOB_STATUSES).optional(),
  url: z.string().url().optional(),
  method: z.enum(HTTP_METHODS).optional(),
  payload: z.unknown().nullable().optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  errorAttemptLimit: z.coerce.number().int().positive().max(100_000).optional(),
  maxAttempts: z.coerce.number().int().positive().max(100_000).optional(),
  successLimit: z
    .coerce
    .number()
    .int()
    .max(1_000_000)
    .refine((v) => v === -1 || v > 0, {
      message: "successLimit must be -1 or a positive integer",
    })
    .optional(),
  successRetryDelaySeconds: z.coerce.number().int().positive().max(86_400).optional(),
});

interface SerializedJob {
  id: string;
  customerId: string;
  name: string;
  descriptionNote: string | null;
  url: string;
  method: string;
  payload: unknown;
  headers: Record<string, string> | null;
  status: JobStatus;
  attempts: number;
  errorAttempts: number;
  errorAttemptLimit: number;
  successCount: number;
  successLimit: number;
  maxAttempts: number;
  successRetryDelaySeconds: number;
  lastStatus: number | null;
  lastBody: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface SerializedCustomer {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

interface SerializedJobWithCustomer extends SerializedJob {
  customerName: string;
}

interface SerializedRun {
  id: string;
  jobId: string;
  runAt: number;
  responseStatus: number | null;
  responsePayload: string | null;
  requestDurationMs: number | null;
}

function serialize(row: JobRow): SerializedJob {
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    descriptionNote: row.description_note,
    url: row.url,
    method: row.method,
    payload: row.payload == null ? null : safeParse(row.payload),
    headers: row.headers == null ? null : (safeParse(row.headers) as Record<string, string>),
    status: row.status,
    attempts: row.attempts,
    errorAttempts: row.error_attempts,
    errorAttemptLimit: row.max_attempts,
    successCount: row.success_count,
    successLimit: row.success_limit,
    maxAttempts: row.max_attempts,
    successRetryDelaySeconds: row.success_retry_delay_seconds,
    lastStatus: row.last_status,
    lastBody: row.last_body,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function serializeCustomer(row: CustomerRow): SerializedCustomer {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeRun(row: {
  id: string;
  job_id: string;
  run_at: number;
  response_status: number | null;
  response_payload: string | null;
  request_duration_ms: number | null;
}): SerializedRun {
  return {
    id: row.id,
    jobId: row.job_id,
    runAt: row.run_at,
    responseStatus: row.response_status,
    responsePayload: row.response_payload,
    requestDurationMs: row.request_duration_ms,
  };
}

const app = new Hono<{ Bindings: Env }>();

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const configured = c.env.CORS_ORIGIN?.trim();
      if (!configured || configured === "*") return origin || "*";
      return configured;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "x-client-token",
      "x-observability-token",
      "x-admin-session",
    ],
  }),
);

function extractClientToken(c: Context<{ Bindings: Env }>): string | null {
  const token = c.req.header("x-client-token")?.trim();
  if (!token) return null;
  return token;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function authenticateCustomer(
  c: Context<{ Bindings: Env }>,
): Promise<CustomerRow | null> {
  const clientToken = extractClientToken(c);
  if (!clientToken) return null;
  const tokenHash = await sha256Hex(clientToken);
  return getActiveCustomerByTokenHash(c.env.DB, tokenHash);
}

function isAdminLoginConfigured(env: Env): boolean {
  return !!(env.ADMIN_USERNAME?.trim() && env.ADMIN_PASSWORD?.trim());
}

async function getAdminSessionToken(env: Env): Promise<string | null> {
  const username = env.ADMIN_USERNAME?.trim();
  const password = env.ADMIN_PASSWORD?.trim();
  if (!username || !password) return null;
  return sha256Hex(`${username}:${password}:fff-bq-admin-session`);
}

function hasObservabilityAccess(c: Context<{ Bindings: Env }>): boolean {
  const configuredToken = c.env.OBSERVABILITY_TOKEN?.trim();
  if (configuredToken) {
    const provided = c.req.header("x-observability-token")?.trim();
    if (provided === configuredToken) return true;
  }

  if (isAdminLoginConfigured(c.env)) {
    return false;
  }

  if (configuredToken) {
    return false;
  }

  return true;
}

async function hasObservabilityAccessAsync(
  c: Context<{ Bindings: Env }>,
): Promise<boolean> {
  if (hasObservabilityAccess(c)) return true;

  if (!isAdminLoginConfigured(c.env)) {
    return false;
  }

  const expectedToken = await getAdminSessionToken(c.env);
  const provided = c.req.header("x-admin-session")?.trim();
  return !!(expectedToken && provided === expectedToken);
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

app.get("/", (c) => c.json({ name: "fff-batch-queuer", ok: true }));
app.get("/health", (c) => c.json({ ok: true }));

app.get("/auth/status", (c) =>
  c.json({ authRequired: isAdminLoginConfigured(c.env) }),
);

app.post("/auth/login", async (c) => {
  if (!isAdminLoginConfigured(c.env)) {
    return c.json({ error: "admin login is not configured" }, 404);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }

  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      400,
    );
  }

  const expectedUsername = c.env.ADMIN_USERNAME!.trim();
  const expectedPassword = c.env.ADMIN_PASSWORD!.trim();
  if (
    parsed.data.username !== expectedUsername ||
    parsed.data.password !== expectedPassword
  ) {
    return c.json({ error: "invalid username or password" }, 401);
  }

  const token = await getAdminSessionToken(c.env);
  return c.json({ token });
});

app.get("/observability/customers", async (c) => {
  if (!(await hasObservabilityAccessAsync(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const customers = await listCustomers(c.env.DB);
  return c.json({ customers: customers.map(serializeCustomer) });
});

app.post("/observability/customers", async (c) => {
  if (!(await hasObservabilityAccessAsync(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }

  const parsed = createCustomerSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      400,
    );
  }

  const id = crypto.randomUUID();
  const newToken = `fff_bq_${crypto.randomUUID().replaceAll("-", "")}`;
  const tokenHash = await sha256Hex(newToken);

  await createCustomer(c.env.DB, {
    id,
    name: parsed.data.name,
    tokenHash,
    isActive: parsed.data.isActive ?? true,
  });

  const created = await getCustomerById(c.env.DB, id);
  if (!created) return c.json({ error: "failed to create customer" }, 500);
  return c.json(
    {
      customer: serializeCustomer(created),
      newToken,
    },
    201,
  );
});

app.patch("/observability/customers/:id", async (c) => {
  if (!(await hasObservabilityAccessAsync(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }

  const parsed = updateCustomerSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      400,
    );
  }

  const id = c.req.param("id");
  const existing = await getCustomerById(c.env.DB, id);
  if (!existing) return c.json({ error: "not found" }, 404);

  let newToken: string | null = null;
  let tokenHash: string | undefined;
  if (parsed.data.rotateToken) {
    newToken = `fff_bq_${crypto.randomUUID().replaceAll("-", "")}`;
    tokenHash = await sha256Hex(newToken);
  }

  const updated = await updateCustomer(c.env.DB, id, {
    name: parsed.data.name,
    isActive: parsed.data.isActive,
    tokenHash,
  });
  if (!updated) return c.json({ error: "not found" }, 404);

  return c.json({
    customer: serializeCustomer(updated),
    newToken,
  });
});

app.delete("/observability/customers/:id", async (c) => {
  if (!(await hasObservabilityAccessAsync(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const id = c.req.param("id");
  const existing = await getCustomerById(c.env.DB, id);
  if (!existing) return c.json({ error: "not found" }, 404);

  await deleteCustomerWithJobs(c.env.DB, id);
  return c.json({ deleted: true });
});

app.get("/observability/jobs", async (c) => {
  if (!(await hasObservabilityAccessAsync(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const parsed = listQuerySchema.safeParse({
    name: c.req.query("name"),
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!parsed.success) {
    return c.json(
      { error: "Invalid query", details: parsed.error.flatten() },
      400,
    );
  }

  const parsedStatuses = listStatusSchema.safeParse(
    (c.req
      .queries("status") ?? [])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  if (!parsedStatuses.success) {
    return c.json(
      { error: "Invalid query", details: parsedStatuses.error.flatten() },
      400,
    );
  }

  const customerId = c.req.query("customerId") ?? undefined;
  const filters = {
    customerId,
    status: parsedStatuses.data.length > 0 ? parsedStatuses.data : undefined,
    name: parsed.data.name,
  };
  const rows = await listAllJobs(c.env.DB, {
    ...filters,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });
  const total = await countAllJobs(c.env.DB, filters);
  const jobs: SerializedJobWithCustomer[] = rows.map((row) => ({
    ...serialize(row),
    customerName: row.customer_name,
  }));
  return c.json({ jobs, total });
});

app.post("/observability/jobs", async (c) => {
  if (!(await hasObservabilityAccessAsync(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }

  const parsed = createObservabilityJobSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      400,
    );
  }

  const customer = await getCustomerById(c.env.DB, parsed.data.customerId);
  if (!customer) return c.json({ error: "customer not found" }, 404);

  const hasDuplicateName = await hasResumableJobWithSameName(
    c.env.DB,
    parsed.data.customerId,
    parsed.data.name,
  );
  if (hasDuplicateName) {
    return c.json(
      {
        error:
          "job already in queue: you cannot add more than one non-done job with the same name for this customer",
      },
      409,
    );
  }
  const hasDuplicateUrl = await hasResumableJobWithSameUrl(
    c.env.DB,
    parsed.data.customerId,
    parsed.data.url,
  );
  if (hasDuplicateUrl) {
    return c.json(
      {
        error:
          "job already in queue: you cannot add more than one active job targeting the same URL for this customer",
      },
      409,
    );
  }

  const id = crypto.randomUUID();
  const row = await insertJob(c.env.DB, id, {
    customerId: parsed.data.customerId,
    name: parsed.data.name,
    descriptionNote: parsed.data.descriptionNote,
    url: parsed.data.url,
    method: parsed.data.method,
    payload: parsed.data.payload ?? undefined,
    headers: parsed.data.headers ?? undefined,
    errorAttemptLimit: parsed.data.errorAttemptLimit ?? parsed.data.maxAttempts,
    successLimit: parsed.data.successLimit,
    successRetryDelaySeconds: parsed.data.successRetryDelaySeconds,
  });
  await c.env.JOB_QUEUE.send({ jobId: id, customerId: parsed.data.customerId });

  return c.json(
    {
      job: {
        ...serialize(row),
        customerName: customer.name,
      },
    },
    201,
  );
});

app.patch("/observability/jobs/:id", async (c) => {
  if (!(await hasObservabilityAccessAsync(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }

  const parsed = updateObservabilityJobSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      400,
    );
  }

  const id = c.req.param("id");
  const existing = await getJob(c.env.DB, id);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (parsed.data.status === "running") {
    return c.json({ error: "status cannot be manually set to running" }, 400);
  }

  const updated = await updateJobForObservability(c.env.DB, id, {
    ...parsed.data,
    errorAttemptLimit: parsed.data.errorAttemptLimit ?? parsed.data.maxAttempts,
  });
  if (!updated) return c.json({ error: "not found" }, 404);
  if (parsed.data.status === "pending" && existing.status !== "pending") {
    await c.env.JOB_QUEUE.send({ jobId: id, customerId: existing.customer_id });
  }
  return c.json({ job: serialize(updated) });
});

app.delete("/observability/jobs/:id", async (c) => {
  if (!(await hasObservabilityAccessAsync(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const id = c.req.param("id");
  const existing = await getJob(c.env.DB, id);
  if (!existing) return c.json({ error: "not found" }, 404);

  const deleted = await deleteJobById(c.env.DB, id);
  return c.json({ deleted });
});

app.get("/observability/jobs/:id/runs", async (c) => {
  if (!(await hasObservabilityAccessAsync(c))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const id = c.req.param("id");
  const existing = await getJob(c.env.DB, id);
  if (!existing) return c.json({ error: "not found" }, 404);
  const parsed = jobRunsQuerySchema.safeParse({
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!parsed.success) {
    return c.json(
      { error: "Invalid query", details: parsed.error.flatten() },
      400,
    );
  }
  const limit = parsed.data.limit ?? 500;
  const offset = parsed.data.offset ?? 0;
  const [runs, total] = await Promise.all([
    listRunsByJobId(c.env.DB, id, limit, offset),
    countRunsByJobId(c.env.DB, id),
  ]);
  return c.json({
    runs: runs.map(serializeRun),
    total,
  });
});

app.post("/jobs", async (c) => {
  const customer = await authenticateCustomer(c);
  if (!customer) {
    return c.json({ error: "invalid or missing x-client-token header" }, 401);
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }

  const parsed = createJobSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      400,
    );
  }

  const hasDuplicateName = await hasResumableJobWithSameName(
    c.env.DB,
    customer.id,
    parsed.data.name,
  );
  if (hasDuplicateName) {
    return c.json(
      {
        error:
          "job already in queue: you cannot add more than one non-done job with the same name for this customer",
      },
      409,
    );
  }
  const hasDuplicateUrl = await hasResumableJobWithSameUrl(
    c.env.DB,
    customer.id,
    parsed.data.url,
  );
  if (hasDuplicateUrl) {
    return c.json(
      {
        error:
          "job already in queue: you cannot add more than one active job targeting the same URL for this customer",
      },
      409,
    );
  }

  const id = crypto.randomUUID();
  const row = await insertJob(c.env.DB, id, {
    customerId: customer.id,
    name: parsed.data.name,
    descriptionNote: parsed.data.descriptionNote,
    url: parsed.data.url,
    method: parsed.data.method,
    payload: parsed.data.payload ?? undefined,
    headers: parsed.data.headers ?? undefined,
    errorAttemptLimit: parsed.data.errorAttemptLimit ?? parsed.data.maxAttempts,
    successLimit: parsed.data.successLimit,
    successRetryDelaySeconds: parsed.data.successRetryDelaySeconds,
  });
  await c.env.JOB_QUEUE.send({ jobId: id, customerId: customer.id });

  return c.json({ id, job: serialize(row) }, 201);
});

app.get("/jobs", async (c) => {
  const customer = await authenticateCustomer(c);
  if (!customer) {
    return c.json({ error: "invalid or missing x-client-token header" }, 401);
  }

  const parsed = listQuerySchema.safeParse({
    name: c.req.query("name"),
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (!parsed.success) {
    return c.json(
      { error: "Invalid query", details: parsed.error.flatten() },
      400,
    );
  }

  const parsedStatuses = listStatusSchema.safeParse(
    (c.req
      .queries("status") ?? [])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  if (!parsedStatuses.success) {
    return c.json(
      { error: "Invalid query", details: parsedStatuses.error.flatten() },
      400,
    );
  }

  const rows = await listJobs(c.env.DB, {
    ...parsed.data,
    status: parsedStatuses.data.length > 0 ? parsedStatuses.data : undefined,
    customerId: customer.id,
  });
  return c.json({ jobs: rows.map(serialize) });
});

app.get("/jobs/:id", async (c) => {
  const customer = await authenticateCustomer(c);
  if (!customer) {
    return c.json({ error: "invalid or missing x-client-token header" }, 401);
  }
  const row = await getJob(c.env.DB, c.req.param("id"), customer.id);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ job: serialize(row) });
});

app.post("/jobs/:id/cancel", async (c) => {
  const customer = await authenticateCustomer(c);
  if (!customer) {
    return c.json({ error: "invalid or missing x-client-token header" }, 401);
  }
  const id = c.req.param("id");
  const row = await getJob(c.env.DB, id, customer.id);
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status === "done" || row.status === "failed" || row.status === "paused") {
    return c.json({ job: serialize(row), cancelled: false });
  }
  await markFailed(
    c.env.DB,
    id,
    customer.id,
    "cancelled",
    row.last_status,
    row.last_body,
  );
  const updated = await getJob(c.env.DB, id, customer.id);
  return c.json({ job: updated ? serialize(updated) : null, cancelled: true });
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  console.error("[api] unhandled error", err);
  return c.json({ error: "internal error" }, 500);
});

export default app;
