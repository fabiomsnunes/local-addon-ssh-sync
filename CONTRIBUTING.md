# Contributing to SSH Sync for Local

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/fabiomsnunes/local-addon-ssh-sync/issues/new/choose) with the bug template. The most useful details:

- your Local and SSH Sync versions, and macOS version;
- the host or server type (VPS, cPanel, a managed host…), and whether you log in with a key or a password;
- what you did, what you expected and what happened, with the exact message SSH Sync showed;
- Local's log (**Help → Reveal Local's Log**), lines starting with `[SSH Sync]`.

Remove host names, paths and anything private before posting. **Security issues never go in a public issue:** see [SECURITY.md](SECURITY.md).

## Suggesting a feature

Open an issue with the feature template and describe the problem first, then the solution you have in mind.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. `npm install`, then `npm run watch` while you work. Link your clone into Local's add-ons folder to try it:
   `ln -s "$PWD" ~/Library/Application\ Support/Local/addons/local-addon-ssh-sync`
3. Add or update tests for what you change: `npm test`.
4. `npm run lint` and `npm run build` must pass (CI runs both).
5. Keep one logical change per commit, with a [conventional commit](https://www.conventionalcommits.org/) message (`fix: …`, `feat: …`, `docs: …`).
6. Open the pull request with what it changes, why, and how you tested it against a real server.

Architecture, the Local hooks we use and what we learned about Local's add-on API are in [CLAUDE.md](CLAUDE.md). Read the safety rules there before touching pull, push or undo: anything that writes to a server needs a test.

## License

By contributing you agree your work is released under the [MIT license](LICENSE).
