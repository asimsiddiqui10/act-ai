import { headers } from "next/headers";
import { env } from "./env";
import { isIpAllowed } from "./ip-network";

/**
 * Read allowlist at request time. Avoid static `process.env.FOO` access in
 * env.ts alone — Next can inline that away at build time when the var was
 * missing from the build secret, leaving production permanently empty.
 */
function configuredNetworks() {
  const dynamic = process.env["KIOSK_ALLOWED_NETWORKS"];
  if (dynamic?.trim()) return dynamic;
  return env.KIOSK_ALLOWED_NETWORKS;
}

function clientIpFrom(requestHeaders: Headers) {
  // Caddy is the only public ingress and sets / replaces untrusted incoming XFF.
  const forwarded = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const real = requestHeaders.get("x-real-ip")?.trim();
  if (real) return real;
  return null;
}

export async function getKioskNetworkAccess() {
  const requestHeaders = await headers();
  const ip = clientIpFrom(requestHeaders);
  const configured = configuredNetworks();

  // Local/dev without an allowlist stays usable. Production fails closed.
  if (!configured?.trim() && env.NODE_ENV !== "production") {
    return { allowed: true, ip, configured: null as string | null };
  }
  return {
    allowed: isIpAllowed(ip, configured),
    ip,
    configured: configured?.trim() || null,
  };
}

export function kioskNetworkDeniedMessage(ip: string | null) {
  const seen = ip?.trim() || "unknown";
  return `This kiosk can only be used from the approved facility network (your connection appears as ${seen}).`;
}
