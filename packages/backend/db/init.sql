-- Current database schema bootstrap for fresh environments.
-- Apply with:
--   wrangler d1 execute fff-batch-queuer --local  --file=./db/init.sql
--   wrangler d1 execute fff-batch-queuer --remote --file=./db/init.sql

CREATE TABLE customers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX idx_customers_token_hash ON customers(token_hash);
CREATE INDEX idx_customers_active ON customers(is_active);


CREATE TABLE jobs (
  id                           TEXT PRIMARY KEY,
  customer_id                  TEXT NOT NULL,
  name                         TEXT NOT NULL,
  description_note             TEXT,
  url                          TEXT NOT NULL,
  method                       TEXT NOT NULL,
  payload                      TEXT,
  headers                      TEXT,
  status                       TEXT NOT NULL DEFAULT 'pending',
  attempts                     INTEGER NOT NULL DEFAULT 0,
  error_attempts               INTEGER NOT NULL DEFAULT 0,
  max_attempts                 INTEGER NOT NULL DEFAULT 1000,
  success_count                INTEGER NOT NULL DEFAULT 0,
  success_limit                INTEGER NOT NULL DEFAULT 1,
  last_status                  INTEGER,
  last_body                    TEXT,
  last_error                   TEXT,
  success_retry_delay_seconds  INTEGER NOT NULL DEFAULT 30,
  next_run_at                  INTEGER,
  created_at                   INTEGER NOT NULL,
  updated_at                   INTEGER NOT NULL,
  completed_at                 INTEGER,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_name ON jobs(name);
CREATE INDEX idx_jobs_created_at ON jobs(created_at);
CREATE INDEX idx_jobs_customer_id ON jobs(customer_id);
CREATE INDEX idx_jobs_customer_status_created ON jobs(customer_id, status, created_at);
CREATE INDEX idx_jobs_customer_status_updated ON jobs(customer_id, status, updated_at);

CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL,
  run_at             INTEGER NOT NULL,
  response_status    INTEGER,
  response_payload   TEXT,
  request_duration_ms INTEGER,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_runs_job_id_run_at ON runs(job_id, run_at DESC);
