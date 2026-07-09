import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MenuItemConstructorOptions, WebContents } from 'electron'
import { sharedPartitionName, tabPartitionName } from '../../src/main/partitions'

// Unit tests for src/main/context-menu.ts — the right-click wiring for tab
// pages and the shell. The security-relevant contract under test is "Open
// Link in New Tab": index.ts binds openInNewTab to the OPENER's session
// (ADR 0011 decision 3), so a container's links must stay in its container.
// A regression here would silently leak containers-mode isolation, which is
// why the propagation is asserted end-to-end below against a harness that
// mirrors index.ts's createTab/openUserTab wiring exactly.
//
// Electron is mocked: Menu.buildFromTemplate captures the template so tests
// click real items, clipboard records writes. Everything else (WebContents,
// sessions) is a plain fake — no Electron runtime in unit tests, matching
// this suite's convention (the live-runtime paths belong to e2e).

const { menuMock, clipboardMock } = vi.hoisted(() => {
  const builtMenus: MenuItemConstructorOptions[][] = []
  return {
    menuMock: {
      builtMenus,
      buildFromTemplate: vi.fn((template: MenuItemConstructorOptions[]) => {
        builtMenus.push(template)
        return { popup: vi.fn() }
      })
    },
    clipboardMock: { writeText: vi.fn() }
  }
})

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: menuMock.buildFromTemplate },
  clipboard: clipboardMock
}))

import { attachTabContextMenu, attachShellContextMenu } from '../../src/main/context-menu'

// --- Fakes -----------------------------------------------------------------

const EDIT_FLAGS_NONE = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  canEditRichly: false
}

const PARAMS_DEFAULTS = {
  x: 10,
  y: 20,
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  selectionText: '',
  isEditable: false,
  editFlags: EDIT_FLAGS_NONE
}

type FakeParams = typeof PARAMS_DEFAULTS

function fakeWebContents() {
  const handlers = new Map<string, (event: unknown, params: FakeParams) => void>()
  const wc = {
    on: (event: string, handler: (event: unknown, params: FakeParams) => void) => {
      handlers.set(event, handler)
      return wc
    },
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    copyImageAt: vi.fn(),
    reload: vi.fn(),
    navigationHistory: {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn()
    },
    rightClick(overrides: Partial<FakeParams> = {}) {
      const handler = handlers.get('context-menu')
      if (!handler) throw new Error('no context-menu handler attached')
      handler({}, { ...PARAMS_DEFAULTS, ...overrides })
    }
  }
  return wc
}

type FakeWebContents = ReturnType<typeof fakeWebContents>

function asWebContents(wc: FakeWebContents): WebContents {
  return wc as unknown as WebContents
}

function lastMenu(): MenuItemConstructorOptions[] {
  const menu = menuMock.builtMenus.at(-1)
  if (!menu) throw new Error('no menu was built')
  return menu
}

function findItem(label: string): MenuItemConstructorOptions {
  const item = lastMenu().find((i) => i.label?.startsWith(label))
  if (!item) {
    const labels = lastMenu()
      .map((i) => i.label ?? `<${i.type}>`)
      .join(', ')
    throw new Error(`menu item "${label}" not found in [${labels}]`)
  }
  return item
}

function clickItem(label: string): void {
  const item = findItem(label)
  if (!item.click) throw new Error(`menu item "${label}" has no click handler`)
  ;(item.click as () => void)()
}

// --- Session-propagation harness -------------------------------------------
//
// Mirrors index.ts exactly (same partition-name modules, same memoized
// fromPartition identity, same opener-bound openInNewTab closure with the same
// isAllowedUrl gate) so the assertions below are about which session a tab
// opened FROM THE CONTEXT MENU ends up on — the invariant ADR 0011 decision 3
// depends on. If index.ts's wiring ever diverges from this shape, these tests
// document what it must still guarantee.

interface FakeTab {
  session: { partition: string }
  url: string | undefined
  background: boolean
  wc: FakeWebContents
}

function makeTabHarness() {
  // session.fromPartition() returns the SAME object for the same name — the
  // identity fact index.ts's shared-session scheme relies on.
  const sessions = new Map<string, { partition: string }>()
  const fromPartition = (name: string) => {
    let ses = sessions.get(name)
    if (!ses) {
      ses = { partition: name }
      sessions.set(name, ses)
    }
    return ses
  }

  const state = { containersEnabled: false, generation: 0, tabCounter: 0 }
  const tabs: FakeTab[] = []

  // Mirrors createTab(): every tab gets the context menu with an
  // opener-session-bound openInNewTab, gated on http(s) exactly like index.ts.
  function createTab(
    ses: { partition: string },
    url?: string,
    options: { background?: boolean } = {}
  ): FakeTab {
    const wc = fakeWebContents()
    attachTabContextMenu(asWebContents(wc), {
      openInNewTab: (linkUrl) => {
        if (/^https?:\/\//i.test(linkUrl)) createTab(ses, linkUrl, { background: true })
      }
    })
    const tab: FakeTab = { session: ses, url, background: options.background ?? false, wc }
    tabs.push(tab)
    return tab
  }

  // Mirrors openUserTab(): fresh per-tab partition when containers are on,
  // the shared per-generation session otherwise.
  function openUserTab(url?: string): FakeTab {
    const ses = state.containersEnabled
      ? fromPartition(tabPartitionName(state.generation, ++state.tabCounter))
      : fromPartition(sharedPartitionName(state.generation))
    return createTab(ses, url)
  }

  return { state, tabs, openUserTab }
}

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  menuMock.builtMenus.length = 0
  vi.clearAllMocks()
})

describe('attachTabContextMenu — opener session propagation (ADR 0011 decision 3)', () => {
  it('containers OFF: a link opened from the context menu lands on the shared session', () => {
    const harness = makeTabHarness()
    const opener = harness.openUserTab('https://site.test/')

    opener.wc.rightClick({ linkURL: 'https://example.com/page' })
    clickItem('Open Link in New Tab')

    expect(harness.tabs).toHaveLength(2)
    const [, opened] = harness.tabs
    expect(opened!.url).toBe('https://example.com/page')
    expect(opened!.background).toBe(true)
    // Same session OBJECT as the opener — the shared per-generation session.
    expect(opened!.session).toBe(opener.session)
    expect(opened!.session.partition).toBe(sharedPartitionName(0))
  })

  it("containers ON: the link stays in the opener tab's container, never a fresh one", () => {
    const harness = makeTabHarness()
    harness.state.containersEnabled = true
    const tabA = harness.openUserTab('https://a.test/')
    const tabB = harness.openUserTab('https://b.test/')
    // Two user tabs, two distinct containers — the premise of the test.
    expect(tabA.session).not.toBe(tabB.session)
    const counterBefore = harness.state.tabCounter

    tabA.wc.rightClick({ linkURL: 'https://example.com/login' })
    clickItem('Open Link in New Tab')

    const opened = harness.tabs.at(-1)!
    // Inherits tab A's container — not tab B's, and NOT a fresh partition:
    // a fresh partition would break OAuth-style flows, while landing on
    // another tab's session would leak isolation across containers.
    expect(opened.session).toBe(tabA.session)
    expect(opened.session.partition).toBe(tabPartitionName(0, 1))
    expect(harness.state.tabCounter).toBe(counterBefore)
  })

  it('containers toggled ON after the opener existed: links still follow the opener session', () => {
    const harness = makeTabHarness()
    const opener = harness.openUserTab('https://site.test/') // shared session (containers were off)
    harness.state.containersEnabled = true // affects only tabs created after (decision 1)

    opener.wc.rightClick({ linkURL: 'https://example.com/' })
    clickItem('Open Link in New Tab')

    expect(harness.tabs.at(-1)!.session).toBe(opener.session)
    expect(harness.tabs.at(-1)!.session.partition).toBe(sharedPartitionName(0))
  })

  it('non-http(s) link URLs never become tabs (the action gate index.ts installs)', () => {
    const harness = makeTabHarness()
    const opener = harness.openUserTab('https://site.test/')

    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'about:blank']) {
      opener.wc.rightClick({ linkURL: url })
      clickItem('Open Link in New Tab')
    }

    expect(harness.tabs).toHaveLength(1) // only the opener
  })

  it('"Open Image in New Tab" propagates the opener session for the image URL too', () => {
    const harness = makeTabHarness()
    const opener = harness.openUserTab('https://site.test/')

    opener.wc.rightClick({ mediaType: 'image', srcURL: 'https://cdn.test/pic.png' })
    clickItem('Open Image in New Tab')

    const opened = harness.tabs.at(-1)!
    expect(opened.url).toBe('https://cdn.test/pic.png')
    expect(opened.session).toBe(opener.session)
  })

  it('the DuckDuckGo search item opens the encoded query through the same opener-bound action', () => {
    const harness = makeTabHarness()
    const opener = harness.openUserTab('https://site.test/')

    opener.wc.rightClick({
      selectionText: '  amnesic browser  ',
      editFlags: { ...EDIT_FLAGS_NONE, canCopy: true }
    })
    clickItem('Search DuckDuckGo')

    const opened = harness.tabs.at(-1)!
    expect(opened.url).toBe('https://duckduckgo.com/?q=amnesic%20browser')
    expect(opened.session).toBe(opener.session)
  })
})

describe('attachTabContextMenu — menu construction', () => {
  function attach(actions = { openInNewTab: vi.fn() }) {
    const wc = fakeWebContents()
    attachTabContextMenu(asWebContents(wc), actions)
    return { wc, actions }
  }

  it('link context: copies the link address to the clipboard', () => {
    const { wc } = attach()
    wc.rightClick({ linkURL: 'https://example.com/x' })
    clickItem('Copy Link Address')
    expect(clipboardMock.writeText).toHaveBeenCalledWith('https://example.com/x')
  })

  it('link-only menu has its trailing separator trimmed', () => {
    const { wc } = attach()
    wc.rightClick({ linkURL: 'https://example.com/x' })
    expect(lastMenu().at(-1)?.type).not.toBe('separator')
  })

  it('image context: copy image / copy image address act on the right coordinates and URL', () => {
    const { wc } = attach()
    wc.rightClick({ mediaType: 'image', srcURL: 'https://cdn.test/a.png', x: 33, y: 44 })
    clickItem('Copy Image')
    expect(wc.copyImageAt).toHaveBeenCalledWith(33, 44)
    clickItem('Copy Image Address')
    expect(clipboardMock.writeText).toHaveBeenCalledWith('https://cdn.test/a.png')
  })

  it('editable context: shows edit items honoring editFlags and dispatching to the webContents', () => {
    const { wc } = attach()
    wc.rightClick({
      isEditable: true,
      editFlags: { ...EDIT_FLAGS_NONE, canCopy: true, canPaste: true, canSelectAll: true }
    })
    expect(findItem('Cut').enabled).toBe(false)
    expect(findItem('Copy').enabled).toBe(true)
    expect(findItem('Paste').enabled).toBe(true)
    clickItem('Paste')
    expect(wc.paste).toHaveBeenCalledTimes(1)
    clickItem('Select All')
    expect(wc.selectAll).toHaveBeenCalledTimes(1)
  })

  it('plain page context: falls back to Back / Forward / Reload gated on navigationHistory', () => {
    const { wc } = attach()
    wc.navigationHistory.canGoBack.mockReturnValue(true)
    wc.rightClick({})
    expect(findItem('Back').enabled).toBe(true)
    expect(findItem('Forward').enabled).toBe(false)
    clickItem('Back')
    expect(wc.navigationHistory.goBack).toHaveBeenCalledTimes(1)
    clickItem('Reload')
    expect(wc.reload).toHaveBeenCalledTimes(1)
  })
})

describe('attachShellContextMenu', () => {
  it('editable shell surface (address bar) gets the edit menu', () => {
    const wc = fakeWebContents()
    attachShellContextMenu(asWebContents(wc))
    wc.rightClick({ isEditable: true, editFlags: { ...EDIT_FLAGS_NONE, canCut: true } })
    expect(findItem('Cut').enabled).toBe(true)
    clickItem('Cut')
    expect(wc.cut).toHaveBeenCalledTimes(1)
  })

  it('non-editable selection gets Copy only', () => {
    const wc = fakeWebContents()
    attachShellContextMenu(asWebContents(wc))
    wc.rightClick({ selectionText: 'hello', editFlags: { ...EDIT_FLAGS_NONE, canCopy: true } })
    expect(lastMenu()).toHaveLength(1)
    clickItem('Copy')
    expect(wc.copy).toHaveBeenCalledTimes(1)
  })

  it('bare chrome (no selection, not editable) shows no menu at all', () => {
    const wc = fakeWebContents()
    attachShellContextMenu(asWebContents(wc))
    wc.rightClick({})
    expect(menuMock.builtMenus).toHaveLength(0)
  })
})
