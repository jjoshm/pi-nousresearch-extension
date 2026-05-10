# pi-nousresearch-extension

A clean, API-first custom provider extension for [pi](https://github.com/earendil-works/pi) that integrates Nous Research OAuth device login and model discovery.

## Features

- Dynamic model loading from `https://inference-api.nousresearch.com/v1/models`
- OAuth device login via Nous Portal (`/login nousresearch`)
- Automatic token refresh
- Automatic agent-key minting and rotation
- No sidecar token files (state is stored in pi auth storage)

## Install

```bash
pi install git:https://github.com/jjoshm/pi-nousresearch-extension
```

Then reload pi:

```text
/reload
```

## Usage

1. Select or login:

```text
/login nousresearch
```

2. Pick a Nous model:

```text
/model
```

3. Start prompting.

## Auth and storage

This extension uses pi's standard OAuth credential storage in:

- `~/.pi/agent/auth.json`

No additional token/session files are required.

### Legacy cleanup

If you previously used an older version that wrote sidecar files, you can remove them safely:

```bash
rm -rf ~/.pi/agent/auth-nousresearch
```

## Logout

Use:

```text
/logout nousresearch
```

This removes the provider credential from `auth.json`.

## Notes

- It is expected that `/model` can still *list* provider models before login; actual availability depends on configured auth.
- Model metadata is sourced directly from the Nous API at extension load time.

## Development

Local smoke test:

1. Copy extension to `~/.pi/agent/extensions/nousresearch.ts`
2. Run pi
3. `/reload`
4. `/login nousresearch`
5. Send a prompt using a Nous model
6. `/logout nousresearch`

## License

MIT
