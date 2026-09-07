# Claude

T3 Code uses Claude Code's login and configuration. Start with the default provider
for one account; [provider setup](./install.md#providers) covers installation and
shared provider settings.

## Separate accounts or configurations

In the web or desktop app, open **Settings > Providers**, select the computer
where you want to run agents, and choose **Add account > Claude**. Name the account
and choose **Add account and sign in**. T3 prepares a separate login and shares
conversations with your default Claude account. You can choose a different account
to share conversations with when multiple accounts are configured.

Complete the Claude sign-in. T3 verifies the account when the sign-in finishes.
If Claude Code is missing, the setup panel installs it with npm first; that computer
needs npm available. When signing in remotely, follow the link on your device and
enter the returned code in the setup panel if prompted.

Choose the new account in an existing thread's model picker to continue with it.
To authenticate again later, select the account in provider settings and choose
**Sign in**. Setting up another computer requires its own sign-in, not copying
credentials from the first computer.

### Custom directory setup

Use a separate Claude config directory for each account. This also works for named
presets that need different Claude settings or a router connection.

Keep your existing account in the default directory. On the environment's machine,
create the second login:

```bash
mkdir -p ~/.claude_personal
CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login
```

Add another Claude instance in **Settings > Providers**:

| Instance        | Binary path | CLAUDE_CONFIG_DIR path |
| --------------- | ----------- | ---------------------- |
| Claude Work     | `claude`    | Leave empty            |
| Claude Personal | `claude`    | `~/.claude_personal`   |

An empty config-directory setting uses Claude Code's normal configuration. The
custom setting changes `CLAUDE_CONFIG_DIR`, leaving `HOME` and the system keychain
location intact. Use the same variable for the login command. Setting `HOME`
instead can put credentials where this provider will not find them.

Check the account reported in provider settings after signing in.

## Continue one thread with another account

Two accounts can continue the same thread when they share a conversation home.
Claude keeps each conversation under the config directory that started it, so
T3 Code links the second account's `projects` folder to the first account's
directory while the login stays in its own directory:

| Instance        | CLAUDE_CONFIG_DIR path | Shared conversation home |
| --------------- | ---------------------- | ------------------------ |
| Claude Work     | Leave empty            | Leave empty              |
| Claude Personal | `~/.claude_personal`   | `~/.claude`              |

Point the shared conversation home at the directory that already holds your
threads. Conversations the second account started on its own are moved into the
shared folder the first time the instance starts, so nothing is lost. Instances
with the same shared home appear together in a thread's model picker, and
switching resumes the same conversation on the other account.

Leave the shared conversation home empty to keep an account's conversations
isolated. Such an instance cannot continue threads from another directory.

On Windows the link needs Developer Mode or an elevated T3 Code server, the same
requirement as a Codex shadow home. Both directories must be on the same drive.

For presets that differ only in API keys or endpoints, use the instance's
**Environment variables**. Variable assignments do not belong in **Launch arguments**.

## Compact long conversations

Set **Auto-compact after** in the Claude provider settings to an integer between
`100000` and `1000000`. For example, `300000` asks Claude to summarize at about
300,000 tokens. This changes when compaction happens, not the model's context
window. Leave it empty for Claude Code's default.

You can also send `/compact` in an existing conversation. Web and desktop offer
**Compact context** from the context meter and may suggest it when you return to
a large older thread. See [commands and skills](./composer.md#commands-and-skills)
for using composer commands.

## Usage limits

If your Claude subscription runs out of usage mid-turn, the thread shows which
limit was reached and the remaining wait when Claude provides a reset time.
Claude Code holds the turn until that window reopens, so it can keep showing as
working. Wait for the reset, or stop the turn and continue later. The warning's
timestamp shows when the displayed wait started.

## Skills

Claude skills come from the config directory's `skills` folder and the project's
`.claude/skills` folder. If both define the same name, the config-directory copy
wins. Skills disabled in Claude's settings do not appear in the composer.

Use `$` in the composer to select a skill. Skills marked `disable-model-invocation`
can still be started by you. Invoke those one per message: Claude directly runs
only the last named skill and may try to start earlier ones through its Skill
tool, which refuses skills reserved for manual invocation.

## OpenRouter

Create a Claude instance with its own config directory, such as
`~/.claude_openrouter`, and keep **Binary path** set to `claude`. In that instance's
**Environment variables**, use:

| Variable               | Value                                     |
| ---------------------- | ----------------------------------------- |
| `ANTHROPIC_BASE_URL`   | `https://openrouter.ai/api`               |
| `ANTHROPIC_AUTH_TOKEN` | Your OpenRouter API key, marked Sensitive |
| `ANTHROPIC_API_KEY`    | An explicitly empty value                 |

If that Claude config directory has a cached Anthropic login, run `/logout` in a
Claude Code session using that directory before starting the router setup. Cached
login credentials can conflict with the router token.

Verify requests in OpenRouter's activity dashboard. For model-role overrides and
current compatibility requirements, use the
[OpenRouter Claude Code guide](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).

## Other routers

A local router uses an ordinary Claude provider instance. Give it a separate
config directory and put the router's endpoint and credential variables in that
instance's **Environment variables**. The router must run where the environment
can reach it. Follow the [Claude Code Router instructions](https://github.com/musistudio/claude-code-router)
for its installation and routing configuration.
