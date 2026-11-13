import { redirect } from "next/navigation";
import { getActor } from "@/lib/auth";
import { Providers } from "@/components/Providers";
import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  if (!(await getActor())) redirect("/login");
  return (
    <Providers>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
