import * as React from 'react';
import { useState, useEffect } from 'react';
import KinstaPullDrawer from './KinstaPullDrawer';
import KinstaLinkDrawer from './KinstaLinkDrawer';
import KinstaPushScreen from './KinstaPushScreen';

const { ipcRenderer } = window.require('electron');

interface SiteLink {
  localSiteId: string;
  kinstaSiteId: string;
  kinstaSiteName: string;
  kinstaSiteSlug?: string;
}

export type KinstaMenuAction = 'link' | 'pull' | 'push' | 'unlink';

// Module-level cache so action handlers can decide synchronously whether a
// site is linked. Populated by KinstaDrawerHost (mounted via
// SiteInfo_TabNav_Items, so it exists on every site tab).
const linkCache = new Map<string, SiteLink | null>();
let apiConnected = false;

export const dispatchKinstaAction = (action: KinstaMenuAction, siteId: string): void => {
  window.dispatchEvent(new CustomEvent('kinsta:action', { detail: { action, siteId } }));
};

interface Props {
  site: any;
}

// Invisible component mounted in the site tab nav. Renders no toolbar UI —
// entry points live in the Kinsta page (routes[site-info]) and the native
// More menu (siteInfoMoreMenu navigation item). Owns the drawers.
export const KinstaDrawerHost: React.FC<Props> = ({ site }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [siteLink, setSiteLink] = useState<SiteLink | null>(null);
  const [drawerMode, setDrawerMode] = useState<'pull' | 'push' | null>(null);
  const [showPushScreen, setShowPushScreen] = useState(false);
  const [showLinkDrawer, setShowLinkDrawer] = useState(false);

  // Tell the Kinsta page (and anything else) that link/sync state changed
  const notifyStateChanged = () => {
    window.dispatchEvent(new CustomEvent('kinsta:state-changed', { detail: { siteId: site.id } }));
  };

  const refresh = async () => {
    const config = await ipcRenderer.invoke('kinsta:getConfig');
    apiConnected = !!config.apiKey;
    setIsConnected(apiConnected);
    const link = (await ipcRenderer.invoke('kinsta:getSiteLink', site.id)) ?? null;
    linkCache.set(site.id, link);
    setSiteLink(link);
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh() only reads site.id; re-run on site change
  }, [site.id]);

  // Triggered from the Kinsta page and the More menu
  useEffect(() => {
    const handler = async (e: Event) => {
      const { action, siteId } = (e as CustomEvent).detail || {};
      if (siteId && siteId !== site.id) return;
      switch (action as KinstaMenuAction) {
        case 'pull':
          if (apiConnected && linkCache.get(site.id)) {
            setDrawerMode('pull');
          } else {
            setShowLinkDrawer(true);
          }
          break;
        case 'push':
          // Push gets the full-screen preview (Magic Sync-style); pull keeps the drawer
          if (apiConnected && linkCache.get(site.id)) {
            setShowPushScreen(true);
          } else {
            setShowLinkDrawer(true);
          }
          break;
        case 'link':
          setShowLinkDrawer(true);
          break;
        case 'unlink':
          await ipcRenderer.invoke('kinsta:unlinkSite', site.id);
          linkCache.set(site.id, null);
          setSiteLink(null);
          notifyStateChanged();
          break;
      }
    };
    window.addEventListener('kinsta:action', handler);
    return () => window.removeEventListener('kinsta:action', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once per site; handler reads the current site.id closure
  }, [site.id]);

  const handleLinkComplete = (link: SiteLink) => {
    // Linking implies the API is connected (the link flow sets it up),
    // so update the module flag too — refresh() only runs on mount.
    apiConnected = true;
    setIsConnected(true);
    linkCache.set(site.id, link);
    setSiteLink(link);
    // Note: the drawer stays open to show its success view
    notifyStateChanged();
  };

  // "Pull from Kinsta" shortcut in the link drawer's success view
  const handleStartPullAfterLink = () => {
    setShowLinkDrawer(false);
    setDrawerMode('pull');
  };

  return (
    <>
      <KinstaLinkDrawer
        isOpen={showLinkDrawer}
        onClose={() => setShowLinkDrawer(false)}
        onLinkComplete={handleLinkComplete}
        onStartPull={handleStartPullAfterLink}
        site={site}
        isConnected={isConnected}
      />

      {drawerMode && siteLink && (
        <KinstaPullDrawer
          isOpen={true}
          onClose={() => {
            setDrawerMode(null);
            // Pull may have updated lastPullAt — refresh the page
            notifyStateChanged();
          }}
          site={site}
          siteLink={siteLink}
        />
      )}

      {showPushScreen && siteLink && (
        <KinstaPushScreen
          isOpen={true}
          onClose={() => {
            setShowPushScreen(false);
            // Push may have updated lastPushAt — refresh the page
            notifyStateChanged();
          }}
          site={site}
          siteLink={siteLink}
        />
      )}
    </>
  );
};

export default KinstaDrawerHost;
