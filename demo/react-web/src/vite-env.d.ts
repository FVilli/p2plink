/// <reference types="vite/client" />
declare const __APP_VERSION__: string;
declare module "virtual:pwa-register" {
  export function registerSW(options?: {
    immediate?: boolean;
  }): (reloadPage?: boolean) => Promise<void>;
}
declare interface Window {
  __P2PLINK_DEMO_CONFIG__?: Record<string, unknown>;
  __P2PLINK_DEMO_TEST__?: { setWebRtcEnabled(enabled: boolean): void };
}
