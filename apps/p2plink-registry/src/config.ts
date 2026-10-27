const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const integer = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
};

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: integer("PORT", 3200),
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  accessTtlSeconds: integer("JWT_ACCESS_TTL_SECONDS", 900),
  refreshTtlDays: integer("JWT_REFRESH_TTL_DAYS", 30),
  registryKeyFile: process.env.REGISTRY_KEY_FILE ?? "./data/registry-key.json",
  registryKid: process.env.REGISTRY_KID ?? "registry-dev-1",
  registryPublicUrl: process.env.REGISTRY_PUBLIC_URL ?? "http://127.0.0.1:3200",
  mqttPublicUrl: required("MQTT_PUBLIC_URL"),
  mqttAdminUrl: process.env.MQTT_ADMIN_URL ?? "",
  mqttAdminUsername: process.env.MQTT_ADMIN_USERNAME ?? "",
  mqttAdminPassword: process.env.MQTT_ADMIN_PASSWORD ?? "",
  mqttPeerRole: process.env.MQTT_PEER_ROLE ?? "peer",
  mqttRevocationTopic: process.env.MQTT_REVOCATION_TOPIC ?? "p2plink/registry/v1/revocations",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://127.0.0.1:5174",
  certificateTtlDays: integer("CERTIFICATE_TTL_DAYS", 30),
  mqttGrantTtlSeconds: integer("MQTT_GRANT_TTL_SECONDS", 3600),
  challengeTtlSeconds: integer("CHALLENGE_TTL_SECONDS", 300),
} as const;
