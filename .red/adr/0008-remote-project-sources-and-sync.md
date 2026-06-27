# 0008 - Remote project sources and multi-user sync

**Status:** proposed - 2026-06-27

## Context

red-request started with one embedded RedDB sidecar per desktop process. That works for
single-user local projects, but it cannot support two users editing the same project unless
both clients talk to the same RedDB source and consume the same ordered change stream.

Connection strings are also product surface, not just storage config. A project can be:

- a local directory-backed `.red/request/app.rdb`
- a remote HTTP/HTTPS RedDB endpoint
- a future RedWire endpoint (`red://`, `reds://`, `red+ws://`, `red+wss://`)
- a future docker target resolved into one of the above transports

## Decision

Introduce an explicit project-source layer. Local projects keep using the managed sidecar.
HTTP/HTTPS connection strings are valid remote project sources and route both RQL and HTTP
API calls to the remote server. Other RedDB transports are recognized but must fail closed
until their bridge exists.

Multi-user sync will not be implemented as ad-hoc client polling. The durable design is:

- mutations remain normal RedDB writes to the shared project store
- app-owned collections emit change records into a durable stream or event queue
- every client has a stable consumer id and stores its last processed offset
- clients replay from their offset on reconnect, then continue tailing changes
- high-level app changes carry typed payloads: collections, requests, environments,
  secrets metadata, settings, reorder operations, and deletes
- secret values stay in the RedDB vault/keychain contract; sync events carry references and
  metadata, not cleartext secrets

Use RedDB streams for replayable ordered state sync. Use queues when a workflow needs
delivery state, ACK/NACK, retry, DLQ, or FANOUT semantics. Prefer RedDB `WITH EVENTS`
where available so source mutations and event emission share the same commit boundary.

## Consequences

- The UI must show remote project state as a real project, not as a fake local folder.
- A failed remote connection lands in the same recovery panel as a failed local open.
- `ws://`/`wss://`/`red+ws://`/`red+wss://` are product-recognized, but require a browser
  RedWire-over-WSS bridge before they can be opened.
- The current HTTP/HTTPS remote support is a stepping stone; it does not yet provide live
  two-user sync. That requires the stream/queue consumer loop above.
