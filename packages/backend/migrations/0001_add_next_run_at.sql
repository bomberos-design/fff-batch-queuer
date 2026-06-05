-- Track when a success-iteration retry is allowed to fire (guards duplicate queue messages).
ALTER TABLE jobs ADD COLUMN next_run_at INTEGER;
