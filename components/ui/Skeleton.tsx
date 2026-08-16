// components/ui/Skeleton.tsx
//
// The pulse animation is neutralized globally under
// prefers-reduced-motion (see app/globals.css), no separate reduced-motion
// handling needed here.
import React from "react";
import { cn } from "./cn";

export default function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-surface-sunken", className)} />;
}
