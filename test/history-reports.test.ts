import { afterEach, describe, expect, it, vi } from "vitest";

import { Vehicles, VehiclesError, type VehicleHistoryReport } from "../src/index.js";
import {
  API_KEY,
  IDEMPOTENCY_KEY,
  REPORT_ID,
  VIN,
  fetchSequence,
  jsonResponse,
  problemResponse,
  successfulFetch
} from "./helpers.js";

const CREATED_AT = "2026-08-16T12:00:00.000Z";

function report(
  status: VehicleHistoryReport["status"],
  overrides: Partial<VehicleHistoryReport> = {}
): VehicleHistoryReport {
  return {
    createdAt: CREATED_AT,
    hasResult: status === "completed",
    id: REPORT_ID,
    retryAfterSeconds: 3,
    status,
    updatedAt: CREATED_AT,
    vin: VIN,
    ...overrides
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("history report orders", () => {
  it("requires the caller to supply a valid stable UUID", () => {
    const stub = successfulFetch();
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    expect(() => client.historyReports.create({ idempotencyKey: "", vin: VIN })).toThrow(
      /stable UUID/u
    );
    expect(() => client.historyReports.create({ idempotencyKey: "not-a-uuid", vin: VIN })).toThrow(
      /stable UUID/u
    );
    expect(stub.calls).toHaveLength(0);
  });

  it("uppercases the VIN but lets the server enforce the history-report VIN contract", async () => {
    const stub = successfulFetch({});
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await client.historyReports.create({ idempotencyKey: IDEMPOTENCY_KEY, vin: " short " });

    expect(stub.calls[0]?.init?.body).toBe(JSON.stringify({ vin: "SHORT" }));
    expect(new Headers(stub.calls[0]?.init?.headers).get("idempotency-key")).toBe(IDEMPOTENCY_KEY);
  });

  it("uses a valid Retry-After response header as the report cadence", async () => {
    const stub = fetchSequence(
      jsonResponse(
        { ...report("queued", { retryAfterSeconds: 30 }), replayed: false },
        { headers: { "retry-after": "7" }, status: 202 }
      )
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await expect(
      client.historyReports.create({ idempotencyKey: IDEMPOTENCY_KEY, vin: VIN })
    ).resolves.toMatchObject({ retryAfterSeconds: 7 });
  });
});

describe("waitForResult", () => {
  it("polls at Retry-After cadence, then reads the completed canonical result", async () => {
    vi.useFakeTimers();
    const stub = fetchSequence(
      jsonResponse(report("processing", { retryAfterSeconds: 30 }), {
        headers: { "retry-after": "3" }
      }),
      jsonResponse(report("completed")),
      jsonResponse({ report: { accidents: [{ severity: "minor" }], vin: VIN } })
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    const result = client.historyReports.waitForResult(REPORT_ID, { maxWaitMs: 10_000 });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(stub.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual({
      report: { accidents: [{ severity: "minor" }], vin: VIN }
    });
    expect(stub.calls.map(({ init, url }) => [init?.method, new URL(url).pathname])).toEqual([
      ["GET", `/v1/vehicles/history-reports/${REPORT_ID}`],
      ["GET", `/v1/vehicles/history-reports/${REPORT_ID}`],
      ["GET", `/v1/vehicles/history-reports/${REPORT_ID}/result`]
    ]);
  });

  it("rejects a zero poll interval before making a request", async () => {
    const stub = successfulFetch(report("queued"));
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    expect(() => client.historyReports.waitForResult(REPORT_ID, { pollIntervalMs: 0 })).toThrow(
      /positive integer/u
    );
    expect(stub.calls).toHaveLength(0);
  });

  it("honors report_not_ready Retry-After and resumes status polling", async () => {
    vi.useFakeTimers();
    const stub = fetchSequence(
      jsonResponse(report("completed")),
      problemResponse(
        {
          code: "report_not_ready",
          detail: "The vehicle history report is still being finalized.",
          request_id: "req-not-ready",
          retryable: true,
          status: 409,
          title: "Conflict",
          type: "https://api.vehicles.dev/problems/report-not-ready"
        },
        { headers: { "retry-after": "2" }, status: 409 }
      ),
      jsonResponse(report("completed")),
      jsonResponse({ report: { vin: VIN } })
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    const outcome = client.historyReports.waitForResult(REPORT_ID, { maxWaitMs: 10_000 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(stub.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(outcome).resolves.toEqual({ report: { vin: VIN } });
    expect(stub.calls.map(({ init, url }) => [init?.method, new URL(url).pathname])).toEqual([
      ["GET", `/v1/vehicles/history-reports/${REPORT_ID}`],
      ["GET", `/v1/vehicles/history-reports/${REPORT_ID}/result`],
      ["GET", `/v1/vehicles/history-reports/${REPORT_ID}`],
      ["GET", `/v1/vehicles/history-reports/${REPORT_ID}/result`]
    ]);
  });

  it("keeps report_not_ready recovery inside the original maxWait deadline", async () => {
    vi.useFakeTimers();
    const stub = fetchSequence(
      jsonResponse(report("completed")),
      problemResponse(
        {
          code: "report_not_ready",
          detail: "The vehicle history report is still being finalized.",
          request_id: "req-not-ready",
          retryable: true,
          status: 409,
          title: "Conflict",
          type: "https://api.vehicles.dev/problems/report-not-ready"
        },
        { headers: { "retry-after": "30" }, status: 409 }
      )
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    const outcome = client.historyReports.waitForResult(REPORT_ID, { maxWaitMs: 1_000 });
    const assertion = expect(outcome).rejects.toMatchObject({
      code: "report_wait_timeout",
      retryable: true,
      status: null
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(stub.calls).toHaveLength(2);
  });

  it("stops on action_required without silently submitting a retry", async () => {
    const stub = fetchSequence(jsonResponse(report("action_required")));
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await expect(client.historyReports.waitForResult(REPORT_ID)).rejects.toMatchObject({
      code: "report_action_required",
      retryable: false,
      status: null
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.init?.method).toBe("GET");
  });

  it("rejects a completed report that claims no canonical result", async () => {
    const stub = fetchSequence(
      jsonResponse(report("completed", { hasResult: false, retryAfterSeconds: 1 }))
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    const error = await client.historyReports
      .waitForResult(REPORT_ID)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VehiclesError);
    expect(error).toMatchObject({ code: "invalid_report_state", retryable: false, status: null });
    expect(stub.calls).toHaveLength(1);
  });

  it("times out locally without making an extra request", async () => {
    vi.useFakeTimers();
    const stub = successfulFetch(report("queued", { retryAfterSeconds: 30 }));
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    const outcome = client.historyReports.waitForResult(REPORT_ID, { maxWaitMs: 1_000 });
    const assertion = expect(outcome).rejects.toMatchObject({
      code: "report_wait_timeout",
      retryable: true,
      status: null
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
    expect(stub.calls).toHaveLength(1);
  });

  it("honors an abort signal while sleeping between polls", async () => {
    vi.useFakeTimers();
    const stub = successfulFetch(report("queued"));
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });
    const controller = new AbortController();

    const outcome = client.historyReports.waitForResult(REPORT_ID, {
      maxWaitMs: 10_000,
      signal: controller.signal
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(outcome).rejects.toMatchObject({
      code: "request_aborted",
      retryable: false,
      status: null
    });
    expect(stub.calls).toHaveLength(1);
  });
});
