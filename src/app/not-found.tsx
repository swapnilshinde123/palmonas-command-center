import Link from "next/link";

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center p-6 text-center">
      <div><p className="text-6xl font-extrabold text-slate-300">404</p><h1 className="mt-2 text-2xl font-extrabold">Page not found</h1><p className="mt-2 text-slate-500">The page you&apos;re looking for doesn&apos;t exist or was moved.</p>
        <Link href="/" className="mt-6 inline-flex h-11 items-center rounded-xl bg-brand px-5 text-sm font-semibold text-white">Back to dashboard</Link></div>
    </div>
  );
}
