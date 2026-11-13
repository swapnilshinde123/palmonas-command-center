// Permission catalogue for account administration. Task-workspace access is decided by the role's
// tier (ADMIN / LEADERSHIP / MEMBER) via the operation matrix in rbac.ts.
export const PERMISSION_GROUPS = [
  {
    group: "Users",
    items: [
      { key: "users.view", label: "View users", description: "See the team directory." },
      { key: "users.create", label: "Add users", description: "Create accounts directly." },
      { key: "users.edit", label: "Edit users", description: "Change name, title, phone, email, role, code and escalation level." },
      { key: "users.status", label: "Change user status", description: "Activate, suspend or deactivate accounts." },
      { key: "users.delete", label: "Delete users", description: "Permanently remove accounts that own no work." },
    ],
  },
  {
    group: "Invitations",
    items: [
      { key: "invitations.view", label: "View invitations", description: "See sent invitations and their status." },
      { key: "invitations.send", label: "Send & resend invitations", description: "Invite people by email and resend links." },
      { key: "invitations.revoke", label: "Revoke invitations", description: "Cancel pending invitations." },
    ],
  },
  {
    group: "Administration",
    items: [
      { key: "roles.view", label: "View roles", description: "See roles and their permissions." },
      { key: "roles.manage", label: "Manage roles", description: "Create, edit and delete roles." },
      { key: "activity.view", label: "View activity log", description: "See the audit trail of account changes." },
      { key: "emails.view", label: "View email outbox", description: "See delivered, queued and failed emails." },
      { key: "settings.manage", label: "Manage settings", description: "Channels, workstreams, holidays, POC registry and workflow thresholds." },
    ],
  },
] as const;

export type Permission = (typeof PERMISSION_GROUPS)[number]["items"][number]["key"];
export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key)) as Permission[];
export const isPermission = (p: string): p is Permission => (ALL_PERMISSIONS as string[]).includes(p);

export type Tier = "ADMIN" | "LEADERSHIP" | "MEMBER";
export const TIER_RANK: Record<Tier, number> = { MEMBER: 0, LEADERSHIP: 1, ADMIN: 2 };
export const TIER_LABEL: Record<Tier, string> = { ADMIN: "Admin", LEADERSHIP: "Leadership", MEMBER: "Team member" };

export const SYSTEM_ROLES: { key: string; name: string; tier: Tier; description: string; permissions: Permission[] }[] = [
  { key: "owner", name: "Owner", tier: "ADMIN", description: "Full access, including other Owners. Cannot be edited or removed.", permissions: ALL_PERMISSIONS },
  { key: "admin", name: "Admin", tier: "ADMIN", description: "Sees and manages every task, the team and settings.", permissions: ALL_PERMISSIONS },
  {
    key: "leadership",
    name: "Leadership",
    tier: "LEADERSHIP",
    description: "Sees every task, approves requests and drills into team statistics.",
    permissions: ["users.view", "invitations.view", "invitations.send", "roles.view", "activity.view"],
  },
  { key: "member", name: "Team member", tier: "MEMBER", description: "Works on own tasks and tasks shared with them.", permissions: [] },
];
