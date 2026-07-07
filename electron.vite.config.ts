import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // Bundle the @ghostery/adblocker engine (and its transitive deps) INTO the
    // main output: the packaged app ships out/** but not node_modules
    // (electron-builder.yml), so an externalized require('@ghostery/adblocker')
    // would fail at runtime. electron stays external (provided by the runtime).
    // The frame preload file is shipped separately via extraResources — see
    // blocking.ts framePreloadPath() and ADR 0013.
    plugins: [externalizeDepsPlugin({ exclude: ['@ghostery/adblocker'] })],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/renderer/index.html'
        }
      }
    }
  }
})
