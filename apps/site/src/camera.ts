export type View = { x: number; y: number; z: number };
export type Rect = { x: number; y: number; w: number; h: number };

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.6;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A pan/zoom camera over `world`. Screen = world × z + (x, y).
 * Drag empty canvas or scroll to pan; pinch or ctrl+scroll to zoom around the pointer.
 */
export const createCamera = (viewport: HTMLElement, world: HTMLElement, onChange: () => void) => {
  const view: View = { x: 0, y: 0, z: 1 };
  let enabled = false;
  let frame = 0;

  const apply = () => {
    if (!enabled) return;
    world.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.z})`;
    const spacing = 24 * view.z * (view.z < 0.5 ? 2 : 1);
    viewport.style.backgroundSize = `${spacing}px ${spacing}px`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
    onChange();
  };

  const stop = () => {
    cancelAnimationFrame(frame);
    viewport.classList.remove('moving');
  };

  const set = (next: View) => {
    stop();
    Object.assign(view, { ...next, z: clamp(next.z, MIN_ZOOM, MAX_ZOOM) });
    apply();
  };

  /** Glides so the world point (cx, cy) lands on screen point (sx, sy) at zoom z. */
  const glide = (cx: number, cy: number, z: number, sx: number, sy: number) => {
    stop();
    const target = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const from = { cx: (sx - view.x) / view.z, cy: (sy - view.y) / view.z, z: view.z };
    if (reducedMotion()) {
      Object.assign(view, { z: target, x: sx - cx * target, y: sy - cy * target });
      return apply();
    }
    const start = performance.now();
    const duration = 820;
    viewport.classList.add('moving');
    const step = (now: number) => {
      const t = ease(Math.min(1, (now - start) / duration));
      // Interpolate zoom in log space so zooming out and back in feels even.
      const z = Math.exp(Math.log(from.z) + (Math.log(target) - Math.log(from.z)) * t);
      const px = from.cx + (cx - from.cx) * t;
      const py = from.cy + (cy - from.cy) * t;
      Object.assign(view, { z, x: sx - px * z, y: sy - py * z });
      apply();
      if (t < 1) frame = requestAnimationFrame(step);
      else viewport.classList.remove('moving');
    };
    frame = requestAnimationFrame(step);
  };

  /** Fits a world rectangle into the visible area (between the top bar and the dock). */
  const frameRect = (rect: Rect, maxZoom = 1) => {
    // Keep clear of the top bar, the dock and the minimap in the bottom-right corner.
    const inset = { top: 72, bottom: 96, left: 64, right: 232 };
    const width = viewport.clientWidth - inset.left - inset.right;
    const height = viewport.clientHeight - inset.top - inset.bottom;
    const z = Math.min(maxZoom, width / rect.w, height / rect.h);
    const sx = inset.left + width / 2;
    const sy = inset.top + height / 2;
    glide(rect.x + rect.w / 2, rect.y + rect.h / 2, z, sx, sy);
  };

  const zoomAt = (factor: number, sx: number, sy: number) => {
    const z = clamp(view.z * factor, MIN_ZOOM, MAX_ZOOM);
    set({ z, x: sx - ((sx - view.x) / view.z) * z, y: sy - ((sy - view.y) / view.z) * z });
  };

  const interactive = 'a, button, input, pre, .cmd, [role="option"]';
  let drag: { px: number; py: number; x: number; y: number; id: number } | null = null;

  viewport.addEventListener('pointerdown', (event) => {
    if (!enabled || event.button !== 0 || (event.target as Element).closest(interactive)) return;
    stop();
    drag = { px: event.clientX, py: event.clientY, x: view.x, y: view.y, id: event.pointerId };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('dragging');
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    set({ z: view.z, x: drag.x + event.clientX - drag.px, y: drag.y + event.clientY - drag.py });
  });
  const release = () => {
    drag = null;
    viewport.classList.remove('dragging');
  };
  viewport.addEventListener('pointerup', release);
  viewport.addEventListener('pointercancel', release);

  viewport.addEventListener(
    'wheel',
    (event) => {
      if (!enabled) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
      } else {
        set({ z: view.z, x: view.x - event.deltaX, y: view.y - event.deltaY });
      }
    },
    { passive: false },
  );

  return {
    view,
    set,
    glide,
    frameRect,
    zoomAt,
    get enabled() {
      return enabled;
    },
    enable(on: boolean) {
      enabled = on;
      stop();
      if (!on) {
        world.style.transform = '';
        viewport.style.backgroundSize = '';
        viewport.style.backgroundPosition = '';
      }
    },
  };
};

export type Camera = ReturnType<typeof createCamera>;
