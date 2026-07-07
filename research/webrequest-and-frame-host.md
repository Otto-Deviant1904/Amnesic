# webRequest frame host resolution (Electron 43)

Verified against pinned `electron@43.0.0` type definitions
(`node_modules/electron/electron.d.ts`).

## APIs used

`session.webRequest.onBeforeRequest` delivers
`OnBeforeRequestListenerDetails`, which includes:

```typescript
frame?: WebFrameMain | null
```

`WebFrameMain` exposes:

```typescript
readonly top: WebFrameMain | null
readonly url: string
```

No manual `.parent` walk is required — `details.frame?.top?.url` reaches the
top-level frame's URL directly.

## Tab hostname derivation

```typescript
const topUrl = details.frame?.top?.url ?? details.frame?.url ?? ''
const tabHostname = topUrl ? new URL(topUrl).hostname : null
```

## Fail-open when `frame` is null

Electron's own documentation notes that `frame` can be `null` if the frame already
navigated away or was destroyed by the time the listener fires. Without a reliable tab
host we cannot classify third-party-ness, so the content-blocking callback allows the
request (`callback({})`) rather than guessing. This matches the project's convention of
documenting gaps honestly (cf. proxy `localhost` bypass in `docs/threat-model.md`).

Implementation note (historical): the homemade v1 blocker consumed
`details.frame` this way. The current engine (ADR 0013 swap,
`research/ghostery-adblocker-engine.md`) classifies party via
`details.referrer` + tldts and never touches `details.frame` on the request
path, so the disposed-frame hazard no longer applies to content blocking. This
note remains the reference for any future `webRequest` consumer that does need
the frame's top-level URL.
