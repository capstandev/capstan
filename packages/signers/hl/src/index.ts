// @capstan/signer-hl: Hyperliquid L1-action and user-signed-action typed data. Pure functions, no network, no key
// storage. The SDK recomputes every digest with this package and refuses to sign on a mismatch.
export * from "./types";
export { actionMsgpack, actionHash, actionHashPreimage, phantomAgentTypedData, phantomSource, l1Digest, lowercaseAction, PHANTOM_DOMAIN, PHANTOM_TYPES, ZERO_ADDRESS } from "./l1";
export {
  userSignedTypedData,
  userSignedDigest,
  userSignedMessage,
  assertMaxFeeRate,
  feeRateToTenthsBp,
  signatureChainIdNumber,
  USER_SIGNED_TYPES,
  USER_SIGNED_DOMAIN_NAME,
  DEFAULT_MAX_FEE_RATE,
  MAX_FEE_RATE_PERPS,
} from "./user";
export { formatPrice, formatSize, allowedPriceDecimals, MAX_SIG_FIGS, PERP_MAX_DECIMALS, type PriceRounding } from "./format";
export { sigToHl, padRs, recoverSigner, signDigest, addressOf } from "./sig";
export { agentNameWithExpiry, parseAgentName, assertNonceWindow, MAX_AGENT_VALIDITY_MS, NONCE_PAST_MS, NONCE_FUTURE_MS } from "./agent";
export { postBody, postedUserAction, isUserAction, type HlExchangeBody } from "./body";
export { hashTypedPayload, encodeType, type TypedField } from "./eip712";
export { checksumAddress, keccakHex, toHex, fromHex } from "./bytes";
