// Funding test helpers: the 30-day settled-funding fixtures (captured read-only by scripts/capture-funding.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FundingFixture {
  name: string;
  marketId: string;
  intervalS: number;
  from: string;
  to: string;
  rows: { ts: string; ratePerHour: string; raw: unknown }[];
}

export const FIXTURES = join(import.meta.dir, "fixtures");

export function fundingFixtures(): FundingFixture[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as FundingFixture);
}
