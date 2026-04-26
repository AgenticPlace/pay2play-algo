// CORE_SYNCED_AT: 2026-04-26T00:02Z
// CORE_SOURCE: github.com/AgenticPlace/pay2play @ 7e386939ef9812e1e87b65ec3d461ff0fbc50140
// DO NOT EDIT BY HAND — sync via scripts/sync-core.sh
// x402 v2 shapes — canonical from _refs/coinbase/x402/specs/transports-v2/
// and verified against _refs/arc-nanopayments/lib/x402.ts.

/** x402 payment requirements (one option in `accepts[]`). */
export interface PaymentRequirement {
  scheme: "exact";
  network: string;          // CAIP-2, e.g. "eip155:5042002"
  asset: string;            // ERC-20 contract address
  amount: string;           // atomic units as decimal string
  payTo: string;            // recipient address
  maxTimeoutSeconds: number;
  extra?: {
    name?: string;          // for GatewayWalletBatched: "GatewayWalletBatched"
    version?: string;       // "1" | "2"
    verifyingContract?: string;
    [k: string]: unknown;
  };
}

/** The 402 challenge body — base64-encoded in `PAYMENT-REQUIRED` response header. */
export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: {
    url: string;
    description: string;
    mimeType: string;
  };
  accepts: PaymentRequirement[];
}

/* ─── PaymentPayload — CAIP-2 tagged union ──────────────────────────────────
 *
 * The `network` field discriminates EVM-style EIP-3009 authorizations from
 * non-EVM (e.g. Algorand atomic-group proofs). Existing pay2play-arc
 * consumers can keep using `EvmPaymentPayload` directly — no behavior
 * change. New chains plug in by adding their own variant + type guard.
 *
 * The discriminant defaults to EVM (network omitted ⇒ EVM) so
 * pre-existing serialized payloads round-trip unchanged.
 * ────────────────────────────────────────────────────────────────────────── */

/** EVM EIP-3009 transferWithAuthorization payload. */
export interface EvmPaymentAuth {
  signature: `0x${string}`;
  authorization: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
}

/** Algorand atomic-group proof — references an already-submitted PayTxn. */
export interface AlgoPaymentAuth {
  /** Sender address (58-char base32). */
  sender: string;
  /** Submitted Algorand transaction ID for the payment leg. */
  txId: string;
  /** Optional PaymentMeter ApplicationCall app ID. */
  appId?: number;
  /** Optional atomic group ID this txn belongs to. */
  groupId?: string;
}

interface PaymentPayloadCommon {
  x402Version: 2;
  resource?: PaymentRequired["resource"];
  accepted?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export interface EvmPaymentPayload extends PaymentPayloadCommon {
  /** CAIP-2; omitted defaults to EVM. */
  network?: `eip155:${string}`;
  payload: EvmPaymentAuth;
}

export interface AlgoPaymentPayload extends PaymentPayloadCommon {
  /** CAIP-2; required for non-EVM disambiguation. */
  network: `algorand:${string}`;
  payload: AlgoPaymentAuth;
}

/** The client's signed authorization — base64-encoded in `payment-signature` request header. */
export type PaymentPayload = EvmPaymentPayload | AlgoPaymentPayload;

/** Narrow a PaymentPayload to the EVM variant. */
export function isEvmPayment(p: PaymentPayload): p is EvmPaymentPayload {
  // Treat omitted network as EVM (back-compat with v0.1 payloads).
  return !p.network || p.network.startsWith("eip155:");
}

/** Narrow a PaymentPayload to the Algorand variant. */
export function isAlgoPayment(p: PaymentPayload): p is AlgoPaymentPayload {
  return p.network?.startsWith("algorand:") === true;
}

/** The settlement receipt — base64-encoded in `PAYMENT-RESPONSE` response header. */
export interface SettlementResponse {
  success: boolean;
  transaction?: `0x${string}`;
  network: string;
  payer?: `0x${string}`;
  errorReason?: string;
}

// --- Private pay2play types (not part of x402 spec) ---

/** Private discriminated union — all metering axes funnel into one path. */
export type UsageSignal =
  | { kind: "request" }
  | { kind: "tokens";  count: number }
  | { kind: "frames";  count: number; model?: string }
  | { kind: "bytes";   count: number }
  | { kind: "rows";    count: number }
  | { kind: "dwell";   elementId?: string; ms: number }
  | { kind: "seconds"; count: number };

export type UsageKind = UsageSignal["kind"];

/** Public price-rule shape — string or function per axis. */
export type PriceRule<K extends UsageKind> =
  | string                                    // fixed, e.g. "$0.001"
  | ((signal: Extract<UsageSignal, { kind: K }>) => string);

export interface PriceRules {
  request?: PriceRule<"request">;
  tokens?:  PriceRule<"tokens">;
  frames?:  PriceRule<"frames">;
  bytes?:   PriceRule<"bytes">;
  rows?:    PriceRule<"rows">;
  dwell?:   PriceRule<"dwell">;
  seconds?: PriceRule<"seconds">;
}

/** The base64 helpers that match the reference's choice of encoding. */
export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

export function decodeHeader<T = unknown>(b64: string): T {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as T;
}

// ── ERC-8004 Agent Identity ───────────────────────────────────────────────────

/** On-chain ERC-8004 agent identity record. */
export interface AgentIdentity {
  agentId: bigint;
  owner: `0x${string}`;
  metadataURI: string;
  reputationScore?: number;
  registrationTx?: `0x${string}`;
}

// ── ERC-8183 Job Escrow ───────────────────────────────────────────────────────

/** State machine for an ERC-8183 job. Numeric values match on-chain enum. */
export type JobState = "OPEN" | "FUNDED" | "SUBMITTED" | "COMPLETED" | "DISPUTED";

export const JOB_STATE_MAP: Record<number, JobState> = {
  0: "OPEN",
  1: "FUNDED",
  2: "SUBMITTED",
  3: "COMPLETED",
  4: "DISPUTED",
};

export interface JobInfo {
  jobId: bigint;
  client: `0x${string}`;
  provider: `0x${string}`;
  evaluator: `0x${string}`;
  amount: bigint;
  expiry: bigint;
  state: JobState;
  deliverableHash?: `0x${string}`;
  createTx?: `0x${string}`;
  completeTx?: `0x${string}`;
}

// ── Bridge types ──────────────────────────────────────────────────────────────

export interface BridgeEstimate {
  fee: string;
  feeUsdc: string;
  estimatedTime: string;
  sourceChain: string;
  destinationChain: string;
  amount: string;
}

export interface BridgeResult {
  success: boolean;
  txHash?: string;
  explorerUrl?: string;
  sourceChain: string;
  destinationChain: string;
  amount: string;
  error?: string;
}
