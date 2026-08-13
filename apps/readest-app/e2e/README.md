# End-to-end tests

Readest has a single end-to-end lane that drives the actual **Tauri** desktop
shell via WebdriverIO.

## Tauri lane — WebdriverIO

Drives the actual **Tauri** desktop shell via `tauri-driver`. Use this for
coverage that depends on the native build (Rust integration, window
management, platform globals).

```bash
pnpm tauri:dev:test        # start the Tauri app with the webdriver feature
pnpm test:e2e              # run wdio against it (specs: e2e/*.e2e.ts)
```

