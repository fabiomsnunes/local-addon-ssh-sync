# SSH Sync for Local

Pull and push WordPress sites between [Local](https://localwp.com) and **any server you can reach over SSH**: files and database, with automatic URL search-replace, safety backups, rollback, and a local copy that cannot email your customers or upload backups by accident.

No host API, no account to connect: if `ssh you@your-server` works, SSH Sync works.

> Started from [local-addon-kinsta](https://github.com/landerss0n/local-addon-kinsta) by Lucas Andersson (MIT), whose sync engine it reuses for any host. Not affiliated with WP Engine or Local.

## Features

- **Pull** files (uploads optional) and the database from a server into a Local site
- **Push** with a preview: a dry-run diff of every file that would change, untick what you don't want, _only newer_ or _all modified_ files; deletions only when you tick them
- **Environments per site**: Production, Staging, anything; each with its own SSH connection, WordPress folder, URL, WP-CLI command, cache command and excludes
- **SSH key or password**: an alias from your `~/.ssh/config`, or host, user and port
- **Safe local copy** (on by default): turns off backup, mail and remote-management plugins, switches Stripe to test mode, and blocks outgoing requests and email on the copy. A later database push puts all of that back on the server
- **Production guard**: replacing a production database needs Migration mode and the domain typed back
- **Search-replace** of `https://`, `http://`, `//` and JSON-escaped URLs, multisite-aware, `guid` untouched; table prefix differences handled both ways
- **Safety nets**: local database backup before a pull, remote database downloaded before a push, automatic rollback if an import fails
- **Command line**: `ssh-sync pull|push|test|envs`, next to Local's own `localwp`

## Requirements

- **macOS** (Linux should work, untested; Windows is not supported)
- **Local 10** or newer
- **On the server**: SSH access, `rsync` and [WP-CLI](https://wp-cli.org/) (most managed hosts have both; Test connection tells you which one is missing)
- **On your computer**: `brew install rsync` is recommended. macOS ships openrsync, which works but cannot show live progress or the size and type of each change in the push preview

## Installation

1. Download the latest `.tgz` from [Releases](https://github.com/fabiomsnunes/local-addon-ssh-sync/releases)
2. In Local: **Add-ons → Installed → Install from disk** and pick the file
3. Enable the add-on and relaunch Local when prompted

From source:

```bash
cd ~/Library/Application\ Support/Local/addons
git clone https://github.com/fabiomsnunes/local-addon-ssh-sync.git
cd local-addon-ssh-sync
npm install
npm run build
```

## Getting started

1. Create (or open) the site in Local. For a new copy of a live site, an empty WordPress site is enough
2. **More → SSH Sync → Add a server**
   - **Connection**: pick a host from your `~/.ssh/config`, or enter host, user and port
   - **Authentication**: SSH key (your agent or `~/.ssh/config`) or password
   - **WordPress folder**: where `wp-config.php` lives, e.g. `/var/www/example.com` or `~/public_html`
   - **Site URL**: e.g. `https://example.com`
   - **This is production**: tick it for the live site
3. **Test connection**, then **Save**
4. **Pull** to bring the site into Local; **Push** to send your changes back

## What a sync does

**Pull** (server → Local): connect once and check the WordPress folder → install the local safety net → rsync files → back up the local database → export the server database to a private temp file, download it, delete it → import → search-replace → adopt the server's table prefix → make the copy safe (see below).

**Push** (Local → server): the preview shows exactly what would change. Push then: confirmation for production → (with the database) export the server database and download it as the rollback backup → rsync only the files you selected → delete only the deletions you ticked → (with the database) import, search-replace, re-enable on the server what the safe copy had turned off → run the environment's cache command.

Never synced, either way: `wp-config.php` and every copy of it, `.htaccess`, `.user.ini`, `php.ini`, object/page cache drop-ins, `wp-content/cache/`, `.git`, `node_modules`, SQL dumps, backup copies of any file (`*.bak`, `*.orig`, `*~`) and the safety mu-plugin. Add your own per environment (e.g. `wp-content/litespeed/`).

## The safe local copy

A pulled site runs the live site's plugins. The first page you open fires wp-cron, which can send real emails, upload a backup to the live site's storage, report to a management dashboard or call payment APIs. With **Make the local copy safe** (on by default), every pull:

- installs `wp-content/mu-plugins/ssh-sync-local-safety.php` and defines `SSH_SYNC_LOCAL_COPY` in the Local site's `wp-config.php` _before_ anything is transferred: outgoing HTTP is blocked (WordPress.org and local hosts allowed) and no email is sent;
- deactivates backup, mail, remote-management and alerting plugins (UpdraftPlus, BackWPup, MainWP Child, ManageWP Worker, FluentSMTP, WP Mail SMTP, Post SMTP, MailPoet, Wordfence, …) straight in the database, before WordPress loads;
- switches WooCommerce Stripe to test mode;
- sets `WP_ENVIRONMENT_TYPE` to `local`.

The mu-plugin is never pushed. When you push the database, SSH Sync re-enables on the server exactly what it turned off, so the live site never ends up without its backups or payments. Delete the mu-plugin or the `SSH_SYNC_LOCAL_COPY` line to turn the protection off on a copy.

## Command line

Install it from **More → SSH Sync → Command line**. It lands next to Local's `localwp` (Preferences → Advanced → Install Local CLI puts that folder on your `PATH`). Local must be running.

```bash
ssh-sync envs my-site
ssh-sync test my-site staging
ssh-sync pull my-site production            # files + database, safe copy
ssh-sync pull my-site production --no-db --uploads
ssh-sync push my-site staging               # dry run: lists what would change
ssh-sync push my-site staging --yes         # push the listed files
ssh-sync push my-site staging --yes --db    # and the database (never to production)
```

`push` never deletes on the server without `--delete`, and the command line never replaces a production database: that needs Migration mode in the app.

## Security

- **No shell strings locally**: every command (`ssh`, `rsync`, `scp`, `mysql`, `php`) is spawned with argument arrays. Every value that reaches the server's shell (paths, WP-CLI and cache commands) is validated against a strict character set and quoted.
- **SSH keys**: your own agent and `~/.ssh/config`; SSH Sync stores no keys.
- **Passwords**: encrypted with Electron `safeStorage` (the macOS Keychain), never shown again, never sent back to the UI. ssh receives them through `SSH_ASKPASS` from a one-shot socket, so they never appear in process arguments, environment variables or files. Refused where the OS has no real keyring.
- **One connection per sync**, closed at the end, even if your `~/.ssh/config` sets `ControlPersist`.
- **Nothing left on the server**: database dumps go to private (`mktemp`, 0600) files in the SSH user's home and are deleted right after the transfer; orphans older than two hours are swept on the next connect. The pre-push backup is kept on your computer (last 3 per environment).
- **No telemetry.** SSH Sync talks to your servers and nothing else.

Stored under Local's `addons-data/ssh-sync/`: environments, encrypted passwords, what the safe copy changed per site, pre-push database backups.

## Troubleshooting

| Problem                                            | Fix                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Test connection: "Could not connect … over SSH"    | Try `ssh <target>` in a terminal. For key auth the key must be in your agent or `~/.ssh/config` (no passphrase prompt is possible) |
| "The WordPress folder … does not exist"            | Use the folder that holds `wp-config.php`; `~/` is the SSH user's home                                                             |
| "WP-CLI failed"                                    | Set the WP-CLI command, e.g. `php ~/wp-cli.phar` or `php8.2 /usr/local/bin/wp`                                                     |
| "rsync is not installed on the server"             | Ask your host; SSH Sync needs it to transfer files                                                                                 |
| No live progress, preview without sizes            | `brew install rsync`                                                                                                               |
| "The local site must be running for database sync" | Start the site in Local first                                                                                                      |
| "N file(s) were skipped" after a sync              | File names in a legacy encoding that macOS cannot store; rename them on the server                                                 |

## Development

```bash
npm install
npm run build          # main + renderer
npm run watch          # rebuild on change (renderer hot-reloads; main needs a Local restart)
npm test
```

Architecture notes, the Local hooks used and the Local API findings are in [CLAUDE.md](CLAUDE.md).

## License

MIT. See [LICENSE](LICENSE).
