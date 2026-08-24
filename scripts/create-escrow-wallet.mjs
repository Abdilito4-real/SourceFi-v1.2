// scripts/create-escrow-wallet.mjs
//
// One-off script: creates a real Circle developer-controlled wallet set +
// wallet on Arc Testnet, and prints the two values ESCROW_WALLET_ID /
// NEXT_PUBLIC_ESCROW_WALLET_ADDRESS actually need. Run once. Uses the
// SAME CIRCLE_API_KEY/CIRCLE_ENTITY_SECRET already in .env.local — no new
// credentials needed, this just does what the Circle console's "Create
// developer-controlled wallets" card says ("Code required") instead of
// a manual dashboard step that doesn't exist.
//
// Run from the project root:
//   node --env-file=.env.local scripts/create-escrow-wallet.mjs
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
const entitySecret = process.env.CIRCLE_ENTITY_SECRET;

if (!apiKey || !entitySecret) {
  console.error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET in .env.local. Set both, then re-run.");
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

async function main() {
  console.log("Creating wallet set...");
  const walletSetResponse = await client.createWalletSet({ name: "SourceFi Escrow" });
  const walletSet = walletSetResponse.data?.walletSet;
  if (!walletSet?.id) throw new Error("Wallet set creation failed: no ID returned.");
  console.log("Wallet set ID:", walletSet.id);

  console.log("Creating wallet on ARC-TESTNET...");
  const walletResponse = await client.createWallets({
    walletSetId: walletSet.id,
    blockchains: ["ARC-TESTNET"],
    count: 1,
    accountType: "EOA",
  });

  const wallet = walletResponse.data?.wallets?.[0];
  if (!wallet?.id || !wallet?.address) throw new Error("Wallet creation failed: no id/address returned.");

  console.log("\nDone. Set these in .env.local AND Vercel's Environment Variables:\n");
  console.log(`ESCROW_WALLET_ID=${wallet.id}`);
  console.log(`NEXT_PUBLIC_ESCROW_WALLET_ADDRESS=${wallet.address}`);
  console.log("\nThen fund that address via https://faucet.circle.com (select Arc Testnet, USDC) before testing a release.");
}

main().catch((err) => {
  console.error("Error:", err.response?.data ?? err.message ?? err);
  process.exit(1);
});
