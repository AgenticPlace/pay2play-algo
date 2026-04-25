# pay2play-algo

**Per-request ALGO metering on Algorand AVM. Standalone counterpart to [pay2play-arc](https://github.com/AgenticPlace/pay2play-arc).**

x402-shaped HTTP surface, Algorand atomic-group settlement, no Circle dependency. Same `meter()` / `Session` / `UsageSignal` ergonomics as pay2play-arc — vendored agnostic core, Algo-specific defaults.

## Status

`v0.1.0` — `typecheck ✓` standalone build. Live ALGO settlement requires testnet ALGO + a deployed `PaymentMeter` contract.

## Why standalone

This repo does **not** depend on `@pay2play/core` or any other `@pay2play/*` package on npm. Instead, the agnostic types (`UsageSignal`, `PriceRules`, `Session`, `PaymentPayload`) are vendored under `src/core/` from a pinned pay2play-arc commit. To re-sync against a newer pay2play-arc release:

```bash
pnpm sync-core                      # against the pinned commit in scripts/sync-core.sh
pnpm sync-core --pin <commit-sha>   # update to a new pin
pnpm sync-core --check              # diff-only, no overwrite
```

Each vendored file carries a `CORE_SYNCED_AT` header so provenance is visible in PRs.

## Run

```bash
pnpm install
cp .env.example .env                # set ALGO_MNEMONIC + ALGO_APP_ID
pnpm deploy                         # deploys PaymentMeter contract → prints app id
ALGO_APP_ID=<id> pnpm start         # :3010

curl http://localhost:3010/         # service info
curl http://localhost:3010/health   # algod + app probe
curl http://localhost:3010/data     # 402 with x402 challenge

# Sign + submit an Algorand pay txn to the app address (use AlgoKit), then:
curl -H "X-Algo-Payment: <confirmed-tx-id>" http://localhost:3010/data
```

## Architecture

```
┌──────────── src/core (vendored from pay2play-arc) ─────────────┐
│  UsageSignal · PriceRules · Session · Voucher                  │
│  PaymentPayload (CAIP-2 tagged union: EVM | Algorand)          │
│  isEvmPayment / isAlgoPayment / encodeHeader / decodeHeader    │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────▼───────────────┐
              │  src/core/meter.ts           │
              │  Algorand defaults:          │
              │   network: algorand:testnet  │
              │   asset: ALGO                │
              │   scheme: AlgorandAtomicPay  │
              └──────────────┬───────────────┘
                             │
              ┌──────────────▼───────────────┐
              │  src/server.ts               │
              │  Express HTTP w/ CORS        │
              │  402 challenge on /data      │
              │  algod payment verification  │
              │  Replay-protected log        │
              └──────────────────────────────┘
```

## Settlement contrast: Algorand vs Arc

| | pay2play-arc | pay2play-algo |
|---|---|---|
| Chain | Arc Testnet (EVM, chainId 5042002) | Algorand Testnet |
| Asset | USDC (6-decimal ERC-20) | ALGO (6-decimal native) |
| Settlement | EIP-3009 + Circle Gateway batched | Atomic group + ApplicationCall |
| Header | `payment-signature` | `X-Algo-Payment` |
| Auth shape | `EvmPaymentAuth` (sig + auth) | `AlgoPaymentAuth` (sender, txId, appId) |
| Discriminant | `network: eip155:5042002` | `network: algorand:testnet-v1.0` |

Both shapes round-trip through the same `PaymentPayload` discriminated union (vendored from pay2play-arc), and both use the same `Session` voucher buffer for batched flushing.

## Fees, precision, PPMT

See [`docs/fees.md`](./docs/fees.md) for the full fee table, precision
guarantees (bigint atomic units, 0–19 decimals lossless), and PPMT
(Profit-Per-Million-Transactions) projections. To change fees on-chain,
see [`docs/algorand-setprice.md`](./docs/algorand-setprice.md) — the
`PaymentMeter.algo.ts` contract exposes a `setPrice(uint64)` admin method
the creator can call post-deployment.

## Layout

```
pay2play-algo/
├── src/
│   ├── core/             ← vendored from pay2play-arc (don't edit)
│   │   ├── types.ts          (PaymentPayload tagged union)
│   │   ├── session.ts        (Voucher buffer + batched flush)
│   │   ├── decimal.ts        (bigint atomic-unit math)
│   │   ├── fee.ts            (FeeConfig + PriceBreakdown + PPMT)
│   │   └── meter.ts          (OURS — Algo defaults)
│   ├── server.ts         ← Express HTTP gateway w/ 402 + breakdown
│   └── deploy.ts         ← AlgoKit deploy script
├── contracts/
│   └── PaymentMeter.algo.ts   ← AVM contract (algorand-typescript)
├── scripts/
│   └── sync-core.sh      ← pin-and-vendor script
└── tests/
```

## Development

```bash
pnpm install
pnpm typecheck                     # tsc --noEmit
pnpm test                          # vitest run (core round-trip tests)
pnpm sync-core --check             # confirm vendored core matches pin
```

## License

MIT — see [LICENSE](./LICENSE).

---

_Algorand testnet only. The `PaymentMeter.algo.ts` AVM contract uses
`@algorandfoundation/algorand-typescript` (PuyaTs); deploy via
`@algorandfoundation/algokit-utils`._
