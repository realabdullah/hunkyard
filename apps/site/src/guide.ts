import { reducedMotion } from './camera';
import { $, $$ } from './dom';

const CLOSE_MS = 300;
const wide = matchMedia('(min-width: 860px)');
const typing = (target: EventTarget | null) =>
  target instanceof Element && target.closest('input, textarea, [contenteditable]') !== null;

/**
 * The field guide: a modal sheet that rises over the canvas. Chapters are deep-linkable as
 * `#guide/<chapter>`, and "See it on the canvas" closes the sheet and glides to that stop.
 */
export const initGuide = (showOnCanvas: (stop: string) => void) => {
  const root = document.documentElement;
  const dialog = $<HTMLDialogElement>('#guide');
  const sheet = $('#g-sheet');
  const toc = $<HTMLDetailsElement>('#g-toc');
  const filter = $<HTMLInputElement>('#g-filter');
  const progress = $('#g-progress');
  const where = $('#g-where');
  const links = $$<HTMLAnchorElement>('#g-chapters a');
  const chapters = $$('.g-sec', sheet);
  let closing = 0;
  let current = '';

  const setHash = (chapter: string) =>
    history.replaceState(null, '', chapter ? `#guide/${chapter}` : '#guide');

  const scrollTo = (chapter: string, smooth: boolean) => {
    const target = chapter ? document.getElementById(`g-${chapter}`) : null;
    // Clear the sticky bar, and on narrow screens the contents toggle under it too.
    const top = target ? target.offsetTop - (wide.matches ? 72 : 112) : 0;
    sheet.scrollTo({ top, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
  };

  const finish = () => {
    clearTimeout(closing);
    closing = 0;
    delete dialog.dataset.closing;
    root.classList.remove('guide-open');
  };

  const open = (chapter = '') => {
    const wasOpen = dialog.open && !closing;
    if (closing) finish();
    if (!dialog.open) {
      toc.open = wide.matches;
      dialog.showModal();
      sheet.scrollTop = 0;
      root.classList.add('guide-open');
    }
    if (!wide.matches) toc.open = false;
    // On first open, let the sheet arrive before travelling to a chapter.
    if (wasOpen) scrollTo(chapter, true);
    else requestAnimationFrame(() => scrollTo(chapter, false));
    setHash(chapter);
  };

  const close = (then?: () => void) => {
    if (!dialog.open || closing) return;
    history.replaceState(null, '', location.pathname + location.search);
    root.classList.remove('guide-open');
    const done = () => {
      finish();
      dialog.close();
      then?.();
    };
    if (reducedMotion()) return done();
    dialog.dataset.closing = '';
    closing = window.setTimeout(done, CLOSE_MS);
  };

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('close', finish);
  // A click on the strip of canvas above the sheet closes it.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  $('#g-close').addEventListener('click', () => close());

  for (const trigger of $$('[data-guide]')) {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      open(trigger.dataset.guide);
    });
  }
  for (const trigger of $$<HTMLButtonElement>('[data-canvas]', sheet)) {
    trigger.addEventListener('click', () =>
      close(() => showOnCanvas(trigger.dataset.canvas ?? 'hero')),
    );
  }

  /* ---------- Reading position: progress line, current chapter ---------- */

  const markChapter = (chapter: string) => {
    if (chapter === current) return;
    current = chapter;
    for (const link of links) link.toggleAttribute('aria-current', link.dataset.guide === chapter);
    const active = links.find((link) => link.dataset.guide === chapter);
    where.textContent = active ? (active.textContent ?? '').replace(/^\d+/, '$& ') : '';
    if (dialog.open && !closing) setHash(chapter);
  };

  let frame = 0;
  sheet.addEventListener('scroll', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const max = sheet.scrollHeight - sheet.clientHeight;
      progress.style.transform = `scaleX(${max > 0 ? sheet.scrollTop / max : 0})`;
      // The current chapter is the last one whose heading has passed the top third.
      const line = sheet.scrollTop + sheet.clientHeight / 3;
      const passed = chapters.filter((section) => section.offsetTop <= line).at(-1);
      markChapter(passed?.dataset.chapter ?? '');
    });
  });

  /* ---------- Filter: narrows the contents to chapters that mention the query ---------- */

  const text = new Map(
    chapters.map((section) => [section.dataset.chapter, section.textContent?.toLowerCase() ?? '']),
  );
  filter.addEventListener('input', () => {
    const query = filter.value.trim().toLowerCase();
    let shown = 0;
    for (const link of links) {
      const match = !query || (text.get(link.dataset.guide) ?? '').includes(query);
      link.parentElement?.toggleAttribute('hidden', !match);
      if (match) shown += 1;
    }
    $('#g-empty').hidden = shown > 0;
  });
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      links.find((link) => !link.parentElement?.hidden)?.click();
    } else if (event.key === 'Escape' && filter.value) {
      event.preventDefault();
      event.stopPropagation();
      filter.value = '';
      filter.dispatchEvent(new Event('input'));
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
    if (!dialog.open && (event.key === 'g' || event.key === 'G')) {
      event.preventDefault();
      open();
    } else if (dialog.open && event.key === '/') {
      event.preventDefault();
      toc.open = true;
      filter.focus();
    }
  });

  /* ---------- Deep links ---------- */

  const fromHash = () => {
    const match = /^#guide(?:\/([\w-]+))?$/.exec(location.hash);
    if (match) open(match[1]);
    else if (dialog.open) close();
  };
  addEventListener('hashchange', fromHash);
  fromHash();

  return {
    open,
    close,
    get isOpen() {
      return dialog.open;
    },
  };
};
