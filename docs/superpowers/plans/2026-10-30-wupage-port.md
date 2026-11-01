# WuPage webpage pipeline implementation plan

**Goal:** Run ordinary webpages through the WuPage 1.5.5 pipeline while preserving WUF's interface, Watchdog, YouTube comments and subtitles.

**Architecture:** Import the relevant upstream background and shared modules, adapting only integration boundaries. WUF maps persisted settings and transports frame/session messages; WuPage owns webpage scheduling, providers, protected translation, response parsing and a versioned webpage-only cache. YouTube remains on its current path.

**Constraints:** Preserve existing uncommitted changes, extension identity and credentials. No OpenCC postprocessing for normal webpages; subtitles remain unchanged. Compare equal settings, source auto, target zh-TW, bilingual, same endpoint and model. Do not commit or push.

## Tasks

- [x] Add a test invoking real upstream and WUF translation against a capture endpoint. Show red for prompt, JSON input, temperature, response parsing and multi-item batching; keep credential-free evidence.
- [x] Port upstream OpenAI-compatible, Google and Microsoft providers, their request templates, parsing and supporting dependencies. Map existing settings and wake Watchdog before the unchanged provider request. Repeat request and parsing parity tests until green.
- [x] Route only normal webpages through upstream batch/cache/protected-translation code. Version webpage cache independently; leave YouTube comments and subtitle cache on existing path. Test abort, cache invalidation, errors and isolation red then green.
- [x] Restore upstream viewport scheduling and provider settings; retain necessary WUF UI/frame exclusions and abort integration. Correct progress reporting for idle offscreen segments. Test viewport, dynamic content, frame sessions and restoration red then green.
- [x] Add Microsoft to webpage service settings without invalidating saved settings. Test selection, persistence, language mapping and YouTube compatibility red then green.
- [x] Update source hashes, modification notice, build provenance, README and changelog. Adapt old tests whose expected WUF webpage protocol has been replaced.
- [x] Build both extensions and run controlled Edge comparisons against the actual Apple model with the same configuration. Save sanitized requests and screenshots; verify rich text, markers, duplicates and restore. Verify scrolling, mutations and frames in the separate Edge tests with a controlled provider.
- [x] Run TypeScript, full tests and build; review correctness and excess complexity; audit each original acceptance criterion with evidence.

## Review focus

- Cancellation during configuration load, queued batches and network fetch must not leak stale results into a new page session.
- Offscreen idle entries must not make WUF show an indefinitely active request.
- Provider errors and rate limits must not be cached as translations or hidden by recovery.
- Cache identity must distinguish configuration and page context without touching subtitle records.
- Existing selected providers, secrets, YouTube comment structures and subtitle decisions must remain usable after update.
