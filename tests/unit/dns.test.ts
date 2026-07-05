import { describe, expect, it } from 'vitest'
import { DOH_PROVIDERS, findDohProvider, resolverConfigFor } from '../../src/main/dns'

describe('DOH_PROVIDERS', () => {
  it('offers exactly two privacy-first providers, no Google/Cloudflare default', () => {
    expect(DOH_PROVIDERS).toHaveLength(2)
    const ids = DOH_PROVIDERS.map((p) => p.id)
    expect(ids).toEqual(['quad9', 'mullvad'])
    for (const provider of DOH_PROVIDERS) {
      expect(provider.template).toMatch(/^https:\/\//)
      expect(provider.template).not.toMatch(/google|cloudflare/i)
    }
  })
})

describe('findDohProvider', () => {
  it('finds a known provider by id', () => {
    expect(findDohProvider('quad9')?.label).toBe('Quad9')
    expect(findDohProvider('mullvad')?.label).toBe('Mullvad')
  })

  it('returns undefined for an unknown id', () => {
    expect(findDohProvider('opendns')).toBeUndefined()
  })
})

describe('resolverConfigFor', () => {
  it('maps null (off) to automatic, never forcing plaintext-only', () => {
    expect(resolverConfigFor(null)).toEqual({ secureDnsMode: 'automatic' })
  })

  it('maps an unknown provider id to automatic rather than throwing', () => {
    expect(resolverConfigFor('not-a-real-provider')).toEqual({ secureDnsMode: 'automatic' })
  })

  it('maps a known provider to secure mode with exactly that one server', () => {
    expect(resolverConfigFor('quad9')).toEqual({
      secureDnsMode: 'secure',
      secureDnsServers: ['https://dns.quad9.net/dns-query']
    })
    expect(resolverConfigFor('mullvad')).toEqual({
      secureDnsMode: 'secure',
      secureDnsServers: ['https://dns.mullvad.net/dns-query']
    })
  })
})
