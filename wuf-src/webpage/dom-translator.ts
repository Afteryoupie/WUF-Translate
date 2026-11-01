import type { DisplayMode, TranslationEngineId } from '../types.ts';

export interface WebpageBatchConfig {
  webConcurrency: number;
  webBatchUnits: number;
  webBatchChars: number;
  firstBatchUnits: number;
  firstBatchChars: number;
}

export interface WebpageTranslateUnit {
  element: HTMLElement;
  sourceText: string;
  tagsMap?: Map<string, Node>;
  sourceDom?: string;
}

export interface WebpageBatch {
  units: WebpageTranslateUnit[];
  isFirstBatch: boolean;
}

// Record only DOM written by this script; a SPA may reuse the same element.
const youtubeTitles = new WeakMap<HTMLElement, { translation: HTMLElement; display: string; priority: string }>();

function restoreYouTubeTitle(el: HTMLElement): boolean {
  const state = youtubeTitles.get(el);
  if (!state) return false;
  state.translation.remove();
  // Respect any subsequent display change made by YouTube itself.
  if (el.style.getPropertyValue('display') === 'none' && el.style.getPropertyPriority('display') === 'important') {
    if (state.display) el.style.setProperty('display', state.display, state.priority);
    else el.style.removeProperty('display');
  }
  youtubeTitles.delete(el);
  el.removeAttribute('data-wuf-translated');
  renderedDom.delete(el);
  return true;
}

const renderedDom = new WeakMap<HTMLElement, string>();
function domSignature(el: HTMLElement): string {
  return `${el.innerHTML ?? ''}\n${el.textContent ?? ''}`;
}

const TRANSLATABLE_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, figcaption, dt, dd, div.u-margin-s-bottom[id^="p"], div.u-margin-s-bottom > div[id^="p"], div.u-margin-s-bottom[id^="abspara"], ytd-comment-renderer #content-text, ytd-comment-view-model #content-text';

const EXCLUDED_ANCESTOR_SELECTOR =
  'script, style, noscript, code, pre, textarea, input, select, button, svg, math, [contenteditable="true"], [data-wuf-ignore], .wuf-bilingual-translation, ytd-watch-flexy #secondary, ytd-watch-next-secondary-results-renderer';

const INLINE_TAG_NAMES = new Set([
  'A',
  'SPAN',
  'CODE',
  'STRONG',
  'EM',
  'B',
  'I',
  'U',
  'MARK',
  'SMALL',
  'SUB',
  'SUP',
]);

export function isTranslatableElement(el: Element): el is HTMLElement {
  if (!el || typeof (el as HTMLElement).textContent !== 'string') return false;
  if (el.getAttribute('data-wuf-injected') === 'true') return false;
  // Hidden chapter menus and duplicate responsive layouts need no translation.
  if (
    !youtubeTitles.has(el as HTMLElement) &&
    typeof el.getClientRects === 'function' &&
    el.getClientRects().length === 0
  ) {
    return false;
  }
  if (el.closest?.(EXCLUDED_ANCESTOR_SELECTOR)) return false;
  // Author handles and comment metadata are not prose to translate.
  if (el.closest?.('ytd-comment-renderer, ytd-comment-view-model') && el.id !== 'content-text') return false;
  const text = (el.textContent || '').trim();
  if (!text || text.length < 2) return false;
  // Skip pure numbers or punctuation
  if (!/[\p{L}]/u.test(text)) return false;
  return true;
}

/**
 * Extracts translatable text from an element while preserving inline tags
 * (<a>, <code>, <strong>, etc.) with safe placeholders like <<<WUF_TAG_0>>>.
 */
export function extractTranslatableContent(el: HTMLElement): {
  text: string;
  tagsMap?: Map<string, Node>;
} {
  if (el.matches?.('ytd-watch-metadata h1, ytd-video-primary-info-renderer h1')) {
    return { text: (el.querySelector('yt-formatted-string')?.textContent || el.textContent || '').trim() };
  }
  // YouTube attributed strings are framework-owned wrappers, not semantic inline markup.
  // Sending their placeholders to translation models can echo English or corrupt delimiters.
  if (el.id === 'content-text') return { text: (el.textContent || '').trim() };
  // If element has no child elements, return plain text directly
  if (el.children.length === 0) {
    return { text: (el.textContent || '').trim() };
  }

  // Check if all child elements are inline tags
  let hasBlockChild = false;
  for (let i = 0; i < el.children.length; i++) {
    const child = el.children[i];
    if (!INLINE_TAG_NAMES.has(child.tagName)) {
      hasBlockChild = true;
      break;
    }
  }

  if (hasBlockChild) {
    return { text: (el.textContent || '').trim() };
  }

  const tagsMap = new Map<string, Node>();
  let tagCounter = 0;
  let text = '';

  for (let i = 0; i < el.childNodes.length; i++) {
    const node = el.childNodes[i];
    if (node.nodeType === 3) {
      // Text node
      text += node.textContent || '';
    } else if (node.nodeType === 1) {
      // Inline element node
      const marker = `<<<WUF_TAG_${tagCounter++}>>>`;
      tagsMap.set(marker, node.cloneNode(true));
      text += (node as Element).tagName === 'CODE'
        ? marker
        : `${marker}${node.textContent || ''}<<<WUF_END_${tagCounter - 1}>>>`;
    }
  }

  const clean = text.trim();
  if (tagsMap.size > 0 && clean) {
    return { text: clean, tagsMap };
  }
  return { text: (el.textContent || '').trim() };
}

/**
 * Replaces <<<WUF_TAG_X>>> placeholders in translated text and mounts restored
 * nodes into the target container.
 */
export function mountRestoredNodes(
  container: HTMLElement,
  translatedText: string,
  tagsMap?: Map<string, Node>,
  doc: Document = container.ownerDocument,
): void {
  if (!tagsMap || tagsMap.size === 0) {
    container.textContent = translatedText;
    return;
  }

  const parts = translatedText.split(/(<<<WUF_TAG_\d+>>>[\s\S]*?<<<WUF_END_\d+>>>|<<<WUF_TAG_\d+>>>)/g);
  for (const part of parts) {
    if (!part) continue;
    const wrapped = part.match(/^<<<WUF_TAG_(\d+)>>>([\s\S]*)<<<WUF_END_\1>>>$/);
    if (wrapped) {
      const original = tagsMap.get(`<<<WUF_TAG_${wrapped[1]}>>>`);
      if (original) {
        const clone = original.cloneNode(false);
        clone.textContent = wrapped[2];
        container.appendChild(clone);
        continue;
      }
    }
    const original = tagsMap.get(part);
    container.appendChild(original ? original.cloneNode(true) : doc.createTextNode(part));
  }
}

export function collectTranslatableUnits(root: ParentNode): WebpageTranslateUnit[] {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(TRANSLATABLE_SELECTOR));
  const units: WebpageTranslateUnit[] = [];

  for (const el of nodes) {
    const rendered = renderedDom.get(el);
    if (rendered !== undefined && rendered !== domSignature(el)) {
      restoreYouTubeTitle(el);
      el.querySelector('[data-wuf-injected="true"]')?.remove();
      el.removeAttribute('data-wuf-original');
      el.removeAttribute('data-wuf-translated');
      renderedDom.delete(el);
    }
    if (!isTranslatableElement(el)) continue;
    // Skip container elements that contain other translatable block children
    const nested = el.querySelector(TRANSLATABLE_SELECTOR);
    if (nested && nested !== el) continue;

    const originalAttr = el.getAttribute('data-wuf-original');
    if (originalAttr !== null) {
      // Already translated previously, keep track of original
      units.push({ element: el, sourceText: originalAttr.trim(), sourceDom: domSignature(el) });
      continue;
    }

    const { text, tagsMap } = extractTranslatableContent(el);
    if (!text) continue;
    units.push({ element: el, sourceText: text, tagsMap, sourceDom: domSignature(el) });
  }
  return units;
}

export function partitionWebpageBatches(
  units: WebpageTranslateUnit[],
  config: WebpageBatchConfig,
): WebpageBatch[] {
  const batches: WebpageBatch[] = [];
  let current: WebpageTranslateUnit[] = [];
  let currentChars = 0;
  let isFirstBatch = true;

  for (const unit of units) {
    const unitLimit = isFirstBatch ? config.firstBatchUnits : config.webBatchUnits;
    const charLimit = isFirstBatch ? config.firstBatchChars : config.webBatchChars;
    const len = unit.sourceText.length;

    if (
      current.length > 0 &&
      (current.length >= unitLimit || currentChars + len > charLimit)
    ) {
      batches.push({ units: current, isFirstBatch });
      current = [];
      currentChars = 0;
      isFirstBatch = false;
    }

    current.push(unit);
    currentChars += len;
  }

  if (current.length > 0) {
    batches.push({ units: current, isFirstBatch });
  }

  return batches;
}

export function applyTranslationToElement(
  el: HTMLElement,
  sourceText: string,
  translatedText: string,
  displayMode: DisplayMode,
  doc: Document = el.ownerDocument,
  tagsMap?: Map<string, Node>,
): void {
  const cleanTranslation = (translatedText || '').trim();
  if (!cleanTranslation) return;

  restoreYouTubeTitle(el);
  // YouTube holds references to the original title's custom elements. Replacing
  // their parent innerHTML breaks updates on later videos, even with WUF off.
  if (el.matches?.('ytd-watch-metadata h1, ytd-video-primary-info-renderer h1')) {
    const translation = doc.createElement('div');
    translation.className = 'wuf-bilingual-translation';
    translation.setAttribute('data-wuf-injected', 'true');
    translation.setAttribute('role', 'heading');
    translation.setAttribute('aria-level', '1');
    translation.textContent = cleanTranslation;
    const titleText = el.querySelector('yt-formatted-string') || el;
    const computed = doc.defaultView?.getComputedStyle(titleText);
    // Chromium can return an empty font shorthand when individual font fields
    // are present. Copy each field so the translation cannot fall back to 14px.
    for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'color'] as const) {
      translation.style[property] = computed?.[property] || 'inherit';
    }
    translation.style.margin = '0.35em 0';
    if (!el.insertAdjacentElement('afterend', translation)) return;
    youtubeTitles.set(el, { translation,
      display: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display') });
    if (displayMode === 'monolingual') el.style.setProperty('display', 'none', 'important');
    el.setAttribute('data-wuf-translated', displayMode);
    renderedDom.set(el, domSignature(el));
    return;
  }

  // Clean up any previous injection on this element first
  const existing = el.querySelector('[data-wuf-injected="true"]');
  if (existing) {
    existing.remove();
  }

  if (displayMode === 'monolingual') {
    if (!el.hasAttribute('data-wuf-original')) {
      el.setAttribute('data-wuf-original', el.textContent || sourceText);
    }
    el.setAttribute('data-wuf-translated', 'monolingual');
    el.innerHTML = '';
    mountRestoredNodes(el, cleanTranslation, tagsMap, doc);
    renderedDom.set(el, domSignature(el));
    return;
  }

  // Bilingual mode: keep original and append a distinct bilingual block
  if (el.getAttribute('data-wuf-translated') === 'monolingual') {
    const orig = el.getAttribute('data-wuf-original');
    if (orig !== null) {
      el.textContent = orig;
    }
  }
  el.setAttribute('data-wuf-translated', 'bilingual');

  const badge = doc.createElement('div');
  badge.className = 'wuf-bilingual-translation';
  badge.setAttribute('data-wuf-injected', 'true');
  badge.style.display = 'block';
  badge.style.marginTop = '0.35em';
  badge.style.marginBottom = '0.25em';
  badge.style.padding = '4px 8px';
  badge.style.borderRadius = '4px';
  badge.style.fontSize = '0.95em';
  badge.style.lineHeight = '1.5';
  badge.style.backgroundColor = 'rgba(180, 61, 29, 0.08)';
  badge.style.color = '#242620';
  badge.style.borderLeft = '3px solid #b43d1d';
  badge.style.boxSizing = 'border-box';

  mountRestoredNodes(badge, cleanTranslation, tagsMap, doc);
  el.appendChild(badge);
  renderedDom.set(el, domSignature(el));
}

export function restoreTranslatedDom(root: ParentNode): number {
  let restored = 0;
  const injected = Array.from(
    root.querySelectorAll<HTMLElement>('[data-wuf-injected="true"]'),
  );
  for (const node of injected) {
    node.remove();
    restored++;
  }

  const modified = Array.from(
    root.querySelectorAll<HTMLElement>('[data-wuf-translated]'),
  );
  for (const el of modified) {
    if (restoreYouTubeTitle(el)) { restored++; continue; }
    const orig = el.getAttribute('data-wuf-original');
    if (orig !== null) {
      // Never restore the previous video title over content supplied by the site.
      if (renderedDom.get(el) === domSignature(el)) el.textContent = orig;
    }
    el.removeAttribute('data-wuf-original');
    el.removeAttribute('data-wuf-translated');
    renderedDom.delete(el);
    restored++;
  }
  return restored;
}

export interface DomTranslatorOptions {
  root: ParentNode;
  doc?: Document;
  translateBatch: (
    texts: string[],
    signal: AbortSignal,
  ) => Promise<string[]>;
  getConfig: () => Promise<{
    engine: TranslationEngineId;
    targetLanguage: string;
    displayMode: DisplayMode;
    batchConfig: WebpageBatchConfig;
  }>;
  onProgress?: (completed: number, total: number, active: boolean) => void;
  onStateChange?: (translated: boolean) => void;
}

export class WufDomTranslator {
  private root: ParentNode;
  private doc?: Document;
  private translateBatchFn: DomTranslatorOptions['translateBatch'];
  private getConfigFn: DomTranslatorOptions['getConfig'];
  private onStateChange?: (translated: boolean) => void;
  private onProgress?: DomTranslatorOptions['onProgress'];
  private reportProgress(): void {
    this.onProgress?.(this.completedUnits, this.totalUnits, this.translating);
  }

  private cache = new Map<string, string>();
  private spaObserver: MutationObserver | null = null;
  private pendingIncremental = false;
  private spaDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  translating = false;
  translated = false;
  totalUnits = 0;
  completedUnits = 0;
  abortController: AbortController | null = null;

  constructor(options: DomTranslatorOptions) {
    this.root = options.root;
    this.doc = options.doc;
    this.translateBatchFn = options.translateBatch;
    this.getConfigFn = options.getConfig;
    this.onStateChange = options.onStateChange;
    this.onProgress = options.onProgress;
  }

  abortInProgressTranslation(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.stopSpaObserver();
    this.translating = false;
    this.reportProgress();
  }

  restorePage(): void {
    if (this.translating) {
      this.abortInProgressTranslation();
    }
    this.stopSpaObserver();
    restoreTranslatedDom(this.root);
    this.translated = false;
    this.totalUnits = 0;
    this.completedUnits = 0;
    this.onStateChange?.(false);
    this.reportProgress();
  }

  private stopSpaObserver(): void {
    this.pendingIncremental = false;
    if (this.spaDebounceTimer) {
      clearTimeout(this.spaDebounceTimer);
      this.spaDebounceTimer = null;
    }
    if (this.spaObserver) {
      this.spaObserver.disconnect();
      this.spaObserver = null;
    }
  }

  private startSpaObserver(): void {
    this.stopSpaObserver();
    if (typeof MutationObserver === 'undefined' || !this.root) return;

    this.spaObserver = new MutationObserver(mutations => {
      let hasAddedTranslatable = false;
      for (const m of mutations) {
        if (m.type === 'characterData') {
          const parent = m.target.parentElement;
          if (
            parent &&
            !parent.closest?.('[data-wuf-injected="true"], .wuf-bilingual-translation') &&
            parent.closest?.(TRANSLATABLE_SELECTOR)
          ) {
            hasAddedTranslatable = true;
            break;
          }
          continue;
        }
        for (let i = 0; i < m.addedNodes.length; i++) {
          const node = m.addedNodes[i];
          if (node.nodeType === 1) {
            const el = node as HTMLElement;
            if (
              el.getAttribute?.('data-wuf-injected') === 'true' ||
              el.closest?.('[data-wuf-injected="true"], .wuf-bilingual-translation')
            ) {
              continue;
            }
            const hasNested =
              typeof el.querySelector === 'function' &&
              Boolean(el.querySelector(TRANSLATABLE_SELECTOR));
            const insideTranslatable = Boolean(el.closest?.(TRANSLATABLE_SELECTOR));
            if (isTranslatableElement(el) || hasNested || insideTranslatable) {
              hasAddedTranslatable = true;
              break;
            }
          } else if (node.nodeType === 3 && (node.textContent || '').trim().length >= 2) {
            const parent = node.parentElement;
            if (
              parent &&
              !parent.closest?.('[data-wuf-injected="true"], .wuf-bilingual-translation') &&
              parent.closest?.(TRANSLATABLE_SELECTOR)
            ) {
              hasAddedTranslatable = true;
              break;
            }
          }
        }
        if (hasAddedTranslatable) break;
      }

      if (hasAddedTranslatable) {
        if (this.spaDebounceTimer) clearTimeout(this.spaDebounceTimer);
        this.spaDebounceTimer = setTimeout(() => {
          this.spaDebounceTimer = null;
          if (this.translated && !this.translating) {
            void this.translateIncremental().catch(() => undefined);
          } else if (this.translating) {
            this.pendingIncremental = true;
          }
        }, 350);
      }
    });

    try {
      this.spaObserver.observe(this.root, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch {
      // Best-effort
    }
  }

  private async translateIncremental(): Promise<void> {
    if (this.translating || !this.translated) return;
    await this.handleTranslatePreset({ translateOnly: true, force: true, incremental: true });
  }

  async handleTranslatePreset(
    options: { translateOnly?: boolean; force?: boolean; incremental?: boolean } = {},
  ): Promise<void> {
    if (this.translating) {
      if (options.translateOnly && options.force) return;
      this.abortInProgressTranslation();
      return;
    }

    if (this.translated && !options.translateOnly) {
      this.restorePage();
      return;
    }

    const controller = new AbortController();
    let progressStarted = !options.incremental;
    this.abortController = controller;
    this.translating = true;
    if (!options.incremental) {
      this.completedUnits = 0;
      this.totalUnits = 0;
    }
    // Background DOM checks must not restart the completion toast's timer.
    if (progressStarted) this.reportProgress();
    try {
      const cfg = await this.getConfigFn();
      if (controller.signal.aborted) return;
      const units = collectTranslatableUnits(this.root).filter(u =>
        !options.incremental || !u.element.hasAttribute('data-wuf-translated'));
      if (units.length === 0) {
        this.translating = false;
        if (!options.incremental && options.translateOnly && options.force) {
          this.translated = true;
          this.onStateChange?.(true);
          this.startSpaObserver();
        }
        return;
      }
      this.totalUnits = options.incremental ? this.totalUnits + units.length : units.length;
      if (!options.incremental) this.completedUnits = 0;
      this.startSpaObserver();
      progressStarted = true;
      this.reportProgress();

      const batches = partitionWebpageBatches(units, cfg.batchConfig);
      const concurrency = Math.max(1, cfg.batchConfig.webConcurrency);
      let cursor = 0;
      const failures: unknown[] = [];

      const runBatch = async (batch: WebpageBatch) => {
        if (controller.signal.aborted) return;
        const uncachedIndices: number[] = [];
        const uncachedTexts: string[] = [];
        const resolved = new Array<string>(batch.units.length);

        batch.units.forEach((u, idx) => {
          const cacheKey = `${cfg.engine}:${cfg.targetLanguage}:${u.sourceText}`;
          const hit = this.cache.get(cacheKey);
          if (hit !== undefined) {
            resolved[idx] = hit;
          } else {
            uncachedIndices.push(idx);
            uncachedTexts.push(u.sourceText);
          }
        });

        if (uncachedTexts.length > 0) {
          const translations = await this.translateBatchFn(
            uncachedTexts,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          uncachedIndices.forEach((unitIdx, i) => {
            const tr = translations[i] ?? '';
            resolved[unitIdx] = tr;
            if (tr.trim()) {
              const key = `${cfg.engine}:${cfg.targetLanguage}:${batch.units[unitIdx].sourceText}`;
              this.cache.set(key, tr);
            }
          });
        }

        if (controller.signal.aborted) return;
        if (resolved.some(text => !text?.trim())) {
          throw new Error('翻譯服務回傳空白或不完整的譯文，請重試。');
        }
        let applied = 0;
        batch.units.forEach((u, idx) => {
          if (u.element.isConnected === false ||
              (u.sourceDom !== undefined && domSignature(u.element) !== u.sourceDom)) return;
          const tr = resolved[idx];
          if (tr) {
            applyTranslationToElement(
              u.element,
              u.sourceText,
              tr,
              cfg.displayMode,
              this.doc,
              u.tagsMap,
            );
            applied++;
          }
        });
        // Removed or replaced DOM is no longer part of this translation queue.
        this.totalUnits -= batch.units.length - applied;
        this.completedUnits = Math.min(this.totalUnits, this.completedUnits + applied);
        if (applied > 0 && !this.translated) {
          this.translated = true;
          this.onStateChange?.(true);
        }
        this.reportProgress();
      };

      // Keep the existing YouTube comment batching behavior.
      if (batches.length > 0) {
        try { await runBatch(batches[0]); } catch (error) { failures.push(error); }
        cursor = 1;
      }

      const workers = Array.from(
        { length: Math.min(concurrency, Math.max(0, batches.length - cursor)) },
        async () => {
          while (cursor < batches.length && !controller.signal.aborted) {
            const idx = cursor++;
            try { await runBatch(batches[idx]); } catch (error) { failures.push(error); }
          }
        },
      );
      await Promise.all(workers);
      if (failures.length > 0) throw failures[0];

      if (!controller.signal.aborted) {
        const nextTranslated =
          this.completedUnits > 0 || (Boolean(options.incremental) && this.translated);
        if (this.translated !== nextTranslated) {
          this.translated = nextTranslated;
          this.onStateChange?.(this.translated);
        } else if (nextTranslated) {
          this.onStateChange?.(true);
        }
      }
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
        this.translating = false;
        if (progressStarted) this.reportProgress();
        if (this.pendingIncremental && !controller.signal.aborted) {
          this.pendingIncremental = false;
          void this.translateIncremental().catch(() => undefined);
        }
      }
    }
  }
}
