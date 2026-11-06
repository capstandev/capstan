# Geo database (IP to country)

Capstan maps a caller's IP to a country with the free DB-IP Lite country file. No account is needed.

- Source: `https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.csv.gz` (checked 2026-11-06: HTTP 200, about 4.6 MB,
  published on the 1st of each month). An `.mmdb.gz` form also exists; Capstan uses the CSV so no database reader
  library is needed.
- Licence: Creative Commons Attribution 4.0. The site footer must carry this line:
  "IP geolocation by DB-IP (https://db-ip.com), licensed under CC BY 4.0." (`GEO_ATTRIBUTION` in `@capstan/eligibility`).
- Refresh: the `geo-db-refresh` worker job runs every Monday at 03:30 UTC. It downloads the current month's file once it
  exists (keeps the previous month's file until then), checks that it parses into at least 100,000 IPv4 ranges with
  under 1% malformed rows, records the sha256 in the meta file (the log line shows it shortened, as every log
  line does for long hex), and swaps it in with an atomic rename. A failed refresh keeps the old file
  and raises the `geo.refresh_failed` ops event.
- Location: `$CAPSTAN_GEO_DIR` (default `var/geo`): `dbip-country-lite.csv.gz` and `dbip-country-lite.meta.json`
  (month, sha256, size, range counts). The api reloads the file when its modification time changes.
- First run on a new host: `WORKER_JOBS=geo-db-refresh bun apps/workers/src/index.ts` once, or wait for Monday.
  Until a file exists every write is refused with `GEO_REFUSED` (unknown country fails closed) and reads still work.

## What the lookup does and does not do

- It returns an ISO 3166-1 country code or nothing. Private, reserved and unknown ranges (`ZZ`) return nothing.
- DB-IP Lite has no region data, so the sanctioned regions (Crimea, Donetsk, Luhansk) are refused through the country
  (UA is on the union list). A region source can be added through `GeoLookup.region`.
- The raw IP is never stored. Decision rows keep only the country code (`eligibility_decisions.ip_country`).
- Eligibility is best effort. It is not identity verification and holds no KYC data.
- Behind the TLS front end (Caddy) set `CAPSTAN_TRUST_FORWARDED_FOR=1` so the first `X-Forwarded-For` entry is used. Never set it
  when the api is reachable directly, because that header is then chosen by the caller.
