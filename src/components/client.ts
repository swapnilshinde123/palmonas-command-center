"use client";
import useSWR, { mutate as globalMutate } from "swr";

export class ApiError extends Error {
  constructor(public code: string, message: string, public fields?: Record<string, string>, public details?: unknown, public status?: number) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError("NETWORK", "Couldn't reach the server. Your change was not saved — check your connection and retry.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401) window.location.href = "/login";
    throw new ApiError(e.code ?? "INTERNAL", e.message ?? "Request failed.", e.fields, e.details, res.status);
  }
  return data as T;
}

export const fetcher = (path: string) => api(path);

export function useApi<T>(path: string | null, opts?: { refreshInterval?: number }) {
  return useSWR<T>(path, fetcher as (p: string) => Promise<T>, { revalidateOnFocus: true, keepPreviousData: true, ...opts });
}

// After any mutation, refresh every list/KPI view so cards and counts stay consistent (§9.5 step 8).
export function refreshAll() {
  return globalMutate(() => true, undefined, { revalidate: true });
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

// Live updates: one EventSource per tab; any signal refreshes the SWR cache (debounced).
let liveTimer: ReturnType<typeof setTimeout> | null = null;
export function startLive(onStatus: (s: "live" | "reconnecting") => void, onBell: () => void) {
  if (typeof window === "undefined" || !("EventSource" in window)) return () => undefined;
  const es = new EventSource("/api/live");
  const refresh = () => {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => void refreshAll(), 250);
  };
  es.addEventListener("ready", () => onStatus("live"));
  for (const ev of ["task", "stats", "admin"]) es.addEventListener(ev, refresh);
  es.addEventListener("bell", () => { onBell(); refresh(); });
  es.onerror = () => onStatus("reconnecting");
  es.onopen = () => onStatus("live");
  return () => es.close();
}
