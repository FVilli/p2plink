import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
} from "@nestjs/common";
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import type { RpcHandlerContext } from "@p2plink/core";
import { P2PLinkServer, type P2PLinkServerConfig } from "@p2plink/server";
import { P2P_HANDLER_METADATA, type P2PHandlerMetadata } from "./decorators.js";
import { P2PLinkBootstrapController } from "./bootstrap-controller.js";
import { P2PLINK_OPTIONS, P2PLINK_SERVER } from "./tokens.js";

export { P2PLINK_OPTIONS, P2PLINK_SERVER } from "./tokens.js";

export type P2PRequestContext = RpcHandlerContext;

export interface P2PLinkModuleOptions extends P2PLinkServerConfig {
  /** Start the server during onModuleInit (default true). */
  autoStart?: boolean;
  /** Register the default POST /p2plink/v1/bootstrap controller. */
  httpBootstrap?: boolean;
}

export interface P2PLinkModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  inject?: InjectionToken[];
  useFactory: (...args: never[]) => P2PLinkModuleOptions | Promise<P2PLinkModuleOptions>;
  global?: boolean;
  /** Register the default POST /p2plink/v1/bootstrap controller. */
  httpBootstrap?: boolean;
}

@Injectable()
export class P2PLinkRegistry implements OnModuleInit, OnApplicationShutdown {
  private readonly registered = new Set<string>();

  constructor(
    @Inject(P2PLINK_OPTIONS) private readonly options: P2PLinkModuleOptions,
    @Inject(P2PLINK_SERVER) private readonly server: P2PLinkServer,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async onModuleInit(): Promise<void> {
    this.discoverHandlers();
    if (this.options.autoStart !== false) await this.server.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.server.stop();
  }

  private discoverHandlers(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | null;
      if (!instance || !wrapper.metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
      if (!prototype) continue;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const method = prototype[methodName];
        if (typeof method !== "function") continue;
        const metadata = this.reflector.get<P2PHandlerMetadata>(P2P_HANDLER_METADATA, method);
        if (!metadata) continue;
        if (this.registered.has(metadata.method)) {
          throw new Error(`Duplicate P2PLink handler for ${metadata.method}`);
        }
        const handler = method as (
          request: unknown,
          context: RpcHandlerContext,
        ) => unknown | Promise<unknown>;
        this.server.register(
          metadata.method,
          (request, context) => handler.call(instance, request, context),
          metadata.options,
        );
        this.registered.add(metadata.method);
      }
    }
  }
}

@Module({})
export class P2PLinkModule {
  static forRoot(options: P2PLinkModuleOptions): DynamicModule {
    return {
      module: P2PLinkModule,
      global: false,
      imports: [DiscoveryModule],
      controllers: options.httpBootstrap ? [P2PLinkBootstrapController] : [],
      providers: [
        { provide: P2PLINK_OPTIONS, useValue: options },
        serverProvider(options),
        P2PLinkRegistry,
      ],
      exports: [P2PLINK_SERVER, P2PLinkRegistry],
    };
  }

  static forRootAsync(options: P2PLinkModuleAsyncOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: P2PLINK_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };
    return {
      module: P2PLinkModule,
      global: options.global ?? false,
      imports: [...(options.imports ?? []), DiscoveryModule],
      controllers: options.httpBootstrap ? [P2PLinkBootstrapController] : [],
      providers: [
        optionsProvider,
        {
          provide: P2PLINK_SERVER,
          useFactory: (resolved: P2PLinkModuleOptions) =>
            new P2PLinkServer(stripModuleOptions(resolved)),
          inject: [P2PLINK_OPTIONS],
        },
        P2PLinkRegistry,
      ],
      exports: [P2PLINK_SERVER, P2PLinkRegistry],
    };
  }
}

function serverProvider(options: P2PLinkModuleOptions): Provider {
  return {
    provide: P2PLINK_SERVER,
    useFactory: () => new P2PLinkServer(stripModuleOptions(options)),
  };
}

function stripModuleOptions(options: P2PLinkModuleOptions): P2PLinkServerConfig {
  const { autoStart: _autoStart, httpBootstrap: _httpBootstrap, ...serverConfig } = options;
  return serverConfig;
}
