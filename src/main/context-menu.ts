import { clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'

// Electron ships no context menu at all — without these handlers, right-click
// does nothing anywhere in the app. Menus are built per right-click from the
// event params; native popup menus hold no state and write nothing to disk.

interface TabMenuActions {
  /** Open a URL as a new background tab; must reject non-http(s) URLs itself. */
  openInNewTab: (url: string) => void
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function editItems(wc: WebContents, flags: Electron.EditFlags): MenuItemConstructorOptions[] {
  return [
    { label: 'Cut', enabled: flags.canCut, click: () => wc.cut() },
    { label: 'Copy', enabled: flags.canCopy, click: () => wc.copy() },
    { label: 'Paste', enabled: flags.canPaste, click: () => wc.paste() },
    { type: 'separator' },
    { label: 'Select All', enabled: flags.canSelectAll, click: () => wc.selectAll() }
  ]
}

export function attachTabContextMenu(wc: WebContents, actions: TabMenuActions): void {
  wc.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    const selection = params.selectionText.trim()

    if (params.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => actions.openInNewTab(params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      )
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => actions.openInNewTab(params.srcURL) },
        { label: 'Copy Image', click: () => wc.copyImageAt(params.x, params.y) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      items.push(...editItems(wc, params.editFlags))
    } else if (selection) {
      items.push(
        { label: 'Copy', enabled: params.editFlags.canCopy, click: () => wc.copy() },
        {
          // DuckDuckGo to match the address bar's default search (App.tsx).
          label: `Search DuckDuckGo for “${truncate(selection, 24)}”`,
          click: () =>
            actions.openInNewTab(`https://duckduckgo.com/?q=${encodeURIComponent(selection)}`)
        }
      )
    }

    if (items.length === 0) {
      items.push(
        {
          label: 'Back',
          enabled: wc.navigationHistory.canGoBack(),
          click: () => wc.navigationHistory.goBack()
        },
        {
          label: 'Forward',
          enabled: wc.navigationHistory.canGoForward(),
          click: () => wc.navigationHistory.goForward()
        },
        { label: 'Reload', click: () => wc.reload() }
      )
    }
    while (items.at(-1)?.type === 'separator') items.pop()
    Menu.buildFromTemplate(items).popup()
  })
}

// The shell renderer only has one meaningful right-click surface: the address
// bar (and any selected toolbar text). Everything else is chrome, so no menu.
export function attachShellContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate(editItems(wc, params.editFlags)).popup()
    } else if (params.selectionText.trim()) {
      Menu.buildFromTemplate([
        { label: 'Copy', enabled: params.editFlags.canCopy, click: () => wc.copy() }
      ]).popup()
    }
  })
}
