"use client";

// components/ui/ImageUploadField.tsx
//
// Real file upload, replacing the URL-paste text inputs every image
// field in this app used before (profile picture, material listing
// photo, supplier verification's supporting document — see
// lib/uploadClient.ts / app/api/uploads/sign/route.ts for the signed-
// upload handshake this calls). Two distinct inputs, not one, to match
// a reference capture-UI: a circular camera button (capture="environment"
// — opens the device's own camera directly on mobile, no custom camera
// UI needed) as the primary action, plus a smaller "Upload photo" text
// link (no `capture`, opens the normal gallery/file picker) as the
// secondary one — same distinction the reference mockup drew between
// its camera-icon button and its "upload photo" link under it.
import React, { useRef, useState } from "react";
import { Camera, ImageIcon, Loader2, X } from "lucide-react";
import { Label, HelperText, ErrorText } from "./Field";
import { uploadImage, UploadError } from "../../lib/uploadClient";

export interface ImageUploadFieldProps {
  label: string;
  /** One of app/api/uploads/sign/route.ts's allow-listed folders. */
  folder: string;
  /** The uploaded image's secure URL, or null if none yet. Controlled,
   * same shape as every other field in this app's forms. */
  value: string | null;
  onChange: (secureUrl: string | null) => void;
  helperText?: React.ReactNode;
  required?: boolean;
  /** Surfaced by the caller's own form-level validation (e.g. "required
   * before submit"), same pattern as Field.tsx's `invalid` prop —
   * this component's OWN upload failures render their own ErrorText
   * regardless of this. */
  invalid?: boolean;
}

export default function ImageUploadField({ label, folder, value, onChange, helperText, required, invalid }: ImageUploadFieldProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputId = `upload-camera-${folder}`;
  const galleryInputId = `upload-gallery-${folder}`;

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const result = await uploadImage(file, folder);
      onChange(result.secureUrl);
    } catch (err) {
      setError(err instanceof UploadError ? err.message : "Upload failed. Try again.");
    } finally {
      setUploading(false);
      // Lets picking the exact same file again re-trigger onChange
      // (e.g. after removing it, then choosing it again).
      if (cameraInputRef.current) cameraInputRef.current.value = "";
      if (galleryInputRef.current) galleryInputRef.current.value = "";
    }
  }

  return (
    <div>
      <Label htmlFor={cameraInputId}>
        {label}
        {required && <span className="ml-1 text-danger-text">*</span>}
      </Label>

      <div
        className={`flex flex-col items-center gap-3 rounded-xl border bg-surface-sunken p-5 ${
          invalid ? "border-danger" : "border-border"
        }`}
      >
        {/* The framed preview: fills with the uploaded photo once one
            exists, otherwise a placeholder icon — same "you can see what
            you're about to submit, right where you'll capture it" shape
            as the reference mockup's phone-screen frame. */}
        <div className="flex h-40 w-full max-w-[220px] items-center justify-center overflow-hidden rounded-lg border border-border-strong bg-surface">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element -- a
            // Cloudinary URL, not a local Next.js image asset; next/image
            // would need a remotePatterns entry per cloud name for no
            // real benefit here (a preview frame, not a hero image).
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageIcon size={28} className="text-text-tertiary" aria-hidden="true" />
          )}
        </div>

        {value ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-danger-text"
          >
            <X size={12} aria-hidden="true" />
            Remove and retake
          </button>
        ) : (
          <>
            <label
              htmlFor={cameraInputId}
              aria-disabled={uploading}
              className={`flex h-14 w-14 items-center justify-center rounded-full border-2 border-accent bg-accent text-accent-contrast shadow-sm transition-transform duration-base ease-base ${
                uploading ? "cursor-not-allowed opacity-60" : "cursor-pointer active:scale-95"
              }`}
            >
              {uploading ? <Loader2 size={22} className="spin-icon" aria-hidden="true" /> : <Camera size={22} aria-hidden="true" />}
            </label>
            <label
              htmlFor={galleryInputId}
              aria-disabled={uploading}
              className={`text-xs font-medium text-accent-text underline-offset-2 hover:underline ${
                uploading ? "pointer-events-none opacity-60" : "cursor-pointer"
              }`}
            >
              Upload photo
            </label>
          </>
        )}
      </div>

      {/* Camera input: capture="environment" opens the device camera
          directly. */}
      <input
        ref={cameraInputRef}
        id={cameraInputId}
        type="file"
        accept="image/*"
        capture="environment"
        disabled={uploading}
        onChange={(e) => handleFile(e.target.files?.[0])}
        className="sr-only"
      />
      {/* Gallery input: deliberately no `capture` attribute, so this
          opens the normal file/photo picker instead of forcing the
          camera — the "Upload photo" text link's distinct behavior from
          the camera button above. */}
      <input
        ref={galleryInputRef}
        id={galleryInputId}
        type="file"
        accept="image/*"
        disabled={uploading}
        onChange={(e) => handleFile(e.target.files?.[0])}
        className="sr-only"
      />

      <HelperText>{helperText}</HelperText>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
