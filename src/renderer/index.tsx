import * as React from 'react';
import { AddonRendererContext, AddonSettingsItem } from '@getflywheel/local/renderer';
import { KinstaDrawerHost } from './KinstaSitePanel';
import KinstaPage from './KinstaPage';
import KinstaStatusBadge from './KinstaStatusBadge';
import KinstaSettings from './KinstaSettings';

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

  // Invisible host for the link/sync drawers.
  // Mounted in the tab nav so it exists on every site tab (renders no toolbar UI).
  hooks.addContent('SiteInfo_TabNav_Items', (site: any) => {
    return <KinstaDrawerHost key="kinsta-drawer-host" site={site} />;
  });

  // The add-on's home: a dedicated page rendered inside Local's site-info
  // <Switch>. Local passes { routeChildrenProps } (site, siteStatus, ...).
  hooks.addContent('routes[site-info]', ({ routeChildrenProps }: any) => {
    return (
      <Route
        key="kinsta-route"
        path="/main/site-info/:siteId/kinsta"
        render={() => (
          <KinstaPage site={routeChildrenProps.site} siteStatus={routeChildrenProps.siteStatus} />
        )}
      />
    );
  });

  // Status badge in the site view's top-right corner: link status at a
  // glance + live sync progress even when the drawer is closed.
  hooks.addContent('SiteInfo_Top_TopRight', (site: any) => {
    return (
      <KinstaStatusBadge
        key="kinsta-status-badge"
        site={site}
        onOpen={() => events.send('goToRoute', `/main/site-info/${site.id}/kinsta`)}
      />
    );
  });

  // Native More-menu item navigating to the Kinsta page (the documented
  // pattern — More holds navigation to add-on tabs, not raw actions).
  hooks.addFilter('siteInfoMoreMenu', (menu: any[], site: any) => {
    menu.push({
      label: 'Kinsta Sync',
      click: () => events.send('goToRoute', `/main/site-info/${site.id}/kinsta`),
    });
    return menu;
  });

  // Add Kinsta settings to preferences
  hooks.addFilter(
    'preferencesMenuItems',
    (items: AddonSettingsItem[]) => {
      const kinstaItem: AddonSettingsItem = {
        path: 'kinsta',
        displayName: 'Kinsta Sync',
        sections: KinstaSettings,
        onApply: () => {},
      };
      return [...items, kinstaItem];
    },
    10,
  );
}
