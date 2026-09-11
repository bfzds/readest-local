import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { DocumentLoader } from '@/libs/document';
import type { BookDoc } from '@/libs/document';
import type { Renderer } from '@/types/view';

// Task 12: a CFI (virtual TOC) entry resolves to a Range anchor, which takes the
// paginator's *rect* branch and pins the element box to the scroll viewport top
// in scrolled mode. Readest reveals its app header bar (h-11 = 44px, opaque
// while hovered) over that same top edge, and with the in-flow page header off
// `scrollMargins.top` is 0, so the chapter heading ends up half-hidden under the
// bar. `overlay-top-inset` shortens the *final* scroll offset of a rect anchor
// by that height, so the target lands underneath the bar's bottom edge; unset/0
// must reproduce the pre-change offset exactly.
const EPUB_URL = new URL('../fixtures/data/sample-alice.epub', import.meta.url).href;

// Mirrors HEADER_BAR_HEIGHT_PX (readest HeaderBar `h-11`, also the `maxHeight`
// of utils/insets.ts getHeaderTriggerHeight).
const HEADER_BAR_PX = 44;

let book: BookDoc;

const loadEPUB = async () => {
  const resp = await fetch(EPUB_URL);
  const buffer = await resp.arrayBuffer();
  const file = new File([buffer], 'sample-alice.epub', { type: 'application/epub+zip' });
  const loader = new DocumentLoader(file);
  const { book } = await loader.open();
  return book;
};

/**
 * Wait for the paginator to emit 'stabilized'.
 * MUST be called BEFORE the action that triggers stabilization (e.g. goTo),
 * because #display dispatches 'stabilized' synchronously before returning.
 */
const waitForStabilized = (el: HTMLElement, timeout = 10000) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stabilized timeout')), timeout);
    el.addEventListener(
      'stabilized',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Wait for fill to complete by polling until getContents count stabilizes. */
const waitForFillComplete = async (el: Renderer, timeout = 10000) => {
  const start = Date.now();
  let lastCount = -1;
  let stableFor = 0;
  while (Date.now() - start < timeout) {
    const count = el.getContents().length;
    if (count === lastCount) {
      stableFor += 100;
      if (stableFor >= 500) return;
    } else {
      stableFor = 0;
      lastCount = count;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
};

const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

/**
 * A large rendered view routes `#scrollTo` through a 300 ms rAF scroll
 * animation, so the container keeps moving after `goTo` resolves. Poll until
 * the scroll position stops changing.
 */
const waitForScrollSettled = async (el: Renderer, timeout = 5000) => {
  const start = Date.now();
  let last = el.containerPosition;
  let stableFor = 0;
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 50));
    const now = el.containerPosition;
    if (now === last) {
      stableFor += 50;
      if (stableFor >= 200) return;
    } else {
      stableFor = 0;
      last = now;
    }
  }
};

/**
 * Distance between the target's box top and the scroll container's top edge.
 *
 * `el` lives inside the view's iframe, so its rect is relative to the iframe's
 * own viewport (which does not move when the container scrolls); add the frame
 * element's position to get the on-screen coordinate.
 */
const deltaFromContainerTop = (el: Element, container: HTMLElement) => {
  const frame = el.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
  expect(frame).not.toBeNull();
  const frameTop = frame!.getBoundingClientRect().top + frame!.clientTop;
  return frameTop + el.getBoundingClientRect().top - container.getBoundingClientRect().top;
};

describe('Paginator element-level jump top inset (browser)', () => {
  let paginator: Renderer;

  beforeAll(async () => {
    book = await loadEPUB();
    await import('foliate-js/paginator.js');
  }, 30000);

  const createPaginator = () => {
    const el = document.createElement('foliate-paginator') as Renderer;
    Object.assign(el.style, {
      width: '800px',
      height: '600px',
      position: 'absolute',
      left: '0',
      top: '0',
    });
    document.body.appendChild(el);
    return el;
  };

  afterEach(() => {
    if (paginator) {
      try {
        paginator.destroy();
      } catch {
        /* iframe body may already be torn down */
      }
      paginator.remove();
    }
  });

  /** Tall linear section, loaded and frozen so view offsets stay put. */
  const openTallSection = async (scrolled: boolean) => {
    paginator = createPaginator();
    paginator.open(book);
    // Mirrors readest with the in-flow page header off: compactMarginTopPx.
    // The pre-change landing is margin-top + 3, i.e. under the 44px bar.
    paginator.setAttribute('margin-top', '16px');
    if (scrolled) paginator.setAttribute('flow', 'scrolled');
    const index = book.sections!.findIndex((s) => s.linear !== 'no' && (s.size ?? 0) > 8000);
    expect(index).toBeGreaterThanOrEqual(0);
    const stabilized = waitForStabilized(paginator);
    await paginator.goTo({ index, anchor: 0 });
    await stabilized;
    await waitForFillComplete(paginator);
    // Freeze the loaded set: preloading another section would shift the target
    // section's offset within the scroll content mid-test.
    paginator.setAttribute('no-preload', '');
    const container = paginator.shadowRoot!.getElementById('container')!;
    const content = paginator.getContents().find((c) => c.index === index);
    expect(content).toBeDefined();
    return { index, container, doc: content!.doc as Document };
  };

  /**
   * Two far-apart paragraphs of the target section: `target` is measured,
   * `away` is jumped to first so the measured jump never short-circuits on the
   * `Math.abs(containerPosition - offset) < 1` early return.
   */
  const pickTargets = (doc: Document) => {
    const paragraphs = (Array.from(doc.querySelectorAll('p')) as HTMLElement[]).filter(
      (el) => el.getBoundingClientRect().height > 0,
    );
    expect(paragraphs.length).toBeGreaterThan(4);
    const target = paragraphs[Math.floor(paragraphs.length / 3)]!;
    const away = paragraphs[Math.floor((paragraphs.length * 2) / 3)]!;
    const gap = away.getBoundingClientRect().top - target.getBoundingClientRect().top;
    expect(gap).toBeGreaterThan(200);
    return { target, away };
  };

  /**
   * A CFI (virtual TOC) entry resolves to a `doc => Range` anchor, so the test
   * uses the same shape: the range covers the target element's box.
   */
  const anchorFor = (el: Element) => (doc: Document) => {
    const range = doc.createRange();
    range.selectNode(el);
    return range;
  };

  const jump = async (index: number, anchor: Element) => {
    await paginator.goTo({ index, anchor: anchorFor(anchor) });
    await waitForScrollSettled(paginator);
    await nextFrame();
  };

  const measureJump = async (
    index: number,
    target: Element,
    away: Element,
    container: HTMLElement,
  ) => {
    await jump(index, away);
    await jump(index, target);
    return {
      delta: deltaFromContainerTop(target, container),
      position: paginator.containerPosition,
    };
  };

  it('should lift a rect anchor off the top edge by overlay-top-inset, keeping the unset default identical', async () => {
    const { index, container, doc } = await openTallSection(true);
    const { target, away } = pickTargets(doc);

    // 1) Unset — the pre-change behaviour (default inset is 0).
    const unset = await measureJump(index, target, away, container);
    // 2) Explicit zero must be indistinguishable from unset.
    paginator.setAttribute('overlay-top-inset', '0px');
    const zero = await measureJump(index, target, away, container);
    // 3) A non-zero inset must push the target down by exactly that many px.
    paginator.setAttribute('overlay-top-inset', `${HEADER_BAR_PX}px`);
    const inset = await measureJump(index, target, away, container);

    // stderr is not filtered by vitest.browser.config.mts, so this is the raw
    // evidence recorded in the task report.
    console.warn(
      `[overlay-top-inset] unset: delta=${unset.delta} position=${unset.position} | ` +
        `0px: delta=${zero.delta} position=${zero.position} | ` +
        `${HEADER_BAR_PX}px: delta=${inset.delta} position=${inset.position}`,
    );

    // Default-0 equivalence: identical arithmetic, identical final offset.
    expect(zero.position).toBe(unset.position);
    expect(zero.delta).toBe(unset.delta);

    // The inset is what keeps the target clear of the header bar: the scroll
    // stops short by the inset, which moves the target down by the same amount.
    expect(Math.abs(unset.position - inset.position - HEADER_BAR_PX)).toBeLessThanOrEqual(1);
    expect(Math.abs(inset.delta - unset.delta - HEADER_BAR_PX)).toBeLessThanOrEqual(1);
    expect(inset.delta).toBeGreaterThanOrEqual(HEADER_BAR_PX);

    // Sanity: without the inset the target sits on the top edge — the bug.
    expect(unset.delta).toBeLessThan(HEADER_BAR_PX);
  });

  it('should ignore overlay-top-inset in paginated mode', async () => {
    const { index, container, doc } = await openTallSection(false);
    expect(paginator.scrolled).toBe(false);
    const { target, away } = pickTargets(doc);

    const unset = await measureJump(index, target, away, container);
    paginator.setAttribute('overlay-top-inset', `${HEADER_BAR_PX}px`);
    const inset = await measureJump(index, target, away, container);

    // Paginated anchoring is page-quantised and must be untouched by the inset.
    expect(inset.position).toBe(unset.position);
    expect(paginator.page).toBeGreaterThanOrEqual(0);
  });
});
