// Agent policy (spec 7.6): EIP-712 'CapstanAgentPolicy' v1, signed by the MAIN wallet. Types only.
import type { Hex, VenueId } from "./adapter";

export interface AgentPolicy {
  owner: Hex;
  agents: { venue: VenueId; agentRef: string }[];
  maxNotionalPerOrderUsd: string;
  maxGrossNotionalUsd: string;
  maxLeverage: number;
  allowedMarkets: string[] | "*";
  allowedVenues: VenueId[];
  maxOrdersPerDay: number;
  reduceOnlyAfter?: string;
  expiresAt: string;
  nonce: string;
}
