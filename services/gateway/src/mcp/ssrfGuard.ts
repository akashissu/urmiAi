import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config.js";

/**
 * Blocks an admin-supplied upstream URL from targeting the cloud metadata
 * service, loopback, or link-local addresses. RFC1918 ranges are blocked
 * too unless ALLOW_INTERNAL_UPSTREAMS=true, because local dev genuinely
 * needs them (our own WooCommerce MCP server is a cluster-internal DNS
 * name). See docs/INTERVIEW_PREP.md for why this is a flag and not a
 * blanket disable.
 */
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);

export async function assertUrlAllowed(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Upstream URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Upstream URL must be http or https");
  }
  if (BLOCKED_HOSTS.has(url.hostname)) {
    throw new Error(`Upstream host ${url.hostname} is blocked`);
  }

  const addresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true })).map((a) => a.address);
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`Upstream URL resolves to a blocked address (${address})`);
    }
  }
}

function isBlockedAddress(address: string): boolean {
  if (address === "169.254.169.254") return true; // cloud metadata
  if (address.startsWith("127.") || address === "::1") return true; // loopback
  if (address.startsWith("169.254.") || address.startsWith("fe80:")) return true; // link-local

  if (!config.allowInternalUpstreams) {
    if (address.startsWith("10.")) return true;
    if (address.startsWith("192.168.")) return true;
    const second = Number(address.split(".")[1]);
    if (address.startsWith("172.") && second >= 16 && second <= 31) return true;
  }
  return false;
}
