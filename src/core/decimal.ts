// CORE_SYNCED_AT: 2026-04-25T18:25Z
// CORE_SOURCE: github.com/AgenticPlace/pay2play-arc @ 7e386939ef9812e1e87b65ec3d461ff0fbc50140
// DO NOT EDIT BY HAND — sync via scripts/sync-core.sh
/**
 * Precision-correct decimal math for token amounts.
 *
 * Goal: zero floating-point arithmetic on money. Every operation runs in
 * `bigint` against atomic units (smallest indivisible token unit). Lossless
 * for any token decimals in [0, 18] (EVM) or [0, 19] (Algorand ASAs).
 *
 * Why this exists: the v0.1 `parseUsdPrice` used `parseFloat(s) * 1_000_000`
 * + `Math.round`, which silently corrupts prices at sub-cent precision when
 * the price string carries more than 15 significant decimal digits. At
 * 1M-transaction scale that drift becomes real money.
 *
 * Conventions:
 *   - "Atomic units" means the smallest indivisible unit of a token
 *     (USDC has 6 decimals → 1 USDC = 1_000_000n atomic; ETH has 18 → 1 ETH
 *     = 10^18 atomic).
 *   - "Decimals" is the canonical decimal count for the token, mandated by
 *     the token's standard (`decimals()` for ERC-20, asset-config for ASA).
 *   - Display strings always carry full precision — `formatDecimal(1n, 18)`
 *     → "0.000000000000000001". No silent truncation.
 */

export type AtomicUnits = bigint;

/** Maximum decimals we accept. EVM uint256 in atomic units fits up to 78
 *  decimal digits; ASAs go to 19. We cap at 19 to refuse pathological inputs. */
export const MAX_DECIMALS = 19;

const POW10: bigint[] = (() => {
  const arr: bigint[] = [];
  let v = 1n;
  for (let i = 0; i <= MAX_DECIMALS + 1; i++) {
    arr.push(v);
    v *= 10n;
  }
  return arr;
})();

/** Get 10^n as a bigint, cached. */
export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0 || n > MAX_DECIMALS + 1) {
    throw new Error(`pow10: n must be an integer in [0, ${MAX_DECIMALS + 1}]; got ${n}`);
  }
  return POW10[n]!;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(
      `decimals must be an integer in [0, ${MAX_DECIMALS}]; got ${decimals}`,
    );
  }
}

/**
 * Parse a human-readable decimal string into atomic units at the given
 * precision. Strict — refuses input with more fractional digits than `decimals`
 * (no silent truncation). Accepts an optional leading "$" for ergonomics.
 *
 * Examples:
 *   parseDecimal("0.001",   6) === 1000n
 *   parseDecimal("$0.001",  6) === 1000n
 *   parseDecimal("0.000000000000000001", 18) === 1n
 *   parseDecimal("1",       0) === 1n
 *   parseDecimal("0.0000001", 6)  → throws (too many fractional digits)
 */
export function parseDecimal(value: string, decimals: number): AtomicUnits {
  assertDecimals(decimals);
  const raw = value.trim().replace(/^\$/, "");
  if (raw === "" || raw === "-") {
    throw new Error(`parseDecimal: empty value`);
  }

  let negative = false;
  let body = raw;
  if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith("+")) {
    body = body.slice(1);
  }

  if (!/^\d+(\.\d+)?$/.test(body)) {
    throw new Error(`parseDecimal: invalid format ${JSON.stringify(value)}`);
  }

  const [whole, frac = ""] = body.split(".") as [string, string?];
  if (frac.length > decimals) {
    throw new RangeError(
      `parseDecimal: "${value}" has ${frac.length} fractional digits but ` +
      `decimals=${decimals}; would lose precision`,
    );
  }

  const padded = frac + "0".repeat(decimals - frac.length);
  const wholeBig = whole === "" ? 0n : BigInt(whole);
  const fracBig = padded === "" ? 0n : BigInt(padded);
  const result = wholeBig * pow10(decimals) + fracBig;
  return negative ? -result : result;
}

/**
 * Format an atomic-unit bigint into its full-precision decimal string.
 * Trailing zeros in the fractional part are preserved up to `decimals`,
 * then the trailing zeros are trimmed; the decimal point is dropped if the
 * result has no fractional part.
 *
 * Examples:
 *   formatDecimal(1000n, 6) === "0.001"
 *   formatDecimal(1n, 18) === "0.000000000000000001"
 *   formatDecimal(1_000_000n, 6) === "1"
 *   formatDecimal(0n, 6) === "0"
 *   formatDecimal(-1500n, 6) === "-0.0015"
 */
export function formatDecimal(atomic: AtomicUnits, decimals: number): string {
  assertDecimals(decimals);
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  if (decimals === 0) return (negative ? "-" : "") + abs.toString();

  const divisor = pow10(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  const wholeStr = whole.toString();
  const body = fracStr === "" ? wholeStr : `${wholeStr}.${fracStr}`;
  return negative ? `-${body}` : body;
}

/**
 * Multiply an atomic unit-price by a count. Lossless — the count can be a
 * `number` (assumed integer) or a `bigint`. Negative counts are rejected
 * (we don't issue refunds via the meter).
 */
export function multiplyByCount(unit: AtomicUnits, count: number | bigint): AtomicUnits {
  let n: bigint;
  if (typeof count === "number") {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`multiplyByCount: count must be a non-negative integer; got ${count}`);
    }
    n = BigInt(count);
  } else {
    if (count < 0n) throw new RangeError(`multiplyByCount: negative count not allowed`);
    n = count;
  }
  return unit * n;
}

/**
 * Apply a basis-point fee to an atomic amount. 1 bp = 0.01%, 10000 bp = 100%.
 * Floor-rounding (the merchant keeps the remainder).
 *
 * Examples:
 *   applyBps(1_000_000n, 30) === 3_000n   // 0.30% of 1 USDC
 *   applyBps(1_000n, 100)    === 10n      // 1% of 0.001 USDC
 *   applyBps(99n, 100)       === 0n       // floor; merchant absorbs sub-cent
 */
export function applyBps(amount: AtomicUnits, bps: number): AtomicUnits {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError(`applyBps: bps must be an integer in [0, 10000]; got ${bps}`);
  }
  if (amount < 0n) throw new RangeError(`applyBps: negative amount`);
  return (amount * BigInt(bps)) / 10_000n;
}

/**
 * Convert an atomic amount from one decimal precision to another.
 * Lossless when scaling up; refuses to scale down with non-zero remainder
 * (precision would be lost).
 *
 * Examples:
 *   convertDecimals(1_000_000n, 6, 18) === 1_000_000_000_000_000_000n  // 1 USDC → 1 wad
 *   convertDecimals(10_000_000_000_000n, 18, 6) === 10n                // exact
 *   convertDecimals(1n, 18, 6)  → throws (would round 0.000_000_000_001 to 0)
 */
export function convertDecimals(
  amount: AtomicUnits,
  fromDecimals: number,
  toDecimals: number,
): AtomicUnits {
  assertDecimals(fromDecimals);
  assertDecimals(toDecimals);
  if (fromDecimals === toDecimals) return amount;
  if (toDecimals > fromDecimals) {
    return amount * pow10(toDecimals - fromDecimals);
  }
  const divisor = pow10(fromDecimals - toDecimals);
  if (amount % divisor !== 0n) {
    throw new RangeError(
      `convertDecimals: ${amount} cannot be reduced from ${fromDecimals} to ${toDecimals} decimals without precision loss`,
    );
  }
  return amount / divisor;
}

/** Profit-Per-Million-Transactions — exact bigint multiply by 1_000_000. */
export const PPMT_MULT = 1_000_000n;
export function ppmt(perTxAtomic: AtomicUnits): AtomicUnits {
  return perTxAtomic * PPMT_MULT;
}

/** Common decimals constants. */
export const USDC_DECIMALS = 6;
export const ETH_DECIMALS = 18;
export const ALGO_DECIMALS = 6; // microALGO; ASAs override per-asset
