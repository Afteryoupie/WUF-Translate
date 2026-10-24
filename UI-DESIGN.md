# WUF Translate interface

## Shared theme

`wuf-src/ui/design-tokens.css` is the shared source for popup and settings colors,
focus styles, motion preferences, and typography. `scripts/build-wuf.mjs` copies
it into `dist/wuf` alongside the page styles.

The light theme follows WUF Watchdog: warm paper `#f5f3ec`, ivory surfaces
`#fffcf5`, ink `#242620`, and vermilion `#b43d1d`.

The dark theme uses graphite `#1c1e22`, elevated surfaces `#25282d`, and muted
surfaces `#30343a`. Text uses `#edece8` and `#b5b7bc`. Solid action buttons keep
vermilion `#b43d1d` with white text. Accent text uses `#ff8663` on dark surfaces
so selected labels and links remain readable. Hover and selection styles use
the corresponding shared tokens.

## W icon

The selected mark is a black-and-white W with folded dog ears, a speech tail,
and a white outer outline on a transparent background. Its silhouette fills
approximately 96% of the square width, leaving a small rendering margin.

- Editable vector: `wuf-src/icons/wuf-translate.svg`.
- Raster master: `wuf-src/icons/wuf-translate-master.png`.
- Packaged sizes: 16, 32, 48, and 128 px.
- To regenerate those sizes from the master on Windows:
  `powershell -NoProfile -File scripts/build-icons.ps1`.
- Build the extension with `node scripts/build-wuf.mjs` and reload `dist/wuf`.

## Interaction

Settings use six responsive navigation tabs with arrow-key, Home, and End
navigation. Popup display-mode choices use a single keyboard tab stop and
arrow-key selection. Header controls use 44 px square buttons with inline SVG
icons; the settings control uses a symmetric gear. Model details are expandable,
and local Watchdog controls appear only for the local translation engine.

Settings retain autosave, separate provider profiles, and existing model fields.
Reduced-motion preferences disable entrance animations and transitions.
