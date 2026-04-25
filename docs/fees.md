# Fees, precision, PPMT — pay2play-algo

This document is the source of truth for the math and economics of pay2play-algo.

- [Precision guarantees](#precision-guarantees)
- [Default fee table](#default-fee-table)
- [Fee breakdown formula](#fee-breakdown-formula)
- [PPMT — Profit Per Million Transactions](#ppmt--profit-per-million-transactions)
- [Worked examples](#worked-examples)
- [How to change fees](#how-to-change-fees)

---

## Precision guarantees

**Zero floating-point arithmetic on money.** Every price, every fee, every
total runs through bigint atomic units. The only place you'll see a `Number`
in the math path is the basis-point integer in `applyBps(amount, bps)`, where
`bps ∈ [0, 10000]`.

Supported precision range:

| Token | Decimals | Atomic unit | Smallest billable amount |
|---|---|---|---|
| Native ALGO | 6 | microALGO | 0.000001 ALGO = 1 µALGO |
| ASA (any) | 0–19 | per-asset | per-asset |

Up to **19 fractional decimals** are supported (the Algorand ASA maximum).
The `parseDecimal` engine **refuses** input with more fractional digits than
the declared precision — no silent truncation:

```ts
parseDecimal("0.0000001", 6)   // throws — 7 fractional digits at 6-decimal precision
parseDecimal("0.000001",  6)   // 1n
parseDecimal("0.000000000000000001", 18) // 1n (1 wei in 18-decimal space)
```

---

## Default fee table

These are the defaults shipped in `src/server.ts` for the `pay2play-algo /data`
demo. Override with env vars (no rebuild needed) — see [How to change fees](#how-to-change-fees).

| Component | Env var | Default | Atomic units | Decimals | Symbol |
|---|---|---|---|---|---|
| Base price per call | `PAY2PLAY_PRICE_USD` | `0.001` | `1000n` | 6 | microALGO |
| Facilitator fee (bps) | `PAY2PLAY_FEE_BPS` | _unset_ (0) | — | — | — |
| Gas overhead per call | `PAY2PLAY_GAS_OVERHEAD_USD` | _unset_ (0) | — | 6 | microALGO |

There is **no facilitator fee** by default on Algorand — atomic group transactions
settle natively without an off-chain batcher. The optional `PAY2PLAY_FEE_BPS`
knob exists for when you front Algorand settlement with a custom facilitator
(rare; mostly meaningful when bridging to/from EVM via Wormhole or similar).

---

## Fee breakdown formula

Every paid response carries a `PriceBreakdown` shaped like this:

```ts
{
  totalAtomic, totalDisplay,
  components: {
    base:           { atomic, display },   // basePriceAtomic × count
    facilitatorFee: { atomic, display },   // applyBps(base, facilitatorFeeBps)
    gasOverhead:    { atomic, display },   // gasOverheadAtomic × count
  },
  netMarginAtomic, netMarginDisplay,        // base − fees − gas (clamped ≥ 0)
  ppmtAtomic, ppmtDisplay,                   // netMargin × 1_000_000
  netMarginBps,                              // floor((netMargin / base) × 10000)
  decimals, symbol,
}
```

Order of operations (all bigint, in this order):

1. **`base = basePriceAtomic × count`** — the buyer's gross obligation.
2. **`facilitatorFee = (base × bps) / 10000`** — floor-rounded; the merchant absorbs the remainder.
3. **`gasOverhead = gasOverheadAtomic × count`** — amortised per priced unit.
4. **`netMargin = max(base − facilitatorFee − gasOverhead, 0)`** — clamped to zero (a loss-making fee config has zero margin, never negative).
5. **`ppmt = netMargin × 1_000_000`** — Profit Per Million Transactions (see below).
6. **`netMarginBps = floor((netMargin / base) × 10000)`** — effective margin in basis points; `-1` if `base = 0`.

Total paid by the buyer is `base` (gross). Fees come out of the merchant's net.

---

## PPMT — Profit Per Million Transactions

**PPMT = `netMarginAtomic × 1_000_000n`**

It's a sizing metric: at the configured fee, how much net revenue does 1M of
**this unit** generate? Use it for capacity planning, margin tier comparisons,
and benchmark vs other settlement networks.

The exact bigint multiplication ensures no rounding drift even at extreme
scale — 1M × any 60-bit integer fits comfortably in a JavaScript bigint.

`ppmtDisplay` formats the result at the token's full precision. At default
1000 µALGO/call with no fees:

```
PPMT = 1000n µALGO × 1_000_000n = 1_000_000_000n µALGO = 1000 ALGO
```

So at $1/ALGO that's $1000 of net revenue per million calls.

---

## Worked examples

### Example 1: Default config, single call

```
basePriceAtomic   = 1_000n µALGO       ($0.001)
facilitatorFeeBps = 0
gasOverheadAtomic = 0n
count             = 1
```

- base           = 1_000n × 1 = 1_000n
- facilitatorFee = (1_000 × 0) / 10000 = 0n
- gasOverhead    = 0n
- **netMargin    = 1_000n** → 0.001 ALGO
- **ppmt         = 1_000n × 1_000_000n = 1_000_000_000n** → 1000 ALGO
- netMarginBps   = (1_000 × 10000) / 1_000 = **10000** (100% — no fees)

### Example 2: 30 bps facilitator + gas

```
basePriceAtomic   = 1_000n
facilitatorFeeBps = 30                   (PAY2PLAY_FEE_BPS=30)
gasOverheadAtomic = 30n                  (PAY2PLAY_GAS_OVERHEAD_USD=0.00003)
count             = 1
```

- base           = 1_000n
- facilitatorFee = (1_000 × 30) / 10000 = **3n**
- gasOverhead    = 30n
- netMargin      = 1_000 − 3 − 30 = **967n** → 0.000967 ALGO
- ppmt           = 967n × 1_000_000 = **967_000_000n** → 967 ALGO
- netMarginBps   = (967 × 10000) / 1_000 = **9670** (96.70%)

### Example 3: 1M-call batch projection

Same config as Example 2 but `count = 1_000_000`:

- base           = 1_000_000_000n → 1000 ALGO
- facilitatorFee = 3_000_000n     → 3 ALGO
- gasOverhead    = 30_000_000n    → 30 ALGO
- netMargin      = 967_000_000n   → 967 ALGO
- ppmt           = 967_000_000n × 1_000_000 = 967_000_000_000_000n
                                  → 967_000_000 ALGO

(PPMT at count=N means "1M repetitions of count=N", so this is "1M batches of
1M calls each" → astronomical. Use the count=1 PPMT for the real
million-tx projection.)

---

## How to change fees

### Option A: env vars (restart required)

Set before starting the server:

```bash
PAY2PLAY_PRICE_USD=0.005          # base price per call, in human ALGO units
PAY2PLAY_FEE_BPS=30               # 0.30% facilitator fee
PAY2PLAY_GAS_OVERHEAD_USD=0.00003 # amortised gas
PORT=3010 ALGO_APP_ID=<id> pnpm start
```

Server logs the effective price on startup:

```
[pay2play-algo] price:  $0.005 (5000 microALGO)
```

### Option B: on-chain `setPrice` (live, requires creator key)

The `PaymentMeter` contract at `contracts/PaymentMeter.algo.ts` exposes a
**`setPrice(uint64)` admin method** that updates the global state's
`pricePerCall` field. Only the contract creator address can invoke it. See
[`docs/algorand-setprice.md`](./algorand-setprice.md) for an AlgoKit walk-through.

```bash
# Pseudocode (use AlgoKit Utils for the actual call):
appCallTxn = makeApplicationCallTxn(creator, APP_ID, "setPrice", [newPriceUint64])
sendAndWait(appCallTxn)
```

After the next round, the contract enforces the new price. The Express server's
local fee config is **unaffected** — the on-chain price gates the AVM execution
path; the server-side bigint math gates the HTTP price-display path.

### Verify your config

```bash
curl http://localhost:3010/data | jq '.breakdown.perTx'
```

Returns the live PriceBreakdown so you can see exactly what your config is doing.
