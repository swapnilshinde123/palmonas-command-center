"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

// Filters live in the URL so they survive reloads, back/forward and shared links.
export function useUrlState<K extends string>(keys: readonly K[]) {
  const sp = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const values = Object.fromEntries(keys.map((k) => [k, sp.get(k) ?? ""])) as Record<K, string>;
  const set = useCallback((patch: Partial<Record<K, string | null>>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch) as [string, string | null][]) (v ? next.set(k, v) : next.delete(k));
    if (!("page" in patch)) next.delete("page");
    const qs = next.toString();
    router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
  }, [router, path]);
  return [values, set] as const;
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
