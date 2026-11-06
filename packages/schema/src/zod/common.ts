// Shared zod primitives. Amounts are decimal strings (never JSON numbers); addresses are 0x + 40 hex.
import { z } from "zod";
import { VENUE_IDS } from "../adapter";
import { CANONICAL_CLASSES } from "../core";

export const AddressZ = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x address");
export const HexZ = z.string().regex(/^0x[0-9a-fA-F]*$/, "expected 0x hex");
export const SigZ = z.string().regex(/^0x[0-9a-fA-F]{130}$/, "expected a 65-byte 0x signature");
export const DecimalZ = z.string().regex(/^-?\d{1,40}(\.\d{1,36})?$/, "expected a decimal string");
export const PositiveDecimalZ = z
  .string()
  .regex(/^\d{1,40}(\.\d{1,36})?$/, "expected a positive decimal string")
  .refine((s) => /[1-9]/.test(s), "must be greater than zero");
export const VenueZ = z.enum(VENUE_IDS);
export const CanonicalAssetZ = z.string().regex(new RegExp(`^(${CANONICAL_CLASSES.join("|")}):[A-Za-z0-9._-]{1,40}$`), "expected a canonical asset such as CR:BTC");
export const MarketIdZ = z.string().min(5).max(120).regex(/^[a-z0-9-]+:[^\s]+:[^\s]+$/, "expected venue:dex:symbol");
export const UlidZ = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "expected a ulid");
export const SideZ = z.enum(["buy", "sell"]);
export const ModeZ = z.enum(["relay", "direct"]);
export const IsoTimeZ = z.string().datetime({ offset: true });
export const CsvVenuesZ = z
  .string()
  .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
  .pipe(z.array(VenueZ));
