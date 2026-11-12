import * as React from 'react';

// Shared theme-aware Kinsta icon used by all add-on screens.

// Kinsta icon - dark background version (for light theme)
const KinstaIconDark = ({ size = 40 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 120 120"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <g clipPath="url(#clip0_shared_dark)">
      <path
        d="M0 24C0 10.7452 10.7452 0 24 0H96C109.254 0 120 10.7452 120 24V96C120 109.254 109.254 120 96 120H24C10.7452 120 0 109.254 0 96V24Z"
        fill="#181516"
      />
      <mask
        id="mask0_shared_dark"
        style={{ maskType: 'luminance' }}
        maskUnits="userSpaceOnUse"
        x="4"
        y="26"
        width="45"
        height="68"
      >
        <path
          d="M38.3632 26.0246C44.0636 26.0246 48.6843 30.6453 48.6843 36.3456V83.6548C48.6843 89.3551 44.0636 93.9755 38.3632 93.9755C27.2161 93.9755 16.069 93.9755 4.92188 93.9755V26.0252C16.069 26.0237 27.2161 26.0246 38.3632 26.0246Z"
          fill="white"
        />
      </mask>
      <g mask="url(#mask0_shared_dark)">
        <path
          d="M30.4688 9.84363H147.721V110.279H30.4688V9.84363Z"
          fill="url(#paint0_shared_dark)"
        />
      </g>
      <mask
        id="mask1_shared_dark"
        style={{ maskType: 'luminance' }}
        maskUnits="userSpaceOnUse"
        x="48"
        y="26"
        width="48"
        height="68"
      >
        <path
          d="M85.3079 26.0252C91.0083 26.0252 95.629 30.646 95.629 36.3463V83.6554C95.629 89.3557 91.0083 93.9762 85.3079 93.9762L48.8301 93.9844L48.8301 26.0156L85.3079 26.0252Z"
          fill="white"
        />
      </mask>
      <g mask="url(#mask1_shared_dark)">
        <path d="M60 9.84375H177.252V110.279H60V9.84375Z" fill="url(#paint1_shared_dark)" />
      </g>
    </g>
    <defs>
      <linearGradient
        id="paint0_shared_dark"
        x1="26.8484"
        y1="69.0531"
        x2="106.313"
        y2="43.7697"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0.182692" stopColor="#FE5A00" />
        <stop offset="0.598914" stopColor="#FF0000" />
      </linearGradient>
      <linearGradient
        id="paint1_shared_dark"
        x1="56.3797"
        y1="69.0532"
        x2="135.844"
        y2="43.7698"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0.211538" stopColor="#FE5A00" />
        <stop offset="0.634615" stopColor="#FF0000" />
      </linearGradient>
      <clipPath id="clip0_shared_dark">
        <rect width="120" height="120" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

// Kinsta icon - light background version (for dark theme)
const KinstaIconLight = ({ size = 40 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 120 120"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <g clipPath="url(#clip0_shared_light)">
      <path
        d="M0 24C0 10.7452 10.7452 0 24 0H96C109.254 0 120 10.7452 120 24V96C120 109.254 109.254 120 96 120H24C10.7452 120 0 109.254 0 96V24Z"
        fill="#F9F5F3"
      />
      <mask
        id="mask0_shared_light"
        style={{ maskType: 'luminance' }}
        maskUnits="userSpaceOnUse"
        x="4"
        y="26"
        width="45"
        height="68"
      >
        <path
          d="M38.3632 26.0246C44.0636 26.0246 48.6843 30.6453 48.6843 36.3456V83.6548C48.6843 89.3551 44.0636 93.9755 38.3632 93.9755C27.2161 93.9755 16.069 93.9755 4.92188 93.9755V26.0252C16.069 26.0237 27.2161 26.0246 38.3632 26.0246Z"
          fill="white"
        />
      </mask>
      <g mask="url(#mask0_shared_light)">
        <path
          d="M30.4688 9.84363H147.721V110.279H30.4688V9.84363Z"
          fill="url(#paint0_shared_light)"
        />
      </g>
      <mask
        id="mask1_shared_light"
        style={{ maskType: 'luminance' }}
        maskUnits="userSpaceOnUse"
        x="48"
        y="26"
        width="48"
        height="68"
      >
        <path
          d="M85.3079 26.0252C91.0083 26.0252 95.629 30.646 95.629 36.3463V83.6554C95.629 89.3557 91.0083 93.9762 85.3079 93.9762L48.8301 93.9844L48.8301 26.0156L85.3079 26.0252Z"
          fill="white"
        />
      </mask>
      <g mask="url(#mask1_shared_light)">
        <path d="M60 9.84375H177.252V110.279H60V9.84375Z" fill="url(#paint1_shared_light)" />
      </g>
    </g>
    <defs>
      <linearGradient
        id="paint0_shared_light"
        x1="26.8484"
        y1="69.0531"
        x2="106.313"
        y2="43.7697"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0.182692" stopColor="#FE5A00" />
        <stop offset="0.598914" stopColor="#FF0000" />
      </linearGradient>
      <linearGradient
        id="paint1_shared_light"
        x1="56.3797"
        y1="69.0532"
        x2="135.844"
        y2="43.7698"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0.211538" stopColor="#FE5A00" />
        <stop offset="0.634615" stopColor="#FF0000" />
      </linearGradient>
      <clipPath id="clip0_shared_light">
        <rect width="120" height="120" fill="white" />
      </clipPath>
    </defs>
  </svg>
);

// Theme-aware: dark theme → light icon (beige), light theme → dark icon (black)
const KinstaIcon = ({ size = 40 }: { size?: number }) => {
  const isDarkMode =
    typeof document !== 'undefined' &&
    (document.body.classList.contains('theme-dark') ||
      (getComputedStyle(document.body).backgroundColor.includes('rgb(') &&
        parseInt(getComputedStyle(document.body).backgroundColor.split(',')[0].replace(/\D/g, '')) <
          128));

  return isDarkMode !== false ? <KinstaIconLight size={size} /> : <KinstaIconDark size={size} />;
};

export default KinstaIcon;
