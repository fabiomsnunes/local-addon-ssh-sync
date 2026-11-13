import * as React from 'react';
import { useState } from 'react';
import { STATUS, tint } from './colors';

// What the main process returns when WordPress in the folder reports another
// site URL than the environment's.
export interface SiteUrlMismatch {
  actual: string;
  expected: string;
}

interface Props {
  mismatch: SiteUrlMismatch;
  busy?: boolean;
  onContinue: (acceptSiteUrl: string) => void;
}

// Asks the user to type the URL WordPress reports before going on anyway
// (e.g. a staging just cloned from production still says production's URL).
const SiteUrlConfirm: React.FC<Props> = ({ mismatch, busy, onContinue }) => {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === mismatch.actual;
  return (
    <div
      style={{
        marginTop: '16px',
        padding: '12px 16px',
        backgroundColor: tint(STATUS.warning, 0.1),
        border: `1px solid ${tint(STATUS.warning, 0.3)}`,
        borderRadius: '8px',
        color: STATUS.warning,
        fontSize: '13px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      <span>
        WordPress in this folder says <strong>{mismatch.actual}</strong>, not{' '}
        <strong>{mismatch.expected}</strong>. If this is right (e.g. a staging just cloned from
        production), type <strong>{mismatch.actual}</strong> to continue.
      </span>
      <input
        type="text"
        value={typed}
        disabled={busy}
        spellCheck={false}
        onChange={(e) => setTyped(e.target.value)}
        style={{
          padding: '6px 8px',
          borderRadius: '4px',
          border: `1px solid ${tint(STATUS.warning, 0.4)}`,
          backgroundColor: '#1e1e1e',
          color: 'inherit',
          fontSize: '13px',
          fontFamily: 'monospace',
        }}
      />
      <div>
        <button
          disabled={!matches || busy}
          onClick={() => onContinue(mismatch.actual)}
          style={{
            background: 'none',
            border: `1px solid ${STATUS.warning}`,
            borderRadius: '14px',
            color: STATUS.warning,
            fontSize: '12px',
            padding: '4px 12px',
            cursor: matches && !busy ? 'pointer' : 'not-allowed',
            opacity: matches && !busy ? 1 : 0.4,
            fontFamily: 'inherit',
          }}
        >
          Continue
        </button>
      </div>
    </div>
  );
};

export default SiteUrlConfirm;
