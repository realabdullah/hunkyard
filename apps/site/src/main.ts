import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { createCamera, type Rect } from './camera';
import { initDemo } from './demo';
import { $, $$ } from './dom';
import { initSetup } from './setup';

const viewport = $('#viewport');
const world = $('#world');
const canvasMode = matchMedia('(min-width: 860px)');
const stops = ['hero', 'review', 'privacy', 'rules', 'models', 'install'] as const;
let current = 0;

/** Cluster bounds in world units (clusters are absolutely positioned children of the world). */
const clusterRect = (element: HTMLElement): Rect => ({
  x: element.offsetLeft,
  y: element.offsetTop,
  w: element.offsetWidth,
  h: element.offsetHeight,
});
const clusters = () => $$('.cluster', world);
const worldRect = (): Rect => {
  const rects = clusters().map(clusterRect);
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y,
  };
};

/* ---------- Links: quiet curves between cards, drawn in world units ---------- */

type Box = { left: number; right: number; top: number; bottom: number; cx: number; cy: number };
const links = $<SVGSVGElement>('#links');
const drawLinks = () => {
  if (!camera.enabled) return;
  const origin = world.getBoundingClientRect();
  const z = camera.view.z;
  const box = (element: Element): Box => {
    const r = element.getBoundingClientRect();
    const left = (r.left - origin.left) / z;
    const top = (r.top - origin.top) / z;
    const w = r.width / z;
    const h = r.height / z;
    return { left, right: left + w, top, bottom: top + h, cx: left + w / 2, cy: top + h / 2 };
  };
  const across = (a: Box, b: Box, cls = '') => {
    const dx = Math.max(40, (b.left - a.right) / 2);
    return `<path class="link ${cls}" d="M${a.right},${a.cy} C${a.right + dx},${a.cy} ${b.left - dx},${b.cy} ${b.left},${b.cy}"/>`;
  };
  const down = (a: Box, b: Box, cls = '') => {
    const dy = Math.max(40, (b.top - a.bottom) / 2);
    return `<path class="link ${cls}" d="M${a.cx},${a.bottom} C${a.cx},${a.bottom + dy} ${b.cx},${b.top - dy} ${b.cx},${b.top}"/>`;
  };
  const end = (b: Box) => `<circle class="link-end" cx="${b.left}" cy="${b.cy}" r="3"/>`;

  const snapshot = box($('.snapshot'));
  const crew = box($('.crew'));
  const launcher = box($('.launcher'));
  const evidence = box($('.evidence'));
  let paths =
    down({ ...launcher, cx: snapshot.cx }, snapshot, 'soft') + across(snapshot, crew) + end(crew);
  for (const node of $$('.finding')) {
    const finding = box(node);
    const active = node.getAttribute('aria-selected') === 'true';
    paths += across(crew, finding, active ? 'active' : '');
    if (active) paths += across(finding, evidence, 'active') + end(evidence);
  }
  paths += across(box($('#c-hero .actions')), launcher, 'dashed');
  paths += down(box($('#c-hero .hint')), box($('#c-privacy .annot')), 'dashed');
  paths += across(box($('#c-privacy .ledger')), box($('#c-rules .tree')), 'dashed');
  paths += down(box($('#c-rules .tree')), box($('#c-install .annot')), 'dashed');
  links.innerHTML = paths;
};

/* ---------- Minimap ---------- */

const mapStage = $('#map-stage');
const mapView = $('#map-view');
const MAP_W = 168;
const MAP_H = 112;
let map = { bounds: { x: 0, y: 0, w: 1, h: 1 }, s: 1 };
const buildMap = () => {
  const bounds = worldRect();
  const s = Math.min(MAP_W / bounds.w, MAP_H / bounds.h);
  for (const old of $$('.map-block', mapStage)) old.remove();
  for (const cluster of clusters()) {
    const r = clusterRect(cluster);
    const block = document.createElement('i');
    block.className = 'map-block';
    block.style.cssText = `left:${(r.x - bounds.x) * s}px;top:${(r.y - bounds.y) * s}px;width:${r.w * s}px;height:${r.h * s}px`;
    mapStage.prepend(block);
  }
  map = { bounds, s };
};
const drawMap = () => {
  const { bounds, s } = map;
  const { x, y, z } = camera.view;
  const left = (-x / z - bounds.x) * s;
  const top = (-y / z - bounds.y) * s;
  mapView.style.cssText = `left:${left}px;top:${top}px;width:${(viewport.clientWidth / z) * s}px;height:${(viewport.clientHeight / z) * s}px`;
  $('#zoom-level').textContent = `${Math.round(z * 100)}%`;
};
mapStage.addEventListener('pointerdown', (event) => {
  const r = mapStage.getBoundingClientRect();
  const { bounds, s } = map;
  camera.glide(
    bounds.x + (event.clientX - r.left) / s,
    bounds.y + (event.clientY - r.top) / s,
    camera.view.z,
    viewport.clientWidth / 2,
    viewport.clientHeight / 2,
  );
});

/* ---------- Camera and stops ---------- */

let pending = 0;
const camera = createCamera(viewport, world, () => {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(drawMap);
});
const center = () => [viewport.clientWidth / 2, viewport.clientHeight / 2] as const;

for (const button of $$<HTMLButtonElement>('[data-zoom]')) {
  button.addEventListener('click', () =>
    camera.zoomAt(Number(button.dataset.zoom) > 0 ? 1.25 : 0.8, ...center()),
  );
}

const markDock = (name: string) => {
  for (const button of $$('#dock button'))
    button.toggleAttribute('aria-current', button.dataset.go === name);
};

const go = (name: string) => {
  markDock(name);
  if (name === 'overview') return camera.frameRect(worldRect(), 1);
  const index = stops.indexOf(name as (typeof stops)[number]);
  if (index >= 0) current = index;
  camera.frameRect(clusterRect($(`#c-${name}`)), name === 'hero' ? 1.15 : 1);
};

const step = (delta: number) =>
  go(stops[(current + delta + stops.length) % stops.length] ?? 'hero');

for (const trigger of $$('[data-go]')) {
  trigger.addEventListener('click', (event) => {
    if (!camera.enabled) return;
    event.preventDefault();
    go(trigger.dataset.go ?? 'hero');
  });
}
for (const trigger of $$('[data-next]')) {
  trigger.addEventListener('click', () =>
    camera.enabled ? step(1) : $('#c-review').scrollIntoView({ behavior: 'smooth' }),
  );
}

document.addEventListener('keydown', (event) => {
  if (!camera.enabled || event.metaKey || event.ctrlKey || event.altKey) return;
  if ((event.target as Element).closest('input, textarea, [role="listbox"], [role="radiogroup"]'))
    return;
  if (event.key === 'ArrowRight') step(1);
  else if (event.key === 'ArrowLeft') step(-1);
  else if (event.key === '+' || event.key === '=') camera.zoomAt(1.25, ...center());
  else if (event.key === '-') camera.zoomAt(0.8, ...center());
  else if (event.key === '0') go('overview');
  else return;
  event.preventDefault();
});

// Keyboard users: bring the focused cluster into view.
world.addEventListener('focusin', (event) => {
  const target = event.target as HTMLElement;
  if (!camera.enabled || !target.matches(':focus-visible')) return;
  const r = target.getBoundingClientRect();
  const inView =
    r.left > 40 && r.right < innerWidth - 40 && r.top > 72 && r.bottom < innerHeight - 96;
  const cluster = target.closest<HTMLElement>('.cluster');
  if (cluster && !inView) go(cluster.dataset.stop ?? 'hero');
});
// The viewport never scrolls itself; undo any browser focus-scrolling.
viewport.addEventListener('scroll', () => {
  if (camera.enabled) viewport.scrollTo(0, 0);
});

/* ---------- Mode: canvas on wide screens, plain document on narrow ones ---------- */

const applyMode = () => {
  camera.enable(canvasMode.matches);
  document.documentElement.classList.toggle('canvas', canvasMode.matches);
  if (!canvasMode.matches) return;
  buildMap();
  const hero = clusterRect($('#c-hero'));
  // Open on the intro, left of centre, with the review peeking in from the right.
  const z = Math.min(1.15, (viewport.clientHeight - 200) / hero.h);
  const left = Math.max(56, viewport.clientWidth * 0.07);
  camera.set({
    z,
    x: left - hero.x * z,
    y: (viewport.clientHeight - hero.h * z) / 2 - hero.y * z + 8,
  });
  markDock('hero');
  current = 0;
  requestAnimationFrame(drawLinks);
};
canvasMode.addEventListener('change', applyMode);
addEventListener('resize', () => {
  if (!camera.enabled) return;
  buildMap();
  drawMap();
});

/* ---------- Theme, copy buttons ---------- */

const themeButton = $('#theme');
const syncTheme = () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeButton.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
};
themeButton.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('theme', next);
  } catch {}
  syncTheme();
});
syncTheme();

for (const button of $$<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? '');
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select to copy';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1600);
  });
}

initDemo(drawLinks);
initSetup();
document.fonts.ready.then(() => {
  applyMode();
  new ResizeObserver(drawLinks).observe($('#stage'));
});
