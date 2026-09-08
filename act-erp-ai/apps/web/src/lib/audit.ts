import { db } from "@/lib/db";
import { headers } from "next/headers";
import { getSessionUser } from "@/lib/auth";
import { clientIpFromHeaders } from "@/lib/ip-network";

/**
 * Write an audit log entry. Call from server actions on writes you want
 * tracked. Failures are swallowed — audit-log failures should never block
 * the primary action.
 */
export async function audit(args: {
  action: string;
  resource: string;
  diff?: Record<string, unknown>;
  /**
   * Override the actor recorded for this entry. Useful when the request is
   * authenticated as one user (e.g. an admin operating a kiosk) but the
   * action is performed on behalf of another (the employee clocking in).
   */
  actor?: { id?: string | null; email?: string | null };
}) {
  try {
    const sessionUser = args.actor ? null : await getSessionUser();
    const actorId = args.actor ? args.actor.id ?? null : sessionUser?.id ?? null;
    const actorEmail = args.actor ? args.actor.email ?? null : sessionUser?.email ?? null;
    const h = await headers();
    await db.auditLog.create({
      data: {
        actorId,
        actorEmail,
        action: args.action,
        resource: args.resource,
        diff: args.diff ? (args.diff as object) : undefined,
        ip: clientIpFromHeaders(h),
        userAgent: h.get("user-agent") ?? null,
      },
    });
  } catch (e) {
    // Don't surface audit-log failures.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[audit] write failed:", e);
    }
  }
}

/** Generates an embedding stub. Wire to OpenAI / Anthropic later. */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  // Placeholder — return null until an embedding provider is wired.
  // When implemented, return Float32Array of length 1536 → store via raw SQL:
  //   await db.$executeRaw`UPDATE employees SET embedding = ${vector}::vector WHERE id = ${id}`
  void text;
  return null;
}
