# WUF Translate

TypeScript browser extension. This project contains only the WUF implementation;
the Go service is maintained separately in `../WUF-Watchdog`.

## Development

Use Node.js 22.18+ (native TypeScript stripping) and npm:

```powershell
npm ci
npm run typecheck
npm test
```

Load `dist/wuf` as an unpacked extension in Edge or Chrome after building.
The existing public extension key is preserved; do not regenerate identity.json
for the installed extension. No signing private key is included.

The extension connects to the Watchdog HTTP API on `127.0.0.1:8080` and native
host `com.wuf_translate.watchdog`; it does not import Watchdog source files.
Local/online provider settings remain in browser storage.

`tests/fixtures/legacy-public-key.json` contains only a public key used to assert
that WUF has its own extension identity. Legacy extension code/tests are excluded.

`node_modules`, `dist`, diagnostic outputs and local credentials are excluded from
Git. Dependencies were copied from the existing installation for offline validation.
Keep the existing LICENSE when publishing; this split does not change its terms.

The original worktree remains at
`C:/LLM_Project/translation_tools/wuf-typescript-extension` for history and rollback.
Reload the browser extension from this project's `dist/wuf` after this split.
