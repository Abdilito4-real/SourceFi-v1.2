// components/ui/cn.ts
//
// Deliberately not clsx/tailwind-merge, this project is bundle-size
// conscious (mid-range Android, metered data), and string-joining truthy
// class fragments is all these primitives need.
export type ClassValue = string | false | null | undefined;

export function cn(...args: ClassValue[]): string {
  return args.filter(Boolean).join(" ");
}
