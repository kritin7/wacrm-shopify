// One-off CLI: encrypt a single raw string with the app's AES-256-GCM
// helper and print the result. For manually provisioning rows in
// tables that store an encrypted secret (e.g. `shopify_stores.webhook_secret`)
// via the Supabase SQL editor, where there's no insert API yet.
//
// Usage:
//   node --env-file=.env.local scripts/encrypt-once.ts '<raw secret>'
//
// Prints the `iv:ciphertext:authTag` hex string to stdout — nothing
// else is touched, nothing is written to the database.

import { encrypt } from '../src/lib/whatsapp/encryption.ts'

const raw = process.argv[2]

if (!raw) {
  console.error('Usage: node --env-file=.env.local scripts/encrypt-once.ts <raw-string>')
  process.exit(1)
}

console.log(encrypt(raw))
