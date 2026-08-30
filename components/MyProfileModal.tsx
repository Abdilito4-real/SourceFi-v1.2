"use client";

// components/MyProfileModal.tsx
//
// "View my own profile" for any signed-in user (buyer/supplier/admin
// alike), opened from the avatar/username block in DashboardShell's
// sidebar (the same footer every dashboard already renders). Shows the
// identity a buyer sees of THEM when they view a supplier's trust
// profile (SupplierTrustProfile.tsx) — username, role, photo — and, if
// no photo is set yet, lets them set one right here via the same
// ImageUploadField + PATCH /api/auth/me path onboarding already uses
// (see SessionProvider.tsx's updateProfilePicture).
import React, { useState } from "react";
import { User as UserIcon } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import ImageUploadField from "./ui/ImageUploadField";
import { useSession } from "./SessionProvider";

const ROLE_LABELS: Record<string, string> = {
  buyer: "Buyer",
  supplier: "Supplier",
  admin: "Admin",
};

export default function MyProfileModal({ onClose }: { onClose: () => void }) {
  const { user, updateProfilePicture, updatingProfilePicture } = useSession();
  // Only touched while actively picking/removing a photo — the display
  // above stays on user.profilePictureUrl (the server-confirmed value)
  // until a save actually succeeds, so a failed upload can't strand the
  // view showing a photo that was never actually saved.
  const [editingPhoto, setEditingPhoto] = useState(false);
  const [draftPhoto, setDraftPhoto] = useState<string | null>(null);

  if (!user) return null;

  const startEditing = () => {
    setDraftPhoto(user.profilePictureUrl);
    setEditingPhoto(true);
  };

  const savePhoto = async () => {
    const result = await updateProfilePicture(draftPhoto);
    if (result.success) setEditingPhoto(false);
  };

  return (
    <Modal open onClose={onClose} size="sm" title="My profile">
      <div className="flex flex-col gap-4">
        {editingPhoto ? (
          <>
            <ImageUploadField label="Profile picture" folder="profile_pictures" value={draftPhoto} onChange={setDraftPhoto} />
            <div className="flex gap-2">
              <Button variant="secondary" fullWidth onClick={() => setEditingPhoto(false)} disabled={updatingProfilePicture}>
                Cancel
              </Button>
              <Button fullWidth onClick={savePhoto} loading={updatingProfilePicture}>
                Save
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              {user.profilePictureUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a
                // Cloudinary URL, not a local Next.js image asset.
                <img
                  src={user.profilePictureUrl}
                  alt=""
                  className="h-16 w-16 shrink-0 rounded-full border border-border object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-text">
                  <UserIcon size={26} />
                </div>
              )}
              <div className="min-w-0">
                <div className="truncate font-display text-lg font-semibold italic text-text-primary">
                  {user.username ? `@${user.username}` : user.identity}
                </div>
                <div className="mt-0.5 text-xs text-text-tertiary">{ROLE_LABELS[user.role] || user.role}</div>
              </div>
            </div>

            <div className="rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text-secondary">{user.identity}</div>

            <Button variant="secondary" fullWidth onClick={startEditing}>
              {user.profilePictureUrl ? "Change profile picture" : "Set a profile picture"}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}
