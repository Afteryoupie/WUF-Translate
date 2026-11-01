# WuPage webpage engine

Source: https://github.com/mr-wuliu/wupage
Version: 1.5.5, from the source directory supplied by the user.
Original source hashes are recorded in UPSTREAM.json.

The DOM extraction, grouping, rendering, visibility, typography, context,
protected-text recovery, frame/session, batching, cache, service providers,
request templates and response parsing originate in WuPage.
Their upstream identifiers are retained to make the port reviewable.

WUF modifications: settings and runtime adapters; abort propagation; WUF overlay
exclusion; frame bootstrap integration and WUF storage notifications. The core
cache prefix is changed to isolate webpage translations from legacy WUF caches.
Translation CSS is extracted from upstream styles.ts; its loading indicator uses
the WUF accent color. Unrelated popup/floating-menu
CSS is omitted. The core directory contains the upstream background dependency
closure; its vite-env.d.ts is an integration declaration, not an upstream file.

The supplied WuPage archive contains no LICENSE file. This notice records
provenance and does not assign WUF's license to the imported source or represent
that upstream granted a redistribution license.
