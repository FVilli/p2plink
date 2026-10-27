/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { connect } from "mqtt";
import { config } from "../config.js";
import { type BrokerAdmin, type BrokerPeerAccess } from "./broker-admin.interface.js";

const CONTROL_TOPIC = "$CONTROL/dynamic-security/v1";
const RESPONSE_TOPIC = "$CONTROL/dynamic-security/v1/response";
const TIMEOUT_MS = 5_000;

type ControlTransport = {
  publish(
    topic: string,
    payload: string,
    options: { qos: 1 },
    callback: (error?: Error) => void,
  ): void;
  subscribe(topic: string, callback: (error?: Error) => void): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  end(force?: boolean): void;
};

@Injectable()
export class MosquittoAdminService implements BrokerAdmin, OnModuleInit, OnModuleDestroy {
  private client: ControlTransport | undefined;
  private connected = false;
  private subscribed = false;
  private queue: Promise<void> = Promise.resolve();
  private responseHandler: ((topic: string, payload: Buffer) => void) | undefined;
  private pendingCommand: string | undefined;

  private readonly transportFactory: (
    url: string,
    options: Record<string, unknown>,
  ) => ControlTransport = connect as any;

  onModuleInit(): void {
    const url = config.mqttAdminUrl;
    if (!url) return;
    const secure = url.startsWith("mqtts:") || url.startsWith("wss:");
    const client = this.transportFactory(url, {
      username: config.mqttAdminUsername,
      password: config.mqttAdminPassword,
      clientId: `p2plink-registry-admin-${process.pid}`,
      keepalive: 30,
      reconnectPeriod: 1000,
      ...(secure
        ? { rejectUnauthorized: true, protocol: url.startsWith("wss:") ? "wss" : "mqtts" }
        : {}),
    });
    this.client = client;
    client.on("connect", () => {
      this.connected = true;
      this.subscribed = false;
      client.subscribe(RESPONSE_TOPIC, (error) => {
        this.subscribed = !error;
        if (error) {
          this.connected = false;
          return;
        }
        void this.enqueue(() => this.ensurePeerRole());
      });
    });
    client.on("message", (topic, payload) => {
      if (topic === RESPONSE_TOPIC) this.responseHandler?.(topic, payload);
    });
    client.on("close", () => {
      this.connected = false;
      this.subscribed = false;
    });
    client.on("offline", () => {
      this.connected = false;
      this.subscribed = false;
    });
    client.on("error", () => {
      this.connected = false;
    });
  }

  onModuleDestroy(): void {
    this.connected = false;
    this.client?.end(true);
  }
  isHealthy(): boolean {
    return this.connected && this.subscribed;
  }

  private async ensurePeerRole(): Promise<void> {
    try {
      await this.command({ command: "createRole", rolename: config.mqttPeerRole });
    } catch (error) {
      if (!this.alreadyExists(error)) return;
    }
    const rules: Array<[string, string]> = [
      ["publishClientSend", "presence/%u"],
      ["subscribePattern", "presence/+"],
      ["publishClientSend", "signal/+/%u"],
      ["subscribePattern", "signal/%u/+"],
      ["publishClientSend", "data/+/%u"],
      ["subscribePattern", "data/%u/+"],
      ["subscribePattern", config.mqttRevocationTopic],
    ];
    for (const [acltype, topic] of rules) {
      try {
        await this.command({
          command: "addRoleACL",
          rolename: config.mqttPeerRole,
          acltype,
          topic,
          allow: true,
          priority: 10,
        });
      } catch (error) {
        if (!this.alreadyExists(error)) throw error;
      }
    }
  }

  createPeer(access: BrokerPeerAccess): Promise<void> {
    return this.enqueue(async () => {
      await this.command({
        command: "createClient",
        username: access.username,
        password: access.password,
        clientid: access.clientId,
      });
      await this.command({
        command: "addClientRole",
        username: access.username,
        rolename: config.mqttPeerRole,
        priority: 1,
      });
    });
  }
  rotatePeer(access: BrokerPeerAccess): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.command({ command: "disableClient", username: access.username });
      } catch (error) {
        if (!this.notFound(error)) throw error;
      }
      await this.command({
        command: "setClientPassword",
        username: access.username,
        password: access.password,
      });
      await this.command({ command: "enableClient", username: access.username });
    });
  }
  disablePeer(username: string): Promise<void> {
    return this.enqueue(() => this.command({ command: "disableClient", username }));
  }
  enablePeer(username: string): Promise<void> {
    return this.enqueue(() => this.command({ command: "enableClient", username }));
  }
  deletePeer(username: string): Promise<void> {
    return this.enqueue(() => this.command({ command: "deleteClient", username }));
  }
  publishRevocation(event: string): Promise<void> {
    return this.enqueue(
      () =>
        new Promise((resolve, reject) => {
          if (!this.isHealthy() || !this.client) return reject(this.unavailable());
          this.client.publish(config.mqttRevocationTopic, event, { qos: 1 }, (error) =>
            error ? reject(this.unavailable(error)) : resolve(),
          );
        }),
    );
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private command(command: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.isHealthy() || !this.client) return reject(this.unavailable());
      const expected = typeof command.command === "string" ? command.command : "";
      this.pendingCommand = expected;
      const timer = setTimeout(() => {
        // Never let a late response satisfy the next command.
        this.responseHandler = undefined;
        this.pendingCommand = undefined;
        this.connected = false;
        this.subscribed = false;
        this.client?.end(true);
        this.client = undefined;
        const reconnect = setTimeout(() => {
          if (!this.client) this.onModuleInit();
        }, 500);
        reconnect.unref?.();
        reject(new Error("Dynamic Security response timed out"));
      }, TIMEOUT_MS);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.responseHandler = undefined;
        this.pendingCommand = undefined;
        if (error) reject(error);
        else resolve();
      };
      this.responseHandler = (_topic, payload) => {
        let response: { responses?: Array<{ command?: string; error?: unknown }> };
        try {
          response = JSON.parse(payload.toString()) as typeof response;
        } catch {
          finish(new Error("Invalid Dynamic Security response"));
          return;
        }
        const first = response.responses?.[0];
        if (!first) {
          finish(new Error("Empty Dynamic Security response"));
          return;
        }
        if (first.command !== expected || this.pendingCommand !== expected) return;
        const error = first.error;
        if (error) finish(new Error(typeof error === "string" ? error : JSON.stringify(error)));
        else finish();
      };
      this.client!.publish(
        CONTROL_TOPIC,
        JSON.stringify({ commands: [command] }),
        { qos: 1 },
        (error) => {
          if (error) finish(this.unavailable(error));
        },
      );
    });
  }

  private notFound(error: unknown): boolean {
    return error instanceof Error && /not found|does not exist/i.test(error.message);
  }
  private alreadyExists(error: unknown): boolean {
    return error instanceof Error && /already exists|duplicate/i.test(error.message);
  }
  private unavailable(cause?: Error): ServiceUnavailableException {
    return new ServiceUnavailableException(
      `Mosquitto Dynamic Security admin unavailable${cause ? `: ${cause.message}` : ""}`,
    );
  }
}
