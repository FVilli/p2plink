import { fromBase64Url, sha256Base64Url } from "@p2plink/core";

export interface PingEchoPayload {
  size: number;
  bytes: string;
  hash: string;
}

/**
 * Decodes and validates an echoed ping payload. Returns null when length or
 * SHA-256 do not match, so corrupted data is never reflected.
 */
export async function verifyPingPayload(payload: {
  size?: unknown;
  bytes?: unknown;
  hash?: unknown;
}): Promise<Uint8Array | null> {
  if (
    typeof payload.size !== "number" ||
    typeof payload.bytes !== "string" ||
    typeof payload.hash !== "string"
  ) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(payload.bytes);
  } catch {
    return null;
  }
  if (bytes.length !== payload.size) return null;
  if ((await sha256Base64Url(bytes)) !== payload.hash) return null;
  return bytes;
}
