# @vehicles-dev/sdk

Official, dependency-free TypeScript SDK for the [vehicles.dev](https://vehicles.dev) API. It uses
the global `fetch` available in Node.js 22 and newer.

> [!WARNING]
> This SDK is server-side only. Never put a vehicles.dev API key in browser code, a public bundle,
> or a `NEXT_PUBLIC_*` variable. The API deliberately rejects browser `Origin` and `Cookie` headers.

## Install

The npm release is not enabled yet. Install the tagged starter directly from GitHub:

```sh
pnpm add "github:vehicles-dev/typescript-sdk#v0.1.1"
```

Once the npm package is published, the install command will be `pnpm add @vehicles-dev/sdk`.

## Quick start

```ts
import { Vehicles } from "@vehicles-dev/sdk";

const vehicles = new Vehicles({
  apiKey: process.env.VEHICLES_API_KEY!
});

const decoded = await vehicles.decodeVin("1HGCM82633A004352");
console.log({
  make: decoded.vehicle["make"],
  model: decoded.vehicle["model"],
  trim: decoded.vehicle["trim"],
  year: decoded.vehicle["year"]
});

const value = await vehicles.getMarketValue({
  make: "Honda",
  miles: 82_000,
  model: "Accord",
  state: "TX",
  year: 2003
});
console.log(value.estimateUsd);
```

The constructor rejects a missing or blank key before making a request. By default it calls
`https://api.vehicles.dev` with a 30-second timeout. Custom remote base URLs must use HTTPS;
plaintext HTTP is accepted only for explicit local development on `localhost`, `127.0.0.0/8`, or
`::1`:

```ts
const vehicles = new Vehicles({
  apiKey: process.env.VEHICLES_API_KEY!,
  baseUrl: "https://staging-api.example.com",
  timeoutMs: 20_000,
  fetch: customFetch // optional test/proxy seam
});
```

Every operation accepts a final request-options argument with `signal` and `timeoutMs`:

```ts
const controller = new AbortController();
const decoded = await vehicles.decodeVin("1HGCM82633A004352", {
  signal: controller.signal,
  timeoutMs: 10_000
});
```

The client sends `Authorization`, `Accept`, and `User-Agent`. It sends `Content-Type` only when a
request has a JSON body, never sends `Origin` or `Cookie`, does not follow redirects automatically,
and does not automatically retry metered operations.

## Operations

Arguments use idiomatic camelCase; the SDK maps them to the API's query names.

| Method                               | API operation                                  |
| ------------------------------------ | ---------------------------------------------- |
| `decodeVin(vin)`                     | `GET /v1/vehicles/vin/{vin}`                   |
| `getSpecifications(vin)`             | `GET /v1/vehicles/specifications/{vin}`        |
| `getRecalls(vin)`                    | `GET /v1/vehicles/recalls/{vin}`               |
| `getPhotos(vin)`                     | `GET /v1/vehicles/photos/{vin}`                |
| `searchListings(params?)`            | `GET /v1/vehicles/listings`                    |
| `getMarketValue(params)`             | `GET /v1/vehicles/market-value`                |
| `getDepreciation(params)`            | `GET /v1/vehicles/depreciation`                |
| `getOwnershipCosts(params)`          | `GET /v1/vehicles/ownership-costs`             |
| `historyReports.create(params)`      | `POST /v1/vehicles/history-reports`            |
| `historyReports.retrySubmission(id)` | `POST /v1/vehicles/history-reports/{id}/retry` |
| `historyReports.getStatus(id)`       | `GET /v1/vehicles/history-reports/{id}`        |
| `historyReports.getResult(id)`       | `GET /v1/vehicles/history-reports/{id}/result` |

VIN path values are trimmed, uppercased, validated, and percent-encoded. Immediate-response data
endpoints require exactly 17 VIN-safe characters matching
`[A-HJ-NPR-Za-hj-npr-z0-9]{17}`; the letters I, O, and Q are not allowed.

### Listings

```ts
const listings = await vehicles.searchListings({
  active: true,
  make: "Ford",
  mileageMax: 80_000,
  priceMax: 35_000,
  sold: false,
  sort: "daysOnMarket",
  yearMin: 2020
});
```

### Depreciation and ownership costs

```ts
const depreciation = await vehicles.getDepreciation({
  make: "Toyota",
  model: "Camry"
});

const ownership = await vehicles.getOwnershipCosts({
  make: "Toyota",
  model: "Camry",
  year: 2024
});
```

## Durable history reports

History reports are asynchronous and separately metered. Generate one UUID for one logical order,
store it with that order, and reuse it if the create response is lost. The SDK requires your UUID and
never silently replaces or generates it.

```ts
import { randomUUID } from "node:crypto";

// Persist this key before sending the request. Reuse it for the same logical order.
const idempotencyKey = randomUUID();
const created = await vehicles.historyReports.create({
  idempotencyKey,
  vin: "1HGCM82633A004352"
});

const result = await vehicles.historyReports.waitForResult(created.id, {
  maxWaitMs: 5 * 60_000,
  signal: AbortSignal.timeout(5 * 60_000)
});
console.log(Object.keys(result.report).sort());
```

History reports can contain private ownership, title, accident, theft, and sale data. Do not log the
raw report, VIN, report ID, or full error object. Persist and display only the fields your application
needs, and keep operational logs to an explicit allowlist.

`waitForResult` polls read-only status at the server's `Retry-After` cadence and fetches the result
only after the report is `completed` with `hasResult: true`. It stops on `action_required`, an invalid
terminal state, cancellation, or timeout. It never calls `retrySubmission`; provider resubmission is
an explicit operation because it can have billing consequences. If result retrieval returns
`409 report_not_ready`, the waiter honors that response's `Retry-After` value and resumes status
polling within the original `maxWaitMs` deadline.

The history-report create route validates its own strict 17-character VIN contract. When a durable
report remains in `submitting`, retry it explicitly by its returned report ID:

```ts
await vehicles.historyReports.retrySubmission(created.id);
```

## Errors

All API, response, and transport failures reject with `VehiclesError`:

```ts
import { VehiclesError } from "@vehicles-dev/sdk";

try {
  await vehicles.getRecalls("1HGCM82633A004352");
} catch (error) {
  if (error instanceof VehiclesError) {
    console.error("vehicles.dev request failed", {
      code: error.code,
      retryable: error.retryable,
      status: error.status
    });
  }
}
```

The error exposes `status`, `code`, `detail`, `type`, `requestId`, `retryable`, `invalidParams`, and
`retryAfterSeconds`. HTTP failures parse the API's RFC 9457 problem document. Timeouts, network
failures, unreadable bodies, and invalid success JSON receive stable local codes. The configured API
key is redacted from every emitted error string. Error details and invalid parameters may still carry
private request context, so do not log a raw `VehiclesError`; select only the operational fields your
logging policy permits.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack --dry-run
pnpm smoke:git-install
```

Tests use injected `fetch` implementations and never call production or make billable requests.

## License

MIT. API access and returned data remain subject to the
[vehicles.dev terms of service](https://vehicles.dev/terms).
