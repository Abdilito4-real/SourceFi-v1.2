// scripts/register-entity-secret.mjs
//
// One-off script, straight from Circle's own docs (developers.circle.com
// /wallets/dev-controlled/register-entity-secret), adapted to this
// project's .env.local convention. Generates a real 32-byte entity
// secret, registers it with Circle, saves a recovery file, and appends
// CIRCLE_ENTITY_SECRET to .env.local.
//
// IMPORTANT: the ./recovery file this creates is the ONLY way to ever
// reset this entity secret if it's lost. Circle does not store it and
// cannot recover it for you. Back that file up somewhere safe (a
// password manager, encrypted storage) — do not rely on it only
// existing on this one machine.
//
// Run from the project root, after CIRCLE_API_KEY is already set in
// .env.local:
//   node --env-file=.env.local scripts/register-entity-secret.mjs
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const apiKey = process.env.CIRCLE_API_KEY;
if (!apiKey) {
  throw new Error("CIRCLE_API_KEY is required. Set it in .env.local first, then re-run.");
}

// Refuse to overwrite an existing entity secret in .env.local.
const envPath = ".env.local";
const existingEnv = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
if (/^CIRCLE_ENTITY_SECRET=.+$/m.test(existingEnv)) {
  throw new Error("CIRCLE_ENTITY_SECRET already has a value in .env.local. Refusing to overwrite it.");
}

const entitySecret = randomBytes(32).toString("hex");
const recoveryFilePath = "./recovery";
mkdirSync(recoveryFilePath, { recursive: true });

await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: recoveryFilePath });

appendFileSync(envPath, `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);

console.log("Entity secret registered.");
console.log(`Recovery file saved to a new file in: ${recoveryFilePath} — back this up somewhere safe, it's the only way to reset this later.`);
console.log("CIRCLE_ENTITY_SECRET added to .env.local. Copy the same value into Vercel's Environment Variables too.");
