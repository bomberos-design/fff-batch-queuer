import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  MultiSelect,
  NumberInput,
  Pagination,
  Select,
  Table,
  TextInput,
  Textarea,
  Text,
  Title,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  createJob,
  deleteJob,
  fetchCustomers,
  fetchJobRuns,
  fetchJobs,
  updateJob,
} from "../api";
import type { Customer, Job, Run } from "../types";

function getStatusColor(status: Job["status"]): string {
  switch (status) {
    case "pending":
      return "yellow";
    case "running":
      return "blue";
    case "done":
      return "green";
    case "failed":
      return "red";
    case "paused":
      return "gray";
  }
}

function formatSuccessProgress(job: Job): string {
  if (job.successLimit === -1) {
    return `${job.successCount} / ∞`;
  }
  return `${job.successCount} / ${job.successLimit}`;
}

function estimateErrorRetryDelaySeconds(errorAttempts: number): number {
  const baseMs = 5_000;
  const maxMs = 300_000;
  const safeAttempt = Math.max(1, Math.floor(errorAttempts));
  const expMs = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
  // Backend adds up to 1s jitter; we show a close deterministic estimate.
  return Math.max(1, Math.ceil(expMs / 1000));
}

const JOB_STATUS_OPTIONS: Array<{ value: Job["status"]; label: string }> = [
  { value: "pending", label: "pending" },
  { value: "running", label: "running" },
  { value: "done", label: "done" },
  { value: "failed", label: "failed" },
  { value: "paused", label: "paused" },
];

const RUNS_BATCH_SIZE = 500;

export function JobsPage() {
  const DEFAULT_PAGE_SIZE = 50;
  const [searchParams, setSearchParams] = useSearchParams();
  const initialCustomerId = searchParams.get("customerId");
  const initialStatuses = searchParams
    .getAll("status")
    .filter((status): status is Job["status"] =>
      JOB_STATUS_OPTIONS.some((option) => option.value === status),
    );
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(
    initialCustomerId && initialCustomerId.length > 0 ? initialCustomerId : null,
  );
  const [selectedStatuses, setSelectedStatuses] = useState<Job["status"][]>(initialStatuses);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [totalJobs, setTotalJobs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpened, setModalOpened] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [modalCustomerId, setModalCustomerId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [modalName, setModalName] = useState("");
  const [modalDescriptionNote, setModalDescriptionNote] = useState("");
  const [modalUrl, setModalUrl] = useState("");
  const [modalMethod, setModalMethod] = useState<string>("POST");
  const [modalPayload, setModalPayload] = useState("");
  const [modalHeaders, setModalHeaders] = useState("");
  const [modalErrorAttemptLimit, setModalErrorAttemptLimit] = useState<number>(1);
  const [modalSuccessLimit, setModalSuccessLimit] = useState<number>(1);
  const [modalSuccessRetryDelaySeconds, setModalSuccessRetryDelaySeconds] =
    useState<number>(30);
  const [reloadToken, setReloadToken] = useState(0);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runsTotal, setRunsTotal] = useState<number | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsLoadingMore, setRunsLoadingMore] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const runsOffsetRef = useRef(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      fetchCustomers(),
      fetchJobs({
        customerId: selectedCustomerId ?? undefined,
        statuses: selectedStatuses.length > 0 ? selectedStatuses : undefined,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
    ])
      .then(([customerRows, jobsResult]) => {
        setCustomers(customerRows);
        setJobs(jobsResult.jobs);
        setTotalJobs(jobsResult.total);
        if (
          expandedJobId &&
          !jobsResult.jobs.some((job) => job.id === expandedJobId)
        ) {
          setExpandedJobId(null);
          setRuns([]);
          setRunsTotal(null);
          setRunsError(null);
          setRunsLoading(false);
          setRunsLoadingMore(false);
          runsOffsetRef.current = 0;
        }
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [selectedCustomerId, selectedStatuses, page, pageSize, reloadToken, expandedJobId]);

  useEffect(() => {
    if (!expandedJobId) {
      setRuns([]);
      setRunsTotal(null);
      setRunsError(null);
      setRunsLoading(false);
      setRunsLoadingMore(false);
      runsOffsetRef.current = 0;
      return;
    }
    runsOffsetRef.current = 0;
    setRunsLoading(true);
    setRunsError(null);
    fetchJobRuns(expandedJobId, { limit: RUNS_BATCH_SIZE, offset: 0 })
      .then(({ runs: rows, total }) => {
        setRuns(rows);
        setRunsTotal(total);
        runsOffsetRef.current = rows.length;
      })
      .catch((err: Error) => setRunsError(err.message))
      .finally(() => setRunsLoading(false));
  }, [expandedJobId]);

  const fetchMoreRuns = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!expandedJobId || runsLoadingMore) return;

    const offset = runsOffsetRef.current;
    setRunsLoadingMore(true);
    setRunsError(null);
    fetchJobRuns(expandedJobId, { limit: RUNS_BATCH_SIZE, offset })
      .then(({ runs: rows, total }) => {
        setRuns((current) => {
          const seen = new Set(current.map((run) => run.id));
          const uniqueRows = rows.filter((run) => !seen.has(run.id));
          return [...current, ...uniqueRows];
        });
        runsOffsetRef.current = offset + rows.length;
        setRunsTotal(total);
      })
      .catch((err: Error) => setRunsError(err.message))
      .finally(() => setRunsLoadingMore(false));
  };

  const totalPages = Math.max(1, Math.ceil(totalJobs / pageSize));

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  useEffect(() => {
    const customerIdFromQuery = searchParams.get("customerId");
    const statusesFromQuery = searchParams
      .getAll("status")
      .filter((status): status is Job["status"] =>
        JOB_STATUS_OPTIONS.some((option) => option.value === status),
      );
    const nextValue =
      customerIdFromQuery && customerIdFromQuery.length > 0
        ? customerIdFromQuery
        : null;
    if (nextValue !== selectedCustomerId) {
      setSelectedCustomerId(nextValue);
      setPage(1);
    }
    if (
      statusesFromQuery.length !== selectedStatuses.length ||
      statusesFromQuery.some((status, index) => status !== selectedStatuses[index])
    ) {
      setSelectedStatuses(statusesFromQuery);
      setPage(1);
    }
  }, [searchParams, selectedCustomerId, selectedStatuses]);

  const customerOptions = useMemo(
    () =>
      customers.map((customer) => ({
        value: customer.id,
        label: customer.name,
      })),
    [customers],
  );

  function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  function formatRelative(timestamp: number): string {
    const diffMs = timestamp - Date.now();
    if (diffMs <= 0) return "now";
    const totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `in ${hours}h ${minutes}m`;
    if (minutes > 0) return `in ${minutes}m ${seconds}s`;
    return `in ${seconds}s`;
  }

  function formatDuration(durationMs: number | null): string {
    if (durationMs == null) return "-";
    if (durationMs < 1000) return `${durationMs} ms`;
    return `${(durationMs / 1000).toFixed(2)} s`;
  }

  function getNextRunAt(job: Job): number | null {
    if (job.status !== "pending") return null;
    if (job.attempts === 0) return Date.now();

    const isErrorRetry = Boolean(job.lastError);
    const delaySeconds = isErrorRetry
      ? estimateErrorRetryDelaySeconds(job.errorAttempts)
      : Math.max(1, job.successRetryDelaySeconds);
    return job.updatedAt + delaySeconds * 1000;
  }

  function openEditModal(job: Job): void {
    setModalOpened(true);
    setModalMode("edit");
    setEditingJob(job);
    setModalCustomerId(job.customerId);
    setSaveError(null);
    setModalName(job.name);
    setModalDescriptionNote(job.descriptionNote ?? "");
    setModalUrl(job.url);
    setModalMethod(job.method);
    setModalPayload(job.payload == null ? "" : JSON.stringify(job.payload, null, 2));
    setModalHeaders(job.headers == null ? "" : JSON.stringify(job.headers, null, 2));
    setModalErrorAttemptLimit(job.errorAttemptLimit);
    setModalSuccessLimit(job.successLimit);
    setModalSuccessRetryDelaySeconds(job.successRetryDelaySeconds);
  }

  function openCreateModal(): void {
    setModalOpened(true);
    setModalMode("create");
    setEditingJob(null);
    setModalCustomerId(selectedCustomerId ?? customerOptions[0]?.value ?? null);
    setSaveError(null);
    setModalName("");
    setModalDescriptionNote("");
    setModalUrl("");
    setModalMethod("POST");
    setModalPayload("");
    setModalHeaders("");
    setModalErrorAttemptLimit(1000);
    setModalSuccessLimit(1);
    setModalSuccessRetryDelaySeconds(30);
  }

  function closeModal(): void {
    if (saving || deleting) return;
    setModalOpened(false);
    setEditingJob(null);
  }

  async function onDeleteJob(): Promise<void> {
    if (!editingJob) return;
    if (!window.confirm(`Delete job "${editingJob.name}"? This cannot be undone.`)) {
      return;
    }

    setDeleting(true);
    setSaveError(null);
    try {
      await deleteJob(editingJob.id);
      setModalOpened(false);
      setEditingJob(null);
      setReloadToken((value) => value + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to delete job");
    } finally {
      setDeleting(false);
    }
  }

  async function onSaveModal(): Promise<void> {
    setSaving(true);
    setSaveError(null);

    try {
      const parsedPayload =
        modalPayload.trim().length === 0 ? null : JSON.parse(modalPayload);
      const parsedHeaders =
        modalHeaders.trim().length === 0
          ? null
          : (JSON.parse(modalHeaders) as Record<string, string>);

      const method = modalMethod as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      const descriptionNote =
        modalDescriptionNote.trim().length > 0 ? modalDescriptionNote.trim() : null;
      if (modalMode === "create") {
        if (!modalCustomerId) {
          throw new Error("Customer is required");
        }
        const result = await createJob({
          customerId: modalCustomerId,
          name: modalName.trim(),
          descriptionNote,
          url: modalUrl.trim(),
          method,
          payload: parsedPayload,
          headers: parsedHeaders,
          errorAttemptLimit: modalErrorAttemptLimit,
          successLimit: modalSuccessLimit,
          successRetryDelaySeconds: modalSuccessRetryDelaySeconds,
        });
        if (!selectedCustomerId || selectedCustomerId === result.job.customerId) {
          setPage(1);
          setReloadToken((value) => value + 1);
        }
        setModalOpened(false);
        setEditingJob(null);
      } else {
        if (!editingJob) return;
        const result = await updateJob(editingJob.id, {
          name: modalName.trim(),
          descriptionNote,
          url: modalUrl.trim(),
          method,
          payload: parsedPayload,
          headers: parsedHeaders,
          errorAttemptLimit: modalErrorAttemptLimit,
          successLimit: modalSuccessLimit,
          successRetryDelaySeconds: modalSuccessRetryDelaySeconds,
        });

        setEditingJob((prev) => (prev ? { ...prev, ...result.job } : prev));
        setReloadToken((value) => value + 1);
        setModalOpened(false);
        setEditingJob(null);
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : modalMode === "create"
            ? "Failed to create job"
            : "Failed to update job";
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  async function onSetJobStatus(status: "paused" | "pending"): Promise<void> {
    if (!editingJob) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await updateJob(editingJob.id, { status });
      setEditingJob((prev) => (prev ? { ...prev, ...result.job } : prev));
      setReloadToken((value) => value + 1);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : `Failed to set status to ${status}`);
    } finally {
      setSaving(false);
    }
  }

  function updateSearchFilters(next: {
    customerId: string | null;
    statuses: Job["status"][];
  }): void {
    const params = new URLSearchParams();
    if (next.customerId) {
      params.set("customerId", next.customerId);
    }
    next.statuses.forEach((status) => params.append("status", status));
    setSearchParams(params);
  }

  return (
    <>
      <Group justify="space-between" mb="md" align="flex-end" wrap="wrap">
        <Title order={3}>Jobs</Title>
        <Group wrap="wrap" justify="flex-end">
          <Select
            placeholder="Filter by customer"
            clearable
            data={customerOptions}
            value={selectedCustomerId}
            onChange={(value) => {
              setSelectedCustomerId(value);
              setPage(1);
              updateSearchFilters({ customerId: value, statuses: selectedStatuses });
            }}
            w={{ base: "100%", sm: 280 }}
            maw={360}
          />
          <MultiSelect
            placeholder="Filter by status"
            clearable
            data={JOB_STATUS_OPTIONS}
            value={selectedStatuses}
            onChange={(value) => {
              const nextStatuses = value.filter((status): status is Job["status"] =>
                JOB_STATUS_OPTIONS.some((option) => option.value === status),
              );
              setSelectedStatuses(nextStatuses);
              setPage(1);
              updateSearchFilters({
                customerId: selectedCustomerId,
                statuses: nextStatuses,
              });
            }}
            w={{ base: "100%", sm: 320 }}
            maw={420}
          />
          <Group gap="xs" wrap="nowrap">
            <ActionIcon
              variant="default"
              size="lg"
              aria-label="Reload jobs"
              onClick={() => setReloadToken((value) => value + 1)}
              disabled={loading}
            >
              <IconRefresh size={18} stroke={1.5} />
            </ActionIcon>
            <Button onClick={openCreateModal} miw={120}>
              New Job
            </Button>
          </Group>
        </Group>
      </Group>
      {loading && <Loader />}
      {error && <Alert color="red">{error}</Alert>}
      {!loading && !error && jobs.length === 0 && (
        <Text c="dimmed">No jobs found.</Text>
      )}
      {!loading && !error && jobs.length > 0 && (
        <>
          <Table.ScrollContainer minWidth={920}>
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Customer</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Next run</Table.Th>
                  <Table.Th>Error State</Table.Th>
                  <Table.Th>Success target</Table.Th>
                  <Table.Th>Attempts</Table.Th>
                  <Table.Th></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {jobs.map((job) => {
                  const nextRunAt = getNextRunAt(job);
                  const isExpanded = expandedJobId === job.id;
                  return (
                    <Fragment key={job.id}>
                      <Table.Tr
                        style={{ cursor: "pointer" }}
                        bg={isExpanded ? "var(--mantine-color-blue-light)" : undefined}
                        onClick={() =>
                          setExpandedJobId((current) => (current === job.id ? null : job.id))
                        }
                      >
                        <Table.Td>{job.name}</Table.Td>
                        <Table.Td>{job.customerName}</Table.Td>
                        <Table.Td>
                          <Badge color={getStatusColor(job.status)} variant="light">
                            {job.status}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          {nextRunAt == null ? (
                            <Text size="sm" c="dimmed">
                              -
                            </Text>
                          ) : (
                            <Text size="sm">
                              {formatDate(nextRunAt)}
                              <br />
                              <Text span size="xs" c="dimmed">
                                {formatRelative(nextRunAt)}
                              </Text>
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          {job.errorAttempts > 0 && job.status === "pending" ? (
                            <Badge color="orange" variant="light">
                              Retrying ({job.errorAttempts}/{job.errorAttemptLimit})
                            </Badge>
                          ) : job.errorAttempts > 0 ? (
                            <Badge color="yellow" variant="light">
                              Had errors ({job.errorAttempts}/{job.errorAttemptLimit})
                            </Badge>
                          ) : (
                            <Badge color="green" variant="light">
                              Clean
                            </Badge>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{formatSuccessProgress(job)}</Text>
                        </Table.Td>
                        <Table.Td>{job.attempts}</Table.Td>
                        <Table.Td>
                          <Button
                            variant="light"
                            onClick={(event) => {
                              event.stopPropagation();
                              openEditModal(job);
                            }}
                          >
                            Edit
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                      {isExpanded && (
                        <Table.Tr onClick={(event) => event.stopPropagation()}>
                          <Table.Td colSpan={8}>
                            <Text size="sm" fw={600} mb="xs">
                              Runs
                              {runsTotal != null
                                ? ` (${runs.length} of ${runsTotal})`
                                : ` (${runs.length})`}
                            </Text>
                            {runsTotal != null && runs.length < runsTotal && !runsLoading && (
                              <Text size="xs" c="dimmed" mb="xs">
                                Newest runs are listed first.
                              </Text>
                            )}
                            {runsLoading && <Loader size="sm" />}
                            {!runsLoading && runsError && <Alert color="red">{runsError}</Alert>}
                            {!runsLoading && !runsError && runs.length === 0 && (
                              <Text size="sm" c="dimmed">
                                No runs found.
                              </Text>
                            )}
                            {!runsLoading && !runsError && runs.length > 0 && (
                              <Table.ScrollContainer minWidth={760}>
                                <Table striped withTableBorder>
                                  <Table.Thead>
                                    <Table.Tr>
                                      <Table.Th>Run At</Table.Th>
                                      <Table.Th>Status</Table.Th>
                                      <Table.Th>Request Time</Table.Th>
                                      <Table.Th>Response Payload</Table.Th>
                                    </Table.Tr>
                                  </Table.Thead>
                                  <Table.Tbody>
                                    {runs.map((run) => (
                                      <Table.Tr key={run.id}>
                                        <Table.Td>{formatDate(run.runAt)}</Table.Td>
                                        <Table.Td>{run.responseStatus ?? "-"}</Table.Td>
                                        <Table.Td>{formatDuration(run.requestDurationMs)}</Table.Td>
                                        <Table.Td>
                                          <Text
                                            size="sm"
                                            style={{
                                              whiteSpace: "pre-wrap",
                                              wordBreak: "break-word",
                                            }}
                                          >
                                            {run.responsePayload ?? "-"}
                                          </Text>
                                        </Table.Td>
                                      </Table.Tr>
                                    ))}
                                  </Table.Tbody>
                                </Table>
                              </Table.ScrollContainer>
                            )}
                            {!runsLoading &&
                              !runsError &&
                              runsTotal != null &&
                              runs.length < runsTotal && (
                                <Button
                                  variant="light"
                                  size="xs"
                                  mt="xs"
                                  loading={runsLoadingMore}
                                  onClick={fetchMoreRuns}
                                >
                                  Load more
                                </Button>
                              )}
                          </Table.Td>
                        </Table.Tr>
                      )}
                    </Fragment>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          <Group justify="space-between" mt="md" wrap="wrap">
            <Text size="sm" c="dimmed">
              Showing {jobs.length} of {totalJobs} jobs
            </Text>
            <Group wrap="wrap" justify="flex-end">
              <Select
                data={["25", "50", "100", "200"]}
                value={String(pageSize)}
                onChange={(value) => {
                  const parsed = Number(value ?? DEFAULT_PAGE_SIZE);
                  setPageSize(Number.isFinite(parsed) ? parsed : DEFAULT_PAGE_SIZE);
                  setPage(1);
                }}
                w={96}
              />
              <Pagination value={page} onChange={setPage} total={totalPages} />
            </Group>
          </Group>
        </>
      )}
      <Modal
        opened={modalOpened}
        onClose={closeModal}
        title={modalMode === "create" ? "New job" : "Edit job"}
        centered
        size="lg"
      >
        {modalMode === "create" && (
          <Select
            mb="sm"
            label="customer"
            placeholder="Select customer"
            data={customerOptions}
            value={modalCustomerId}
            onChange={setModalCustomerId}
            disabled={saving}
            searchable
          />
        )}
        <Group grow align="start">
          <TextInput
            label="name"
            value={modalName}
            onChange={(event) => setModalName(event.currentTarget.value)}
            disabled={saving || modalMode === "edit"}
            readOnly={modalMode === "edit"}
          />
          <TextInput
            label="url"
            value={modalUrl}
            onChange={(event) => setModalUrl(event.currentTarget.value)}
            disabled={saving || deleting}
          />
        </Group>
        <Group mt="sm" grow align="start">
          <Textarea
            label="description_note"
            minRows={3}
            autosize
            value={modalDescriptionNote}
            onChange={(event) => setModalDescriptionNote(event.currentTarget.value)}
            disabled={saving || deleting}
          />
        </Group>
        <Group mt="sm" grow align="start">
          <Select
            label="method"
            data={["GET", "POST", "PUT", "PATCH", "DELETE"]}
            value={modalMethod}
            onChange={(value) => setModalMethod(value ?? "POST")}
            disabled={saving || deleting}
          />
          <NumberInput
            label="max_attempts"
            min={1}
            value={modalErrorAttemptLimit}
            onChange={(value) =>
              setModalErrorAttemptLimit(typeof value === "number" ? value : 1)
            }
            disabled={saving || deleting}
          />
        </Group>
        <Group mt="sm" grow align="start">
          <NumberInput
            label="success_limit"
            value={modalSuccessLimit}
            onChange={(value) =>
              setModalSuccessLimit(typeof value === "number" ? value : 1)
            }
            disabled={saving || deleting}
          />
          <NumberInput
            label="success_retry_delay_seconds"
            min={1}
            value={modalSuccessRetryDelaySeconds}
            onChange={(value) =>
              setModalSuccessRetryDelaySeconds(typeof value === "number" ? value : 30)
            }
            disabled={saving || deleting}
          />
        </Group>
        <Textarea
          mt="sm"
          label="payload"
          minRows={4}
          autosize
          value={modalPayload}
          onChange={(event) => setModalPayload(event.currentTarget.value)}
          disabled={saving || deleting}
        />
        <Textarea
          mt="sm"
          label="headers"
          minRows={4}
          autosize
          value={modalHeaders}
          onChange={(event) => setModalHeaders(event.currentTarget.value)}
          disabled={saving || deleting}
        />
        {saveError && (
          <Alert mt="sm" color="red">
            {saveError}
          </Alert>
        )}
        {modalMode === "edit" && editingJob && (
          <Alert mt="sm" color="gray" title="Read-only info">
            <Text size="sm">id: {editingJob.id}</Text>
            <Text size="sm">customer: {editingJob.customerName}</Text>
            <Text size="sm">status: {editingJob.status}</Text>
            <Text size="sm">attempts: {editingJob.attempts}</Text>
            <Text size="sm">error_attempt_limit: {editingJob.errorAttemptLimit}</Text>
            <Text size="sm">success_count: {editingJob.successCount}</Text>
            <Text size="sm">created_at: {formatDate(editingJob.createdAt)}</Text>
            <Text size="sm">updated_at: {formatDate(editingJob.updatedAt)}</Text>
            <Text size="sm">
              completed_at:{" "}
              {editingJob.completedAt ? formatDate(editingJob.completedAt) : "-"}
            </Text>
            <Text size="sm">last_status: {editingJob.lastStatus ?? "-"}</Text>
            <Text size="sm">last_error: {editingJob.lastError ?? "-"}</Text>
          </Alert>
        )}
        <Group justify="flex-end" mt="md">
          {modalMode === "edit" && editingJob?.status !== "paused" && (
            <Button
              color="gray"
              variant="light"
              onClick={() => void onSetJobStatus("paused")}
              loading={saving}
              disabled={deleting}
              mr="auto"
            >
              Pause job
            </Button>
          )}
          {modalMode === "edit" && editingJob?.status === "paused" && (
            <Button
              color="blue"
              variant="light"
              onClick={() => void onSetJobStatus("pending")}
              loading={saving}
              disabled={deleting}
              mr="auto"
            >
              Restore job
            </Button>
          )}
          {modalMode === "edit" && (
            <Button
              color="red"
              variant="light"
              onClick={() => void onDeleteJob()}
              loading={deleting}
              disabled={saving}
            >
              Delete job
            </Button>
          )}
          <Button variant="default" onClick={closeModal} disabled={saving || deleting}>
            Cancel
          </Button>
          <Button
            onClick={() => void onSaveModal()}
            loading={saving}
            disabled={
              deleting ||
              modalName.trim().length === 0 ||
              modalUrl.trim().length === 0 ||
              (modalMode === "create" && !modalCustomerId)
            }
          >
            {modalMode === "create" ? "Create" : "Save"}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
