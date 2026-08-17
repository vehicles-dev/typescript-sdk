import { VehiclesError, type VehiclesErrorOptions } from "./errors.js";
import type {
  CreateVehicleHistoryReportParams,
  CreatedVehicleHistoryReport,
  DepreciationParams,
  HistoryReports,
  InvalidParam,
  MarketValueParams,
  OwnershipCostsParams,
  RequestOptions,
  SearchListingsParams,
  VehicleDepreciation,
  VehicleHistoryReport,
  VehicleHistoryReportResult,
  VehicleListings,
  VehicleMarketValue,
  VehicleOwnershipCosts,
  VehiclePhotos,
  VehicleRecalls,
  VehiclesOptions,
  VehicleSpecifications,
  VinDecodeResult,
  WaitForResultOptions
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.vehicles.dev";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;
const USER_AGENT = "@vehicles-dev/sdk/0.1.1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const VIN_PATTERN = /^[A-HJ-NPR-Za-hj-npr-z0-9]{17}$/u;

type QueryValue = boolean | number | string | undefined;

interface TransportRequest {
  readonly body?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: "GET" | "POST";
  readonly options?: RequestOptions | undefined;
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>> | undefined;
  readonly timeoutCapMs?: number | undefined;
}

interface TransportResponse<T> {
  readonly data: T;
  readonly retryAfterSeconds: number | null;
}

type RequestFunction = <T>(request: TransportRequest) => Promise<TransportResponse<T>>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readInvalidParams(problem: Readonly<Record<string, unknown>>): InvalidParam[] {
  const value = problem["invalid_params"];
  if (!Array.isArray(value)) return [];
  const result: InvalidParam[] = [];
  for (const item of value as readonly unknown[]) {
    const record = asRecord(item);
    if (!record) continue;
    const name = readString(record, "name");
    const pointer = readString(record, "pointer");
    const reason = readString(record, "reason");
    if (name !== null && pointer !== null && reason !== null)
      result.push({ name, pointer, reason });
  }
  return result;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^[0-9]+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname)
  );
}

function normalizeBaseUrl(raw: string | undefined): string {
  const value = raw ?? DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("baseUrl must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("baseUrl must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new TypeError("baseUrl must use HTTPS unless it targets a loopback host");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/u, "");
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  const timeoutMs = value ?? fallback;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("timeoutMs must be a positive integer");
  }
  return timeoutMs;
}

function monotonicNow(): number {
  return typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Date.now();
}

function normalizeVin(vin: string): string {
  const trimmed = vin.trim();
  if (!VIN_PATTERN.test(trimmed)) {
    throw new TypeError(
      "VIN must be exactly 17 characters using A-H, J-N, P, R-Z, and 0-9 (I, O, and Q are not allowed)"
    );
  }
  return trimmed.toUpperCase();
}

function normalizeHistoryVin(vin: string): string {
  return vin.trim().toUpperCase();
}

function vinPath(segment: string, vin: string): string {
  return `/v1/vehicles/${segment}/${encodeURIComponent(normalizeVin(vin))}`;
}

function reportPath(id: string, suffix = ""): string {
  return `/v1/vehicles/history-reports/${encodeURIComponent(id)}${suffix}`;
}

function withRetryAfter<T extends { readonly retryAfterSeconds: number }>(
  data: T,
  retryAfterSeconds: number | null
): T {
  if (retryAfterSeconds === null || asRecord(data) === null) return data;
  return { ...data, retryAfterSeconds };
}

function localError(
  code: string,
  detail: string,
  retryable: boolean,
  retryAfterSeconds: number | null = null
): VehiclesError {
  return new VehiclesError({
    code,
    detail,
    requestId: null,
    retryAfterSeconds,
    retryable,
    status: null,
    type: null
  });
}

function reportWaitTimeout(maxWaitMs: number): VehiclesError {
  return localError(
    "report_wait_timeout",
    `The vehicle history report did not complete within ${maxWaitMs} ms.`,
    true
  );
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(localError("request_aborted", "The report wait was aborted.", false));
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(localError("request_aborted", "The report wait was aborted.", false));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Client for the durable, asynchronous vehicle-history report workflow. */
class HistoryReportsClient implements HistoryReports {
  readonly #request: RequestFunction;

  constructor(request: RequestFunction) {
    this.#request = request;
  }

  create(
    params: CreateVehicleHistoryReportParams,
    options?: RequestOptions
  ): Promise<CreatedVehicleHistoryReport> {
    if (!UUID_PATTERN.test(params.idempotencyKey)) {
      throw new TypeError(
        "historyReports.create requires a caller-supplied stable UUID idempotencyKey"
      );
    }
    return this.#request<CreatedVehicleHistoryReport>({
      body: { vin: normalizeHistoryVin(params.vin) },
      headers: { "idempotency-key": params.idempotencyKey },
      method: "POST",
      options,
      path: "/v1/vehicles/history-reports"
    }).then(({ data, retryAfterSeconds }) => withRetryAfter(data, retryAfterSeconds));
  }

  retrySubmission(id: string, options?: RequestOptions): Promise<CreatedVehicleHistoryReport> {
    return this.#request<CreatedVehicleHistoryReport>({
      method: "POST",
      options,
      path: reportPath(id, "/retry")
    }).then(({ data, retryAfterSeconds }) => withRetryAfter(data, retryAfterSeconds));
  }

  getStatus(id: string, options?: RequestOptions): Promise<VehicleHistoryReport> {
    return this.#getStatus(id, options);
  }

  #getStatus(
    id: string,
    options: RequestOptions | undefined,
    timeoutCapMs?: number
  ): Promise<VehicleHistoryReport> {
    return this.#request<VehicleHistoryReport>({
      method: "GET",
      options,
      path: reportPath(id),
      timeoutCapMs
    }).then(({ data, retryAfterSeconds }) => withRetryAfter(data, retryAfterSeconds));
  }

  getResult(id: string, options?: RequestOptions): Promise<VehicleHistoryReportResult> {
    return this.#getResult(id, options);
  }

  #getResult(
    id: string,
    options: RequestOptions | undefined,
    timeoutCapMs?: number
  ): Promise<VehicleHistoryReportResult> {
    return this.#request<VehicleHistoryReportResult>({
      method: "GET",
      options,
      path: reportPath(id, "/result"),
      timeoutCapMs
    }).then(({ data }) => data);
  }

  waitForResult(
    id: string,
    options: WaitForResultOptions = {}
  ): Promise<VehicleHistoryReportResult> {
    const maxWaitMs = normalizeTimeout(options.maxWaitMs, DEFAULT_MAX_WAIT_MS);
    const pollIntervalMs = options.pollIntervalMs;
    if (
      pollIntervalMs !== undefined &&
      (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1)
    ) {
      throw new TypeError("pollIntervalMs must be a positive integer");
    }
    return this.#waitForResult(id, maxWaitMs, pollIntervalMs, options.signal);
  }

  async #waitForResult(
    id: string,
    maxWaitMs: number,
    pollIntervalMs: number | undefined,
    signal: AbortSignal | undefined
  ): Promise<VehicleHistoryReportResult> {
    const startedAt = monotonicNow();
    for (;;) {
      if (signal?.aborted) {
        throw localError("request_aborted", "The report wait was aborted.", false);
      }

      const requestOptions = signal === undefined ? undefined : { signal };
      const report = await this.#requestWithinDeadline(
        (timeoutCapMs) => this.#getStatus(id, requestOptions, timeoutCapMs),
        startedAt,
        maxWaitMs,
        signal
      );
      if (report.status === "action_required") {
        throw localError(
          "report_action_required",
          "The vehicle history report requires manual review before it can continue.",
          false
        );
      }
      if (report.status === "completed") {
        if (!report.hasResult) {
          throw localError(
            "invalid_report_state",
            "The vehicle history report completed without an available result.",
            false
          );
        }
        try {
          return await this.#requestWithinDeadline(
            (timeoutCapMs) => this.#getResult(id, requestOptions, timeoutCapMs),
            startedAt,
            maxWaitMs,
            signal
          );
        } catch (error) {
          if (
            !(error instanceof VehiclesError) ||
            error.status !== 409 ||
            error.code !== "report_not_ready"
          ) {
            throw error;
          }
          const retryAfterMs =
            pollIntervalMs ?? (error.retryAfterSeconds ?? report.retryAfterSeconds) * 1_000;
          await this.#sleepWithinDeadline(retryAfterMs, startedAt, maxWaitMs, signal);
          continue;
        }
      }
      if (
        report.status !== "submitting" &&
        report.status !== "queued" &&
        report.status !== "processing"
      ) {
        throw localError(
          "invalid_report_state",
          "The vehicle history report returned an unknown status.",
          false
        );
      }

      const requestedDelayMs = pollIntervalMs ?? report.retryAfterSeconds * 1_000;
      await this.#sleepWithinDeadline(requestedDelayMs, startedAt, maxWaitMs, signal);
    }
  }

  async #requestWithinDeadline<T>(
    request: (timeoutCapMs: number) => Promise<T>,
    startedAt: number,
    maxWaitMs: number,
    signal: AbortSignal | undefined
  ): Promise<T> {
    const timeoutCapMs = this.#remainingTimeoutMs(startedAt, maxWaitMs);
    try {
      const result = await request(timeoutCapMs);
      if (monotonicNow() - startedAt >= maxWaitMs) throw reportWaitTimeout(maxWaitMs);
      return result;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (monotonicNow() - startedAt >= maxWaitMs) throw reportWaitTimeout(maxWaitMs);
      throw error;
    }
  }

  #remainingTimeoutMs(startedAt: number, maxWaitMs: number): number {
    const remainingMs = maxWaitMs - (monotonicNow() - startedAt);
    if (remainingMs <= 0) throw reportWaitTimeout(maxWaitMs);
    return Math.max(1, Math.ceil(remainingMs));
  }

  async #sleepWithinDeadline(
    requestedDelayMs: number,
    startedAt: number,
    maxWaitMs: number,
    signal: AbortSignal | undefined
  ): Promise<void> {
    const remainingMs = this.#remainingTimeoutMs(startedAt, maxWaitMs);
    await sleep(Math.min(requestedDelayMs, remainingMs), signal);
  }
}

/** Official dependency-free, server-side client for the Vehicles.dev API. */
export class Vehicles {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  readonly historyReports: HistoryReports;

  constructor(options: VehiclesOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new TypeError("Vehicles requires a nonblank apiKey");
    }
    this.#apiKey = options.apiKey.trim();
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.historyReports = new HistoryReportsClient(<T>(request: TransportRequest) =>
      this.#request<T>(request)
    );
  }

  decodeVin(vin: string, options?: RequestOptions): Promise<VinDecodeResult> {
    return this.#get(vinPath("vin", vin), undefined, options);
  }

  getSpecifications(vin: string, options?: RequestOptions): Promise<VehicleSpecifications> {
    return this.#get(vinPath("specifications", vin), undefined, options);
  }

  getRecalls(vin: string, options?: RequestOptions): Promise<VehicleRecalls> {
    return this.#get(vinPath("recalls", vin), undefined, options);
  }

  getPhotos(vin: string, options?: RequestOptions): Promise<VehiclePhotos> {
    return this.#get(vinPath("photos", vin), undefined, options);
  }

  searchListings(
    params: SearchListingsParams = {},
    options?: RequestOptions
  ): Promise<VehicleListings> {
    return this.#get(
      "/v1/vehicles/listings",
      {
        active: params.active,
        condition: params.condition,
        limit: params.limit,
        make: params.make,
        mileage_max: params.mileageMax,
        min_quality: params.minQuality,
        model: params.model,
        offset: params.offset,
        order: params.order,
        price_max: params.priceMax,
        price_min: params.priceMin,
        seller_type: params.sellerType,
        sold: params.sold,
        sort: params.sort === "daysOnMarket" ? "days_on_market" : params.sort,
        source: params.source,
        state: params.state,
        valid_vin: params.validVin,
        year_max: params.yearMax,
        year_min: params.yearMin
      },
      options
    );
  }

  getMarketValue(params: MarketValueParams, options?: RequestOptions): Promise<VehicleMarketValue> {
    return this.#get(
      "/v1/vehicles/market-value",
      {
        base_msrp: params.baseMsrp,
        body_style: params.bodyStyle,
        color: params.color,
        condition: params.condition,
        drivetrain: params.drivetrain,
        fuel: params.fuel,
        make: params.make,
        miles: params.miles,
        model: params.model,
        state: params.state,
        transmission: params.transmission,
        trim: params.trim,
        year: params.year
      },
      options
    );
  }

  getDepreciation(
    params: DepreciationParams,
    options?: RequestOptions
  ): Promise<VehicleDepreciation> {
    return this.#get(
      "/v1/vehicles/depreciation",
      { make: params.make, model: params.model },
      options
    );
  }

  getOwnershipCosts(
    params: OwnershipCostsParams,
    options?: RequestOptions
  ): Promise<VehicleOwnershipCosts> {
    return this.#get(
      "/v1/vehicles/ownership-costs",
      { make: params.make, model: params.model, year: params.year },
      options
    );
  }

  #get<T>(
    path: string,
    query: Readonly<Record<string, QueryValue>> | undefined,
    options: RequestOptions | undefined
  ): Promise<T> {
    return this.#request<T>({ method: "GET", options, path, query }).then(({ data }) => data);
  }

  #request<T>(request: TransportRequest): Promise<TransportResponse<T>> {
    const requestedTimeoutMs = normalizeTimeout(request.options?.timeoutMs, this.#timeoutMs);
    const timeoutMs =
      request.timeoutCapMs === undefined
        ? requestedTimeoutMs
        : Math.min(requestedTimeoutMs, normalizeTimeout(request.timeoutCapMs, requestedTimeoutMs));
    return this.#execute<T>(request, timeoutMs);
  }

  async #execute<T>(request: TransportRequest, timeoutMs: number): Promise<TransportResponse<T>> {
    const url = new URL(`${this.#baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      "user-agent": USER_AGENT,
      ...request.headers
    });
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      headers.set("content-type", "application/json");
    }

    const controller = new AbortController();
    const callerSignal = request.options?.signal;
    let timedOut = false;
    const abortFromCaller = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("The request timed out", "TimeoutError"));
    }, timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          ...(body === undefined ? {} : { body }),
          headers,
          method: request.method,
          redirect: "manual",
          signal: controller.signal
        });
      } catch (error) {
        throw this.#transportError(error, timeoutMs, timedOut, callerSignal?.aborted === true);
      }

      const requestIdHeader = response.headers.get("x-request-id");
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (timedOut || callerSignal?.aborted === true) {
          throw this.#transportError(error, timeoutMs, timedOut, callerSignal?.aborted === true);
        }
        throw this.#error({
          code: "response_unreadable",
          detail: "The response body could not be read.",
          requestId: requestIdHeader,
          retryable: true,
          status: response.status,
          type: null
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        if (response.ok) {
          throw this.#error({
            code: "invalid_response_body",
            detail: `The API returned ${response.status} with a body that is not valid JSON.`,
            requestId: requestIdHeader,
            retryable: false,
            status: response.status,
            type: null
          });
        }
        throw this.#error({
          code: "unexpected_response",
          detail: `The API returned ${response.status} without a valid problem document.`,
          requestId: requestIdHeader,
          retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
          type: null
        });
      }

      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      if (response.ok) return { data: parsed as T, retryAfterSeconds };

      const problem = asRecord(parsed);
      if (problem === null) {
        throw this.#error({
          code: "unexpected_response",
          detail: `The API returned ${response.status} without a valid problem document.`,
          requestId: requestIdHeader,
          retryAfterSeconds,
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
          type: null
        });
      }
      const retryable = problem["retryable"];
      throw this.#error({
        code: readString(problem, "code") ?? "unexpected_response",
        detail:
          readString(problem, "detail") ??
          readString(problem, "title") ??
          "The API returned an error without details.",
        invalidParams: readInvalidParams(problem),
        requestId: readString(problem, "request_id") ?? requestIdHeader,
        retryAfterSeconds,
        retryable:
          typeof retryable === "boolean"
            ? retryable
            : response.status === 429 || response.status >= 500,
        status: response.status,
        type: readString(problem, "type")
      });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  #transportError(
    error: unknown,
    timeoutMs: number,
    timedOut: boolean,
    callerAborted: boolean
  ): VehiclesError {
    const name = error instanceof Error ? error.name : "";
    if (callerAborted && !timedOut) {
      return this.#error({
        code: "request_aborted",
        detail: "The request was aborted by the caller.",
        requestId: null,
        retryable: false,
        status: null,
        type: null
      });
    }
    if (timedOut || name === "TimeoutError" || name === "AbortError") {
      return this.#error({
        code: "request_timeout",
        detail: `The request to ${this.#baseUrl} did not complete within ${timeoutMs} ms.`,
        requestId: null,
        retryable: true,
        status: null,
        type: null
      });
    }
    const reason = error instanceof Error ? error.message : "unknown transport error";
    return this.#error({
      code: "network_unreachable",
      detail: `The request to ${this.#baseUrl} could not be sent: ${reason}.`,
      requestId: null,
      retryable: true,
      status: null,
      type: null
    });
  }

  #error(options: VehiclesErrorOptions): VehiclesError {
    const redact = (value: string): string => value.split(this.#apiKey).join("[redacted]");
    return new VehiclesError({
      code: redact(options.code),
      detail: redact(options.detail),
      invalidParams: (options.invalidParams ?? []).map(({ name, pointer, reason }) => ({
        name: redact(name),
        pointer: redact(pointer),
        reason: redact(reason)
      })),
      requestId:
        options.requestId === null || options.requestId === undefined
          ? null
          : redact(options.requestId),
      retryAfterSeconds: options.retryAfterSeconds ?? null,
      retryable: options.retryable,
      status: options.status ?? null,
      type: options.type === null || options.type === undefined ? null : redact(options.type)
    });
  }
}
