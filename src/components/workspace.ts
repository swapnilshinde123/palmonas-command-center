"use client";
import { useApi } from "./client";
import type { TaskDTO } from "@/domain/task-core";

export type Task = TaskDTO;
export type Level = "L1" | "L2" | "L3";
export type PocType = "I" | "WB" | "E";

export interface Workspace {
  users: { id: string; name: string; code: string; escalationLevel: Level | null }[];
  channels: { id: string; name: string; active: boolean }[];
  workstreams: { id: string; name: string; active: boolean }[];
  projects: { id: string; name: string; status: string }[];
  escalationOwners: { level: Level; userId: string | null; name: string | null; active: boolean }[];
  tier: "ADMIN" | "LEADERSHIP" | "MEMBER";
  privileged: boolean;
  escalationLevel: Level | null;
  perms: Record<string, "ALLOW" | "OWN" | "DENY">;
  dueSoon: { deadlineDays: number; followupDays: number };
}

export function useWorkspace() {
  const r = useApi<Workspace>("/workspace");
  const allow = (op: string, own = false) => {
    const d = r.data?.perms[op];
    return d === "ALLOW" || (d === "OWN" && own);
  };
  return { ...r, ws: r.data, allow };
}

export const POC_LABEL: Record<PocType, string> = { I: "Internal", WB: "Within Brand", E: "External" };
