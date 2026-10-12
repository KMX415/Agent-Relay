# Source provenance

Agent Relay was extracted from KMX415/Turn-Signal, a private development prototype.

- Mailbox, CLI, setup, tests, and wake workflow: commits 8448226 and fd61997.
- Read-only browser viewer: GitHub `chrillios`, draft PR #2, commit 9bab8ac502ee94a1dc273807fcb7a2e4b3ec4e55; tested on Windows and Linux before extraction.
- Standalone extraction: configurable mailbox repository, independent MCP names, root-level tools, and project-neutral documentation.

Only tracked toolkit source was copied. No Turn Signal mailbox messages, worker identities, credentials, application data, firmware, or Git history were imported. The viewer's source originated in a draft PR; extraction does not merge that PR in Turn Signal.

Third-party dependencies retain their own licenses. The MCP TypeScript SDK is MIT-licensed; dependency notices remain distributed in their packages.
