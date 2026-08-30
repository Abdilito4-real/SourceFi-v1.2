// lib/uploadValidation.ts
//
// Replaces lib/safeUrl.ts's isSafeHttpUrl for the three fields that must
// go through the real upload flow (app/api/uploads/sign +
// lib/uploadClient.ts), not just "any https URL" — otherwise "you must
// upload an image" is only a UI suggestion; a client can always send a
// raw API request with an arbitrary imageUrl string, so the server has
// to actually reject anything that isn't a real result from THIS
// account's Cloudinary uploads.
import { isSafeHttpUrl } from "./safeUrl";

const CLOUDINARY_HOST = "res.cloudinary.com";

/** True only for a Cloudinary-hosted URL under this app's own cloud
 * name — not just any res.cloudinary.com URL (that would accept an
 * image uploaded to someone else's unrelated Cloudinary account,
 * bypassing this app's own upload flow, folder allow-list, and
 * image-only enforcement at app/api/uploads/sign/route.ts). Returns
 * false (not throws) if CLOUDINARY_CLOUD_NAME isn't set — nothing can
 * be a legitimate result of this app's own upload flow yet. */
export function isCloudinaryUrl(value: string): boolean {
  if (!isSafeHttpUrl(value)) return false;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return false;
  try {
    const parsed = new URL(value);
    return parsed.hostname === CLOUDINARY_HOST && parsed.pathname.startsWith(`/${cloudName}/`);
  } catch {
    return false;
  }
}
