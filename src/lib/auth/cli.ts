import crypto from "node:crypto";
import { deactivateUser, listUsers, upsertUser, type Role } from "./users";

/**
 * Account management from the terminal.
 *
 *   npm run user:create -- --email=mark@med-estates.com --role=admin
 *   npm run user:create -- --email=… --password='…'
 *   npm run user:create -- --list
 *   npm run user:create -- --email=… --deactivate
 *
 * With no `--password` a strong one is generated and printed once. That is
 * better than a prompt here: the realistic caller is whoever is deploying, and
 * a generated password is one they cannot reuse from another service.
 */

type Args = {
  email?: string;
  password?: string;
  name?: string;
  role?: Role;
  client?: string;
  list: boolean;
  deactivate: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

  const role = get("role");
  if (role && role !== "admin" && role !== "member") {
    throw new Error(`--role must be "admin" or "member", not "${role}".`);
  }

  return {
    email: get("email"),
    password: get("password"),
    name: get("name"),
    role: role as Role | undefined,
    client: get("client"),
    list: argv.includes("--list"),
    deactivate: argv.includes("--deactivate"),
  };
}

/** Base58-ish: no characters that get misread when a password is read aloud. */
function generatePassword(length = 20): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function main(args: Args): Promise<void> {
  if (args.list) {
    const users = await listUsers();
    if (users.length === 0) {
      console.log("No users yet. Create one with --email=…");
      return;
    }
    for (const u of users) {
      const last = u.lastLoginAt ? u.lastLoginAt.toISOString().slice(0, 16).replace("T", " ") : "never";
      console.log(
        `${u.active ? " " : "✗"} ${u.email.padEnd(34)} ${u.role.padEnd(7)} last login: ${last}`,
      );
    }
    return;
  }

  if (!args.email) {
    console.error(
      "Usage:\n" +
        "  npm run user:create -- --email=you@example.com [--password=…] [--name=…] [--role=admin|member] [--client=slug]\n" +
        "  npm run user:create -- --list\n" +
        "  npm run user:create -- --email=you@example.com --deactivate\n",
    );
    process.exitCode = 1;
    return;
  }

  if (args.deactivate) {
    const done = await deactivateUser(args.email);
    console.log(done ? `Deactivated ${args.email}.` : `No user ${args.email}.`);
    if (done) {
      console.log(
        "\nNote: sessions already issued stay valid until they expire (12 h).\n" +
          "Rotate AUTH_SECRET to end every session everywhere immediately.",
      );
    }
    return;
  }

  const generated = !args.password;
  const password = args.password ?? generatePassword();

  const result = await upsertUser({
    email: args.email,
    password,
    name: args.name,
    role: args.role,
    clientSlug: args.client,
  });

  console.log(`${result.created ? "Created" : "Updated"} ${result.email} (${result.role}).`);
  if (generated) {
    console.log(`\n  Password: ${password}\n`);
    console.log("Shown once. It is stored only as a bcrypt hash — re-run this command to reset it.");
  }
}

if (process.argv[1]?.endsWith("auth/cli.ts")) {
  main(parseArgs(process.argv))
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((err) => {
      console.error("\nuser:create failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
