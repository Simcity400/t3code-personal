# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Use multiple accounts

In the web or desktop app, open **Settings > Providers**, select the computer
where you want to run agents, and choose **Add account > Codex**. Name the account
and choose **Add account and sign in**. T3 creates a separate login directory and
shares conversations with your default Codex account. If you already have separate
conversation groups, choose which account's conversations to continue.

Complete the ChatGPT sign-in. T3 checks the account when the sign-in finishes.
If Codex is missing, the setup panel runs its standalone installer first.
For a remote computer, select the device-code option.

The account appears in the model picker for compatible existing threads. Account
setup belongs to the selected computer; repeat sign-in when adding the same account
to another computer. You do not need to copy credentials between computers.

### Custom directory setup

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.

## Manage a Codex Goal

A Goal gives Codex a long-running objective. Codex keeps starting turns on its own
until it can verify the objective is done, and stops to ask you when it is stuck.

Send `/goal` in a started Codex thread to open the goal editor, or
`/goal <objective>` to start one straight away. The banner above the composer shows
the goal status, the objective, what Codex is doing about it, and the tokens and
time used, with Pause, Resume, Edit, and Clear. The goal stays visible after the
thread stops; Continue wakes the thread so Codex picks the goal back up.

- **Stalled**: Codex hit the same blocker on three turns in a row and needs your
  input or an outside change. The banner quotes the message that explains the
  blocker. Reply in the thread, or Resume once the blocker is gone.
- **Usage limited**: your usage limit stopped the goal. Resume once it resets.
- **Budget limited**: the token budget is used up. Raise it in Edit, then Resume.
- **Complete**: Codex verified the objective. Clear the goal to finish.

`/goal status`, `/goal pause`, `/goal resume`, `/goal steer <objective>`, and
`/goal clear` do the same from the composer.
