/// <reference types="vite/client" />

import type { AmnesicBridge } from '../../shared/ipc'

declare global {
  interface Window {
    amnesic: AmnesicBridge
  }
}
