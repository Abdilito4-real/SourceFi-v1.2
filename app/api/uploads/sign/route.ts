// app/api/uploads/sign/route.ts
//
// The only thing this route does is compute a short-lived Cloudinary
// upload signature — the actual file bytes never touch this server.
// "No secrets in client code" (CLAUDE.md) means the browser can't hold
// CLOUDINARY_API_SECRET itself; instead it asks this route to sign one
// specific upload (a folder + timestamp), then POSTs the file straight
// to Cloudinary's REST endpoint using that signature. See
// lib/uploadClient.ts for the client half of this handshake.
import { v2 as cloudinary } from "cloudinary";
import { requireSession } from "../../../../lib/authz";

// Allow-listed server-side, never trust an arbitrary client-supplied
// folder string — that's how someone could smuggle an unrelated upload
// into a folder this app doesn't expect (or worse, an admin-only one, if
// one is ever added later).
const ALLOWED_FOLDERS = ["profile_pictures", "material_listings", "verification_documents"] as const;
type AllowedFolder = (typeof ALLOWED_FOLDERS)[number];

function isAllowedFolder(value: unknown): value is AllowedFolder {
  return typeof value === "string" && (ALLOWED_FOLDERS as readonly string[]).includes(value);
}

export async function POST(request: Request) {
  const auth = await requireSession();
  if (!auth) return Response.json({ error: "Not authenticated." }, { status: 401 });

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    return Response.json({ error: "Image uploads aren't configured yet. See .env.local.example." }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  if (!isAllowedFolder(body?.folder)) {
    return Response.json({ error: "Invalid or missing folder." }, { status: 400 });
  }
  const folder = body.folder;

  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });

  const timestamp = Math.floor(Date.now() / 1000);
  // Only these two params are part of what gets signed — the client
  // can't add extra params (e.g. its own `folder`) to the actual upload
  // request that weren't included here, Cloudinary rejects a mismatch
  // between the signed params and what's actually sent.
  const signature = cloudinary.utils.api_sign_request({ folder, timestamp }, apiSecret);

  return Response.json({ signature, timestamp, apiKey, cloudName, folder });
}
