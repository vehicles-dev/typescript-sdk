/** An API payload whose fields intentionally remain open for forwards compatibility. */
export type JsonObject = Record<string, unknown>;

/** Options accepted by every individual HTTP operation. */
export interface RequestOptions {
  /** Cancels this call. */
  readonly signal?: AbortSignal;
  /** Overrides the client's request timeout for this call, in milliseconds. */
  readonly timeoutMs?: number;
}

/** Client construction options. This SDK is intended for server-side runtimes only. */
export interface VehiclesOptions {
  /** Vehicles.dev API key. Keep it in a server-side secret store. */
  readonly apiKey: string;
  /** Absolute HTTP(S) API base URL. Defaults to https://api.vehicles.dev. */
  readonly baseUrl?: string;
  /** Fetch implementation used for requests. Defaults to the Node.js global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Default request timeout in milliseconds. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
}

export interface MarketValueParams {
  readonly baseMsrp?: number;
  readonly bodyStyle?: string;
  readonly color?: string;
  readonly condition?: string;
  readonly drivetrain?: string;
  readonly fuel?: string;
  readonly make: string;
  readonly miles?: number;
  readonly model: string;
  readonly state?: string;
  readonly transmission?: string;
  readonly trim?: string;
  readonly year: number;
}

export type ListingSort = "daysOnMarket" | "miles" | "price" | "year";

export interface SearchListingsParams {
  readonly active?: boolean;
  readonly condition?: string;
  readonly limit?: number;
  readonly make?: string;
  readonly mileageMax?: number;
  readonly minQuality?: number;
  readonly model?: string;
  readonly offset?: number;
  readonly order?: "asc" | "desc";
  readonly priceMax?: number;
  readonly priceMin?: number;
  readonly sellerType?: string;
  readonly sold?: boolean;
  readonly sort?: ListingSort;
  readonly source?: string;
  readonly state?: string;
  readonly validVin?: boolean;
  readonly yearMax?: number;
  readonly yearMin?: number;
}

export interface DepreciationParams {
  readonly make: string;
  readonly model: string;
}

export interface OwnershipCostsParams {
  readonly make: string;
  readonly model: string;
  readonly year: number;
}

export interface CompositeReportParams {
  readonly miles?: number;
  readonly state?: string;
}

export interface VinDecodeResult {
  readonly origin: "store" | "vpic";
  readonly source: "carscrape";
  readonly vehicle: JsonObject;
  readonly vin: string;
}

export interface VehicleSpecifications {
  readonly source: "carscrape";
  readonly specifications: JsonObject;
  readonly vin: string;
}

export interface VehicleRecalls {
  readonly count: number;
  readonly make: string;
  readonly model: string;
  readonly recalls: JsonObject[];
  readonly source: "carscrape";
  readonly vin: string;
  readonly year: number;
}

export interface VehiclePhotos {
  readonly listingSource: string | null;
  readonly listingUrl: string | null;
  readonly photoCount: number | null;
  readonly primaryImage: string;
  readonly source: "carscrape";
  readonly vin: string;
}

export interface VehicleListings {
  readonly count: number;
  readonly limit: number;
  readonly offset: number;
  readonly results: JsonObject[];
  readonly source: "carscrape";
  readonly total: number;
}

export interface VehicleListingHistory {
  readonly currentPrice: number | null;
  readonly currentlyActive: boolean;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly observations: JsonObject[];
  readonly priceChanges: number;
  readonly priceMax: number | null;
  readonly priceMin: number | null;
  readonly source: "carscrape";
  readonly vin: string;
}

export interface VehicleMarketValue {
  readonly currency: string;
  readonly estimateUsd: number;
  readonly inputs: JsonObject;
  readonly medianApePct: number;
  readonly source: "carscrape";
}

export interface VehicleDepreciation {
  readonly annualDecay: number | null;
  readonly byModelYear: JsonObject[];
  readonly curveByAge: JsonObject[] | null;
  readonly make: string;
  readonly model: string;
  readonly source: "carscrape";
}

export interface VehicleOwnershipCosts {
  readonly annualFuelCostUsd: number | null;
  readonly co2GramsPerMile: number | null;
  readonly combinedMpg: number | null;
  readonly config: string | null;
  readonly fiveYearFuelCostUsd: number | null;
  readonly fuelType: string | null;
  readonly make: string;
  readonly model: string;
  readonly note: string;
  readonly source: "carscrape";
  readonly trimsAvailable: number;
  readonly year: number;
}

export interface VehicleCompositeReport {
  readonly coverage: string[];
  readonly depreciation: JsonObject | null;
  readonly generatedAt: string;
  readonly identity: JsonObject;
  readonly marketValue: JsonObject | null;
  readonly origin: "store" | "vpic";
  readonly source: "carscrape";
  readonly vin: string;
}

export type VehicleHistoryReportStatus =
  "submitting" | "queued" | "processing" | "action_required" | "completed";

export interface VehicleHistoryReport {
  readonly createdAt: string;
  readonly hasResult: boolean;
  readonly id: string;
  readonly retryAfterSeconds: number;
  readonly status: VehicleHistoryReportStatus;
  readonly updatedAt: string;
  readonly vin: string;
}

export interface CreatedVehicleHistoryReport extends VehicleHistoryReport {
  readonly replayed: boolean;
}

export interface VehicleHistoryReportResult {
  readonly report: JsonObject;
}

export interface CreateVehicleHistoryReportParams {
  /** A caller-generated UUID that must remain stable across retries of this logical order. */
  readonly idempotencyKey: string;
  readonly vin: string;
}

export interface WaitForResultOptions {
  /** Maximum total polling time. Defaults to 5 minutes. */
  readonly maxWaitMs?: number;
  /** Overrides the server-provided Retry-After cadence. Useful for deterministic tests. */
  readonly pollIntervalMs?: number;
  /** Cancels polling and any in-flight status/result request. */
  readonly signal?: AbortSignal;
}

/** Operations for durable, asynchronous vehicle-history reports. */
export interface HistoryReports {
  create(
    params: CreateVehicleHistoryReportParams,
    options?: RequestOptions
  ): Promise<CreatedVehicleHistoryReport>;
  retrySubmission(id: string, options?: RequestOptions): Promise<CreatedVehicleHistoryReport>;
  getStatus(id: string, options?: RequestOptions): Promise<VehicleHistoryReport>;
  getResult(id: string, options?: RequestOptions): Promise<VehicleHistoryReportResult>;
  waitForResult(id: string, options?: WaitForResultOptions): Promise<VehicleHistoryReportResult>;
}

export interface InvalidParam {
  readonly name: string;
  readonly pointer: string;
  readonly reason: string;
}
