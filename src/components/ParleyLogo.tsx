type ParleyLogoProps = {
  className?: string;
  title?: string;
};

export function ParleyLogo({ className, title = "Parley" }: ParleyLogoProps) {
  return (
    <svg viewBox="0 0 40 40" role="img" aria-label={title} className={className}>
      <title>{title}</title>
      <path
        d="M10 3 H30 A7 7 0 0 1 37 10 V26 A7 7 0 0 1 30 33 H20 L13 38 L15 33 H10 A7 7 0 0 1 3 26 V10 A7 7 0 0 1 10 3 Z"
        fill="#222428"
      />
      <path d="M14 22 A6 6 0 0 1 26 22 Z" fill="#E8A23A" />
      <line
        x1="8"
        y1="22"
        x2="32"
        y2="22"
        stroke="#EEECE6"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
