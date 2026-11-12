import * as React from 'react';
import { AddonRendererContext } from '@getflywheel/local/renderer';
import { DrawerHost } from './DrawerHost';
import SyncPage from './SyncPage';
import StatusBadge from './StatusBadge';

const PAGE_PATH = (siteId: string) => `/main/site-info/${siteId}/ssh-sync`;

export default function (context: AddonRendererContext): void {
  const { hooks, events } = context;
  // Use Local's own react-router-dom (exposed on the context) instead of
  // importing the package. The add-on bundle is loaded by a plain Node
  // require() from the installed add-on directory — outside Local's app.asar —
  // so a bare `import 'react-router-dom'` (webpack external) would be an
  // unresolvable `require("react-router-dom")` on a clean install (it's a
  // devDependency only, not shipped in the .tgz) → MODULE_NOT_FOUND at load →
  // no hooks register → no UI. context.ReactRouter.Route is the version-matched
  // component Local already uses for its <Switch>.
  // (ReactRouter is typed Partial<…>; Local's loader always provides Route.)
  const Route = context.ReactRouter.Route!;

  // Invisible host for the environments/pull/push drawers.
  // Mounted in the tab nav so it exists on every site tab (renders no toolbar UI).
  hooks.addContent('SiteInfo_TabNav_Items', (site: any) => {
    return <DrawerHost key="ssh-sync-drawer-host" site={site} />;
  });

  // The add-on's home: a dedicated page rendered inside Local's site-info
  // <Switch>. Local passes { routeChildrenProps } (site, siteStatus, ...).
  hooks.addContent('routes[site-info]', ({ routeChildrenProps }: any) => {
    return (
      <Route
        key="ssh-sync-route"
        path="/main/site-info/:siteId/ssh-sync"
        render={() => (
          <SyncPage site={routeChildrenProps.site} siteStatus={routeChildrenProps.siteStatus} />
        )}
      />
    );
  });

  // Status badge in the site view's top-right corner: configured state at a
  // glance + live sync progress even when the drawer is closed.
  hooks.addContent('SiteInfo_Top_TopRight', (site: any) => {
    return (
      <StatusBadge
        key="ssh-sync-status-badge"
        site={site}
        onOpen={() => events.send('goToRoute', PAGE_PATH(site.id))}
      />
    );
  });

  // Native More-menu item navigating to the SSH Sync page (the documented
  // pattern — More holds navigation to add-on tabs, not raw actions).
  hooks.addFilter('siteInfoMoreMenu', (menu: any[], site: any) => {
    menu.push({
      label: 'SSH Sync',
      click: () => events.send('goToRoute', PAGE_PATH(site.id)),
    });
    return menu;
  });
}
