import {
  P2PLinkError,
  P2PLinkErrorCodes,
  isPlainObject,
  type BootstrapProvider,
  type BootstrapRequest,
  type BootstrapResult,
  type MqttCredentials,
} from "@p2plink/core";
import { validatePublicJwk } from "@p2plink/crypto";

export interface HttpBootstrapOptions {
  /** Full endpoint URL, e.g. https://api.example.com/p2plink/v1/bootstrap */
  url: string;
  getAccessToken(): Promise<string> | string;
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** HTTPS bootstrap provider. The application bearer token never reaches MQTT. */
export function httpBootstrapProvider(options: HttpBootstrapOptions): BootstrapProvider {
  const url = validateBootstrapUrl(options.url, options.allowInsecureHttp ?? false);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "fetch is not available");
  }
  return {
    async bootstrap(request: BootstrapRequest): Promise<BootstrapResult> {
      const token = await options.getAccessToken();
      if (!token) {
        throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "No bootstrap access token");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
      timer.unref?.();
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
          credentials: "omit",
        });
        if (!response.ok) {
          const code =
            response.status === 401 || response.status === 403
              ? P2PLinkErrorCodes.AUTH_FAILED
              : P2PLinkErrorCodes.TRANSPORT_UNAVAILABLE;
          throw new P2PLinkError(code, `Bootstrap failed with HTTP ${response.status}`, {
            retryable: response.status >= 500,
          });
        }
        return validateBootstrapResult(await response.json());
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function staticBootstrapProvider(
  result: BootstrapResult | (() => BootstrapResult | Promise<BootstrapResult>),
): BootstrapProvider {
  return {
    async bootstrap(): Promise<BootstrapResult> {
      return validateBootstrapResult(typeof result === "function" ? await result() : result);
    },
  };
}

export function validateBootstrapResult(value: unknown): BootstrapResult {
  if (!isPlainObject(value)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed bootstrap response");
  }
  if (typeof value.capability !== "string" || value.capability.length < 32) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Missing bootstrap capability");
  }
  if (typeof value.clientId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(value.clientId)) {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Invalid bootstrap client id");
  }
  if (typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) {
    throw new P2PLinkError(P2PLinkErrorCodes.AUTH_FAILED, "Bootstrap response expired");
  }
  if (!isPlainObject(value.server) || typeof value.server.identityId !== "string") {
    throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Missing server identity");
  }
  validatePublicJwk(value.server.publicKeyJwk as JsonWebKey);
  let mqtt: MqttCredentials | undefined;
  if (value.mqtt !== undefined) {
    if (!isPlainObject(value.mqtt)) {
      throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed MQTT bootstrap credentials");
    }
    mqtt = {
      ...(typeof value.mqtt.url === "string" ? { url: value.mqtt.url } : {}),
      ...(typeof value.mqtt.username === "string" ? { username: value.mqtt.username } : {}),
      ...(typeof value.mqtt.password === "string" ? { password: value.mqtt.password } : {}),
      ...(typeof value.mqtt.clientId === "string" ? { clientId: value.mqtt.clientId } : {}),
    };
  }
  return {
    capability: value.capability,
    clientId: value.clientId,
    expiresAt: value.expiresAt,
    server: {
      identityId: value.server.identityId,
      publicKeyJwk: value.server.publicKeyJwk as JsonWebKey,
    },
    ...(mqtt === undefined ? {} : { mqtt }),
  };
}

function validateBootstrapUrl(raw: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new P2PLinkError(P2PLinkErrorCodes.INVALID_CONFIG, "Invalid bootstrap URL");
  }
  if (url.protocol !== "https:" && !(allowInsecureHttp && url.protocol === "http:")) {
    throw new P2PLinkError(
      P2PLinkErrorCodes.INVALID_CONFIG,
      "Bootstrap URL must use https (allowInsecureBootstrap is for local development only)",
    );
  }
  return url.toString();
}
