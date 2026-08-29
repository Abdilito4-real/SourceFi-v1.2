// tests/uploadValidation.test.ts
//
// isCloudinaryUrl is the server-side enforcement behind "you must
// upload an image" for material listings, supplier verification, and
// (once wired) profile pictures — without it, a client could just send
// any https URL in the request body and the "must upload" rule would
// only be a UI suggestion. Covers: real uploads from this app's own
// cloud accepted, a DIFFERENT Cloudinary account's URL rejected (not
// just "any res.cloudinary.com URL"), non-Cloudinary URLs rejected,
// unsafe protocols rejected, and the "not configured yet" case.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isCloudinaryUrl } from "../lib/uploadValidation";

describe("isCloudinaryUrl", () => {
  const ORIGINAL_ENV = process.env.CLOUDINARY_CLOUD_NAME;

  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = "sourcefi-prod";
  });
  afterEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = ORIGINAL_ENV;
  });

  it("accepts a real upload result from this app's own cloud", () => {
    expect(isCloudinaryUrl("https://res.cloudinary.com/sourcefi-prod/image/upload/v1234/material_listings/abc123.jpg")).toBe(true);
  });

  it("rejects a URL from a DIFFERENT Cloudinary account, not just any res.cloudinary.com URL", () => {
    expect(isCloudinaryUrl("https://res.cloudinary.com/someone-elses-cloud/image/upload/v1/x.jpg")).toBe(false);
  });

  it("rejects a non-Cloudinary URL entirely", () => {
    expect(isCloudinaryUrl("https://example.com/photo.jpg")).toBe(false);
  });

  it("rejects an unsafe protocol even on the right host", () => {
    expect(isCloudinaryUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(isCloudinaryUrl("not a url")).toBe(false);
  });

  it("rejects everything when CLOUDINARY_CLOUD_NAME isn't set, rather than throwing", () => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    expect(isCloudinaryUrl("https://res.cloudinary.com/sourcefi-prod/image/upload/v1/x.jpg")).toBe(false);
  });
});
