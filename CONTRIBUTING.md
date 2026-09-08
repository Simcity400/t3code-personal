# Contributing to T3 Code Personal

This is an independently maintained fork of
[pingdotgg/t3code](https://github.com/pingdotgg/t3code). Report fork bugs and discuss
proposed changes in [this repository's issues](https://github.com/Simcity400/t3code-personal/issues).
Please discuss substantial features before implementing them. Small, focused fixes
are easier to review; review and merge times are not guaranteed.

## Development

Start with the [README](README.md#run-from-source) and
[development runbook](docs/operations/development.md). Read [AGENTS.md](AGENTS.md)
for repository conventions and [MY-FORK.md](MY-FORK.md) for differences that need
to survive upstream merges.

Keep development state separate from your installed app. Never commit `.env` files,
provider logins, pairing URLs, databases, signing credentials, or private conversation
data. The values in `.env.example` are public client identifiers.

## Pull requests

Explain the problem, the resulting behavior, and how you verified it. Keep each PR
focused on one concern. Run tests for affected behavior, targeted lint, and the
typecheck for packages you changed. Include before/after images for UI changes and
a short video when timing or interaction matters.

Consider web, desktop, mobile, and local and remote connections. Follow the
[documentation rules](AGENTS.md#documentation) when a change affects how people use
the app. Do not include implementation plans, agent scratch files, or test data.

Fork Checks scans the application source for secrets and runs focused fork regression
tests on pushes and pull requests. Publishing workflows only run in the maintainer's
repository. Upstream's vouch and triage automation is not active here.

For vulnerabilities, follow the [security policy](.github/SECURITY.md) instead of
posting details in a public issue.
