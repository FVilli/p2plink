import { SetMetadata } from "@nestjs/common";
import type { RpcHandlerOptions } from "@p2plink/core";

export const P2P_HANDLER_METADATA = Symbol("p2plink:handler");

export interface P2PHandlerMetadata {
  method: string;
  options: RpcHandlerOptions;
}

/**
 * Marks a NestJS provider method as a P2PLink RPC handler.
 * The method signature is `(request, context)`.
 */
export function P2PHandler(method: string, options: RpcHandlerOptions = {}): MethodDecorator {
  return SetMetadata(P2P_HANDLER_METADATA, { method, options } satisfies P2PHandlerMetadata);
}
