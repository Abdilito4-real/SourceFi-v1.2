// components/ui/CardListSkeleton.tsx
//
// Skeleton placeholder for the order/application/dispute/listing lists
// every dashboard renders while its data loads. Replaces the bare
// centered spinner (<Loader2 className="spin-icon" />) that used to be
// the only loading state — a shape that roughly previews what's about to
// appear reads as more considered and cuts the layout jump once real
// content pops in.
import React from "react";
import Skeleton from "./Skeleton";
import { cn } from "./cn";

export interface CardListSkeletonProps {
  rows?: number;
  /** "list" mirrors OrderCard's shape (stacked rows); "grid" mirrors the
   * supplier/material/listing card grids. */
  layout?: "list" | "grid";
  className?: string;
}

function ListRowSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-5 w-28 rounded-pill" />
        <Skeleton className="h-4 w-16" />
      </div>
    </div>
  );
}

function GridCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-2">
        <Skeleton className="h-11 w-11 rounded-xl" />
        <Skeleton className="h-5 w-14 rounded" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-3 w-full" />
      <div className="mt-auto flex items-center justify-between pt-1">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-20 rounded-md" />
      </div>
    </div>
  );
}

export default function CardListSkeleton({ rows = 3, layout = "list", className = "" }: CardListSkeletonProps) {
  return (
    <div
      className={cn("grid gap-3", layout === "grid" && "grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3", className)}
      aria-hidden="true"
    >
      {Array.from({ length: rows }).map((_, i) => (layout === "grid" ? <GridCardSkeleton key={i} /> : <ListRowSkeleton key={i} />))}
    </div>
  );
}
