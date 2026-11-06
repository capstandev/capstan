// Key replacement for the kill switch: a ChangePubKey at the SAME index with a fresh key the owner's SDK makes (the
// old key stops working the moment the new one is registered), plus an integrator approval reset (expiry 0, fees 0)
// when one was given. Never a transfer, withdrawal or any other fund movement.
import { ulid } from "@capstan/core";
import { CapstanError, type OnboardingBundle, type OnboardingStep, type VenueIdentity } from "@capstan/schema";
import type { LighterConfig } from "./config";
import { isUsableKeyIndex } from "./keyindex";
import { approveIntegratorTx, changePubKeyMessage, onboardingTemplateHash, type ChangePubKeyVenueTx } from "./onboarding";
import { TX_EXPIRY_MS, TX_TYPE } from "./orders";
import type { LighterReader } from "./read";

export async function buildRevocation(
  id: VenueIdentity,
  ctx: { cfg: Readonly<LighterConfig>; reader: Pick<LighterReader, "nextNonce">; replacementPubKey: string; nowMs: number; integratorAccountIndex?: number | null },
): Promise<OnboardingBundle> {
  const { cfg } = ctx;
  if (id.venue !== cfg.venue) throw new CapstanError("INVALID_INPUT", `a ${id.venue} identity cannot be revoked on ${cfg.venue}`);
  if (id.accountIndex === undefined || id.apiKeyIndex === undefined || !isUsableKeyIndex(id.apiKeyIndex)) throw new CapstanError("INVALID_INPUT", "revocation needs the account index and the usable key index to replace");
  const nonce = await ctx.reader.nextNonce(id.accountIndex, id.apiKeyIndex);
  const expiredAt = ctx.nowMs + TX_EXPIRY_MS;
  const pubKeyHex = `0x${ctx.replacementPubKey.replace(/^0x/i, "").toLowerCase()}`;
  const cpk: ChangePubKeyVenueTx = { txType: TX_TYPE.changePubKey, args: { pubKeyHex, nonce, apiKeyIndex: id.apiKeyIndex, accountIndex: id.accountIndex, expiredAt }, signWith: "new_api_key" };
  const steps: OnboardingStep[] = [{ kind: "revoke_agent", signer: "main_wallet", personalSignText: changePubKeyMessage(pubKeyHex, nonce, id.accountIndex, id.apiKeyIndex), venueTx: cpk }];
  const human = [`Replace the trading key at index ${id.apiKeyIndex} on ${cfg.exchangeName} (account ${id.accountIndex}) with a new key. The old key stops working at once.`];
  if (ctx.integratorAccountIndex) {
    // expiry 0 with all fees 0 removes the approval
    steps.push({ kind: "revoke_builder", signer: "delegated_key", venueTx: approveIntegratorTx(cfg, { integratorAccountIndex: ctx.integratorAccountIndex, approvalExpiryMs: 0, nonce: nonce + 1, apiKeyIndex: id.apiKeyIndex, accountIndex: id.accountIndex, expiredAt }) });
    human.push(`Remove the Capstan integrator tag (account ${ctx.integratorAccountIndex}) from ${cfg.exchangeName}.`);
  }
  return { bundleId: ulid(ctx.nowMs), venue: cfg.venue, owner: id.owner, steps, humanReadable: human, templateHash: onboardingTemplateHash(cfg, steps.map((s) => s.kind)), expiresAt: expiredAt - 5000 };
}
