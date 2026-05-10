# Contributing

Thanks for contributing!

## Development workflow

1. Edit `src/nousresearch.ts`
2. Copy to local pi extension path:
   ```bash
   cp src/nousresearch.ts ~/.pi/agent/extensions/nousresearch.ts
   ```
3. In pi, run:
   ```text
   /reload
   ```
4. Smoke test login, prompt, and logout flows.

## Style

- Keep implementation API-first (avoid static model lists)
- Prefer small, focused helpers
- Keep error messages actionable
- Never log secrets/tokens

## Pull requests

Please include:

- Summary of behavior change
- Any auth/storage implications
- Manual test notes
