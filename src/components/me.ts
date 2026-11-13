"use client";
import { useApi } from "./client";
import type { Permission } from "@/domain/permissions";

export interface Me {
  me: { id: string; name: string; email: string; title: string; phone: string; status: string; version: number; role: { id: string; key: string; name: string; tier: string }; code: string; escalationLevel: "L1" | "L2" | "L3" | null; permissions: Permission[]; roleKey: string; lastLoginAt: string | null; createdAt: string };
  assignableRoles: { id: string; key: string; name: string; description: string; tier: string }[];
  permissionGroups: { group: string; items: { key: Permission; label: string; description: string }[] }[];
  mailMode: "smtp" | "outbox";
}

export function useMe() {
  const r = useApi<Me>("/me");
  const can = (p: Permission) => !!r.data?.me.permissions.includes(p);
  return { ...r, can };
}
