# WUF webpage settings implementation plan

**Goal:** Use WUF red for the webpage loading indicator and make existing WUF webpage options and service checks accessible in the webpage settings tab.

**Architecture:** Keep WuPage translation scheduling and protocol unchanged. Add an explicit editable host list backed by the existing `autoTranslateHosts` setting, links to existing model-profile tabs, and a service test routed through the existing WuPage webpage runtime with persistent cache bypassed. Preserve existing settings and secrets.

- [x] Add an Edge test of the actual pending indicator, observe the old color fail, change to `#b43d1d`, then verify.
- [x] Add Edge tests that edit, save, reload and reject invalid auto-translate hosts; verify exact host behavior and preservation of other settings. Implement and rerun.
- [x] Add a test of the selected webpage provider through the real WuPage runtime, ensuring repeated tests do not use cache and errors are shown. Add model-profile navigation and localized status/help text; verify.
- [x] Run TypeScript, full tests and build; visually inspect the settings tab and complete correctness and complexity reviews.
