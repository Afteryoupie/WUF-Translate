import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { WUF_DICTIONARIES } from '../wuf-src/i18n/locales.ts';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = resolve(rootDir, 'wuf-src');
const outDir = resolve(rootDir, 'dist', 'wuf');

const identity = JSON.parse(readFileSync(resolve(srcDir, 'identity.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(srcDir, 'manifest.json'), 'utf8'));

if (manifest.key !== identity.key) {
  throw new Error('wuf-src/manifest.json key does not match wuf-src/identity.json key');
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. Write verified manifest.json
writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// 2. Copy static HTML and CSS for Popup and Options
copyFileSync(resolve(srcDir, 'popup', 'popup.html'), resolve(outDir, 'popup.html'));
copyFileSync(resolve(srcDir, 'popup', 'popup.css'), resolve(outDir, 'popup.css'));
copyFileSync(resolve(srcDir, 'options', 'options.html'), resolve(outDir, 'options.html'));
copyFileSync(resolve(srcDir, 'options', 'options.css'), resolve(outDir, 'options.css'));
copyFileSync(resolve(srcDir, 'ui', 'design-tokens.css'), resolve(outDir, 'design-tokens.css'));

// 3. Copy multi-size extension icons generated from the W vector
const iconsDir = resolve(outDir, 'icons');
mkdirSync(iconsDir, { recursive: true });
for (const size of ['16', '32', '48', '128']) {
  const src = resolve(srcDir, 'icons', `icon-${size}.png`);
  copyFileSync(src, resolve(iconsDir, `icon-${size}.png`));
}

// 4. Generate Chrome _locales messages.json for all 8 supported UI languages
const chromeLocaleDirMap = {
  'zh-TW': 'zh_TW',
  'zh-CN': 'zh_CN',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  de: 'de',
};

const contextLabels = {
  'zh-TW': { translate: '翻譯本頁', original: '顯示原文' },
  'zh-CN': { translate: '翻译本页', original: '显示原文' },
  en: { translate: 'Translate This Page', original: 'Show Original' },
  ja: { translate: 'このページを翻訳', original: '原文を表示' },
  ko: { translate: '이 페이지 번역', original: '원문 표시' },
  es: { translate: 'Traducir esta página', original: 'Mostrar original' },
  fr: { translate: 'Traduire cette page', original: 'Afficher l’original' },
  de: { translate: 'Diese Seite übersetzen', original: 'Original anzeigen' },
};

for (const [uiLocale, dirName] of Object.entries(chromeLocaleDirMap)) {
  const dict = WUF_DICTIONARIES[uiLocale];
  const ctx = contextLabels[uiLocale];
  const localeDir = resolve(outDir, '_locales', dirName);
  mkdirSync(localeDir, { recursive: true });
  const messages = {
    extName: { message: dict['app.name'] },
    extDescription: { message: dict['app.subtitle'] },
    contextTranslatePage: { message: ctx.translate },
    contextShowOriginal: { message: ctx.original },
  };
  writeFileSync(resolve(localeDir, 'messages.json'), JSON.stringify(messages, null, 2) + '\n', 'utf8');
}

// 5. Bundle synchronous pre-display theme bootstrap and content scripts as IIFE
await build({
  entryPoints: {
    'theme-init': resolve(srcDir, 'ui', 'theme-init.ts'),
    'content-webpage': resolve(srcDir, 'content', 'content-webpage.ts'),
    'content-youtube': resolve(srcDir, 'content', 'content-youtube.ts'),
    'youtube-main-interceptor': resolve(srcDir, 'content', 'youtube-main-interceptor.ts'),
  },
  outdir: outDir,
  bundle: true,
  format: 'iife',
  target: 'es2022',
  platform: 'browser',
  charset: 'utf8',
});

// 6. Bundle extension entrypoints (background, popup, options) and shared library index
await build({
  entryPoints: {
    background: resolve(srcDir, 'background', 'index.ts'),
    popup: resolve(srcDir, 'popup', 'popup.ts'),
    options: resolve(srcDir, 'options', 'options.ts'),
    index: resolve(srcDir, 'index.ts'),
  },
  outdir: outDir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  charset: 'utf8',
});

console.log('[wuf-build] Built clean-room extension to dist/wuf/');
