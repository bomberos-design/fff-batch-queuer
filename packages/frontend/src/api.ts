import type { Customer, Job, Run } from "./types";
import { clearSessionToken, getSessionToken } from "./auth";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.trim() || "http://127.0.0.1:8999";
const OBSERVABILITY_TOKEN = import.meta.env.VITE_OBSERVABILITY_TOKEN?.trim();

function getHeaders(): HeadersInit {
  const headers: Record<string, string> = {};
  if (OBSERVABILITY_TOKEN) {
    headers["x-observability-token"] = OBSERVABILITY_TOKEN;
  }
  const sessionToken = getSessionToken();
  if (sessionToken) {
    headers["x-admin-session"] = sessionToken;
  }
  return headers;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...getHeaders(),
    },
  });
  if (!response.ok) {
    if (response.status === 401 && getSessionToken()) {
      clearSessionToken();
    }
    const body = await response.text();
    throw new Error(
      `Request failed (${response.status}): ${body || response.statusText}`,
    );
  }
  return response.json() as Promise<T>;
}

export async function fetchAuthStatus(): Promise<{ authRequired: boolean }> {
  return request<{ authRequired: boolean }>("/auth/status");
}

export async function login(
  username: string,
  password: string,
): Promise<{ token: string }> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    const body = await response.text();
    let message = "Login failed";
    try {
      const parsed = JSON.parse(body) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // ignore non-JSON bodies
    }
    throw new Error(message);
  }
  return response.json() as Promise<{ token: string }>;
}

export async function fetchCustomers(): Promise<Customer[]> {
  const payload = await request<{ customers: Customer[] }>("/observability/customers");
  return payload.customers;
}

export async function fetchJobs(input?: {
  customerId?: string;
  statuses?: Job["status"][];
  limit?: number;
  offset?: number;
}): Promise<{ jobs: Job[]; total: number }> {
  const query = new URLSearchParams();
  if (input?.customerId) {
    query.set("customerId", input.customerId);
  }
  if (input?.statuses?.length) {
    input.statuses.forEach((status) => query.append("status", status));
  }
  if (input?.limit != null) {
    query.set("limit", String(input.limit));
  }
  if (input?.offset != null) {
    query.set("offset", String(input.offset));
  }
  const queryString = query.toString();
  const payload = await request<{ jobs: Job[]; total?: number }>(
    queryString.length > 0 ? `/observability/jobs?${queryString}` : "/observability/jobs",
  );
  return { jobs: payload.jobs, total: payload.total ?? payload.jobs.length };
}

export async function createJob(input: {
  customerId: string;
  name: string;
  descriptionNote?: string | null;
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  payload: unknown | null;
  headers: Record<string, string> | null;
  errorAttemptLimit: number;
  successLimit: number;
  successRetryDelaySeconds: number;
}): Promise<{ job: Job }> {
  return request<{ job: Job }>("/observability/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateJob(
  jobId: string,
  input: {
    name?: string;
    descriptionNote?: string | null;
    status?: "pending" | "running" | "done" | "failed" | "paused";
    url?: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    payload?: unknown | null;
    headers?: Record<string, string> | null;
    errorAttemptLimit?: number;
    successLimit?: number;
    successRetryDelaySeconds?: number;
  },
): Promise<{ job: Job }> {
  return request<{ job: Job }>(`/observability/jobs/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteJob(jobId: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/observability/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}

export async function fetchJobRuns(
  jobId: string,
  options?: { limit?: number; offset?: number },
): Promise<{ runs: Run[]; total: number }> {
  const limit = options?.limit ?? 500;
  const offset = options?.offset ?? 0;
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  return request<{ runs: Run[]; total: number }>(
    `/observability/jobs/${encodeURIComponent(jobId)}/runs?${params.toString()}`,
  );
}

export async function updateCustomer(
  customerId: string,
  input: { name: string; isActive: boolean; rotateToken: boolean },
): Promise<{ customer: Customer; newToken: string | null }> {
  return request<{ customer: Customer; newToken: string | null }>(
    `/observability/customers/${encodeURIComponent(customerId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function createCustomer(input: {
  name: string;
  isActive: boolean;
}): Promise<{ customer: Customer; newToken: string }> {
  return request<{ customer: Customer; newToken: string }>("/observability/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteCustomer(
  customerId: string,
): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(
    `/observability/customers/${encodeURIComponent(customerId)}`,
    {
      method: "DELETE",
    },
  );
}
