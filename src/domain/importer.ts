import { loadActor } from "./actor";
import { parse } from "csv-parse/sync";
import type { DepTier, EscalationLevel, Prisma, TaskStatus } from "@prisma/client";
import { prisma, tx as runTx } from "@/lib/db";
import { addDays, iso, parseISODate, todayBiz } from "@/lib/dates";
import { audit } from "./audit";
import { allocateSubtaskId, allocateTaskId, TASK_ID_RE } from "./ids";
import { isExcludedName, resolveSlaPolicy } from "./task-core";

// Controlled migration of a 'Task Tracker' CSV export (spec §40.3 Option C). Never fabricates:
// unknown owners/channels are row errors, missing values stay null and are flagged in `extra.import`.

export const DEFAULT_MAPPING = {
  name: ["Task Name", "Task"],
  channel: ["Channel"],
  assignedDate: ["Assigned Date", "Assigned"],
  owner: ["Owner", "Assignee"],
  priority: ["Priority"],
  status: ["Status"],
  lastUpdate: ["Last Update", "Last Updated"],
  remarks: ["Updated Remarks", "Remarks"],
  pendingFrom: ["Pending From"],
  followupDate: ["Followup Date", "Follow-up Date", "Follow Up Date"],
  deadline: ["Deadline", "Deadline Date"],
  metadata: ["Metadata", "Metadata JSON", "Meta"],
  outputLink: ["Output Link", "Output"],
  escalation: ["Escalation Req", "Escalation Required", "Escalation"],
  tat: ["TAT (Days)", "TAT"],
};
export type MappingKey = keyof typeof DEFAULT_MAPPING;

const STATUS: Record<string, TaskStatus> = { "not started": "NOT_STARTED", "in progress": "IN_PROGRESS", completed: "COMPLETED", done: "COMPLETED", dropped: "DROPPED", cancelled: "DROPPED", "on hold": "ON_HOLD" };
const TIER: Record<string, DepTier> = { i: "I", internal: "I", wb: "WB", "within brand": "WB", e: "E", external: "E" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseLooseDate(v: string | undefined | null): Date | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return parseISODate(s.slice(0, 10));
  if (/^\d{5}(\.\d+)?$/.test(s)) return addDays(parseISODate("1899-12-30"), Math.floor(Number(s))); // Sheets serial
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/); // DD/MM/YYYY (India locale)
  if (m) return parseISODate(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{4})/); // 12-Nov-2026 / 12 November 2026
  if (m && MONTHS.includes(m[2].toLowerCase())) return parseISODate(`${m[3]}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  throw new Error(`Unrecognised date "${s}"`);
}

export interface ImportRowResult { row: number; legacyId: string; status: "IMPORTED" | "SKIPPED_EXISTING" | "ERROR" | "WOULD_IMPORT"; taskId?: string; errors?: string[]; warnings?: string[] }
export interface ImportReport { file: string; dryRun: boolean; headerMapping: Record<string, string | null>; unmappedHeaders: string[]; rows: ImportRowResult[]; totals: Record<string, number> }

export async function importTaskTracker(csv: string, opts: { file?: string; dryRun?: boolean; mapping?: Partial<Record<MappingKey, string[]>>; createdByEmail?: string } = {}): Promise<ImportReport> {
  const dryRun = opts.dryRun ?? true;
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Record<string, string>[];
  const headers = records.length ? Object.keys(records[0]) : [];
  const mapping = { ...DEFAULT_MAPPING, ...opts.mapping };
  const headerMapping: Record<string, string | null> = {};
  for (const [k, candidates] of Object.entries(mapping)) headerMapping[k] = headers.find((h) => candidates.some((c) => c.toLowerCase() === h.toLowerCase())) ?? null;
  const used = new Set(Object.values(headerMapping).filter(Boolean));
  const get = (r: Record<string, string>, k: MappingKey) => (headerMapping[k] ? (r[headerMapping[k]!] ?? "").trim() : "");

  const users = await prisma.user.findMany();
  const channels = await prisma.channel.findMany();
  const asEmail = opts.createdByEmail?.toLowerCase();
  const admins = await prisma.user.findMany({ where: { status: "ACTIVE", role: { tier: "ADMIN" } } });
  const importer = asEmail ? admins.find((u) => u.email.toLowerCase() === asEmail) : admins[0];
  if (!importer) throw new Error("No active admin user available to attribute the import to.");
  const loaded = (await loadActor(importer.id))!;
  const actor = { ...loaded, name: `${importer.name} (import)` };
  const findUser = (name: string) => users.find((u) => u.name.toLowerCase() === name.toLowerCase() || u.name.toLowerCase().replace(/\s+sir$/, "") === name.toLowerCase().replace(/\s+sir$/, ""));

  const rows: ImportRowResult[] = [];
  for (const [i, r] of records.entries()) {
    const rowNo = i + 2;
    const errors: string[] = [];
    const warnings: string[] = [];
    let meta: Record<string, unknown> = {};
    const rawMeta = get(r, "metadata");
    if (rawMeta) {
      try { meta = JSON.parse(rawMeta); } catch { errors.push("Metadata column is not valid JSON."); }
    }
    const legacyId = typeof meta.taskId === "string" && meta.taskId ? meta.taskId : `ROW-${rowNo}:${get(r, "name").slice(0, 60)}`;
    if (await prisma.task.findUnique({ where: { legacyId } })) { rows.push({ row: rowNo, legacyId, status: "SKIPPED_EXISTING" }); continue; }

    const name = get(r, "name");
    if (!name) errors.push("Task name is blank.");
    const owner = findUser(get(r, "owner"));
    if (!owner) errors.push(`Owner "${get(r, "owner")}" is not a provisioned user.`);
    const channel = channels.find((c) => c.name.toLowerCase() === get(r, "channel").toLowerCase());
    if (!channel) errors.push(`Channel "${get(r, "channel")}" is not in the controlled list.`);
    const pr = Number(get(r, "priority").replace(/^p/i, ""));
    if (!Number.isInteger(pr) || pr < 0 || pr > 10) errors.push(`Priority "${get(r, "priority")}" is not P0–P10.`);
    const status = STATUS[get(r, "status").toLowerCase()];
    if (!status) errors.push(`Status "${get(r, "status")}" is not recognised.`);
    const dates: Record<string, Date | null> = {};
    for (const k of ["assignedDate", "deadline", "followupDate", "lastUpdate"] as const) {
      try { dates[k] = parseLooseDate(get(r, k)); } catch (e) { errors.push(`${k}: ${(e as Error).message}`); }
    }
    if (!dates.assignedDate) errors.push("Assigned date is missing.");
    if (!dates.deadline) errors.push("Deadline is missing.");
    const link = get(r, "outputLink");
    if (link && !/^https?:\/\//i.test(link)) warnings.push("Output link is not http(s); dropped.");

    if (errors.length) { rows.push({ row: rowNo, legacyId, status: "ERROR", errors }); continue; }
    if (dryRun) { rows.push({ row: rowNo, legacyId, status: "WOULD_IMPORT", warnings }); continue; }

    let completedAt: Date | null = null;
    if (status === "COMPLETED") {
      const tat = Number(get(r, "tat"));
      if (dates.lastUpdate) completedAt = new Date(dates.lastUpdate.getTime() + 6.5 * 3_600_000); // noon IST on that date
      else if (Number.isFinite(tat) && get(r, "tat") !== "") completedAt = new Date(addDays(dates.assignedDate!, tat).getTime() + 6.5 * 3_600_000);
      else warnings.push("Completed without Last Update or TAT — completion date unknown; timeliness evaluated as of import.");
    }
    const pendingTier = typeof meta.pendingTier === "string" ? TIER[meta.pendingTier.toLowerCase()] ?? null : null;
    // Pending From needs a POC Type (brief §6). Without one, the legacy text is kept in remarks rather than guessed.
    const legacyPending = get(r, "pendingFrom");
    const pendingName = legacyPending && pendingTier ? legacyPending : null;
    const remarks = [get(r, "remarks"), legacyPending && !pendingTier ? `Pending From (legacy, no POC type): ${legacyPending}` : ""].filter(Boolean).join("\n") || null;
    if (legacyPending && !pendingTier) warnings.push("Pending From has no POC Type; kept in remarks. Set the POC Type on the task to show it in Pending From.");
    const ext = Number(meta.extensionsCount ?? 0);
    const waived = Number(meta.waivedExtensionsCount ?? 0);
    if (ext || waived) warnings.push(`Legacy counters kept in extra.import (extensions ${ext}, waived ${waived}); no synthetic extension records are created.`);

    const taskId = await runTx(async (tx) => {
      const id = TASK_ID_RE.test(legacyId) && !(await tx.task.findFirst({ where: { id: { equals: legacyId, mode: "insensitive" } } })) ? legacyId : await allocateTaskId(tx, owner!.code);
      const softDeleted = meta.softDeleted === true;
      const extra: Prisma.InputJsonValue = JSON.parse(JSON.stringify({ import: { source: opts.file ?? "csv", row: rowNo, legacyMetadata: meta, completedAtSource: completedAt ? (dates.lastUpdate ? "LAST_UPDATE" : "ASSIGNED_PLUS_TAT") : null, warnings } }));
      await tx.task.create({
        data: {
          id, legacyId, name, description: "", channelId: channel!.id, ownerId: owner!.id, priority: pr, status: status!,
          assignedDate: dates.assignedDate!, deadline: dates.deadline!, originalDeadline: typeof meta.originalDeadline === "string" ? parseLooseDate(meta.originalDeadline) ?? dates.deadline! : dates.deadline!,
          followupDate: dates.followupDate, pendingFrom: pendingName, pendingSince: pendingName ? new Date() : null, remarks,
          outputLink: /^https?:\/\//i.test(link) ? link : null, pocType: pendingName ? pendingTier : null, completedAt, completedById: completedAt ? owner!.id : null,
          softDeleted, deletedAt: softDeleted && typeof meta.deletedAt === "string" ? parseLooseDate(meta.deletedAt) : null,
          deletedById: softDeleted ? actor.id : null, deletionReason: softDeleted ? String(meta.deletionReason ?? "Deleted in legacy sheet") : null,
          excludedFromMetrics: await isExcludedName(tx, name), slaPolicyId: await resolveSlaPolicy(tx, pr, channel!.name),
          createdById: actor.id, updatedById: actor.id, extra,
        },
      });
      for (const s of Array.isArray(meta.subtasks) ? (meta.subtasks as Record<string, unknown>[]) : []) {
        const sOwner = typeof s.owner === "string" ? findUser(s.owner) : undefined;
        const sid = await allocateSubtaskId(tx, id);
        const done = s.completed === true;
        await tx.subtask.create({
          data: {
            id: sid, taskId: id, title: String(s.title ?? "Imported subtask"), description: `Imported from legacy subtask ${String(s.id ?? "?")}`,
            ownerId: sOwner?.id ?? null, pendingFrom: !sOwner && s.owner ? String(s.owner) : null, depType: typeof s.depType === "string" ? TIER[s.depType.toLowerCase()] ?? null : null,
            status: done ? "COMPLETED" : "NOT_STARTED", completedAt: done ? completedAt ?? new Date() : null, createdById: actor.id,
          },
        });
      }
      const escFlag = /^(true|yes|1)$/i.test(get(r, "escalation"));
      if (escFlag && ["NOT_STARTED", "IN_PROGRESS", "ON_HOLD"].includes(status!)) {
        const level = (["L1", "L2", "L3"].includes(String(meta.escalationLevel)) ? meta.escalationLevel : "L1") as EscalationLevel;
        const assignee = await tx.user.findFirst({ where: { escalationLevel: level } });
        const e = await tx.escalation.create({ data: { taskId: id, level, assigneeId: assignee?.id ?? null, reason: "Imported active escalation", triggeredById: actor.id, dependencyTier: pendingTier, pendingFrom: legacyPending || null } });
        if (assignee) await tx.taskAccess.create({ data: { taskId: id, userId: assignee.id, reason: "ESCALATION", grantedById: actor.id } });
        await tx.escalationLevelChange.create({ data: { escalationId: e.id, toLevel: level, actorId: actor.id, cause: "Imported active escalation" } });
        await tx.task.update({ where: { id }, data: { escalationRequired: true } });
      }
      const approval = meta.approval as Record<string, unknown> | null | undefined;
      if (approval?.type === "extension" && approval.status === "pending" && typeof approval.requestedDeadline === "string") {
        const req = findUser(String(approval.requestedBy ?? "")) ?? owner!;
        await tx.extensionRequest.create({ data: { taskId: id, requestedById: req.id, previousDeadline: dates.deadline!, requestedDeadline: parseLooseDate(approval.requestedDeadline)!, reason: String(approval.reason ?? "Imported pending request") } });
      }
      const transfer = meta.incomingTransfer as Record<string, unknown> | null | undefined;
      const to = transfer && transfer.status === "pending" ? findUser(String(transfer.to ?? "")) : undefined;
      if (to && to.id !== owner!.id) {
        await tx.transfer.create({ data: { taskId: id, fromUserId: owner!.id, toUserId: to.id, initiatedById: owner!.id, reason: String(transfer!.reason ?? "Imported pending transfer"), deadlineAtRequest: dates.deadline!, wasOverdueAtRequest: todayBiz() > dates.deadline! } });
      }
      // No notification events: an import is a backfill, not a stream of new assignments (§39.5).
      await audit(tx, { recordId: id, eventType: "TASK_IMPORTED", actor, reason: `Imported from ${opts.file ?? "CSV"} row ${rowNo}`, newValue: { legacyId, row: r, warnings } });
      return id;
    });
    rows.push({ row: rowNo, legacyId, status: "IMPORTED", taskId, warnings });
  }
  const totals = rows.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  return { file: opts.file ?? "csv", dryRun, headerMapping, unmappedHeaders: headers.filter((h) => !used.has(h)), rows, totals: { ...totals, total: rows.length } };
}

export { iso };
