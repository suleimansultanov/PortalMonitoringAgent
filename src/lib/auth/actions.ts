"use server";

import { AuthError, CredentialsSignin } from "next-auth";
import { RATE_LIMITED, signIn, signOut } from "./index";

/**
 * Sign in from the login form.
 *
 * The return value is an error message or nothing. On success `signIn` throws
 * Next's redirect signal, which must be allowed past — hence the `AuthError`
 * check before the rethrow. Swallowing everything here is the classic version
 * of this bug: the login succeeds, the redirect is eaten, and the form sits
 * there looking broken.
 */
export async function authenticate(
  _previous: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  const callbackUrl = String(formData.get("callbackUrl") || "/portal");

  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      // Only ever redirect within this app. A callbackUrl arrives in the query
      // string, so anyone can put anything in it.
      redirectTo: callbackUrl.startsWith("/") ? callbackUrl : "/portal",
    });
  } catch (err) {
    if (err instanceof AuthError) {
      // A server action answers 200 whatever happens, so the 429 is a sentence.
      if (err instanceof CredentialsSignin && err.code === RATE_LIMITED) {
        return "Too many failed attempts. Try again in a few minutes (at most fifteen).";
      }
      return err.type === "CredentialsSignin"
        ? "Wrong email or password."
        : "Could not sign in. Check the server logs.";
    }
    throw err;
  }

  return undefined;
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
