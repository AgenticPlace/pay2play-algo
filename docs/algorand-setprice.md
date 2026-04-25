# Changing the on-chain price — `PaymentMeter.setPrice`

The `PaymentMeter.algo.ts` contract gates `/data` settlements on the AVM side.
Its `pricePerCall` global-state field is **mutable post-deployment** by the
contract creator. Use this when you want price changes to be enforced at the
chain layer, not just the server-side display layer.

## Method signature

```ts
// contracts/PaymentMeter.algo.ts:56
setPrice(newPrice: uint64): void
```

Guards:

- `this.txn.sender === this.app.creator`  — only the creator address
- `newPrice > 0n`                          — refuses zero (no free path)

Effect: writes `pricePerCall = newPrice` to global state. The next `payAndCall`
transaction will enforce the new price.

## AlgoKit Utils walk-through

```ts
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import algosdk from "algosdk";

// 1. Connect with the creator account
const algorand = AlgorandClient.testNet();
const creator  = algosdk.mnemonicToSecretKey(process.env.ALGO_MNEMONIC!);

// 2. Resolve the deployed PaymentMeter app
const APP_ID = BigInt(process.env.ALGO_APP_ID!);

// 3. Compute the new price in microALGO
//    e.g. raise from $0.001 (1000 µALGO) to $0.005 (5000 µALGO)
const newPriceMicro = 5_000n;

// 4. Encode the ApplicationCall — note the abi-typed args
const result = await algorand.send.appCallMethodCall({
  sender: creator.addr,
  appId:  APP_ID,
  method: new algosdk.ABIMethod({
    name: "setPrice",
    args: [{ name: "newPrice", type: "uint64" }],
    returns: { type: "void" },
  }),
  args: [newPriceMicro],
  signer: algosdk.makeBasicAccountTransactionSigner(creator),
});

console.log("setPrice tx:", result.txIds[0]);
console.log("new pricePerCall:", newPriceMicro.toString());
```

## Verifying the new price

After confirmation:

```bash
# Server reflects on-chain state via /stats
curl http://localhost:3010/stats | jq '.pricePerCall'
# → 5000 (matches your setPrice value)
```

Or directly via algod:

```ts
const info = await algod.getApplicationByID(Number(APP_ID)).do();
const gs = info.params.globalState ?? [];
const price = gs.find(s => Buffer.from(s.key).toString() === "pricePerCall");
console.log("on-chain price:", Number(price.value.uint));
```

## Coordinating server + contract

The Express server has its own fee config (sourced from env vars). For the
two layers to agree, run:

```bash
# 1. Update on-chain price
ALGO_APP_ID=<id> ALGO_MNEMONIC=<words> pnpm tsx scripts/set-price.ts 5000

# 2. Update server config and restart
PAY2PLAY_PRICE_USD=0.005 ALGO_APP_ID=<id> pnpm start
```

If they disagree:

- **Server price > contract price**: server quotes more than the contract
  enforces; buyers underpay relative to the displayed price. Probably a bug.
- **Contract price > server price**: server quotes too little; AVM rejects
  the txn at settlement. Buyers see "Insufficient payment" 402s.

The on-chain price is authoritative — set it first, then bring the server
config in line.

## Withdrawals

The contract also exposes `withdraw(amount: uint64)` for the creator to
sweep accumulated ALGO. Same access guard. Useful when you've accrued enough
balance to justify the gas of a sweep.
