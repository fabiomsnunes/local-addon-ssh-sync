import * as React from 'react';
import { useState, useEffect } from 'react';
import PullDrawer from './PullDrawer';
import EnvironmentsDrawer from './EnvironmentsDrawer';
import PushScreen from './PushScreen';
import { SiteProfile } from './types';

const { ipcRenderer } = window.require('electron');

export type SyncAction = 'environments' | 'pull' | 'push';

export const dispatchSyncAction = (
  action: SyncAction,
  siteId: string,
  environmentId?: string,
): void => {
  window.dispatchEvent(
    new CustomEvent('sshsync:action', { detail: { action, siteId, environmentId } }),
  );
};

// Tell the page and the status badge that the profile or sync state changed
export const notifyStateChanged = (siteId: string): void => {
  window.dispatchEvent(new CustomEvent('sshsync:state-changed', { detail: { siteId } }));
};

interface Props {
  site: any;
}

// Invisible component mounted in the site tab nav. Renders no toolbar UI —
// entry points live in the SSH Sync page (routes[site-info]) and the native
// More menu (siteInfoMoreMenu navigation item). Owns the drawers.
export const DrawerHost: React.FC<Props> = ({ site }) => {
  const [profile, setProfile] = useState<SiteProfile | null>(null);
  const [pullEnvironmentId, setPullEnvironmentId] = useState<string | null>(null);
  const [pushEnvironmentId, setPushEnvironmentId] = useState<string | null>(null);
  const [showEnvironments, setShowEnvironments] = useState(false);

  const loadProfile = async (): Promise<SiteProfile | null> => {
    const loaded: SiteProfile | null =
      (await ipcRenderer.invoke('sshsync:getProfile', site.id)) ?? null;
    setProfile(loaded);
    return loaded;
  };

  useEffect(() => {
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadProfile() only reads site.id; re-run on site change
  }, [site.id]);

  // Triggered from the SSH Sync page and the More menu
  useEffect(() => {
    const handler = async (e: Event) => {
      const { action, siteId, environmentId } = (e as CustomEvent).detail || {};
      if (siteId && siteId !== site.id) return;
      // Read fresh: the page may have just saved environments
      const current = await loadProfile();
      const environments = current?.environments || [];
      const chosen =
        environments.find((env) => env.id === environmentId)?.id || environments[0]?.id || null;
      switch (action as SyncAction) {
        case 'pull':
          if (chosen) setPullEnvironmentId(chosen);
          else setShowEnvironments(true);
          break;
        case 'push':
          if (chosen) setPushEnvironmentId(chosen);
          else setShowEnvironments(true);
          break;
        case 'environments':
          setShowEnvironments(true);
          break;
      }
    };
    window.addEventListener('sshsync:action', handler);
    return () => window.removeEventListener('sshsync:action', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once per site; handler reads the current site.id closure
  }, [site.id]);

  const handleEnvironmentsSaved = (saved: SiteProfile) => {
    setProfile(saved);
    notifyStateChanged(site.id);
  };

  return (
    <>
      <EnvironmentsDrawer
        isOpen={showEnvironments}
        onClose={() => setShowEnvironments(false)}
        onSaved={handleEnvironmentsSaved}
        site={site}
        environments={profile?.environments || []}
      />

      {pullEnvironmentId && profile && (
        <PullDrawer
          isOpen={true}
          onClose={() => {
            setPullEnvironmentId(null);
            // Pull may have updated lastPullAt — refresh the page
            loadProfile();
            notifyStateChanged(site.id);
          }}
          site={site}
          profile={profile}
          initialEnvironmentId={pullEnvironmentId}
        />
      )}

      {pushEnvironmentId && profile && (
        <PushScreen
          isOpen={true}
          onClose={() => {
            setPushEnvironmentId(null);
            // Push may have updated lastPushAt — refresh the page
            loadProfile();
            notifyStateChanged(site.id);
          }}
          site={site}
          profile={profile}
          initialEnvironmentId={pushEnvironmentId}
        />
      )}
    </>
  );
};

export default DrawerHost;
