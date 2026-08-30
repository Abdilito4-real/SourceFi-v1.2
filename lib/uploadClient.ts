"use client";

// lib/uploadClient.ts
//
// The browser half of the signed-upload handshake — see
// app/api/uploads/sign/route.ts's own header comment for the server
// half. This file never sees CLOUDINARY_API_SECRET; it only holds the
// signature the sign route already computed, then uploads straight to
// Cloudinary, bypassing this app's own server for the file bytes
// entirely (no multipart handling needed anywhere in this codebase).
export class UploadError extends Error {}

export interface UploadResult {
  secureUrl: string;
  publicId: string;
}

/** Uploads `file` to Cloudinary under `folder` (must be one of the
 * folders app/api/uploads/sign/route.ts allow-lists). Throws
 * UploadError with a message safe to show the user on any failure —
 * not configured yet, the sign request failed, or Cloudinary itself
 * rejected the file (e.g. not actually an image, hitting the
 * `/image/upload` endpoint specifically is what enforces that). */
export async function uploadImage(file: File, folder: string): Promise<UploadResult> {
  const signRes = await fetch("/api/uploads/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder }),
  });
  if (!signRes.ok) {
    const body = await signRes.json().catch(() => null);
    throw new UploadError(body?.error || "Couldn't start the upload. Try again.");
  }
  const { signature, timestamp, apiKey, cloudName, allowedFormats } = await signRes.json();

  const formData = new FormData();
  formData.append("file", file);
  formData.append("folder", folder);
  formData.append("timestamp", String(timestamp));
  formData.append("api_key", apiKey);
  formData.append("signature", signature);
  // Must exactly match what the server signed (allowed_formats is part
  // of the signed param set, see app/api/uploads/sign/route.ts) — this
  // is what makes Cloudinary itself reject anything outside the raster
  // photo formats server-side, not just a client-side content-type hint
  // that a direct API request could ignore entirely.
  formData.append("allowed_formats", allowedFormats);

  const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    body: formData,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.json().catch(() => null);
    // Cloudinary's error shape is {error: {message}}, distinct from our
    // own routes' {error: string} — surface it the same way either way.
    throw new UploadError(body?.error?.message || "Upload failed. Make sure it's an image and try again.");
  }
  const data = await uploadRes.json();
  return { secureUrl: data.secure_url, publicId: data.public_id };
}
