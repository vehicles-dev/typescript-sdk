import { describe, expect, it } from "vitest";

import { Vehicles } from "../src/index.js";
import { API_KEY, REPORT_ID, VIN, successfulFetch } from "./helpers.js";

describe("operation mapping", () => {
  it("maps every API operation to its method and escaped path", async () => {
    const stub = successfulFetch({});
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await client.decodeVin(` ${VIN.toLowerCase()} `);
    await client.getSpecifications(VIN);
    await client.getRecalls(VIN);
    await client.getPhotos("ab/c");
    await client.searchListings();
    await client.getMarketValue({ make: "Toyota", model: "Camry", year: 2021 });
    await client.getDepreciation({ make: "Toyota", model: "Camry" });
    await client.getOwnershipCosts({ make: "Toyota", model: "Camry", year: 2021 });
    await client.historyReports.create({
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      vin: VIN
    });
    await client.historyReports.retrySubmission(REPORT_ID);
    await client.historyReports.getStatus(REPORT_ID);
    await client.historyReports.getResult(REPORT_ID);

    expect(stub.calls.map(({ init, url }) => [init?.method, new URL(url).pathname])).toEqual([
      ["GET", `/v1/vehicles/vin/${VIN}`],
      ["GET", `/v1/vehicles/specifications/${VIN}`],
      ["GET", `/v1/vehicles/recalls/${VIN}`],
      ["GET", "/v1/vehicles/photos/AB%2FC"],
      ["GET", "/v1/vehicles/listings"],
      ["GET", "/v1/vehicles/market-value"],
      ["GET", "/v1/vehicles/depreciation"],
      ["GET", "/v1/vehicles/ownership-costs"],
      ["POST", "/v1/vehicles/history-reports"],
      ["POST", `/v1/vehicles/history-reports/${REPORT_ID}/retry`],
      ["GET", `/v1/vehicles/history-reports/${REPORT_ID}`],
      ["GET", `/v1/vehicles/history-reports/${REPORT_ID}/result`]
    ]);
  });

  it("serializes camelCase market-value arguments and omits absent values", async () => {
    const stub = successfulFetch({});
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await client.getMarketValue({
      baseMsrp: 32_000,
      bodyStyle: "sedan",
      make: "Toyota",
      miles: 42_000,
      model: "Camry",
      state: "TX",
      year: 2021
    });

    const url = new URL(stub.calls[0]?.url ?? "");
    expect([...url.searchParams.entries()]).toEqual([
      ["base_msrp", "32000"],
      ["body_style", "sedan"],
      ["make", "Toyota"],
      ["miles", "42000"],
      ["model", "Camry"],
      ["state", "TX"],
      ["year", "2021"]
    ]);
    expect(url.search).not.toContain("undefined");
  });

  it("serializes listing booleans and numeric boundaries without dropping false or zero", async () => {
    const stub = successfulFetch({});
    const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

    await client.searchListings({
      active: true,
      limit: 25,
      mileageMax: 0,
      minQuality: 0.5,
      offset: 0,
      sold: false,
      sort: "daysOnMarket",
      validVin: false,
      yearMax: 2025,
      yearMin: 2020
    });

    expect(Object.fromEntries(new URL(stub.calls[0]?.url ?? "").searchParams)).toEqual({
      active: "true",
      limit: "25",
      mileage_max: "0",
      min_quality: "0.5",
      offset: "0",
      sold: "false",
      sort: "days_on_market",
      valid_vin: "false",
      year_max: "2025",
      year_min: "2020"
    });
  });

  it.each(["", " ", "x".repeat(33)])(
    "rejects an invalid immediate-response VIN %j locally",
    (vin) => {
      const stub = successfulFetch({});
      const client = new Vehicles({ apiKey: API_KEY, fetch: stub.fetch });

      expect(() => client.decodeVin(vin)).toThrow(/VIN must contain between 1 and 32 characters/u);
      expect(stub.calls).toHaveLength(0);
    }
  );
});
