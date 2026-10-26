import { P2PLinkError, P2PLinkErrorCodes } from "./errors.js";
import { utf8Decode, utf8Encode } from "./util.js";

export interface Codec {
  readonly name: string;
  encode(value: unknown, maxBytes?: number): Uint8Array;
  decode(bytes: Uint8Array, maxBytes?: number): unknown;
}

export class JsonCodec implements Codec {
  readonly name = "json";

  encode(value: unknown, maxBytes = 64 * 1024): Uint8Array {
    let text: string;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Value is not JSON serializable", {
        cause: error,
      });
    }
    const bytes = utf8Encode(text);
    if (bytes.length > maxBytes) {
      throw new P2PLinkError(
        P2PLinkErrorCodes.PAYLOAD_TOO_LARGE,
        `Encoded value is ${bytes.length} bytes, limit is ${maxBytes}`,
      );
    }
    return bytes;
  }

  decode(bytes: Uint8Array, maxBytes = 64 * 1024): unknown {
    if (bytes.length > maxBytes) {
      throw new P2PLinkError(P2PLinkErrorCodes.PAYLOAD_TOO_LARGE, "Encoded value too large");
    }
    try {
      return JSON.parse(utf8Decode(bytes)) as unknown;
    } catch (error) {
      throw new P2PLinkError(P2PLinkErrorCodes.PROTOCOL, "Malformed JSON", { cause: error });
    }
  }
}

export const jsonCodec = new JsonCodec();
