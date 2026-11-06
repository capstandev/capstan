// Webhook registration (owner-signed, SIG-1 purpose webhook_register over the URL and kinds), listing and removal.
// The signing value is derived from the server's alert key and the webhook id, shown to the owner once, and only its
// hash is stored. The URL is guard-checked at registration and again on every delivery.
import { schema, ulid, verifyCapstanMessage, type Db, type NonceStore } from "@capstan/core";
import type { Hex } from "@capstan/schema";
import { createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { ALERT_KINDS, sha256Hex, type AlertKind } from "./dispatch";
import { guardUrl, type Resolver } from "./guard";

export const MAX_WEBHOOKS_PER_OWNER = 5;
export const REMOVED_REASON = "Removed by the owner.";

export class WebhookError extends Error {
  readonly code: "INVALID_INPUT" | "UNAUTHORIZED" | "NOT_FOUND";
  constructor(code: WebhookError["code"], message: string) {
    super(message);
    this.name = "WebhookError";
    this.code = code;
  }
}

/** The signed body for a registration: the URL, a newline, the kinds sorted and comma-joined. */
export const registerBody = (url: string, kinds: AlertKind[]) => `${url}\n${[...new Set(kinds)].sort().join(",")}`;
export const removeBody = (id: string) => `remove ${id}`;

/** Signing value derivation: HMAC-SHA256(server alert key, webhook id). */
export function secretDeriver(alertKey: Uint8Array | string): (webhookId: string) => string {
  return (id) => `whsec_${createHmac("sha256", alertKey).update(`capstan-webhook:${id}`).digest("base64url")}`;
}

export interface RegisterOpts {
  message: string;
  host: string;
  nowMs: number;
  nonces: NonceStore;
  deriveSecret: (webhookId: string) => string;
  resolver?: Resolver;
  id?: () => string;
}

export async function registerWebhook(db: Db, owner: Hex, url: string, kinds: AlertKind[], ownerSig: Hex, o: RegisterOpts): Promise<{ id: string; secret: string }> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new WebhookError("INVALID_INPUT", "owner must be an address");
  if (!Array.isArray(kinds) || !kinds.length || kinds.some((k) => !ALERT_KINDS.includes(k))) throw new WebhookError("INVALID_INPUT", `kinds must be some of ${ALERT_KINDS.join(", ")}`);
  if (typeof url !== "string" || url.length > 500) throw new WebhookError("INVALID_INPUT", "url is too long");
  const v = await verifyCapstanMessage(o.message, ownerSig, { purpose: "webhook_register", signers: [owner], host: o.host, nowMs: o.nowMs, body: registerBody(url, kinds) }, o.nonces);
  if (!v.ok) throw new WebhookError("UNAUTHORIZED", `the registration signature is not valid (${v.reason})`);
  const g = await guardUrl(url, o.resolver);
  if (!g.ok) throw new WebhookError("INVALID_INPUT", `the webhook URL is refused: ${g.reason}`);
  const live = await db.select({ id: schema.webhooks.id }).from(schema.webhooks).where(and(sql`lower(${schema.webhooks.owner}) = ${owner.toLowerCase()}`, eq(schema.webhooks.disabled, false)));
  if (live.length >= MAX_WEBHOOKS_PER_OWNER) throw new WebhookError("INVALID_INPUT", `at most ${MAX_WEBHOOKS_PER_OWNER} webhooks per owner`);
  const id = (o.id ?? (() => ulid(o.nowMs)))();
  const secret = o.deriveSecret(id);
  await db.insert(schema.webhooks).values({ id, owner: owner.toLowerCase(), url, secretHash: sha256Hex(secret), kinds: [...new Set(kinds)].sort(), disabled: false, createdAt: new Date(o.nowMs) });
  return { id, secret };
}

export interface WebhookView {
  id: string;
  url: string;
  kinds: string[];
  disabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  createdAt: string;
}

export async function listWebhooks(db: Db, owner: Hex): Promise<WebhookView[]> {
  const rows = await db.select().from(schema.webhooks).where(sql`lower(${schema.webhooks.owner}) = ${owner.toLowerCase()}`);
  return rows
    .filter((r) => r.disabledReason !== REMOVED_REASON)
    .map((r) => ({ id: r.id, url: r.url, kinds: r.kinds, disabled: r.disabled, disabledReason: r.disabledReason, consecutiveFailures: r.consecutiveFailures, createdAt: r.createdAt.toISOString() }));
}

/** Removal keeps the row (alert_events point at it) but turns it off for good. */
export async function removeWebhook(db: Db, owner: Hex, id: string, ownerSig: Hex, o: Omit<RegisterOpts, "deriveSecret" | "resolver" | "id">): Promise<void> {
  const v = await verifyCapstanMessage(o.message, ownerSig, { purpose: "webhook_register", signers: [owner], host: o.host, nowMs: o.nowMs, body: removeBody(id) }, o.nonces);
  if (!v.ok) throw new WebhookError("UNAUTHORIZED", `the removal signature is not valid (${v.reason})`);
  const r = await db.update(schema.webhooks).set({ disabled: true, disabledReason: REMOVED_REASON }).where(and(eq(schema.webhooks.id, id), sql`lower(${schema.webhooks.owner}) = ${owner.toLowerCase()}`)).returning({ id: schema.webhooks.id });
  if (!r.length) throw new WebhookError("NOT_FOUND", "unknown webhook");
}
