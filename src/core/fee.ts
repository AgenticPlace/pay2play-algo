// CORE_SYNCED_AT: 2026-04-25T18:25Z
// CORE_SOURCE: github.com/AgenticPlace/pay2play-arc @ 7e386939ef9812e1e87b65ec3d461ff0fbc50140
// DO NOT EDIT BY HAND — sync via scripts/sync-core.sh
/**
 * Fee configuration + breakdown + PPMT for pay2play meters.
 *
 * Sits on top of `decimal.ts` — every value here is bigint atomic units at
 * a declared precision. Zero floats. The breakdown surface is what the 402
 * challenge body and the admin endpoint expose to clients and operators.
 *
 * PPMT (Profit Per Million Transactions) is a project coinage: the
 * end-of-month-style projection a merchant uses to size capacity, set
 * margin targets, and compare networks. It's just `netMarginPerTx × 1e6`,
 * but having it as a first-class field makes the math obvious.
 */

import {
  type AtomicUnits,
  applyBps,
  formatDecimal,
  multiplyByCount,
  parseDecimal,
  ppmt as ppmtMul,
  PPMT_MULT,
} from "./decimal.js";

export interface FeeConfig {
  /** Base price per priced unit, in atomic units of `decimals`. */
  basePriceAtomic: AtomicUnits;
  /** Optional facilitator fee in basis points (1 bp = 0.01%). Default 0. */
  facilitatorFeeBps?: number;
  /** Optional gas overhead amortised per priced unit, atomic units. Default 0. */
  gasOverheadAtomic?: AtomicUnits;
  /** Token decimals — informs every `formatDecimal` call. */
  decimals: number;
  /** CAIP-2 network identifier (informational; routing is upstream). */
  network?: string;
  /** Scheme tag for the x402 challenge `extra.name`. */
  schemeName?: string;
  /** Human-friendly currency symbol (e.g. "USDC", "ALGO"). */
  symbol?: string;
}

export interface PriceBreakdown {
  /** Total atomic price the buyer must pay for this transaction. */
  totalAtomic: AtomicUnits;
  /** Same total as a full-precision decimal string ("$0.001000"). */
  totalDisplay: string;
  /** Component breakdown (atomic + display strings each). */
  components: {
    base: { atomic: AtomicUnits; display: string };
    facilitatorFee: { atomic: AtomicUnits; display: string };
    gasOverhead: { atomic: AtomicUnits; display: string };
  };
  /** Net margin retained by the merchant (base − fees − gas). Never negative; clamped to 0. */
  netMarginAtomic: AtomicUnits;
  netMarginDisplay: string;
  /** Projected revenue at 1M transactions worth of net margin. */
  ppmtAtomic: AtomicUnits;
  ppmtDisplay: string;
  /** Effective margin in basis points of `totalAtomic`. -1 if `totalAtomic === 0n`. */
  netMarginBps: number;
  /** Currency / decimals for display. */
  decimals: number;
  symbol?: string;
}

/**
 * Compute a per-transaction price breakdown given a unit price and a count.
 *
 * Order of operations:
 *   1. base = basePriceAtomic × count
 *   2. facilitatorFee = applyBps(base, facilitatorFeeBps ?? 0)
 *   3. gasOverhead = gasOverheadAtomic × count   (amortised, scales with count)
 *   4. netMargin = max(base - facilitatorFee - gasOverhead, 0n)
 *   5. ppmt = netMargin × 1_000_000
 *   6. netMarginBps = floor((netMargin / base) * 10000)  (or -1 if base=0)
 *
 * `count` defaults to 1 — the per-unit case used by 402 challenge generation.
 */
export function priceBreakdown(
  config: FeeConfig,
  count: number | bigint = 1,
): PriceBreakdown {
  const dec = config.decimals;
  const sym = config.symbol;
  const base = multiplyByCount(config.basePriceAtomic, count);
  const facilitatorFee = applyBps(base, config.facilitatorFeeBps ?? 0);
  const gasOverhead = multiplyByCount(config.gasOverheadAtomic ?? 0n, count);

  const subtotal = base - facilitatorFee - gasOverhead;
  const netMargin = subtotal > 0n ? subtotal : 0n;

  const totalAtomic = base; // buyer pays gross; fees come out of merchant net
  const ppmtVal = ppmtMul(netMargin);

  let netMarginBps = -1;
  if (base > 0n) {
    netMarginBps = Number((netMargin * 10_000n) / base);
  }

  return {
    totalAtomic,
    totalDisplay: formatDecimal(totalAtomic, dec),
    components: {
      base:           { atomic: base,           display: formatDecimal(base, dec) },
      facilitatorFee: { atomic: facilitatorFee, display: formatDecimal(facilitatorFee, dec) },
      gasOverhead:    { atomic: gasOverhead,    display: formatDecimal(gasOverhead, dec) },
    },
    netMarginAtomic: netMargin,
    netMarginDisplay: formatDecimal(netMargin, dec),
    ppmtAtomic: ppmtVal,
    ppmtDisplay: formatDecimal(ppmtVal, dec),
    netMarginBps,
    decimals: dec,
    symbol: sym,
  };
}

/**
 * Build a FeeConfig from human-readable strings + optional knobs.
 * `basePrice` is parsed via the bigint engine — rejects more fractional
 * digits than `decimals`.
 *
 * ```ts
 * const arc = feeConfig({ basePrice: "$0.001", decimals: 6, symbol: "USDC",
 *                         facilitatorFeeBps: 30, network: "eip155:5042002" });
 * ```
 */
export interface FeeConfigInput {
  basePrice: string;
  decimals: number;
  facilitatorFeeBps?: number;
  /** Gas overhead expressed as a string, parsed at the same precision as basePrice. */
  gasOverhead?: string;
  network?: string;
  schemeName?: string;
  symbol?: string;
}

export function feeConfig(input: FeeConfigInput): FeeConfig {
  return {
    basePriceAtomic: parseDecimal(input.basePrice, input.decimals),
    facilitatorFeeBps: input.facilitatorFeeBps,
    gasOverheadAtomic: input.gasOverhead
      ? parseDecimal(input.gasOverhead, input.decimals)
      : 0n,
    decimals: input.decimals,
    network: input.network,
    schemeName: input.schemeName,
    symbol: input.symbol,
  };
}

/** Re-export for callers that want PPMT directly without a breakdown. */
export { ppmtMul as ppmt, PPMT_MULT };
