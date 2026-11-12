# Security Policy

## Supported versions

Only the latest release receives security fixes. Please update to the newest
version before reporting an issue.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Kinsta Sync handles sensitive data — your Kinsta API key, SSH access to your
servers, and your database contents. If you find a vulnerability, report it
privately via GitHub's
**[private vulnerability reporting](https://github.com/landerss0n/local-addon-kinsta/security/advisories/new)**
("Report a vulnerability" on the repository's **Security** tab).

I'll acknowledge the report as soon as I can, confirm the issue, and ship a fix
in a new release. Please allow a reasonable window to address it before any
public disclosure.

## How the add-on protects your data

For the security model — API key encrypted at rest via Electron `safeStorage`,
SSH using your own keys/agent (no stored credentials), every external command
spawned with argument arrays (no shell strings), and no telemetry — see the
[Security section of the README](README.md#security).
