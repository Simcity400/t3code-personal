# Provider status

With automatic health checks enabled, provider status checks run in the background while a client is active. You can also refresh them in Settings > Providers. Concurrent refreshes share the same running check.

If a check cannot verify a previously working provider, T3 Code keeps its last verified account and models available with a warning. The warning includes when the provider was last verified and why the latest check failed. You can still try sending a message; the warning does not guarantee that the provider is currently reachable. A successful check clears the warning automatically.

Confirmed sign-outs, missing installations, disabled providers, and changes to account settings take effect immediately. T3 Code does not reuse a previous account's authentication for a different account. A provider that has never been verified still needs to complete its initial checks.
