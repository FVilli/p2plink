export interface BrokerPeerAccess {
  /** MQTT username; must equal peerId. */
  username: string;
  /** MQTT password; never persist or log it. */
  password: string;
  clientId: string;
  role: string;
}

export interface BrokerAdmin {
  /** Creates a peer MQTT client and assigns the peer role. */
  createPeer(access: BrokerPeerAccess): Promise<void>;
  /** Disables the current client, rotates the password, then enables it. */
  rotatePeer(access: BrokerPeerAccess): Promise<void>;
  /** Disables the client and kicks active MQTT sessions. */
  disablePeer(username: string): Promise<void>;
  /** Re-enables a disabled client. */
  enablePeer(username: string): Promise<void>;
  /** Deletes the client after revocation/cleanup. */
  deletePeer(username: string): Promise<void>;
  /** Publishes a signed revocation event on the registry topic. */
  publishRevocation(event: string): Promise<void>;
  /** Returns true when the admin session is connected. */
  isHealthy(): boolean;
}

export const BROKER_ADMIN = Symbol("BROKER_ADMIN");
