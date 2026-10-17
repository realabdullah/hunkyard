/** ReviewLab mark: a lens over two diff lines, in the current ink. */
export const BrandMark = ({ size = 26 }: { size?: number }) => (
  <svg
    className="brand-mark"
    width={size}
    height={size}
    viewBox="0 0 26 26"
    aria-hidden="true"
    focusable="false"
  >
    <rect width="26" height="26" rx="7" style={{ fill: 'var(--text)' }} />
    <g style={{ stroke: 'var(--bg)' }} fill="none" strokeLinecap="round">
      <circle cx="11.6" cy="11.6" r="6" strokeWidth="2" />
      <path d="M8.9 10.2h3.6M10.4 13h4" strokeWidth="1.7" />
      <path d="m16.2 16.2 3.6 3.6" strokeWidth="2.2" />
    </g>
  </svg>
);
