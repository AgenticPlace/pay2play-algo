/**
 * Algorand-flavoured meter. Mirrors the `meter()` API from pay2play-arc
 * but with Algorand-native defaults — no EVM contract addresses, no Circle
 * Gateway, no EIP-3009. Same UsageSignal axes, same PriceRules shape, same
 * onFlush/Session integration on the producer side.
 *
 * The output `PaymentRequirement` carries CAIP-2 `algorand:<network>` and
 * an `extra.appAddress` pointing at the PaymentMeter app — the gateway
 * server uses that to verify the buyer's atomic-group payment.
 */
import type {
  PaymentRequirement,
  PaymentRequired,
  PriceRules,
  UsageKind,
  UsageSignal,
} from "./types.js";

/** Default Algorand testnet network ID (CAIP-2). */
export const ALGORAND_TESTNET_CAIP2 = "algorand:testnet-v1.0";

/** ALGO has 6 decimal places — same as USDC. */
const ALGO_DECIMALS = 6;

/** Parse a USD-style price string ("$0.001") to atomic microALGO units. */
export function parseAlgoPrice(price: string): bigint {
  const m = /^\$?(\d+(?:\.\d+)?)$/.exec(price.trim());
  if (!m || m[1] === undefined) throw new Error(`Invalid price string: ${price}`);
  const parts = m[1].split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  const padded = (frac + "0".repeat(ALGO_DECIMALS)).slice(0, ALGO_DECIMALS);
  return BigInt(whole) * BigInt(10 ** ALGO_DECIMALS) + BigInt(padded);
}

export interface AlgoMeterOptions {
  /** CAIP-2 network ID. Default: Algorand testnet. */
  network?: string;
  /** ApplicationCall app ID for the PaymentMeter. */
  appId?: number;
  /** Resolved app address (32-byte base32). Caller can compute via algosdk.getApplicationAddress(appId). */
  appAddress?: string;
  /** How long a 402 challenge stays valid (seconds). Default: 4 days. */
  maxTimeoutSeconds?: number;
  /** Scheme tag for the x402 challenge. Default: "AlgorandAtomicPay". */
  schemeName?: string;
}

/**
 * Build an Algorand meter. Same producer-side ergonomics as the Arc meter:
 *
 * ```ts
 * const m = meter({ request: "$0.001" }, { appId: 12345, appAddress: "AAAA..." });
 * m.price({ kind: "request" });        // "$0.001"
 * m.priceAtomic({ kind: "request" });  // 1000n  (microALGO)
 * m.requirement({ kind: "request" }, "AAAA...");
 * m.challenge({ kind: "request" }, { payTo: "AAAA...", resourceUrl });
 * ```
 */
export function meter(rules: PriceRules, opts: AlgoMeterOptions = {}) {
  const network = opts.network ?? ALGORAND_TESTNET_CAIP2;
  const appId = opts.appId;
  const appAddress = opts.appAddress;
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? 345_600;
  const schemeName = opts.schemeName ?? "AlgorandAtomicPay";

  function price(signal: UsageSignal): string {
    const rule = rules[signal.kind] as PriceRules[UsageKind] | undefined;
    if (rule === undefined) {
      throw new Error(`No price rule configured for usage kind "${signal.kind}"`);
    }
    if (typeof rule === "string") return rule;
    return (rule as (s: UsageSignal) => string)(signal);
  }

  function priceAtomic(signal: UsageSignal): bigint {
    return parseAlgoPrice(price(signal));
  }

  function requirement(signal: UsageSignal, payTo: string): PaymentRequirement {
    return {
      scheme: "exact",
      network,
      asset: "ALGO",
      amount: priceAtomic(signal).toString(),
      payTo,
      maxTimeoutSeconds,
      extra: {
        name: schemeName,
        version: "1",
        appId,
        appAddress,
      },
    };
  }

  function challenge(
    signal: UsageSignal,
    ctx: { payTo: string; resourceUrl: string; description?: string },
  ): PaymentRequired {
    const p = price(signal);
    return {
      x402Version: 2,
      error: "X-Algo-Payment header is required",
      resource: {
        url: ctx.resourceUrl,
        description: ctx.description ?? `Paid resource (${p} ALGO)`,
        mimeType: "application/json",
      },
      accepts: [requirement(signal, ctx.payTo)],
    };
  }

  return { price, priceAtomic, requirement, challenge };
}

export type AlgoMeter = ReturnType<typeof meter>;
