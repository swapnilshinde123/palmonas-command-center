import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import { DomainError } from "./errors";
import { requireActor } from "./auth";
import { log } from "./log";
import type { Actor } from "@/domain/actor";

type Ctx = { req: NextRequest; params: Record<string, string>; body: unknown; query: Record<string, string> };

function sameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const allowed = new URL(process.env.NEXTAUTH_URL ?? process.env.APP_BASE_URL ?? req.nextUrl.origin).origin;
  return origin === allowed || origin === req.nextUrl.origin;
}

function errorResponse(err: unknown, req: NextRequest, requestId: string) {
  if (err instanceof DomainError)
    return NextResponse.json({ error: { code: err.code, message: err.message, fields: err.fields, details: err.details, requestId } }, { status: err.status });
  if (err instanceof ZodError) {
    const fields = Object.fromEntries(err.issues.map((i) => [i.path.join(".") || "body", i.message]));
    return NextResponse.json({ error: { code: "VALIDATION", message: "Some fields need attention.", fields, requestId } }, { status: 422 });
  }
  log.error("unhandled api error", { requestId, path: req.nextUrl.pathname, err: err instanceof Error ? err.stack : String(err) });
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong and nothing was saved. Try again.", requestId } }, { status: 500 });
}

async function parse(req: NextRequest) {
  if (req.method === "GET" || !req.headers.get("content-type")?.includes("application/json")) return undefined;
  try {
    return await req.json();
  } catch {
    throw new DomainError("VALIDATION", "Malformed request body.");
  }
}

function handler(fn: (ctx: Ctx & { actor: Actor | null }) => Promise<unknown>, needsAuth: boolean) {
  return async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    try {
      if (req.method !== "GET" && !sameOrigin(req)) throw new DomainError("FORBIDDEN", "Cross-origin request blocked.");
      const actor = needsAuth ? await requireActor() : null;
      const data = await fn({ actor, req, params: await params, body: await parse(req), query: Object.fromEntries(req.nextUrl.searchParams.entries()) });
      return NextResponse.json(data ?? { ok: true }, { headers: { "cache-control": "no-store", "x-request-id": requestId } });
    } catch (err) {
      return errorResponse(err, req, requestId);
    }
  };
}

export const route = (fn: (ctx: Ctx & { actor: Actor }) => Promise<unknown>) => handler(fn as never, true);
export const publicRoute = (fn: (ctx: Ctx) => Promise<unknown>) => handler(fn, false);
