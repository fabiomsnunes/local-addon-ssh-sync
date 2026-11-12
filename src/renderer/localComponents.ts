/**
 * Single resolution point for `@getflywheel/local-components`.
 *
 * WHY THIS EXISTS
 * ---------------
 * local-components hashes its CSS-module class names AND suffixes every one of
 * them with its own package version:
 *
 *     .Spinner_nsNfA_v17-8-1 { ... }      // shipped by local-components 17.8.1
 *     .Spinner_nsNfA_v17-8-2 { ... }      // shipped by local-components 17.8.2
 *
 * The stylesheet is not part of the JS bundle — `dist/add-styles` injects a
 * <link> to `<pkg dir>/dist/scoped.css` at import time. Local loads the copy
 * inside its own app.asar, so the document only ever contains the rules for the
 * version LOCAL ships.
 *
 * We webpack-bundle local-components (it is NOT resolvable from an installed
 * add-on dir on a clean install — see bundle.packaging.test.ts), but the bundle
 * carries no scoped.css. So a bundled copy emits `_v17-8-1` class names while
 * Local's sheet defines `_v17-8-2` ones: zero overlap, every component renders
 * completely unstyled. That is exactly what Local 10.1.2 did — it bumped
 * local-components 17.8.1 -> 17.8.2 and the add-on's UI lost its styling.
 * Before that the versions happened to match, so it looked fine by luck.
 *
 * Fix: take the components from LOCAL's own copy at runtime. `window.require`
 * resolves against the renderer page inside app.asar, so it finds whichever
 * version Local ships — the class names then always match the stylesheet Local
 * loaded, for this update and every future one. (`window.require` is already
 * how this add-on gets `electron`.)
 *
 * The webpack-bundled copy stays as a fallback so a Local build that does not
 * expose the package still renders a working (if unstyled) UI instead of
 * throwing at load time and taking the whole add-on down with it.
 */
import * as bundledComponents from '@getflywheel/local-components';

type LocalComponents = typeof bundledComponents;

function resolveLocalComponents(): LocalComponents {
  try {
    // Written as a direct `window.require(...)` member call on purpose: it is the
    // same pattern the rest of the renderer uses for `electron`, it throws (and
    // is caught here) when Local doesn't expose it, and it survives minification
    // verbatim so bundle.packaging.test.ts can assert on it.
    const fromLocal = (window as unknown as { require(id: string): LocalComponents }).require(
      '@getflywheel/local-components',
    );
    // Sanity-check the shape before trusting it — a stub would break every screen.
    if (fromLocal && typeof fromLocal.Title !== 'undefined') {
      return fromLocal;
    }
  } catch {
    // Fall through to the bundled copy.
  }

  console.warn(
    '[kinsta-sync] Could not load @getflywheel/local-components from Local; ' +
      'using the bundled copy. Components will render unstyled because their ' +
      "class names won't match Local's stylesheet.",
  );
  return bundledComponents;
}

const localComponents = resolveLocalComponents();

export const {
  Checkbox,
  Close,
  ConnectPushIcon,
  FileAddedIcon,
  FileRightArrowIcon,
  FlyModal,
  FlySelect,
  InputSearch,
  PrimaryButton,
  ProgressBar,
  RadioBlock,
  Spinner,
  TextButton,
  Title,
  VirtualTable,
} = localComponents;

// Types are erased at compile time, so they can come straight from the package.
export type { IVirtualTableCellRendererDataArgs } from '@getflywheel/local-components';
