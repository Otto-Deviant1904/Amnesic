import { describe, it, expect } from 'vitest'
import { diskBackedSwapDevices } from '../../src/main/swap'

const HEADER = 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority'

describe('diskBackedSwapDevices', () => {
  it('returns empty for no swap', () => {
    expect(diskBackedSwapDevices(`${HEADER}\n`)).toEqual([])
    expect(diskBackedSwapDevices('')).toEqual([])
  })

  it('reports a disk partition', () => {
    const content = `${HEADER}\n/dev/nvme0n1p3                          partition\t9227464\t0\t\t-1\n`
    expect(diskBackedSwapDevices(content)).toEqual(['/dev/nvme0n1p3'])
  })

  it('reports a swap file', () => {
    const content = `${HEADER}\n/swapfile                               file\t\t4194300\t0\t\t-2\n`
    expect(diskBackedSwapDevices(content)).toEqual(['/swapfile'])
  })

  it('ignores zram devices (compressed RAM, never touches disk)', () => {
    const content = `${HEADER}\n/dev/zram0                              partition\t8388604\t0\t\t100\n`
    expect(diskBackedSwapDevices(content)).toEqual([])
  })

  it('reports only the disk device when zram and disk swap coexist', () => {
    const content = [
      HEADER,
      '/dev/zram0                              partition\t8388604\t0\t\t100',
      '/dev/sda2                               partition\t2097148\t0\t\t-2',
      ''
    ].join('\n')
    expect(diskBackedSwapDevices(content)).toEqual(['/dev/sda2'])
  })
})
