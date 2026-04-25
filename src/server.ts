/**
 * pay2play-algo — per-request ALGO metering on Algorand testnet.
 *
 * Standalone Algorand counterpart to pay2play-arc. Same x402-shaped HTTP
 * surface; settlement uses Algorand atomic-group transactions instead of
 * EIP-3009 + Circle Gateway batching.
 *
 * Endpoints:
 *   GET  /          — service info + app address
 *   GET  /health    — algod reachability + app state probe (free)
 *   GET  /info      — chain config (free)
 *   GET  /stats     — payment stats (free)
 *   GET  /data      — paid (X-Algo-Payment: <confirmed-tx-id>)
 */

import express, { type Request, type Response, type NextFunction } from "express";
import algosdk from "algosdk";
import {
  meter,
  ALGORAND_TESTNET_CAIP2,
  isAlgoPayment,
  feeConfig,
  priceBreakdown,
  ALGO_DECIMALS,
  parseDecimal,
  formatDecimal,
  type AlgoPaymentPayload,
  type Voucher,
} from "./core/index.js";

const PORT = Number(process.env.PORT ?? 3010);
const APP_ID = BigInt(process.env.ALGO_APP_ID ?? "0");
const ALGOD_URL = process.env.ALGOD_SERVER ?? "https://testnet-api.algonode.cloud";
const ALGOD_TOKEN = process.env.ALGOD_TOKEN ?? "";

// Bigint-correct fee config — env-controlled, defaults preserve $0.001 / 1000 µALGO.
const PRICE_USD = process.env.PAY2PLAY_PRICE_USD ?? "0.001";
const FEE_BPS = process.env.PAY2PLAY_FEE_BPS
  ? Number(process.env.PAY2PLAY_FEE_BPS)
  : undefined;
const GAS_OVERHEAD_USD = process.env.PAY2PLAY_GAS_OVERHEAD_USD;

const algoFeeConfig = feeConfig({
  basePrice: PRICE_USD,
  decimals: ALGO_DECIMALS,
  facilitatorFeeBps: FEE_BPS,
  gasOverhead: GAS_OVERHEAD_USD,
  network: ALGORAND_TESTNET_CAIP2,
  schemeName: "AlgorandAtomicPay",
  symbol: "microALGO",
});
const PRICE_MICRO = algoFeeConfig.basePriceAtomic;

const algod = new algosdk.Algodv2(ALGOD_TOKEN, ALGOD_URL, 443);

/** Serialize a PriceBreakdown for JSON transport (bigints → strings). */
function serializeBreakdown(b: ReturnType<typeof priceBreakdown>) {
  return {
    totalAtomic: b.totalAtomic.toString(),
    totalDisplay: b.totalDisplay,
    components: {
      base: { atomic: b.components.base.atomic.toString(), display: b.components.base.display },
      facilitatorFee: {
        atomic: b.components.facilitatorFee.atomic.toString(),
        display: b.components.facilitatorFee.display,
      },
      gasOverhead: {
        atomic: b.components.gasOverhead.atomic.toString(),
        display: b.components.gasOverhead.display,
      },
    },
    netMarginAtomic: b.netMarginAtomic.toString(),
    netMarginDisplay: b.netMarginDisplay,
    ppmtAtomic: b.ppmtAtomic.toString(),
    ppmtDisplay: b.ppmtDisplay,
    netMarginBps: b.netMarginBps,
    decimals: b.decimals,
    symbol: b.symbol,
  };
}

/** Build the meter once at startup so price() is reusable. */
const m = meter(
  { request: "$" + PRICE_USD },
  {
    appId: APP_ID > 0n ? Number(APP_ID) : undefined,
    appAddress: APP_ID > 0n ? algosdk.getApplicationAddress(APP_ID).toString() : undefined,
  },
);

const app = express();

// CORS that exposes the payment-required header to browser JS.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Algo-Payment, payment-signature");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json());

/** Wrap async handlers so unhandled rejections become 500s, not crashes. */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(`[${req.method} ${req.originalUrl}]`, err);
      if (res.headersSent) return;
      res.status(500).json({ error: "internal", message: err instanceof Error ? err.message : String(err) });
    });
  };
}

/** In-memory log capped to prevent OOM. */
const MAX_PAYMENTS = 1000;
const paymentLog: Array<{ txId: string; sender: string; amount: number; timestamp: number }> = [];

app.get("/", (_req, res) => {
  const appAddr = APP_ID > 0n ? algosdk.getApplicationAddress(APP_ID).toString() : "not deployed";
  res.json({
    service: "pay2play-algo",
    description: "Per-request ALGO metering on Algorand testnet",
    network: ALGORAND_TESTNET_CAIP2,
    appId: APP_ID.toString(),
    appAddr,
    pricePerCall: m.price({ kind: "request" }),
    pricePerCallMicroAlgo: m.priceAtomic({ kind: "request" }).toString(),
    endpoints: [
      "GET /        — service info (free)",
      "GET /health  — algod + app probe (free)",
      "GET /info    — chain config (free)",
      "GET /stats   — payment stats (free)",
      "GET /data    — paid (X-Algo-Payment: <confirmed-tx-id>)",
    ],
  });
});

app.get("/info", (_req, res) => {
  res.json({
    network: ALGORAND_TESTNET_CAIP2,
    algodUrl: ALGOD_URL,
    appId: APP_ID.toString(),
    pricePerCall: m.price({ kind: "request" }),
  });
});

app.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      const status = await algod.status().do();
      // algosdk v3: lastRound is camelCase
      const round = (status as { lastRound?: bigint }).lastRound ?? 0n;
      checks.algod = { ok: true, detail: `lastRound=${round.toString()}` };
    } catch (err) {
      checks.algod = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    if (APP_ID === 0n) {
      checks.app = { ok: false, detail: "ALGO_APP_ID not set — run pnpm deploy" };
    } else {
      try {
        const info = await algod.getApplicationByID(Number(APP_ID)).do();
        checks.app = { ok: Boolean(info.id), detail: `appId=${info.id?.toString() ?? "?"}` };
      } catch (err) {
        checks.app = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }

    const ok = Object.values(checks).every((c) => c.ok);
    res.status(ok ? 200 : 503).json({ ok, checks });
  }),
);

app.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    if (APP_ID === 0n) {
      res.json({ error: "ALGO_APP_ID not set — run pnpm deploy first", paymentLog });
      return;
    }
    const info = await algod.getApplicationByID(Number(APP_ID)).do();
    const gs = (info.params.globalState ?? []) as Array<{ key: Uint8Array; value: { uint: bigint } }>;
    const get = (k: string) => {
      const entry = gs.find((s) => Buffer.from(s.key).toString() === k);
      return entry ? Number(entry.value.uint) : 0;
    };
    res.json({
      appId: APP_ID.toString(),
      pricePerCall: get("pricePerCall"),
      totalReceived: get("totalReceived"),
      callCount: get("callCount"),
      paymentLog: paymentLog.slice(-50),
    });
  }),
);

/** Build a 402 challenge body for the /data resource. */
function makeChallenge(req: Request) {
  const url = `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`;
  const appAddr = APP_ID > 0n ? algosdk.getApplicationAddress(APP_ID).toString() : "<deploy first>";
  return m.challenge({ kind: "request" }, {
    payTo: appAddr,
    resourceUrl: url,
    description: "Algorand atomic-group payment required",
  });
}

app.get(
  "/data",
  asyncHandler(async (req, res) => {
    const txId =
      req.header("X-Algo-Payment") ?? req.header("payment-signature") ?? null;

    if (!txId) {
      // Surface the x402 challenge + a live PriceBreakdown so the buyer-side
      // facilitator and any UI can show the exact cost components for this op.
      const challenge = makeChallenge(req);
      const breakdown = priceBreakdown(algoFeeConfig);
      const breakdownPerMillion = priceBreakdown(algoFeeConfig, 1_000_000);
      const exampleVoucher: AlgoPaymentPayload = {
        x402Version: 2,
        network: "algorand:testnet-v1.0",
        payload: {
          sender: "<your 58-char base32 sender>",
          txId: "<confirmed Algorand tx id>",
          appId: APP_ID > 0n ? Number(APP_ID) : undefined,
        },
      };
      res.status(402).json({
        ...challenge,
        _example_payload: exampleVoucher,
        breakdown: {
          perTx: serializeBreakdown(breakdown),
          per1M: serializeBreakdown(breakdownPerMillion),
        },
      });
      return;
    }

    if (APP_ID === 0n) {
      res.status(503).json({ error: "ALGO_APP_ID not set — server not configured" });
      return;
    }

    const txInfo = await algod.pendingTransactionInformation(txId).do();
    const confirmed = (txInfo as { confirmedRound?: bigint }).confirmedRound;

    if (!confirmed) {
      res.status(402).json({ error: "Transaction not yet confirmed", txId });
      return;
    }

    const appAddr = algosdk.getApplicationAddress(APP_ID).toString();
    const rawTxn = (txInfo as { txn?: { txn?: { rcv?: unknown; amt?: bigint; snd?: unknown } } }).txn?.txn;
    const receiver = rawTxn?.rcv ? algosdk.encodeAddress(rawTxn.rcv as Uint8Array) : "";
    const amount = rawTxn?.amt ?? 0n;
    const sender = rawTxn?.snd ? algosdk.encodeAddress(rawTxn.snd as Uint8Array) : "unknown";

    if (receiver !== appAddr) {
      res.status(402).json({ error: "Payment must be sent to app address", expected: appAddr, got: receiver });
      return;
    }
    if (BigInt(amount) < PRICE_MICRO) {
      res.status(402).json({ error: "Insufficient payment", required: Number(PRICE_MICRO), got: Number(amount) });
      return;
    }
    if (paymentLog.some((p) => p.txId === txId)) {
      res.status(402).json({ error: "Payment already used", txId });
      return;
    }

    paymentLog.push({ txId, sender, amount: Number(amount), timestamp: Date.now() });
    if (paymentLog.length > MAX_PAYMENTS) paymentLog.shift();

    res.json({
      data: { weather: "sunny", temperature: 72, forecast: "clear skies" },
      payment: { txId, sender, amount: Number(amount), confirmedRound: confirmed.toString() },
      // Demonstrates the union: same Voucher type wraps the AlgoPaymentPayload.
      voucher: {
        id: `vc-${txId.slice(0, 8)}`,
        signal: { kind: "request" },
        payload: {
          x402Version: 2,
          network: "algorand:testnet-v1.0",
          payload: { sender, txId, appId: Number(APP_ID) },
        },
        signedAt: Date.now(),
      } satisfies Voucher,
      _typeguardCheck: isAlgoPayment({
        x402Version: 2,
        network: "algorand:testnet-v1.0",
        payload: { sender, txId, appId: Number(APP_ID) },
      }),
    });
  }),
);

app.listen(PORT, () => {
  console.log(`[pay2play-algo] listening on :${PORT}`);
  console.log(`[pay2play-algo] app id: ${APP_ID.toString() || "not set (run pnpm deploy)"}`);
  console.log(`[pay2play-algo] price:  ${m.price({ kind: "request" })} (${PRICE_MICRO} microALGO)`);
  console.log(`[pay2play-algo] algod:  ${ALGOD_URL}`);
  console.log(`[pay2play-algo] try:    curl http://localhost:${PORT}/health`);
});
