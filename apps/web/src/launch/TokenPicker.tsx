import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';

export type TokenOption<T extends string> = {
  id: T;
  label: string;
  hint?: string;
  lead?: ReactNode;
  trail?: ReactNode;
};

/**
 * An inline word in the launch sentence that opens a keyboard-driven list (arrows, Enter, Esc),
 * in the manner of a command bar.
 */
export const TokenPicker = <T extends string>({
  label,
  value,
  options,
  onChange,
  display,
  footer,
}: {
  label: string;
  value: T;
  options: readonly TokenOption<T>[];
  onChange: (value: T) => void;
  display: ReactNode;
  footer?: (close: () => void) => ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const host = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    setCursor(
      Math.max(
        0,
        options.findIndex((option) => option.id === value),
      ),
    );
    const away = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    requestAnimationFrame(() => list.current?.focus());
    return () => document.removeEventListener('pointerdown', away);
  }, [open, options, value]);
  const close = () => {
    setOpen(false);
    host.current?.querySelector<HTMLButtonElement>('.token')?.focus();
  };
  const pick = (id: T) => {
    onChange(id);
    close();
  };
  const active = options[cursor];
  return (
    <span className="token-host" ref={host}>
      <button
        type="button"
        className={`token ${open ? 'is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${options.find((option) => option.id === value)?.label ?? value}`}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {display}
        <Icon name="chevronDown" size={14} className="token-caret" />
      </button>
      {open && (
        <div className="token-pop">
          <div className="token-pop-head">{label}</div>
          <div
            ref={list}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label={label}
            aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
            className="token-list"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setCursor((index) => (index + 1) % options.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setCursor((index) => (index - 1 + options.length) % options.length);
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                if (active) pick(active.id);
              }
            }}
          >
            {options.map((option, index) => (
              <div
                key={option.id}
                id={`${listId}-${option.id}`}
                role="option"
                aria-selected={option.id === value}
                className={`token-option ${index === cursor ? 'is-cursor' : ''}`}
                onPointerMove={() => setCursor(index)}
                onClick={() => pick(option.id)}
              >
                {option.lead && <span className="token-lead">{option.lead}</span>}
                <span className="token-text">
                  <strong>{option.label}</strong>
                  {option.hint && <small>{option.hint}</small>}
                </span>
                {option.trail}
                {option.id === value && <Icon name="check" size={14} className="token-check" />}
              </div>
            ))}
          </div>
          {footer && <div className="token-foot">{footer(close)}</div>}
        </div>
      )}
    </span>
  );
};
