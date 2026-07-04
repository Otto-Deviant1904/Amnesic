import { useEffect, useRef, useState } from 'react'
import type { FindResult } from '../../../shared/ipc'
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from '../icons'

interface FindBarProps {
  tabId: string
  onClose: () => void
}

// Third chrome row driving webContents.findInPage. The shell tells main its
// new chrome height while this is mounted (see App.tsx), because the page's
// WebContentsView sits below the chrome and cannot be overlapped by shell DOM.
export default function FindBar({ tabId, onClose }: FindBarProps) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<FindResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const unsubscribe = window.amnesic.onFindResult((incoming) => {
      if (incoming.tabId === tabId) setResult(incoming)
    })
    return () => {
      unsubscribe()
      // Covers every way the bar goes away (Esc, ✕, tab switch): clear the
      // page's match highlights along with it.
      void window.amnesic.findStop(tabId, false)
    }
  }, [tabId])

  // Electron's findNext flag is the reverse of what the name suggests:
  // true begins a NEW finding session, false continues the current one
  // (verified against electron@43's typings).
  const search = (value: string) => {
    setText(value)
    setResult(null)
    if (value) {
      void window.amnesic.findStart(tabId, value, true, true)
    } else {
      void window.amnesic.findStop(tabId, false)
    }
  }

  const step = (forward: boolean) => {
    if (text) void window.amnesic.findStart(tabId, text, forward, false)
  }

  const close = () => onClose() // unmount cleanup stops the search

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-bar__input"
        value={text}
        placeholder="Find in page"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => search(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            step(!event.shiftKey)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
        }}
      />
      <span className="find-bar__count">
        {text && result
          ? result.matches > 0
            ? `${result.activeMatchOrdinal}/${result.matches}`
            : 'No results'
          : ''}
      </span>
      <button
        type="button"
        className="nav-bar__button find-bar__button"
        disabled={!text || !result || result.matches === 0}
        onClick={() => step(false)}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUpIcon size={13} />
      </button>
      <button
        type="button"
        className="nav-bar__button find-bar__button"
        disabled={!text || !result || result.matches === 0}
        onClick={() => step(true)}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        <ChevronDownIcon size={13} />
      </button>
      <button
        type="button"
        className="nav-bar__button find-bar__button"
        onClick={close}
        aria-label="Close find bar"
        title="Close (Esc)"
      >
        <CloseIcon size={13} />
      </button>
    </div>
  )
}
