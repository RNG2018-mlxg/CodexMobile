# CodexMobile

CodexMobile is a lightweight iPhone-first PWA for using a local Codex setup from your phone. It runs a small bridge service on your computer, reads local Codex projects and sessions, and exposes a mobile chat UI over a private network such as Tailscale.

The project is designed for personal/private use. It is not a public SaaS, multi-user control panel, or remote desktop replacement.

## Features

- iPhone-friendly PWA that can be added to the Home Screen
- Local bridge server with HTTP, HTTPS, REST APIs, and WebSocket streaming
- Reads local Codex config, projects, models, and session JSONL files
- Starts new Codex conversations and continues existing sessions
- Project drawer with expandable sessions, rename, and delete
- Real-time Codex status lines for thinking, tool calls, commands, file changes, and errors
- File and image upload as local paths passed to Codex
- Optional local image generation support through an OpenAI-compatible provider
- Optional local voice input through a SenseVoice/FunASR Docker service
- CLIProxyAPI Codex quota display, when CLIProxyAPI management credentials are configured
- Device pairing with local tokens, intended for private-network access

## Architecture

```text
iPhone PWA
  |
  | HTTPS over Tailscale/private LAN
  v
CodexMobile server (Node.js)
  |-- reads ~/.codex config, sessions, models
  |-- calls @openai/codex-sdk for chat turns
  |-- calls CLIProxyAPI/OpenAI-compatible APIs for images and quotas
  |-- optionally calls local SenseVoice ASR on :8000
```

## Requirements

- Windows, macOS, or Linux computer with Node.js 20+
- A working local Codex configuration in `~/.codex`
- Private network access from your phone, for example Tailscale
- Optional: Docker Desktop for local SenseVoice voice transcription
- Optional: CLIProxyAPI if you want OpenAI-compatible routing, image generation, or quota display

## Quick Start

```powershell
npm install
npm run build
npm start
```

Open the local UI:

```text
http://127.0.0.1:3321
```

For phone access, connect both devices to Tailscale or the same private network, then open:

```text
http://<computer-private-ip>:3321
```

The server prints a six-digit pairing code on startup. Enter it once on the phone. CodexMobile stores a device token in the browser/PWA.

## HTTPS for iOS Microphone

iOS requires HTTPS for microphone access in browser/PWA contexts. CodexMobile supports HTTPS on port `3443` if you provide a PFX certificate:

```powershell
$env:HTTPS_PFX_PATH="$PWD\.codexmobile\tls\server.pfx"
$env:HTTPS_PFX_PASSPHRASE="change-me"
$env:HTTPS_ROOT_CA_PATH="$PWD\.codexmobile\tls\codexmobile-root-ca.cer"
npm start
```

Then open:

```text
https://<your-device>.<your-tailnet>.ts.net:3443/
```

If you use a self-signed CA, install and trust that CA on the iPhone.

## Configuration

Copy `.env.example` and set only what you need:

```powershell
Copy-Item .env.example .env
```

Then start with:

```powershell
npm run start:env
```

You can also set environment variables in PowerShell, systemd, Task Scheduler, Docker, or any other service manager and keep using `npm start`.

Common variables:

- `PORT`: HTTP port, default `3321`
- `HTTPS_PORT`: HTTPS port, default `3443`
- `CODEXMOBILE_PUBLIC_URL`: URL printed by startup scripts
- `CODEXMOBILE_PAIRING_CODE`: optional fixed six-digit pairing code
- `CODEX_HOME`: Codex home directory, default `~/.codex`
- `CODEXMOBILE_HOME`: CodexMobile auth state directory, default `.codexmobile/state`
- `CLIPROXYAPI_CONFIG`: CLIProxyAPI config path
- `CLIPROXYAPI_API_KEY` / `CLI_PROXY_API_KEY`: optional OpenAI-compatible API keys
- `CODEXMOBILE_CLIPROXY_MANAGEMENT_URL`: CLIProxyAPI management URL
- `CODEXMOBILE_CLIPROXY_MANAGEMENT_KEY`: CLIProxyAPI management key

Do not commit `.env`, `.codexmobile`, certificates, generated files, uploads, or local auth data.

## Local Voice Input

CodexMobile can use a local OpenAI-compatible SenseVoice service for Chinese-friendly transcription.

Start Docker Desktop, then run:

```powershell
npm run asr:start
```

Default endpoint:

```text
http://127.0.0.1:8000/v1/audio/transcriptions
```

Default model:

```text
iic/SenseVoiceSmall
```

The phone uploads the recording to CodexMobile, CodexMobile forwards it to the local ASR service, and audio is not saved as an upload or chat attachment. If the ASR implementation needs a temporary file internally, it should delete it after the request.

Useful variables:

- `CODEXMOBILE_LOCAL_TRANSCRIBE_BASE_URL`
- `CODEXMOBILE_TRANSCRIBE_MODEL`
- `CODEXMOBILE_ASR_DEVICE`
- `CODEXMOBILE_ASR_REBUILD=1`
- `CODEXMOBILE_ASR_RECREATE=1`

## CLIProxyAPI Quotas

If CLIProxyAPI management is available, CodexMobile can query Codex quota data through CLIProxyAPI management APIs.

Set:

```powershell
$env:CODEXMOBILE_CLIPROXY_MANAGEMENT_URL="http://127.0.0.1:8317"
$env:CODEXMOBILE_CLIPROXY_MANAGEMENT_KEY="<your-management-key>"
```

The UI displays remaining quota percentages, matching CLIProxyAPI management page behavior.

## Scripts

- `npm run build`: build the PWA into `client/dist`
- `npm start`: start the API, WebSocket endpoint, and built PWA
- `npm run start:bg`: start the server in the background and write logs under `.codexmobile`
- `npm run asr:start`: build/start the local SenseVoice ASR Docker container
- `npm run smoke`: check the local `/api/status` endpoint

## Private Network Deployment

Recommended deployment for personal use:

1. Install Tailscale on the computer and iPhone.
2. Start CodexMobile on the computer.
3. Use HTTP for text-only testing, or HTTPS for microphone features.
4. Pair the phone once with the printed code.
5. Add the PWA to the iPhone Home Screen.

Avoid exposing CodexMobile directly to the public internet. The first version assumes a single trusted user on a private network.

## Security Notes

- Pairing tokens are stored locally under `.codexmobile/state`.
- Uploads and generated images are stored under `.codexmobile`.
- HTTPS certificates are local files and should not be committed.
- CLIProxyAPI/OpenAI keys should come from environment variables or local config files only.
- The project intentionally excludes `.codexmobile`, `node_modules`, build output, env files, logs, and certificates from Git.

## License

MIT. See [LICENSE](./LICENSE).
