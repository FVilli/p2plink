# @p2plink/angular

Part of [P2PLink](https://github.com/FVilli/p2plink): WebRTC DataChannel with MQTT signaling and fallback, typed RPC, events and end-to-end payload protection.

See the [main README](https://github.com/FVilli/p2plink#readme) and the [documentation](https://github.com/FVilli/p2plink/tree/main/docs).

## Byte formatting

Standalone component and pipe for counters:

```html
<p2p-byte-size [bytes]="peer.p2pBytes" /> {{ peer.mqttBytes | p2pByteSize }}
```

Output examples: `512 B`, `1.5 KB`, `2.0 MB`. The unit is selected automatically.

MIT licensed. Not published to npm yet.
