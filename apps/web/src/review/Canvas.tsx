import {
  forwardRef,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { IconButton } from '../ui/primitives';

export type View = { x: number; y: number; k: number };
export type Bounds = { x: number; y: number; w: number; h: number };
export type CanvasHandle = {
  fit: (bounds: Bounds) => void;
  view: () => View;
  reveal: (bounds: Bounds, insetRight: number) => void;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Infinite dotted canvas: drag empty space or hold Space to pan, scroll to pan,
 * ⌘/Ctrl + scroll or pinch to zoom around the pointer.
 */
export const Canvas = forwardRef<
  CanvasHandle,
  { children: ReactNode; initial: Bounds; overlay?: ReactNode; onBackground?: () => void }
>(({ children, initial, overlay, onBackground }, ref) => {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const [gliding, setGliding] = useState(false);

  const fit = useCallback((bounds: Bounds) => {
    const element = host.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const k = clamp(Math.min((width - 120) / bounds.w, (height - 140) / bounds.h), 0.35, 1);
    setView({
      k,
      x: (width - bounds.w * k) / 2 - bounds.x * k,
      y: Math.max(48, (height - bounds.h * k) / 2) - bounds.y * k,
    });
  }, []);
  /** Pans just enough to keep `bounds` clear of an overlay docked on the right. */
  const reveal = useCallback((bounds: Bounds, insetRight: number) => {
    const element = host.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setGliding(true);
    setTimeout(() => setGliding(false), 480);
    setView((current) => {
      const left = bounds.x * current.k + current.x;
      const right = (bounds.x + bounds.w) * current.k + current.x;
      const top = bounds.y * current.k + current.y;
      const bottom = (bounds.y + bounds.h) * current.k + current.y;
      const limit = width - insetRight - 24;
      let dx = 0;
      let dy = 0;
      if (right > limit) dx = limit - right;
      if (left + dx < 24) dx = 24 - left;
      if (bottom > height - 70) dy = height - 70 - bottom;
      if (top + dy < 24) dy = 24 - top;
      return dx || dy ? { ...current, x: current.x + dx, y: current.y + dy } : current;
    });
  }, []);
  useImperativeHandle(ref, () => ({ fit, reveal, view: () => viewRef.current }), [fit, reveal]);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || initial.w === 0) return;
    fitted.current = true;
    fit(initial);
  }, [initial, fit]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const element = host.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    setView((current) => {
      const k = clamp(current.k * factor, 0.25, 2.5);
      return {
        k,
        x: px - ((px - current.x) * k) / current.k,
        y: py - ((py - current.y) * k) / current.k,
      };
    });
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('.no-canvas-scroll')) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey)
        zoomAt(
          Math.exp(-event.deltaY * 0.0022),
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
      else
        setView((current) => ({
          ...current,
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoomAt]);

  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !typing(event.target)) {
        if (!event.repeat) setSpace(true);
        event.preventDefault();
      }
      if (typing(event.target) || event.metaKey || event.ctrlKey) return;
      if (event.key === '=' || event.key === '+') zoomAt(1.2);
      if (event.key === '-') zoomAt(1 / 1.2);
      if (event.key === '0') fit(initial);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [zoomAt, fit, initial]);

  const start = (event: ReactPointerEvent) => {
    const onCard = (event.target as HTMLElement).closest(
      '[data-card], button, a, input, textarea, select',
    );
    if (onCard && !space) return;
    if (event.button !== 0 && event.button !== 1) return;
    const origin = { x: event.clientX, y: event.clientY, view: viewRef.current };
    let moved = false;
    setPanning(true);
    const move = (next: PointerEvent) => {
      const dx = next.clientX - origin.x;
      const dy = next.clientY - origin.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      setView({ ...origin.view, x: origin.view.x + dx, y: origin.view.y + dy });
    };
    const end = () => {
      setPanning(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      if (!moved && !onCard) onBackground?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const dot = 22 * view.k;
  return (
    <div
      ref={host}
      className={`canvas ${space ? 'is-space' : ''} ${panning ? 'is-panning' : ''} ${gliding ? 'is-gliding' : ''}`}
      style={{
        backgroundSize: `${dot}px ${dot}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onPointerDown={start}
    >
      <div
        className="canvas-world"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        data-zoom={view.k < 0.6 ? 'far' : 'near'}
      >
        {children}
      </div>
      {overlay}
      <div className="canvas-controls" role="toolbar" aria-label="Canvas zoom">
        <IconButton icon="zoomOut" label="Zoom out (−)" onClick={() => zoomAt(1 / 1.2)} />
        <button
          type="button"
          className="zoom-readout"
          onClick={() => setView((current) => ({ ...current, k: 1 }))}
          title="Reset to 100%"
        >
          {Math.round(view.k * 100)}%
        </button>
        <IconButton icon="zoomIn" label="Zoom in (+)" onClick={() => zoomAt(1.2)} />
        <span className="divider" />
        <IconButton icon="fit" label="Fit everything (0)" onClick={() => fit(initial)} />
      </div>
    </div>
  );
});
Canvas.displayName = 'Canvas';
