"use client";
import { useState } from "react";
import { useApi } from "@/components/client";
import { useMe } from "@/components/me";
import { Alert, Badge, Button, Card, EmptyState, fmtRelative, Modal, PageHeader, Pagination, Skeleton } from "@/components/ui";

interface Mail { id: string; to: string; subject: string; html: string; text: string; kind: string; status: string; error: string | null; createdAt: string }

export default function EmailsPage() {
  const { data: me, can } = useMe();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Mail | null>(null);
  const { data, error, isLoading } = useApi<{ rows: Mail[]; total: number; page: number; pageSize: number; mode: string }>(can("emails.view") ? `/emails?page=${page}` : null, { refreshInterval: 15000 });
  if (me && !can("emails.view")) return <Card><EmptyState icon="lock" title="You don't have access to the email outbox" /></Card>;
  return (
    <div>
      <PageHeader title="Email outbox" description="Every email the system sent or tried to send." />
      {data?.mode === "outbox" && <Alert tone="info">SMTP isn&apos;t configured, so emails are stored here instead of being delivered. Open one to copy the invitation link, or set <code className="rounded bg-white/70 px-1">SMTP_HOST</code>, <code className="rounded bg-white/70 px-1">SMTP_USER</code> and <code className="rounded bg-white/70 px-1">SMTP_PASSWORD</code> to deliver them.</Alert>}
      <Card className="mt-4">
        {error && <div className="p-5"><Alert>{error.message}</Alert></div>}
        {isLoading && !data && <div className="space-y-3 p-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>}
        {data?.rows.length === 0 && <EmptyState icon="inbox" title="No emails yet" body="Invitations you send will appear here." />}
        {data && data.rows.length > 0 && (
          <>
            <ul className="divide-y divide-slate-100">
              {data.rows.map((m) => (
                <li key={m.id}>
                  <button onClick={() => setOpen(m)} className="flex w-full flex-col gap-1 px-5 py-4 text-left hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-4">
                    <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{m.subject}</span><span className="block truncate text-sm text-slate-500">To {m.to}</span></span>
                    <span className="flex items-center gap-2"><Badge tone={m.status === "SENT" ? "green" : m.status === "FAILED" ? "red" : "blue"}>{m.status === "LOGGED" ? "In outbox" : m.status === "SENT" ? "Delivered" : "Failed"}</Badge><span className="w-24 text-right text-xs text-slate-500">{fmtRelative(m.createdAt)}</span></span>
                  </button>
                </li>
              ))}
            </ul>
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.subject ?? ""} description={`To ${open?.to}`} size="lg" footer={<Button variant="primary" onClick={() => setOpen(null)}>Close</Button>}>
        {open?.error && <Alert>{open.error}</Alert>}
        {/* Rendered in a sandboxed frame: no scripts, links open in a new tab. */}
        {open && <iframe title="Email preview" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={open.html.replace("<head>", '<head><base target="_blank">').replace("<html>", "<html><head><base target=\"_blank\"></head>")} className="h-[480px] w-full rounded-xl border border-slate-200" />}
      </Modal>
    </div>
  );
}
