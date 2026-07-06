// Session partition naming (ADR 0009 + ADR 0011). Every name produced here is
// non-persistent by construction — no `persist:` prefix anywhere, which is
// what keeps a partition memory-only (the same fact ADR 0009 relies on).
//
// Two never-reused schemes share one prefix:
//   - the shared per-generation partition (containers off) — one session all
//     containers-off tabs share within a generation, rotated by New Identity;
//   - fresh per-tab partitions (containers on) — one session per user-opened
//     tab, keyed by a monotonic counter that is NEVER reset (not even by New
//     Identity), so a per-tab name is never revisited for the life of the
//     process regardless of how the generation moves.
//
// Kept in its own module (like tor.ts / dns.ts) so the pure naming logic is
// unit-testable without importing the Electron main entry point.

export const SESSION_PARTITION_PREFIX = 'inmemory-session'

// The shared partition for a generation (ADR 0009): `inmemory-session-<n>`.
export function sharedPartitionName(generation: number): string {
  return `${SESSION_PARTITION_PREFIX}-${generation}`
}

// A fresh per-tab partition (ADR 0011): `inmemory-session-<generation>-tab-<k>`.
// `k` is a module-level monotonic counter in index.ts, never reset — pairing
// it with the generation makes the name unique across both axes so no per-tab
// session object is ever reused, the zero-reuse invariant ADR 0011 depends on.
export function tabPartitionName(generation: number, counter: number): string {
  return `${SESSION_PARTITION_PREFIX}-${generation}-tab-${counter}`
}
