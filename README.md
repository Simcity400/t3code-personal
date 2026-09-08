# T3 Code Personal

A personal fork of [T3 Code](https://github.com/pingdotgg/t3code), maintained by
[Simcity400](https://github.com/Simcity400). T3 Code controls coding agents through
web, Electron desktop, and React Native mobile clients. This is an independent
fork, not an official T3 Tools release.

The maintained differences are small:

- Compact web and mobile composers, with brighter text.
- Expanded [native agent transcripts](docs/user/agent-transcripts.md).
- Codex goal controls, including `/goal`, budgets, pause, resume, and clear.
- Personal Windows installers and iPhone preview builds, with upstream nightly sync.

See [MY-FORK.md](MY-FORK.md) for scope and release maintenance.

## Install on Windows

Download the newest published nightly from this fork's
[Releases](https://github.com/Simcity400/t3code-personal/releases).

| Computer            | Installer suffix |
| ------------------- | ---------------- |
| Intel or AMD 64-bit | `-x64.exe`       |
| Windows on ARM      | `-arm64.exe`     |

These unsigned builds use the **T3 Code (Nightly)** app name. Updates use this
repository's public release feed and select the native Windows architecture.
The optional `Setup T3 Code (My Version).cmd` helper requires an authenticated
GitHub CLI.

Back up your T3 data before changing installations. See [MY-FORK.md](MY-FORK.md)
for the maintained fork scope.

## iPhone preview

This fork has a maintainer-operated iPhone preview pipeline. Native changes require
installing a new preview build; compatible JavaScript updates arrive over the air.
There is no public App Store or Google Play release of this fork. To build your own,
follow the [mobile development guide](apps/mobile/README.md) and configure your own
Expo project, app identifiers, and signing credentials.

## Run from source

Use Node.js 24.13.1 or a compatible newer Node 24 release, as specified in
[package.json](package.json), and install [Vite+](https://viteplus.dev/guide/).

```sh
git clone https://github.com/Simcity400/t3code-personal.git
cd t3code-personal
vp i
vp run dev
```

Open the one-time pairing URL printed by the dev runner. Use `vp run dev:desktop`
to develop the Electron client. Follow the relevant [provider guide](docs/README.md)
to authenticate a provider before starting a thread.

T3 Connect is optional. Copy `.env.example` to `.env` before building to enable the
upstream-hosted service using its public client configuration. See the
[development runbook](docs/operations/development.md) for prerequisites and isolated
state. Provider credentials and local T3 state stay on the host; never commit them.

The personal release pipeline packages Windows only; use source builds for macOS
and Linux. Official downloads and `npx t3@latest` install upstream T3 Code.

## Documentation and support

- [User guides](docs/README.md)
- [Remote access](docs/user/remote-access.md)
- [Contributing](CONTRIBUTING.md)
- [Security reporting](.github/SECURITY.md)

Report fork bugs in [this repository's issues](https://github.com/Simcity400/t3code-personal/issues).
Retained upstream documentation may describe official releases and infrastructure;
use this README for personal installation instructions.

## License and attribution

[MIT](LICENSE). T3 Code was created by T3 Tools Inc. and its contributors. This fork
retains upstream copyright and license notices. Bundled reference repositories and
third-party assets retain their own licenses.
