"use client";

// components/SupplierTrustProfile.tsx
//
// A supplier's trust profile: what a buyer sees before ordering (design
// doc's "modern, professional" verification signal), pulled from
// GET /api/suppliers/[id], the same tier lib/supplierTrust.ts computes
// for the directory listing this modal is opened from.
import React, { useEffect, useState } from "react";
import { Loader2, Store, MapPin, Star, Package, CalendarCheck } from "lucide-react";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import SupplierTierBadge, { type SupplierTier } from "./ui/SupplierTierBadge";

interface TrustProfile {
  id: number;
  business_name: string;
  business_location: string;
  what_they_sell: string;
  profile_picture_url: string | null;
  verified_at: string | null;
  rating_average: number | null;
  rating_count: number;
  completed_order_count: number;
  tier: SupplierTier | null;
}

export default function SupplierTrustProfile({
  supplierId,
  onClose,
  onOrder,
}: {
  supplierId: number;
  onClose: () => void;
  onOrder?: () => void;
}) {
  const [profile, setProfile] = useState<TrustProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/suppliers/${supplierId}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load this supplier's profile.");
        if (!cancelled) setProfile(data.supplier);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load this supplier's profile.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  return (
    <Modal open onClose={onClose} size="sm" title={profile?.business_name || "Supplier profile"}>
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 size={22} className="spin-icon text-accent" />
        </div>
      ) : error || !profile ? (
        <p className="text-sm text-danger-text">{error || "Supplier not found."}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            {profile.profile_picture_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- a
              // Cloudinary URL, not a local Next.js image asset.
              <img
                src={profile.profile_picture_url}
                alt=""
                className="h-12 w-12 shrink-0 rounded-xl border border-border object-cover"
              />
            ) : (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">
                <Store size={22} />
              </div>
            )}
            <div>
              <SupplierTierBadge tier={profile.tier} />
              <div className="mt-1 flex items-center gap-1 text-xs text-text-tertiary">
                <MapPin size={12} /> {profile.business_location}
              </div>
            </div>
          </div>

          <p className="text-sm leading-relaxed text-text-secondary">{profile.what_they_sell}</p>

          <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-center">
            <div>
              <div className="flex items-center justify-center gap-1 font-display text-lg font-semibold text-text-primary">
                <Star size={14} className="text-warning-text" />
                {profile.rating_count > 0 ? profile.rating_average?.toFixed(1) : "—"}
              </div>
              <div className="mt-0.5 text-[10.5px] uppercase tracking-wide text-text-tertiary">
                {profile.rating_count} rating{profile.rating_count === 1 ? "" : "s"}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-center gap-1 font-display text-lg font-semibold text-text-primary">
                <Package size={14} className="text-accent-text" />
                {profile.completed_order_count}
              </div>
              <div className="mt-0.5 text-[10.5px] uppercase tracking-wide text-text-tertiary">Completed</div>
            </div>
            <div>
              <div className="flex items-center justify-center gap-1 font-display text-sm font-semibold text-text-primary">
                <CalendarCheck size={14} className="text-success-text" />
                {profile.verified_at ? new Date(profile.verified_at).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—"}
              </div>
              <div className="mt-0.5 text-[10.5px] uppercase tracking-wide text-text-tertiary">Verified since</div>
            </div>
          </div>

          {onOrder && (
            <Button fullWidth onClick={onOrder}>
              Create order
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}
