import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { builtinModules } from 'module';

/**
 * Packaging guard for the renderer bundle.
 *
 * The renderer bundle is loaded by Local via a plain Node `require()` of
 * `lib/renderer/index.js` from inside the installed add-on directory
 * (`.../Local/addons/local-addon-kinsta/`), OUTSIDE Local's own app.asar.
 * So every bare `require("<pkg>")` left in the bundle (a webpack `external`)
 * MUST be resolvable from that directory on a CLEAN install — i.e. it must be
 * either:
 *   - a module Local actually exposes to the add-on's renderer require() path.
 *     Verified empirically (Local's local-lightning.log on a real .tgz install):
 *     the React ecosystem only — `react`, `react-dom` — plus `electron` (always
 *     available in the renderer). Local does NOT expose
 *     `@getflywheel/local-components` to add-ons, so it must NOT be an external;
 *     webpack has to bundle it.
 *   - one of our own `bundledDependencies` (shipped inside the .tgz node_modules).
 *
 * Anything else is absent from the released .tgz and throws MODULE_NOT_FOUND at
 * load time — Local swallows the throw (RendererAddonLoader logs it), the add-on
 * never registers its hooks, no UI appears, and Local's shell then crashes with
 * "Cannot read properties of undefined (reading 'toString')".
 *
 * Regressions this guards (both surfaced as the same toString crash on clean
 * installs): 1.1.6 shipped `require("react-router-dom")`; 1.1.7 still shipped
 * `require("@getflywheel/local-components")`. Both are devDependency-only and
 * unavailable on a clean install.
 */
describe('renderer bundle packaging', () => {
  const bundlePath = path.resolve(__dirname, '../../lib/renderer/index.js');

  it('only requires runtime-resolvable modules (no devDependency-only externals)', () => {
    if (!fs.existsSync(bundlePath)) {
      throw new Error(
        `Built bundle not found at ${bundlePath}. Run "npm run build:renderer" first.`,
      );
    }

    const bundle = fs.readFileSync(bundlePath, 'utf8');
    const required = new Set<string>();
    // Bare `require("x")` only. A member call like `window.require("x")` is a
    // DIFFERENT resolver: it runs against Local's renderer page inside app.asar,
    // so it reaches Local's own node_modules rather than the add-on directory.
    // The lookbehind keeps those out of the clean-install allow-list check.
    const re = /(?<![.\w$])require\(["']([^"']+)["']\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(bundle)) !== null) {
      const id = m[1];
      // Ignore relative requires (none expected in a bundled output anyway).
      if (!id.startsWith('.')) required.add(id);
    }

    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    const bundled: string[] = pkg.bundledDependencies ?? [];

    // Modules guaranteed present at runtime on a clean install:
    //  - exposed by Local to add-ons (verified: react + react-dom only)
    //  - electron + Node built-ins (always available in the electron-renderer)
    //  - our own bundled dependencies (shipped inside the .tgz)
    // NOTE: @getflywheel/local-components is deliberately NOT here — Local does
    // not expose it to add-ons, so it must be webpack-bundled, not externalized.
    const allowed = new Set<string>([
      'react',
      'react-dom',
      'electron',
      ...builtinModules,
      ...builtinModules.map((m) => `node:${m}`),
      ...bundled,
    ]);

    const disallowed = [...required].filter((id) => {
      // allow subpath imports of an allowed package (e.g. "@getflywheel/local/renderer")
      const base = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
      return !allowed.has(id) && !allowed.has(base);
    });

    expect(disallowed).toEqual([]);
  });

  /**
   * local-components suffixes every CSS-module class name with its own package
   * version (`.Spinner_nsNfA_v17-8-2`) and injects the matching stylesheet from
   * its own package directory. Local loads the copy in its app.asar, so the
   * document only ever has rules for the version LOCAL ships. Our webpack-bundled
   * copy carries no stylesheet, so if the components come from the bundle their
   * class names match nothing and every screen renders unstyled — the Local 10.1.2
   * regression. src/renderer/localComponents.ts pulls them from Local's copy via
   * `window.require` instead; this guards that indirection from being refactored
   * away back into a plain bundled import.
   */
  it('resolves local-components from Local at runtime, not from the bundle', () => {
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    expect(bundle).toMatch(/window\.require\(["']@getflywheel\/local-components["']\)/);
  });
});
