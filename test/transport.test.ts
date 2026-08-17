import { describe, expect, it, vi } from "vitest";

import { Vehicles, VehiclesError } from "../src/index.js";
import {
  API_KEY,
  IDEMPOTENCY_KEY,
  VIN,
  fetchSequence,
  jsonResponse,
  problemResponse,
  successfulFetch
} from "./helpers.js";

describe("client configuration", () => {
  it.each([undefined, "", "   "])("rejects a missing or blank API key", (apiKey) => {
    expect(() => new Vehicles({ apiKey } as never)).toThrow(/nonblank apiKey/u);
  });

  it("accepts only absolute HTTP(S) base URLs and removes trailing slashes", async () => {
    expect(() => new Vehicles({ apiKey: API_KEY, baseUrl: "api.vehicles.dev" })).toThrow(
      /absolute HTTP\(S\) URL/u
    );
    expect(() => new Vehicles({ apiKey: API_KEY, baseUrl: "ftp://api.vehicles.dev" })).toThrow(
      /absolute HTTP\(S\) URL/u
    );
    const stub = successfulFetch();
    const client = new Vehicles({
      apiKey: API_KEY,
      baseUrl: "http://localhost:3001/staging///",
      fetch: stub.fetch
    });

    await client.decodeVin(VIN);

    expect(stub.calls[0]?.url).toBe(`http://localhost:3001/staging/v1/vehicles/vin/${VIN}`);
  });

  it.each([
    "http://api.vehicles.dev",
    "http://example.com:3000",
    "http://10.0.0.1",
    "http://127.example.com",
    "http://[::2]"
  ])("rejects plaintext HTTP for a non-loopback base URL: %s", (baseUrl) => {
    expect(() => new Vehicles({ apiKey: API_KEY, baseUrl })).toThrow(
      /HTTPS unless it targets a loopback host/u
    );
  });

  it.each([
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://127.42.0.9:3001",
    "http://[::1]:3001"
  ])("allows plaintext HTTP for explicit local development on %s", async (baseUrl) => {
    const stub = successfulFetch();
    const client = new Vehicles({ apiKey: API_KEY, baseUrl, fetch: stub.fetch });

    await client.decodeVin(VIN);

    expect(new URL(stub.calls[0]?.url ?? "").protocol).toBe("http:");
  });

  it("allows HTTPS for a non-loopback base URL", async () => {
    const stub = successfulFetch();
    const client = new Vehicles({
      apiKey: API_KEY,
      baseUrl: "https://staging-api.example.com/root/",
      fetch: stub.fetch
    });

    await client.decodeVin(VIN);

    expect(stub.calls[0]?.url).toBe(`https://staging-api.example.com/root/v1/vehicles/vin/${VIN}`);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])("rejects invalid timeout %j", (timeoutMs) => {
    expect(() => new Vehicles({ apiKey: API_KEY, timeoutMs })).toThrow(/positive integer/u);
  });
});

describe("request transport", () => {
  it("sends the server-only headers and never sends Origin or Cookie", async () => {
    const stub = successfulFetch();
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await client.decodeVin(VIN);

    const init = stub.calls[0]?.init;
    const headers = new Headers(init?.headers);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toBe("@vehicles-dev/sdk/0.1.1");
    expect(headers.has("content-type")).toBe(false);
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
  });

  it("adds Content-Type only when it sends a JSON body", async () => {
    const stub = successfulFetch();
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await client.historyReports.create({ idempotencyKey: IDEMPOTENCY_KEY, vin: VIN });
    await client.historyReports.retrySubmission("report/id");

    const create = stub.calls[0]?.init;
    expect(create?.body).toBe(JSON.stringify({ vin: VIN }));
    expect(new Headers(create?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(create?.headers).get("idempotency-key")).toBe(IDEMPOTENCY_KEY);
    const retry = stub.calls[1];
    expect(retry?.url).toContain("/history-reports/report%2Fid/retry");
    expect(retry?.init?.body).toBeUndefined();
    expect(new Headers(retry?.init?.headers).has("content-type")).toBe(false);
  });

  it("applies per-call timeout and signal options without mutating the client defaults", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      signals.push(init?.signal);
      return jsonResponse({});
    });
    const client = new Vehicles({ apiKey: API_KEY, fetch, timeoutMs: 5_000 });
    const controller = new AbortController();

    await client.decodeVin(VIN, { signal: controller.signal, timeoutMs: 50 });
    await client.decodeVin(VIN);

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(controller.signal);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("does not automatically retry a failed metered call", async () => {
    const stub = successfulFetch({
      code: "upstream_unavailable",
      detail: "Try later",
      retryable: true
    });
    stub.fetch.mockResolvedValueOnce(
      problemResponse(
        {
          code: "upstream_unavailable",
          detail: "Try later",
          request_id: "req-once",
          retryable: true,
          status: 503,
          title: "Service Unavailable",
          type: "https://api.vehicles.dev/problems/upstream-unavailable"
        },
        { status: 503 }
      )
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await expect(client.decodeVin(VIN)).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(stub.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("RFC 9457 errors", () => {
  it("maps the complete problem document, Retry-After, and body request id", async () => {
    const stub = fetchSequence(
      problemResponse(
        {
          code: "request_validation_failed",
          detail: "The request did not match the contract.",
          invalid_params: [{ name: "minimum", pointer: "/year", reason: "must be at least 1900" }],
          request_id: "body-request-id",
          retryable: false,
          status: 400,
          title: "Bad Request",
          type: "https://api.vehicles.dev/problems/request-validation-failed"
        },
        {
          headers: { "retry-after": "7", "x-request-id": "header-request-id" },
          status: 400
        }
      )
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    const error = await client
      .getMarketValue({ make: "Toyota", model: "Camry", year: 1800 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VehiclesError);
    expect(error).toMatchObject({
      code: "request_validation_failed",
      detail: "The request did not match the contract.",
      invalidParams: [{ name: "minimum", pointer: "/year", reason: "must be at least 1900" }],
      requestId: "body-request-id",
      retryAfterSeconds: 7,
      retryable: false,
      status: 400,
      type: "https://api.vehicles.dev/problems/request-validation-failed"
    });
  });

  it("falls back to the response request-id header and safe defaults", async () => {
    const stub = fetchSequence(
      problemResponse(
        { detail: "Unexpected failure" },
        { headers: { "x-request-id": "header-request-id" }, status: 502 }
      )
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await expect(client.decodeVin(VIN)).rejects.toMatchObject({
      code: "unexpected_response",
      requestId: "header-request-id",
      retryable: true,
      status: 502
    });
  });

  it("redacts the API key from every emitted error string", async () => {
    const stub = fetchSequence(
      problemResponse(
        {
          code: `bad-${API_KEY}`,
          detail: `credential ${API_KEY} failed`,
          invalid_params: [
            { name: API_KEY, pointer: `/${API_KEY}`, reason: `contains ${API_KEY}` }
          ],
          request_id: `req-${API_KEY}`,
          retryable: false,
          status: 401,
          title: `bad ${API_KEY}`,
          type: `https://example.test/${API_KEY}`
        },
        { status: 401 }
      )
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    const error = await client.decodeVin(VIN).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VehiclesError);
    expect(String(error)).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    expect(String(error)).toContain("[redacted]");
  });

  it("maps an unreadable response body", async () => {
    const response = new Response(null, {
      headers: { "x-request-id": "req-unreadable" },
      status: 502
    });
    Object.defineProperty(response, "text", {
      value: async () => Promise.reject(new Error("stream broke"))
    });
    const stub = fetchSequence(response);
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await expect(client.decodeVin(VIN)).rejects.toMatchObject({
      code: "response_unreadable",
      requestId: "req-unreadable",
      retryable: true,
      status: 502
    });
  });

  it("rejects a successful response with invalid JSON", async () => {
    const stub = fetchSequence(
      new Response("not json", { headers: { "x-request-id": "req-invalid" }, status: 200 })
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await expect(client.decodeVin(VIN)).rejects.toMatchObject({
      code: "invalid_response_body",
      requestId: "req-invalid",
      retryable: false,
      status: 200
    });
  });
});

describe("transport failures", () => {
  it("maps a request deadline to request_timeout", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true
          });
        })
    );
    const client = new Vehicles({ apiKey: API_KEY, fetch });

    await expect(client.decodeVin(VIN, { timeoutMs: 5 })).rejects.toMatchObject({
      code: "request_timeout",
      retryable: true,
      status: null
    });
  });

  it("maps a network error and redacts a credential echoed by the runtime", async () => {
    const stub = fetchSequence(new TypeError(`fetch failed for ${API_KEY}`));
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    const error = await client.decodeVin(VIN).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "network_unreachable", retryable: true, status: null });
    expect(String(error)).not.toContain(API_KEY);
    expect(String(error)).toContain("[redacted]");
  });
});
