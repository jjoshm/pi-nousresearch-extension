# Security Policy

## Reporting a Vulnerability

If you discover a security issue (especially related to OAuth tokens, auth handling, or credential leakage), please report it privately before opening a public issue.

Please include:

- Affected version/commit
- Reproduction steps
- Potential impact
- Suggested fix (if available)

Do **not** include real tokens or sensitive account data in reports.

## Scope

In scope:

- Credential persistence behavior
- OAuth flow handling
- Token refresh/mint logic
- Accidental token exposure in logs/errors

Out of scope:

- Third-party provider outages
- General upstream API bugs not caused by this extension
