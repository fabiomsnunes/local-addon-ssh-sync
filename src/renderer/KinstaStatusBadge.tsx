import * as React from 'react';
import { useState, useEffect } from 'react';
import KinstaIcon from './KinstaIcon';

const { ipcRenderer } = window.require('electron');

interface ActiveSyncState {
  mode: 'pull' | 'push';
  progress: number;
}

interface Props {
  site: any;
  // Navigate to the Kinsta page (events.send('goToRoute', ...) from index.tsx)
  onOpen: () => void;
}

// Always-visible status badge in the site view's top-right corner
// (SiteInfo_Top_TopRight hook). Shows link status at a glance and live sync
// progress even when the sync drawer is closed or another tab is active.
// Renders nothing for unlinked sites — zero noise.
const KinstaStatusBadge: React.FC<Props> = ({ site, onOpen }) => {
  const [linked, setLinked] = useState(false);
  const [sync, setSync] = useState<ActiveSyncState | null>(null);
  const [hover, setHover] = useState(false);

  const refresh = async () => {
    const link = await ipcRenderer.invoke('kinsta:getSiteLink', site.id);
    setLinked(!!link);
  };

  useEffect(() => {
    refresh();
    setSync(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh() only reads site.id; re-run on site change
  }, [site.id]);

  // Stay in sync with link/unlink from the page and drawers
  useEffect(() => {
    const handler = (e: Event) => {
      const { siteId } = (e as CustomEvent).detail || {};
      if (!siteId || siteId === site.id) refresh();
    };
    window.addEventListener('kinsta:state-changed', handler);
    return () => window.removeEventListener('kinsta:state-changed', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once per site; handler reads the current site.id closure
  }, [site.id]);

  // Live sync progress (events carry siteId + mode from the main process)
  useEffect(() => {
    const handler = (_event: any, p: any) => {
      if (p.siteId !== site.id) return;
      if (p.stage === 'done' || p.stage === 'error' || p.stage === 'cancelled') {
        setSync(null);
        refresh();
      } else if (p.mode === 'pull' || p.mode === 'push') {
        setSync({ mode: p.mode, progress: p.progress || 0 });
      }
    };
    ipcRenderer.on('kinsta:syncProgress', handler);
    return () => {
      ipcRenderer.removeListener('kinsta:syncProgress', handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once per site; handler reads the current site.id closure
  }, [site.id]);

  if (!linked && !sync) return null;

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Open Kinsta"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        alignSelf: 'center',
        gap: '8px',
        cursor: 'pointer',
        fontSize: '14px',
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        marginRight: '16px',
        opacity: hover ? 0.8 : 1,
        transition: 'opacity 0.15s ease',
        userSelect: 'none',
      }}
    >
      <KinstaIcon size={18} />
      {sync ? (
        <span>
          {sync.mode === 'pull' ? 'Pulling' : 'Pushing'}… {sync.progress}%
        </span>
      ) : (
        <span>Linked to Kinsta</span>
      )}
    </div>
  );
};

export default KinstaStatusBadge;
