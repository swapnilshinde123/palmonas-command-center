import { fail } from "@/lib/errors";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normEmail(v: unknown) {
  return String(v ?? "").trim().toLowerCase();
}

export function passwordProblem(p: string): string | null {
  if (p.length < 8) return "Use at least 8 characters.";
  if (p.length > 128) return "Use at most 128 characters.";
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return "Include at least one letter and one number.";
  return null;
}

export class FieldErrors {
  e: Record<string, string> = {};
  add(field: string, msg: string) {
    if (!this.e[field]) this.e[field] = msg;
  }
  throwIfAny() {
    if (Object.keys(this.e).length) throw fail.validation(this.e);
  }
}
