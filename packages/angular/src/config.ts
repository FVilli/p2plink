import { InjectionToken, makeEnvironmentProviders, type EnvironmentProviders } from "@angular/core";
import type { EventContract, RpcContract } from "@p2plink/core";
import { createP2PLinkClient, type P2PLinkClient, type P2PLinkClientConfig } from "@p2plink/client";

export interface P2PLinkAngularOptions {
  /** Connect as soon as the root service is instantiated (default true). */
  autoConnect?: boolean;
}

export const P2PLINK_CONFIG = new InjectionToken<P2PLinkClientConfig>("P2PLINK_CONFIG");
export const P2PLINK_ANGULAR_OPTIONS = new InjectionToken<P2PLinkAngularOptions>(
  "P2PLINK_ANGULAR_OPTIONS",
);
export const P2PLINK_CLIENT = new InjectionToken<P2PLinkClient<RpcContract, EventContract>>(
  "P2PLINK_CLIENT",
);

/** Standalone provider for a browser P2PLink client. */
export function provideP2PLink(
  config: P2PLinkClientConfig,
  options: P2PLinkAngularOptions = {},
): EnvironmentProviders {
  return provideP2PLinkClient(createP2PLinkClient(config), options, config);
}

/** Provider for tests or applications that build their own client. */
export function provideP2PLinkClient(
  client: P2PLinkClient<RpcContract, EventContract>,
  options: P2PLinkAngularOptions = {},
  config?: P2PLinkClientConfig,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: P2PLINK_CLIENT, useValue: client },
    { provide: P2PLINK_ANGULAR_OPTIONS, useValue: options },
    ...(config === undefined ? [] : [{ provide: P2PLINK_CONFIG, useValue: config }]),
  ]);
}
