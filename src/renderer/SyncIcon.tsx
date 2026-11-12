import * as React from 'react';

// Shared add-on icon: a server with up/down arrows. Drawn with currentColor so
// it follows Local's light and dark themes without detecting either.
const SyncIcon = ({ size = 40 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 40 40"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="34" height="34" rx="8" opacity="0.35" />
    <rect x="11" y="10" width="18" height="8" rx="2" />
    <rect x="11" y="22" width="18" height="8" rx="2" />
    <path d="M15 14h.01M15 26h.01" />
    <path d="M24 13.5v-1.5M22.5 13l1.5-1.5 1.5 1.5" />
    <path d="M24 25v1.5M22.5 25.5l1.5 1.5 1.5-1.5" />
  </svg>
);

export default SyncIcon;
