import { describe, it, expect } from 'vitest'
import { describeNetError } from '../../src/renderer/src/components/ErrorPage'
import type { TabLoadError } from '../../src/shared/ipc'

function makeError(code: number, description = 'ERR_SOMETHING'): TabLoadError {
  return { code, description, url: 'https://example.com/' }
}

describe('describeNetError', () => {
  it('maps DNS failure to a "site not found" message', () => {
    const { title } = describeNetError(makeError(-105, 'ERR_NAME_NOT_RESOLVED'))
    expect(title).toBe('Site not found')
  })

  it('maps connection refused and timeouts', () => {
    expect(describeNetError(makeError(-102)).title).toBe('Connection refused')
    expect(describeNetError(makeError(-7)).title).toBe('Connection timed out')
    expect(describeNetError(makeError(-118)).title).toBe('Connection timed out')
  })

  it('maps every certificate error code (-2xx) to the no-bypass message', () => {
    for (const code of [-200, -201, -202, -213, -299]) {
      const { title, detail } = describeNetError(makeError(code, 'ERR_CERT_AUTHORITY_INVALID'))
      expect(title).toBe('This connection is not secure')
      expect(detail).toContain('no way to proceed')
    }
  })

  it('does not treat -3xx codes as certificate errors', () => {
    expect(describeNetError(makeError(-300)).title).toBe('This page could not be loaded')
  })

  it('falls back to a generic message for unknown codes', () => {
    const { title } = describeNetError(makeError(-999))
    expect(title).toBe('This page could not be loaded')
  })
})
