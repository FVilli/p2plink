import { P2PLinkError, P2PLinkErrorCodes } from "./errors.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function utf8Decode(value: Uint8Array): string {
  return textDecoder.decode(value);
}

export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid byte length");
  const bytes = new Uint8Array(length);
  // Web Crypto limits getRandomValues to 65536 bytes per call.
  for (let offset = 0; offset < length; offset += 65_536) {
    globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65_536)));
  }
  return bytes;
}

export function randomId(): string {
  return globalThis.crypto.randomUUID();
}

export function randomToken(bytes = 24): string {
  return toBase64Url(randomBytes(bytes));
}

export async function sha256Base64Url(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? utf8Encode(input) : input;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return toBase64Url(new Uint8Array(digest));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid base64url value");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic JSON encoding used for signatures and transcripts.
 * Object keys are sorted; undefined, functions, symbols, bigint and non-finite
 * numbers are rejected. This is a canonical subset of RFC 8785 for the value
 * types used by P2PLink (strings, finite numbers, booleans, null, arrays and
 * plain objects).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Non-finite number in canonical JSON");
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys
        .map((key) => {
          const item = record[key];
          if (item === undefined) {
            throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "undefined in canonical JSON");
          }
          return `${JSON.stringify(key)}:${canonicalJson(item)}`;
        })
        .join(",")}}`;
    }
    default:
      throw new P2PLinkError(
        P2PLinkErrorCodes.PROTOCOL,
        `Unsupported canonical JSON value: ${typeof value}`,
      );
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
