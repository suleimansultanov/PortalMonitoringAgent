"use client";

import { useActionState } from "react";
import { authenticate } from "@/lib/auth/actions";

export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const [error, formAction, pending] = useActionState(authenticate, undefined);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />

      <Field label="Email">
        <input
          name="email"
          type="email"
          required
          autoComplete="username"
          autoFocus
          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm outline-none focus:border-[var(--color-ink)]"
        />
      </Field>

      <Field label="Password">
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-canvas)] px-3 py-2 text-sm outline-none focus:border-[var(--color-ink)]"
        />
      </Field>

      {/*
        One message for every failure. Saying "no such account" would confirm
        which addresses exist here, and this is a client's market data behind a
        URL that will be pasted into email.
      */}
      {error && (
        <p role="alert" className="rounded-lg bg-[var(--color-warn-bg,#fdf2f2)] px-3 py-2 text-sm text-[var(--color-warn,#8a1c1c)]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-[var(--color-ink)] px-3 py-2 text-sm font-medium text-[var(--color-canvas)] transition-opacity disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--color-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}
