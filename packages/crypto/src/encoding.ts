import { toBase64Url } from "@p2plink/core";
export { toBase64Url };
export {
  canonicalJson,
  concatBytes,
  equalBytes,
  fromBase64Url,
  randomBytes,
  randomToken,
  utf8Decode,
  utf8Encode,
} from "@p2plink/core";

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", data as unknown as BufferSource),
  );
}

export async function sha256Base64Url(data: Uint8Array): Promise<string> {
  return toBase64Url(await sha256(data));
}
