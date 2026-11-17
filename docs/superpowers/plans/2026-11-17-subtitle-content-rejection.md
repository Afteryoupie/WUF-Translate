# Subtitle content rejection repair

**Goal:** Keep playback progressing when the local model rejects an individual subtitle.
**Evidence:** Real video Ga3AjEN0U2I, English automatic captions, local Apple Foundation Models returned HTTP 500 `The model's safety guardrails were triggered.` at 1007s and 1082s. Ordinary adjacent sentences completed in roughly one second.
**Architecture:** Classify explicit content rejection separately from infrastructure errors; never trigger engine-wide backoff or repeat identical refused requests. Display the rejected sentence's source text for the current session and keep translation local.
**Tech Stack:** TypeScript, node:test, esbuild.

- [x] Add failing provider classification and worker continuation tests using the observed response.
- [x] Classify explicit rejection as CONTENT_REJECTED and make it terminal only for that sentence.
- [x] Implement selected fallback with regression coverage, preserving auth/rate-limit/timeout behavior.
- [x] Replay real-video captions through real local provider, record outcomes and durations.
- [x] Run full tests/typecheck, review correctness and unnecessary complexity; build installable output.

Review focus: HTTP 500 unrelated to content still retries; refusal cannot trip breaker; subsequent sentences run; no caching original as translated text; no unexpected external routing.

**Verification:** Edge rendered original dialogue at 16:47 and resumed showing translated dialogue at 16:55 on video Ga3AjEN0U2I. Playback crossed 17:30 and 18:00 at 2×, and forward/backward seeks showed cues. The independent playback-clock replay logged 20 translations, two single-attempt refusals, and one startup gap of about 1.4 seconds. Typecheck, build, and all 122 automated tests passed.
