# p2plink-registry

Control-plane service for users, peer identities, signed peer certificates and per-peer MQTT authorization.

The registry **does not carry peer-to-peer traffic** and never receives private peer keys. Mosquitto remains the only transport server; the registry only manages identities and broker accounts.

## Model

```text
User ── login ──► Registry ── creates/revokes ──► Mosquitto
                     │
                     └── signs peer certificate
Peer ══════════════ P2P / MQTT mesh ══════════════ Peer
```

A peer has a stable `peerId`. The MQTT username and client ID are the same `peerId`; the password is generated once and never stored in PostgreSQL.

Flow:

1. an administrator creates a user account;
2. the user logs in with username/password;
3. the client generates an ECDSA P-256 key pair locally;
4. the client requests a one-time challenge and signs it with its private key;
5. the registry validates the proof, creates the MQTT account and signs a peer certificate;
6. the client receives `peerId`, MQTT URL/username/password/client ID and the certificate once; the `clientId` must be used for the MQTT connection;
7. future connections use the pinned peer certificate and rotated MQTT credentials.

There is **no public self-registration**.

## API

Authentication:

```text
POST /v1/auth/login      { username, password }
POST /v1/auth/refresh    { refreshToken }
POST /v1/auth/logout     { refreshToken }
```

Protected peer lifecycle:

```text
POST /v1/peers/challenge
  { purpose: "REGISTER" | "CREDENTIALS", peerId?, publicKeyJwk? }

POST /v1/peers
  { challengeId, nonce, signature, name, publicKeyJwk }

GET  /v1/peers
GET  /v1/peers/:peerId

POST /v1/peers/:peerId/credentials
  { challengeId, nonce, signature }

POST /v1/peers/:peerId/revoke
  { reason? }

GET  /v1/revocations
GET  /v1/registry/keys
GET  /v1/registry/health
GET  /health
GET  /ready
```

Admin-only user management:

```text
GET   /v1/admin/users
POST  /v1/admin/users                 { username, password, role }
PATCH /v1/admin/users/:id/status      { status: "ACTIVE" | "DISABLED" }
```

Passwords are hashed with Argon2id. Access tokens are short-lived JWTs; refresh tokens are opaque, hashed in PostgreSQL and rotated on refresh.

### Challenge proof

The challenge is bound to the authenticated user (and to the peer for credential rotation). The client signs the UTF-8 canonical string:

```text
p2plink-registry:register:<challengeId>:<nonce>
p2plink-registry:credentials:<challengeId>:<nonce>
```

The signature is base64url ECDSA/SHA-256 using the peer key. Challenges are single-use, expire after `CHALLENGE_TTL_SECONDS` and are consumed atomically.

## Peer certificate

The registry signs an ES256 JWS with `typ: p2plink-peer-cert` and claims:

```text
iss: p2plink-registry
aud: p2plink-peer
sub: peerId
userId, jwk, fingerprint, serial, iat, nbf, exp
```

Clients must pin the registry public key from a trusted channel. They must reject:

- bad signature, issuer or audience;
- expired/not-yet-valid certificates;
- `peerId`, key or fingerprint mismatch;
- a changed key for an already pinned `peerId`;
- a revocation for the peer/serial.

`verifyPeerCertificate()` in `src/registry/peer-certificate.ts` is the Node verifier. A browser client can perform the same checks with WebCrypto/JOSE.

## Mosquitto Dynamic Security

The service is the only holder of the broker admin credentials. It uses:

```text
$CONTROL/dynamic-security/v1
$CONTROL/dynamic-security/v1/response
```

Commands are serialized one at a time. A PUBACK is not considered success; the response payload must have no `error`.

On connection the service creates/ensures the `peer` role with ACLs:

```text
publishClientSend  presence/%u
subscribePattern   presence/+

publishClientSend  signal/+/%u
subscribePattern   signal/%u/+

publishClientSend  data/+/%u
subscribePattern   data/%u/+

subscribePattern   p2plink/registry/v1/revocations
```

`disableClient` and `deleteClient` disconnect active MQTT sessions. Certificate revocation is also published as a signed JWS on the revocation topic and exposed via `GET /v1/revocations`.

Broker operations are not transactional with PostgreSQL. If the broker is unavailable, peer creation/rotation fails without returning credentials. Revocation returns `PENDING` rather than claiming success; a reconciliation worker is planned.

## Configuration

Copy `.env.example` to `.env` and set secrets. Important variables:

| Variable                                      | Purpose                                               |
| --------------------------------------------- | ----------------------------------------------------- |
| `DATABASE_URL`                                | PostgreSQL connection                                 |
| `JWT_SECRET`                                  | access-token signing key                              |
| `REGISTRY_KEY_FILE`                           | persistent ES256 registry private/public key file     |
| `REGISTRY_KID`                                | certificate key ID                                    |
| `REGISTRY_PUBLIC_URL`                         | public registry URL                                   |
| `MQTT_PUBLIC_URL`                             | broker URL returned to peers                          |
| `MQTT_ADMIN_URL`                              | broker control connection                             |
| `MQTT_ADMIN_USERNAME` / `MQTT_ADMIN_PASSWORD` | dynamic-security administrator (password >= 12 chars) |
| `MQTT_PEER_ROLE`                              | role auto-created for peers (default `peer`)          |
| `MQTT_REVOCATION_TOPIC`                       | signed revocation topic                               |
| `CERTIFICATE_TTL_DAYS`                        | peer certificate lifetime                             |
| `MQTT_GRANT_TTL_SECONDS`                      | MQTT grant lifetime metadata                          |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | initial admin seed                                    |

The registry key file is generated on first start with mode `0600`; back it up. In production keep it on a persistent volume or HSM-backed signer.

## Local development

```bash
pnpm install
pnpm --filter p2plink-registry exec prisma migrate deploy
SEED_ADMIN_PASSWORD='a-long-admin-password' pnpm --filter p2plink-registry db:seed
pnpm --filter p2plink-registry dev
```

`pnpm --filter p2plink-registry test` runs the unit tests. `pnpm --filter p2plink-registry build` compiles the service.

## Docker Compose

The compose file contains PostgreSQL, Mosquitto with Dynamic Security, migration, seed and registry services.

```bash
POSTGRES_PASSWORD='...' \
JWT_SECRET='at-least-32-random-bytes' \
MQTT_ADMIN_PASSWORD='at-least-12-chars' \
SEED_ADMIN_PASSWORD='...' \
docker compose up --build
```

Mosquitto 2.1+ generates its Dynamic Security file on first start. The registry then ensures the `peer` role. The development listeners are plaintext; terminate TLS/WSS in front of both services for production. Never expose the admin listener or PostgreSQL publicly.

## Security limits

- The registry is a central trust authority: a compromised registry can mint identities.
- Revoking MQTT credentials does not instantly close an already established direct WebRTC session. Peers must consume the signed revocation event and enforce certificate expiry/pinning.
- MQTT ACLs protect broker access; they do not replace peer signature verification.
- No persistent event delivery or exactly-once guarantee is provided.
- The service is a control plane. It does not implement multi-hop routing or the demo mesh.
