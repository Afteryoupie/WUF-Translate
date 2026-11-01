/** Implicit-root intersection observes clipping through nested browsing contexts. */
import { frameIsRendered } from "./frame-visibility";
export class DocumentViewport {
  private observer?: IntersectionObserver;
  private visible = new Set<Element>();
  private tracked = new Set<Element>();
  private order: Element[] = [];
  private positions = new Map<Element, number>();
  readonly ready: Promise<void>;
  private resolveReady = () => {};
  private readyTimer?: ReturnType<typeof setTimeout>;
  get deferred(): boolean { return Boolean(this.observer); }
  constructor(private changed: () => void) {
    this.ready = Promise.resolve();
    if (window !== window.top && typeof IntersectionObserver !== "undefined") {
      this.ready = new Promise(resolve => { this.resolveReady = resolve; });
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0) this.visible.add(entry.target);
          else this.visible.delete(entry.target);
        }
        clearTimeout(this.readyTimer); this.resolveReady();
        this.changed();
      }, { threshold: 0 });
    }
  }
  update(elements: Element[]): void {
    if (!this.observer) return;
    this.order = elements;
    this.positions.clear();
    elements.forEach((element, index) => { if (!this.positions.has(element)) this.positions.set(element, index); });
    if (!elements.length) this.resolveReady();
    else if (!this.readyTimer) this.readyTimer = setTimeout(this.resolveReady, 250);
    const current = new Set(elements);
    for (const element of this.tracked) if (!current.has(element)) {
      this.observer.unobserve(element); this.tracked.delete(element); this.visible.delete(element);
    }
    for (const element of current) if (!this.tracked.has(element)) {
      this.tracked.add(element); this.observer.observe(element);
    }
  }
  priority(element: Element): number | undefined | null {
    if (!frameIsRendered()) return null;
    if (!this.observer) return undefined;
    if (this.visible.has(element)) return Math.max(0, element.getBoundingClientRect().top);
    // Cross-origin rootMargin is restricted. Prefetch only immediate reading
    // neighbours of an actually intersecting paragraph, never an entire iframe.
    const index = this.positions.get(element) ?? -1;
    const rect = element.getBoundingClientRect();
    const margin = Math.max(240, Math.min(window.innerHeight, 960) * 0.75);
    const neighbour = [this.order[index - 1], this.order[index + 1]].find(candidate => {
      if (!this.visible.has(candidate)) return false;
      const visibleRect = candidate.getBoundingClientRect();
      return rect.top - visibleRect.bottom <= margin && visibleRect.top - rect.bottom <= margin;
    });
    return neighbour ? 100000 + index : null;
  }
  disconnect(): void {
    clearTimeout(this.readyTimer); this.resolveReady(); this.observer?.disconnect();
    this.tracked.clear(); this.visible.clear(); this.positions.clear(); this.order = [];
  }
}
