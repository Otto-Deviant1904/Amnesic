export interface DohProvider {
  id: string
  label: string
  /** RFC 8484 §3 DoH server template — a plain URI works for POST-based servers. */
  template: string
}

// Deliberately no Google/Cloudflare default (ADR 0010, per the master
// roadmap's explicit "no Google default" instruction): both of these
// publish a no-logging policy and are operated independently of any large
// ad-tech or ISP entity. Exactly two choices, no "custom server" field —
// a free-text DoH template is an easy way to typo yourself into leaking
// queries to an unintended host, and this project would rather ship two
// vetted defaults than a footgun.
export const DOH_PROVIDERS: DohProvider[] = [
  { id: 'quad9', label: 'Quad9', template: 'https://dns.quad9.net/dns-query' },
  { id: 'mullvad', label: 'Mullvad', template: 'https://dns.mullvad.net/dns-query' }
]

export function findDohProvider(id: string): DohProvider | undefined {
  return DOH_PROVIDERS.find((provider) => provider.id === id)
}

export interface HostResolverConfig {
  secureDnsMode: 'off' | 'automatic' | 'secure'
  secureDnsServers?: string[]
}

// null means "off" in this app's own terms — which maps to Electron's
// 'automatic' (opportunistic DoH upgrade when the OS resolver already
// advertises support), not 'off' (which would forbid DoH outright). This
// app never forces plaintext-only; "off" just means "don't force a
// specific provider," matching Chromium's own un-configured default.
export function resolverConfigFor(providerId: string | null): HostResolverConfig {
  if (!providerId) return { secureDnsMode: 'automatic' }
  const provider = findDohProvider(providerId)
  if (!provider) return { secureDnsMode: 'automatic' }
  return { secureDnsMode: 'secure', secureDnsServers: [provider.template] }
}
