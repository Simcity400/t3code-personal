# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

On web and desktop, click the circular context indicator beside the input controls to see the
conversation's context usage and the selected account's plan limits, including percentages and
reset dates and times in your local time zone, plus a countdown that updates each minute while
the popover is open. Only windows reported by that account appear, including five-hour, weekly,
model-specific weekly, or monthly limits. The indicator stays available when the input is
collapsed or idle. Context usage shows **Not reported yet** until the provider supplies it;
accounts without limit data show an
explanation. **See detailed breakdown** opens the Usage page's Limits view. Manual context
compaction remains available in this popover when supported.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

The **Limits** view shows how much of each subscription window you have used on Codex and Claude
Code, per connected environment: the session and weekly windows, plus a per-model weekly window
such as Fable when your plan has one. Each window is a bar from the moment it opened to its reset,
filled by the share of quota spent; a thin line marks how far into the window you are, which is
also where even spending would have put the fill, and the icon beside the label says whether you
are ahead of, on, or under that pace. Hover a bar for the exact reset time. Limits refresh on the
provider health-check interval and update live while a turn runs. API-key accounts have no
subscription windows and say so; that includes a Claude Code that reaches Anthropic through a proxy
via `ANTHROPIC_AUTH_TOKEN`, since the CLI then treats itself as an API-key client.

A Claude OAuth token can run conversations while lacking the profile access needed to read
subscription usage. In that case, Limits explains that the current sign-in cannot read usage;
it does not mean the account has no subscription. Previously reported limits remain visible
through failed reads, and supported live updates can still refresh them.

For a saved Claude login, run `/login` in the affected account's Claude configuration to renew
its permissions. If that provider has `CLAUDE_CODE_OAUTH_TOKEN` configured, the token overrides
the saved login. Current Claude versions assume that an environment token has only inference
access unless `CLAUDE_CODE_OAUTH_SCOPES` supplies its scopes. A token that already has profile
access needs its actual granted scopes supplied there, including `user:profile`; setting a
scope does not grant permission to a token that lacks it. Alternatively, remove the token
override and use a saved login with profile access. Keep separate Claude configurations for
separate accounts so signing in to one does not switch the others. See Claude's
[OAuth scope troubleshooting](https://code.claude.com/docs/en/errors#oauth-scope-requirement).
T3 Code does not change account credentials automatically.

The usage endpoint can also throttle reads independently of conversation usage. If it returns
HTTP 429, wait for the indicated retry period before checking again; that response alone does
not establish whether a token has profile access or whether a conversation limit is exhausted.

When a provider refuses a turn because a limit was reached, the transcript shows the reason the
provider returned. If you have another compatible account configured for that provider, select it
in the composer and send again; T3 Code releases the previous account's session before resuming the
same conversation through the replacement.

If you pool accounts behind a CLIProxyAPI hub, **Add CLIProxyAPI hub** on the Limits view shows
every account the hub manages, each marked _via CLIProxyAPI_ so it is not mistaken for the provider
signed in on this machine. Enter the hub's URL and management key; the key is stored on the server
and never sent back to a client. Emails are blurred until clicked, as in provider settings.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Refreshing rescans every connected environment and refetches model pricing on
each of them, so a newly released model that showed $0.00 gets a price without waiting for the daily
pricing update.
