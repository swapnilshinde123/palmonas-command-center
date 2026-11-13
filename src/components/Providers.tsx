"use client";
import { SessionProvider } from "next-auth/react";
import { SWRConfig } from "swr";
import { Toaster } from "./toast";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <SWRConfig value={{ shouldRetryOnError: false }}>{children}<Toaster /></SWRConfig>
    </SessionProvider>
  );
}
