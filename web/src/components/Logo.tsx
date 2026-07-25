/**
 * Brand mark, inlined as JSX.
 *
 * It has to be inline rather than <img src="logo.svg"> because an external SVG
 * cannot inherit `currentColor` — referenced that way it renders in its own
 * fixed colour and ignores the theme entirely.
 *
 * Geometry: a location pin whose void forms the vehicle, flanked by two arcs
 * that read as both a route and a signal wave.
 */
export function Logo({
  size = 28,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Kairosa"
    >
      <path
        d="M16 3.5c-5.1 0-9.2 4.03-9.2 9 0 6.3 7.9 14.4 8.6 15.06a.86.86 0 0 0 1.2 0c.7-.66 8.6-8.76 8.6-15.06 0-4.97-4.1-9-9.2-9Z"
        fill="currentColor"
      />
      <circle cx="16" cy="12.3" r="3.4" fill="var(--bg)" />
      <path
        d="M23.4 5.2a10.6 10.6 0 0 1 0 14.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.35"
      />
      <path
        d="M8.6 5.2a10.6 10.6 0 0 0 0 14.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.35"
      />
    </svg>
  );
}
