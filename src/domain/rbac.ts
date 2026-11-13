import { fail } from "@/lib/errors";
import type { Actor } from "./actor";

export type { Actor };

export type Decision = "ALLOW" | "OWN" | "DENY";

// Operation-level matrix (spec §14.2, §29). OWN = allowed only on records the actor owns
// (task owner, subtask owner, or designated recipient — see each service for the exact check).
export const MATRIX = {
  VIEW_ALL_TASKS:          { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "Members see own tasks, tasks where they own a subtask, and tasks with a transfer pending to them." },
  CREATE_TASK:             { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "ALLOW", note: "Members create for self; naming a peer raises a transfer the peer must accept." },
  ASSIGN_ANY_OWNER:        { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "" },
  EDIT_TASK_DETAILS:       { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Name, description, channel, workstream, project, remarks, pending-from, follow-up, output link, dependency tier." },
  SET_P0_DIRECT:           { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "Members may set P0 only with a written justification (recorded in audit)." },
  CHANGE_PRIORITY:         { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "" },
  CHANGE_DEADLINE_DIRECT:  { ADMIN: "ALLOW", LEADERSHIP: "DENY",  MEMBER: "DENY",  note: "Admin override with reason; does not count as an extension. Everyone else uses the extension flow." },
  CHANGE_STATUS:           { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Within the transition matrix; drop/reopen-dropped have their own rows." },
  REOPEN_COMPLETED:        { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Reason required." },
  DROP_TASK:               { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "Members submit a cancellation request." },
  REOPEN_DROPPED:          { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "Reason required." },
  REQUEST_CANCELLATION:    { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "" },
  DECIDE_CANCELLATION:     { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "Self-decision blocked." },
  INITIATE_TRANSFER:       { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Members may propose a transfer of their own task to a peer." },
  TRANSFER_OVERRIDE:       { ADMIN: "ALLOW", LEADERSHIP: "DENY",  MEMBER: "DENY",  note: "Instant reassignment without recipient acceptance." },
  DECIDE_TRANSFER:         { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Members: designated recipient only." },
  REQUEST_EXTENSION:       { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Reason required." },
  DECIDE_EXTENSION:        { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "Nobody approves their own request." },
  REQUEST_WAIVER:          { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "" },
  DECIDE_WAIVER:           { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "Self-approval blocked." },
  TRIGGER_ESCALATION:      { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Members may flag tasks they own or own a subtask of." },
  RESOLVE_ESCALATION:      { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "" },
  SOFT_DELETE:             { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "Reason required." },
  RESTORE:                 { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "" },
  HARD_DELETE:             { ADMIN: "ALLOW", LEADERSHIP: "DENY",  MEMBER: "DENY",  note: "Only soft-deleted records without dependencies; typed confirmation." },
  VIEW_BIN:                { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "DENY",  note: "" },
  VIEW_AUDIT:              { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Members see history of tasks visible to them." },
  VIEW_TEAM_SCORECARD:     { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Members see their own scorecard only." },
  OVERRIDE_SCORECARD:      { ADMIN: "ALLOW", LEADERSHIP: "DENY",  MEMBER: "DENY",  note: "" },
  CLOSE_SCORECARD_PERIOD:  { ADMIN: "ALLOW", LEADERSHIP: "DENY",  MEMBER: "DENY",  note: "" },
  VIEW_RAW_METADATA:       { ADMIN: "ALLOW", LEADERSHIP: "DENY",  MEMBER: "DENY",  note: "" },
  MANAGE_SERIES:           { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Members manage series they own." },
  MANAGE_PROJECTS:         { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Members manage projects they own." },
  MANAGE_SUBTASKS:         { ADMIN: "ALLOW", LEADERSHIP: "ALLOW", MEMBER: "OWN",   note: "Parent owner manages; subtask owner may update own subtask status/link only." },
  MANAGE_MEMBERS_LISTS:    { ADMIN: "ALLOW", LEADERSHIP: "DENY",  MEMBER: "DENY",  note: "Users, channels, workstreams, holidays, config, SLA policies." },
  MANAGE_NOTIFICATIONS:    { ADMIN: "ALLOW", LEADERSHIP: "DENY",  MEMBER: "DENY",  note: "Queue retry, dead-letter review." },
} as const satisfies Record<string, { ADMIN: Decision; LEADERSHIP: Decision; MEMBER: Decision; note: string }>;

export type Op = keyof typeof MATRIX;

export function decide(actor: Pick<Actor, "role">, op: Op): Decision {
  return MATRIX[op][actor.role];
}

export function isPrivileged(actor: Pick<Actor, "role">) {
  return actor.role === "ADMIN" || actor.role === "LEADERSHIP";
}

// Throws unless the actor may perform `op`; `isOwn` is evaluated only for OWN decisions.
export function assertCan(actor: Actor, op: Op, isOwn: boolean | (() => boolean) = false) {
  const d = decide(actor, op);
  if (d === "ALLOW") return;
  if (d === "OWN" && (typeof isOwn === "function" ? isOwn() : isOwn)) return;
  throw fail.forbidden();
}

export function can(actor: Actor, op: Op, isOwn = false) {
  const d = decide(actor, op);
  return d === "ALLOW" || (d === "OWN" && isOwn);
}
