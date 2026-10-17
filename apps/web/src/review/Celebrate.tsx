import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';

const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

/** A brief, dismissible "everything decided" moment. Respects reduced motion via CSS. */
export const Celebrate = ({ total }: { total: number }) => {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setOpen(false), 5200);
    return () => clearTimeout(timer);
  }, []);
  if (!open) return null;
  return (
    <div className="celebrate" role="status">
      <div className="confetti" aria-hidden="true">
        {Array.from({ length: 28 }, (_, index) => (
          <i
            key={index}
            className={`ink-${colors[index % colors.length]}`}
            style={{
              left: `${(index * 37) % 100}%`,
              animationDelay: `${(index % 7) * 70}ms`,
              transform: `rotate(${index * 47}deg)`,
            }}
          />
        ))}
      </div>
      <div className="celebrate-card">
        <span className="clean-badge">
          <Icon name="check" size={18} />
        </span>
        <strong>Board cleared</strong>
        <small>
          All {total} finding{total === 1 ? '' : 's'} decided. Rerun after your fixes to confirm
          them.
        </small>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
    </div>
  );
};

/** True only right after the last open finding gets decided in this view, not on every visit. */
export const useJustCleared = (done: number | null, total: number) => {
  const previous = useRef<number | null>(null);
  const [cleared, setCleared] = useState(false);
  useEffect(() => {
    if (done === null) return;
    if (previous.current !== null && total > 0 && done === total && previous.current < total)
      setCleared(true);
    if (done < total) setCleared(false);
    previous.current = done;
  }, [done, total]);
  return cleared;
};
