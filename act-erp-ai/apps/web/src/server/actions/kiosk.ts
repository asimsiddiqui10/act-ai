"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin, requireUser } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { audit } from "@/lib/audit";
import { rateLimited } from "@/lib/rate-limit";
import { ok, fail, failFromUnknown, type ActionResult } from "@/lib/action-result";
import { requestUsesHttps } from "@/lib/cookie-secure";
import {
  getKioskNetworkAccess,
  kioskNetworkDeniedMessage,
} from "@/lib/kiosk-network";
import { DEFAULT_KIOSK_PIN } from "@/lib/kiosk-pin";
import { _clockIn, _clockOut, _startBreak, _endBreak } from "./time-clock";

const COOKIE = "act_kiosk";
const KIOSK_TTL_DAYS = 90;

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

const slugRe = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

const createSchema = z.object({
  slug: z.string().regex(slugRe, "Use lowercase letters, numbers, hyphens (max 42)."),
  label: z.string().min(1).max(80),
});

/**
 * Admin creates a new kiosk record. The kiosk is "registered" but inactive
 * until an admin physically activates it from the terminal via
 * `activateKiosk`.
 */
export async function createKiosk(
  input: z.infer<typeof createSchema>,
): Promise<ActionResult<{ id: string; slug: string }>> {
  const admin = await requireAdmin();
  try {
    const data = createSchema.parse(input);

    const existing = await db.kioskSession.findUnique({ where: { slug: data.slug } });
    if (existing) {
      return fail(
        `A kiosk with slug "${data.slug}" already exists. Choose a different slug and try again.`,
      );
    }

    const session = await db.kioskSession.create({
      data: {
        slug: data.slug,
        label: data.label,
        provisionedBy: admin.id,
        expiresAt: new Date(Date.now() + KIOSK_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    await audit({
      action: "kiosk.create",
      resource: `KioskSession:${session.id}`,
      diff: { slug: data.slug, label: data.label },
    });
    revalidatePath("/admin/kiosks");
    revalidatePath("/kiosk");
    return ok({ id: session.id, slug: session.slug ?? data.slug });
  } catch (err) {
    return failFromUnknown(err);
  }
}

/**
 * Activate the kiosk identified by `slug` on the current device. Sets a
 * scoped cookie containing a hashed secret. Must be called by an admin.
 */
export async function activateKiosk(
  slug: string,
): Promise<ActionResult<{ redirectTo: string }>> {
  const admin = await requireAdmin();
  try {
    const network = await getKioskNetworkAccess();
    if (!network.allowed) {
      return fail(kioskNetworkDeniedMessage(network.ip));
    }
    const session = await db.kioskSession.findUnique({ where: { slug } });
    if (!session) {
      return fail("That kiosk was not found. Check the slug or create the kiosk first.");
    }
    if (session.revokedAt) {
      return fail(
        "That kiosk has been revoked. Create a new kiosk or ask an admin to restore access.",
      );
    }

    const raw = randomBytes(32).toString("base64url");
    await db.kioskSession.update({
      where: { id: session.id },
      data: {
        cookieHash: hash(raw),
        provisionedBy: admin.id,
        expiresAt: new Date(Date.now() + KIOSK_TTL_DAYS * 24 * 60 * 60 * 1000),
        revokedAt: null,
      },
    });

    const jar = await cookies();
    jar.set(COOKIE, raw, {
      httpOnly: true,
      secure: await requestUsesHttps(),
      sameSite: "lax",
      path: "/",
      maxAge: KIOSK_TTL_DAYS * 24 * 60 * 60,
    });

    await audit({
      action: "kiosk.activate",
      resource: `KioskSession:${session.id}`,
      diff: { slug },
    });
    revalidatePath("/admin/kiosks");
    return ok({ redirectTo: `/kiosk/${slug}` });
  } catch (err) {
    return failFromUnknown(err);
  }
}

/**
 * Server-only helper: returns the active kiosk session for the given slug
 * if (and only if) the device cookie matches this kiosk. Returns null
 * otherwise.
 */
export async function getActiveKioskSession(slug: string) {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  const session = await db.kioskSession.findUnique({ where: { slug } });
  if (!session) return null;
  if (session.revokedAt || session.expiresAt < new Date()) return null;
  if (!session.cookieHash || session.cookieHash !== hash(raw)) return null;
  return session;
}

async function requireActiveKiosk(slug: string) {
  const session = await getActiveKioskSession(slug);
  if (!session) return null;
  await db.kioskSession.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date() },
  });
  return session;
}

/** Sign out of the kiosk on this device. */
export async function endKioskSession(slug: string) {
  const jar = await cookies();
  jar.delete(COOKIE);
  await audit({
    action: "kiosk.end",
    resource: `KioskSession:${slug}`,
  });
  redirect(`/kiosk/${slug}`);
}

type KioskLookupOk = {
  id: string;
  employeeId: string;
  name: string;
  email: string | null;
  profilePic: string | null;
  jobTitle: string | null;
  hasPin: boolean;
  status: "ACTIVE" | "ON_BREAK" | "OUT";
  activeEntryId: string | null;
};

/** Lookup an employee by their business ID for the kiosk confirmation card. */
export async function kioskLookup(
  slug: string,
  employeeId: string,
): Promise<ActionResult<KioskLookupOk>> {
  try {
    const network = await getKioskNetworkAccess();
    if (!network.allowed) {
      return fail(kioskNetworkDeniedMessage(network.ip));
    }
    const session = await requireActiveKiosk(slug);
    if (!session) {
      return fail(
        "This kiosk session is not active on this device. An admin must activate the kiosk here first.",
      );
    }
    if (rateLimited(`lookup:${session.id}`, 30, 60_000)) {
      return fail("Too many lookups — wait a moment and try again.");
    }
    const employee = await db.employee.findUnique({
      where: { employeeId: employeeId.trim() },
      include: {
        timeEntries: {
          where: { status: { in: ["ACTIVE", "ON_BREAK"] } },
          take: 1,
          orderBy: { clockIn: "desc" },
        },
      },
    });
    if (!employee) {
      return fail("Unknown employee ID. Check the ID and try again.");
    }

    const active = employee.timeEntries[0];
    return ok({
      id: employee.id,
      employeeId: employee.employeeId,
      name: employee.name,
      email: employee.email,
      profilePic: employee.profilePic,
      jobTitle: employee.jobTitle,
      hasPin: !!employee.kioskPinHash,
      status: (active?.status ?? "OUT") as "ACTIVE" | "ON_BREAK" | "OUT",
      activeEntryId: active?.id ?? null,
    });
  } catch (err) {
    return failFromUnknown(err);
  }
}

const actionSchema = z.object({
  slug: z.string(),
  employeeId: z.string(),
  pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits"),
  action: z.enum(["CLOCK_IN", "CLOCK_OUT", "START_BREAK", "END_BREAK"]),
});

export async function kioskAction(
  input: z.infer<typeof actionSchema>,
): Promise<ActionResult<{ id: string | null; status: string | null }>> {
  try {
    const network = await getKioskNetworkAccess();
    if (!network.allowed) {
      return fail(kioskNetworkDeniedMessage(network.ip));
    }
    const session = await requireActiveKiosk(input.slug);
    if (!session) {
      return fail(
        "This kiosk session is not active on this device. An admin must activate the kiosk here first.",
      );
    }
    const data = actionSchema.parse(input);

    const employee = await db.employee.findUnique({
      where: { employeeId: data.employeeId },
    });
    if (!employee) {
      return fail("Unknown employee ID. Check the ID and try again.");
    }

    const limitKey = `pin:${session.id}:${employee.id}`;
    if (rateLimited(limitKey, 5, 5 * 60_000)) {
      return fail("Too many incorrect attempts. Try again in a few minutes.");
    }
    if (!employee.kioskPinHash) {
      return fail(
        "No kiosk PIN is set for this employee. Set one in Settings before using the kiosk.",
      );
    }
    const pinOk = await verifyPassword(data.pin, employee.kioskPinHash);
    if (!pinOk) {
      await audit({
        action: "kiosk.pin_failed",
        resource: `Employee:${employee.id}`,
        diff: { kioskSlug: session.slug },
      });
      return fail(
        "Incorrect PIN. Try again, or ask an admin to reset your PIN if you forgot it.",
      );
    }

    const meta = { kioskSlug: session.slug ?? input.slug, kioskLabel: session.label };

    let entryResult: ActionResult<{ id: string; status: string }>;
    switch (data.action) {
      case "CLOCK_IN":
        entryResult = await _clockIn(employee.id, undefined, "KIOSK", meta);
        break;
      case "CLOCK_OUT":
        entryResult = await _clockOut(employee.id, undefined, meta);
        break;
      case "START_BREAK":
        entryResult = await _startBreak(employee.id);
        break;
      case "END_BREAK":
        entryResult = await _endBreak(employee.id);
        break;
    }

    if (!entryResult.ok) return entryResult;

    await audit({
      action: `kiosk.${data.action.toLowerCase()}`,
      resource: `Employee:${employee.id}`,
      actor: { id: employee.userId, email: employee.email },
      diff: {
        employeeId: employee.employeeId,
        employeeName: employee.name,
        kioskSlug: session.slug,
        kioskLabel: session.label,
        timeEntryId: entryResult.id,
      },
    });

    revalidatePath(`/kiosk/${input.slug}`);
    revalidatePath("/admin/time-tracking");
    revalidatePath("/admin");
    return ok({ id: entryResult.id, status: entryResult.status });
  } catch (err) {
    return failFromUnknown(err);
  }
}

export async function revokeKiosk(id: string): Promise<ActionResult> {
  await requireAdmin();
  try {
    const session = await db.kioskSession.update({
      where: { id },
      data: { revokedAt: new Date(), cookieHash: null },
    });
    await audit({
      action: "kiosk.revoke",
      resource: `KioskSession:${id}`,
      diff: { slug: session.slug },
    });
    revalidatePath("/admin/kiosks");
    return ok();
  } catch (err) {
    return failFromUnknown(err);
  }
}

export async function deleteKiosk(id: string): Promise<ActionResult> {
  await requireAdmin();
  try {
    const session = await db.kioskSession.findUnique({ where: { id } });
    await db.kioskSession.delete({ where: { id } });
    await audit({
      action: "kiosk.delete",
      resource: `KioskSession:${id}`,
      diff: { slug: session?.slug },
    });
    revalidatePath("/admin/kiosks");
    return ok();
  } catch (err) {
    return failFromUnknown(err);
  }
}

/** Self-service: set or change your own kiosk PIN. Requires the current
 *  password as a check, same as changeMyPassword — it's what gates clock
 *  in/out at a shared terminal. */
export async function setMyKioskPin(
  currentPassword: string,
  pin: string,
): Promise<ActionResult> {
  const user = await requireUser();
  if (!user.employeeId) {
    return fail(
      "Your account has no employee profile yet. Ask an admin to create one before you can set a kiosk PIN.",
    );
  }
  if (!/^\d{4,6}$/.test(pin)) {
    return fail("PIN must be 4–6 digits. Enter a new PIN and try again.");
  }

  try {
    const row = await db.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (
      !row?.passwordHash ||
      !(await verifyPassword(currentPassword, row.passwordHash))
    ) {
      return fail("Current password is incorrect. Re-enter your password and try again.");
    }
    await db.employee.update({
      where: { id: user.employeeId },
      data: { kioskPinHash: await hashPassword(pin) },
    });
    await audit({ action: "kiosk.pin_set", resource: `Employee:${user.employeeId}` });
    return ok();
  } catch (err) {
    return failFromUnknown(err);
  }
}

/** Admin: restore the temporary kiosk PIN for lost-PIN recovery. */
export async function resetEmployeeKioskPin(employeeId: string): Promise<ActionResult> {
  await requireAdmin();
  try {
    await db.employee.update({
      where: { id: employeeId },
      data: { kioskPinHash: await hashPassword(DEFAULT_KIOSK_PIN) },
    });
    await audit({
      action: "kiosk.pin_reset",
      resource: `Employee:${employeeId}`,
      diff: { resetToDefault: true },
    });
    revalidatePath(`/admin/employees/${employeeId}`);
    return ok();
  } catch (err) {
    return failFromUnknown(err);
  }
}
