import {
  type ButtonHTMLAttributes,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { Tint } from '../lib/meta';
import { Icon, type IconName } from './Icon';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'soft' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  kbd?: string;
};
export const Button = ({
  variant = 'soft',
  size = 'md',
  icon,
  kbd,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) => (
  <button type={type} className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
    {icon && <Icon name={icon} size={size === 'lg' ? 18 : 15} />}
    {children}
    {kbd && <Kbd>{kbd}</Kbd>}
  </button>
);

export const IconButton = ({
  icon,
  label,
  className = '',
  active,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  active?: boolean;
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    className={`icon-btn ${active ? 'is-active' : ''} ${className}`}
    {...rest}
  >
    <Icon name={icon} />
  </button>
);

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

export const Pill = ({
  tint = 'gray',
  children,
  dot,
  className = '',
}: {
  tint?: Tint;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) => (
  <span className={`pill tint-${tint} ${className}`}>
    {dot && <i className="pill-dot" />}
    {children}
  </span>
);

export const Switch = ({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean | undefined;
}) => (
  <label className={`switch-row ${disabled ? 'is-disabled' : ''}`}>
    <span className="switch-text">
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </span>
    <input
      type="checkbox"
      role="switch"
      className="switch"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  </label>
);

export const Segmented = <T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { id: T; label: ReactNode; icon?: IconName }[];
  onChange: (value: T) => void;
  label: string;
}) => (
  <div className="segmented" role="radiogroup" aria-label={label}>
    {options.map((option) => (
      <button
        key={option.id}
        type="button"
        role="radio"
        aria-checked={value === option.id}
        className={value === option.id ? 'is-on' : ''}
        onClick={() => onChange(option.id)}
      >
        {option.icon && <Icon name={option.icon} size={14} />}
        {option.label}
      </button>
    ))}
  </div>
);

export const Field = ({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <small className="field-hint">{hint}</small>}
  </label>
);

export const Avatar = ({
  tint,
  glyph,
  size = 28,
}: {
  tint: Tint;
  glyph: string;
  size?: number;
}) => (
  <span
    className={`avatar tint-${tint}`}
    style={{ width: size, height: size, fontSize: size * 0.42 }}
    aria-hidden="true"
  >
    {glyph}
  </span>
);

/** Small anchored popover menu. Closes on outside click and Escape. */
export const Menu = ({
  trigger,
  children,
  align = 'end',
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
}) => {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div className="menu-host" ref={host}>
      {trigger({ onClick: () => setOpen(!open), 'aria-expanded': open })}
      {open && (
        <div className={`menu menu-${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
};

export const MenuItem = ({
  icon,
  children,
  hint,
  danger,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  hint?: ReactNode;
  danger?: boolean;
}) => (
  <button
    type="button"
    role="menuitem"
    className={`menu-item ${danger ? 'is-danger' : ''}`}
    {...rest}
  >
    {icon && <Icon name={icon} size={15} />}
    <span className="menu-item-text">
      {children}
      {hint && <small>{hint}</small>}
    </span>
  </button>
);

export const Dialog = ({
  title,
  children,
  onClose,
  footer,
  wide,
}: {
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
}) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'is-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body">
        <header className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className="dialog-content">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </dialog>
  );
};

type Toast = { id: number; text: string; tone: 'info' | 'error' | 'success' };
const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-3), { id, text, tone }]);
    setTimeout(
      () => setToasts((list) => list.filter((toast) => toast.id !== id)),
      tone === 'error' ? 9000 : 4500,
    );
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.tone}`}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <Icon
              name={
                toast.tone === 'error' ? 'flag' : toast.tone === 'success' ? 'check' : 'sparkle'
              }
              size={15}
            />
            <span>{toast.text}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setToasts((list) => list.filter((entry) => entry.id !== toast.id))}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const Empty = ({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: ReactNode;
  children?: ReactNode;
}) => (
  <div className="empty-state">
    <span className="empty-icon">
      <Icon name={icon} size={20} />
    </span>
    <strong>{title}</strong>
    {children && <p>{children}</p>}
  </div>
);
