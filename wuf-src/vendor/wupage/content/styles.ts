const STYLE_ID = "wupage-translation-style";

export function injectContentStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .wupage-translation {
      box-sizing: border-box;
      max-width: 100%;
      white-space: normal;
      overflow-wrap: break-word;
      word-break: break-word;
      pointer-events: none;
    }

    .wupage-translation[data-wupage-mode="block"] {
      display: block;
      margin: 0.18em 0 0.38em;
      color: inherit;
      font: inherit;
      line-height: inherit;
    }

    .wupage-translation[data-wupage-mode="block"][data-wupage-container="heading"] {
      display: block;
      margin: 0.18em 0 0.38em;
      color: inherit;
      font: inherit;
      line-height: inherit;
    }

    .wupage-translation[data-wupage-mode="inline"] {
      display: inline;
      margin-left: 0.35em;
      color: inherit;
      font-size: 0.92em;
      line-height: inherit;
      white-space: inherit;
      overflow-wrap: inherit;
      word-break: inherit;
    }

    .wupage-translation[data-wupage-mode="code-comment"] {
      display: block;
      margin: 0;
      color: inherit;
      font: inherit;
      line-height: inherit;
      white-space: pre-wrap;
    }

    .wupage-translation[data-wupage-preserve-whitespace="true"] {
      white-space: pre-wrap;
    }

    .wupage-translation[data-wupage-container="youtube-description"] {
      display: inline;
      margin: 0;
      white-space: pre-wrap;
    }

    .wupage-translation[data-wupage-container="youtube-description"]:not([data-wupage-display-mode="replace"])::before {
      content: "\\A";
      white-space: pre;
    }

    .wupage-translation[data-wupage-display-mode="replace"] {
      display: inline;
      margin: 0;
      color: inherit;
      font: inherit;
      line-height: inherit;
    }

    /* GitHub lays out code and line numbers in separate fixed-height rows.
       Keep comment translations on the source row, including pending states,
       so neither virtualized code nor the gutter needs to be resized. */
    :is(.react-code-text, .blob-code) .wupage-translation[data-wupage-mode="code-comment"] {
      display: inline;
      margin: 0 0 0 0.75em;
      white-space: nowrap;
    }

    :is(.react-code-text, .blob-code) .wupage-translation[data-wupage-mode="code-comment"][data-wupage-display-mode="replace"] {
      margin: 0;
    }

    .wupage-replaced-source {
      display: none !important;
    }

    /* Keep host-managed text measurable while its replacement determines the
       wrapper's height. The source must not stretch to the translation row. */
    .wupage-stable-replacement {
      display: grid !important;
      grid-template-columns: minmax(0, 1fr) !important;
      align-items: start !important;
    }

    .wupage-stable-replacement > .wupage-stable-source {
      grid-area: 1 / 1 !important;
      align-self: start !important;
      min-width: 0 !important;
      visibility: hidden !important;
    }

    .wupage-stable-replacement > .wupage-translation[data-wupage-container="stable-replacement"] {
      grid-area: 1 / 1;
      align-self: start;
      min-width: 0;
      display: block;
      margin: 0;
      visibility: visible;
    }

    .wupage-translation[data-wupage-container="authored-lines"] {
      position: static;
      display: block;
      float: none;
      width: auto;
      min-width: 0;
      height: auto;
      transform: none;
      letter-spacing: inherit;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .wupage-translation[data-wupage-container="image-text"] {
      display: block;
      margin: 0.6em 0;
      padding: 0;
      border-radius: 0;
      color: inherit;
      background: transparent;
      font-size: 0.95em;
      line-height: 1.55;
      text-align: start;
      white-space: pre-wrap;
    }

    .wupage-translation[data-wupage-image-layout="interleaved"] {
      container-type: inline-size;
      margin: 0;
      padding: 0;
      border-radius: 0;
      background: transparent;
      text-align: center;
      white-space: normal;
      pointer-events: auto;
    }

    .wupage-image-text-row {
      display: block;
      margin: 0 0 1.4em;
      font-size: var(--wupage-image-font-size);
    }

    .wupage-image-text-original {
      position: relative;
      display: block;
      width: 100%;
      overflow: hidden;
    }

    .wupage-image-text-original > img {
      position: absolute;
      top: 0;
      left: 0;
      display: block;
      width: 100%;
      max-width: none;
      height: auto;
      margin: 0;
      padding: 0;
      border: 0;
      transform-origin: top left;
    }

    .wupage-image-text-result {
      display: block;
      margin: 0.3em 0 0;
      font-size: 0.95em;
      font-weight: 600;
      line-height: 1.75;
      white-space: pre-wrap;
    }

    .wupage-translation-pending {
      min-width: 1.25em;
      min-height: 1.25em;
    }

    .wupage-translation-pending > span {
      display: inline-block;
      width: 0.9em;
      height: 0.9em;
      box-sizing: border-box;
      border: 2px solid rgba(180, 61, 29, 0.22);
      border-top-color: #b43d1d;
      border-radius: 999px;
      vertical-align: -0.12em;
      animation: wupage-spin 780ms linear infinite;
    }

    .wupage-translation-pending[data-wupage-mode="block"] > span,
    .wupage-translation-pending[data-wupage-mode="code-comment"] > span {
      margin: 0.2em 0;
    }

    :is(.react-code-text, .blob-code) .wupage-translation-pending[data-wupage-mode="code-comment"] > span {
      margin: 0;
    }

    @keyframes wupage-spin {
      to {
        transform: rotate(360deg);
      }
    }

  `;
  document.documentElement.append(style);
}
