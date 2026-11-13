import { redirect } from "next/navigation";
import { getActor, googleEnabled, passwordLoginEnabled } from "@/lib/auth";
import { AuthLayout } from "@/components/AuthLayout";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getActor()) redirect("/");
  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to the Palmonas Command Center.">
      <LoginForm google={googleEnabled()} password={passwordLoginEnabled()} />
    </AuthLayout>
  );
}
