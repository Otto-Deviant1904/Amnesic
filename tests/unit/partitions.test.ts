import { describe, expect, it } from 'vitest'
import {
  SESSION_PARTITION_PREFIX,
  sharedPartitionName,
  tabPartitionName
} from '../../src/main/partitions'

// Partition naming (ADR 0009 + ADR 0011). The guarantee under test is
// zero-reuse: no partition name a session was ever created under is produced
// again, across generation rotations (New Identity) and container toggles.

describe('sharedPartitionName', () => {
  it('is the bare per-generation name, no persist: prefix', () => {
    expect(sharedPartitionName(0)).toBe('inmemory-session-0')
    expect(sharedPartitionName(7)).toBe('inmemory-session-7')
    // The persist: prefix is what would make a partition disk-backed — its
    // absence is the memory-only guarantee (ADR 0009), regression-guarded here.
    expect(sharedPartitionName(0).startsWith('persist:')).toBe(false)
  })
})

describe('tabPartitionName', () => {
  it('encodes both the generation and the monotonic per-tab counter', () => {
    expect(tabPartitionName(0, 1)).toBe('inmemory-session-0-tab-1')
    expect(tabPartitionName(3, 42)).toBe('inmemory-session-3-tab-42')
    expect(tabPartitionName(0, 1).startsWith('persist:')).toBe(false)
  })

  it('never collides with the shared name of the same generation', () => {
    // A fresh per-tab partition must be distinct from the shared session all
    // containers-off tabs of that generation share, or containers-on and
    // containers-off tabs could land in the same session.
    for (let gen = 0; gen < 5; gen++) {
      for (let k = 1; k <= 5; k++) {
        expect(tabPartitionName(gen, k)).not.toBe(sharedPartitionName(gen))
      }
    }
  })

  it('produces a unique name for every (generation, counter) pair', () => {
    // Simulate the real invariant: the counter is monotonic across the whole
    // process and is NOT reset by a generation bump (ADR 0011 decision 2).
    // Even if a generation were somehow revisited, a never-reset counter keeps
    // every per-tab name unique on its own.
    const seen = new Set<string>()
    let counter = 0
    for (let gen = 0; gen < 4; gen++) {
      for (let tab = 0; tab < 10; tab++) {
        const name = tabPartitionName(gen, ++counter)
        expect(seen.has(name)).toBe(false)
        seen.add(name)
      }
    }
    expect(seen.size).toBe(40)
  })

  it('shares one prefix with the shared scheme', () => {
    expect(sharedPartitionName(0).startsWith(SESSION_PARTITION_PREFIX)).toBe(true)
    expect(tabPartitionName(0, 1).startsWith(SESSION_PARTITION_PREFIX)).toBe(true)
  })
})
