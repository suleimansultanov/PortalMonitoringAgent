import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata = { title: "Sign in — Market Analysis" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");

  const { callbackUrl } = await searchParams;

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-[360px] flex-col justify-center">
      <div className="mb-8">
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.2em] text-[var(--color-faint)]">
          Lead Estate
        </div>
        <h1 className="display text-[28px] leading-tight">Market Analysis</h1>
        <p className="mt-1.5 text-sm text-[var(--color-muted)]">
          Sign in to continue.
        </p>
      </div>

      <LoginForm callbackUrl={callbackUrl ?? "/"} />

      <p className="mt-6 text-xs text-[var(--color-faint)]">
        No self-service accounts. Ask whoever runs the collector to create one with{" "}
        <code>npm run user:create</code>.
      </p>
    </div>
  );
}
