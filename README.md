# T3 Code Personal

A community fork of [T3 Code](https://github.com/pingdotgg/t3code), maintained by
[Simcity400](https://github.com/Simcity400). It controls coding agents through a web,
Electron desktop, or React Native mobile client. This fork is independently maintained
and is not an official T3 Tools release.

It tracks published upstream nightlies and adds improvements for working with multiple
accounts, side conversations, and background agents:

- Separate [Codex](docs/user/providers-codex.md) and [Claude](docs/user/providers-claude.md)
  accounts, with account setup from Settings and shared conversation history.
- [Side chats](docs/user/side-chats.md) for branching a conversation while keeping the
  main thread available.
- [Agent transcripts](docs/user/agent-transcripts.md), background-task controls, and
  per-agent context usage on desktop, web, and mobile.

See [MY-FORK.md](MY-FORK.md) for the maintained differences from upstream.

## Install this fork

### Windows

Download an installer from this fork's
[Releases](https://github.com/Simcity400/t3code-personal/releases). Choose the newest
published nightly and the installer matching your computer:

| Computer            | Installer suffix |
| ------------------- | ---------------- |
| Intel or AMD 64-bit | `-x64.exe`       |
| Windows on ARM      | `-arm64.exe`     |

These are unsigned Windows builds. They use the **T3 Code (Nightly)** app name and
the existing T3 Code installation/profile locations, so they can replace an existing
installation. Back up your T3 data before switching between this fork and upstream;
their database migrations differ.

Builds produced while the repository is public use a public update feed. Older builds
from the private repository require `gh auth login` for updates; install a newer public
build manually once to remove that requirement. The optional
`Setup T3 Code (My Version).cmd` helper still requires an authenticated GitHub CLI.

### Web, macOS, and Linux

Use the source instructions below. This fork's release workflow currently packages
Windows only. `npx t3@latest`, the official package-manager installers, and downloads
from t3.codes install upstream T3 Code, which has a different feature set.

### Mobile

The fork includes mobile source and a maintainer-operated iPhone preview pipeline.
There is no public App Store or Google Play release of this fork. To build your own,
follow the [mobile development guide](apps/mobile/README.md) and configure your own
Expo project, app identifiers, and signing credentials. The official store apps are
upstream clients and may not expose this fork's features.

## Run from source

Use Node.js 24.13.1 or a compatible newer Node 24 release, as specified in
[package.json](package.json).

### Install `vp`

This repository uses Vite+. Follow its [installation guide](https://viteplus.dev/guide/).

```sh
git clone https://github.com/Simcity400/t3code-personal.git
cd t3code-personal
vp i
vp run dev
```

Open the one-time pairing URL printed by the dev runner. Use `vp run dev:desktop`
to develop the Electron client. Authenticate a supported provider before starting a
thread; the web and desktop apps offer account setup under **Settings > Providers**.

T3 Connect is optional. Copy `.env.example` to `.env` before building to enable the
upstream-hosted service using its public client configuration. Leave it absent to run
without that integration. Provider credentials and local T3 state stay on the host;
never commit them. See the [development runbook](docs/operations/development.md) for
isolated state, build prerequisites, and focused checks.

## Documentation and support

- [User guides](docs/README.md)
- [Remote access](docs/user/remote-access.md)
- [Fork updates and upstream sync](docs/internals/personal-fork-updates.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting](.github/SECURITY.md)

Report fork bugs and propose changes in
[this repository's issues](https://github.com/Simcity400/t3code-personal/issues).
Documentation retained from upstream may describe its release infrastructure or point
to its downloads; use this README for fork installation and support.

## License and attribution

[MIT](LICENSE). T3 Code was created by T3 Tools Inc. and its contributors. This fork
retains the upstream copyright and license notices. Bundled reference repositories
and third-party assets retain their own licenses.
