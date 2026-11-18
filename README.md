# AGY Mobile Web

Lightweight, zero-dependency (Python stdlib only) mobile-friendly Web console and image/file viewer for Antigravity CLI (`agy`).

## Features

- **Mobile-first UI**: Responsive layout with PWA / iOS home-screen support and `100dvh` full-height viewport.
- **Live Streaming (SSE)**: Real-time markdown responses, simplified tool-step traces (`Read`, `Edit`, `Write`, `Bash`, etc.), and inline image thumbnails (click to view full resolution with pinch/zoom).
- **Queue & Immediate Send (`Now`)**: Queue follow-up messages while `agy` is busy, or click `Now` to interrupt the current turn and send immediately.
- **In-bubble Cancel & Re-edit**: Cancel a running turn from the top-right `✕` icon and tap `✎ 重新编辑` to restore the previous prompt into the input box.
- **Session & Workspace Management**: Switch/rename/delete sessions from `~/.gemini/antigravity-cli/brain`, or click `New` to pick/set any workspace directory.
- **File & Image Browser**: Browse workspace files and recent images directly from mobile.

## Configuration (`config.json`)

Copy `config.example.json` to `config.json` in the same directory as `server.py` (already ignored by `.gitignore` so personal paths stay local):

```json
{
  "cwd": "/path/to/your/workspace",
  "agy_bin": "~/.local/bin/agy",
  "host": "0.0.0.0",
  "port": 8088,
  "mode": "auto"
}
```

### Fields

| Key | Description | Default if omitted |
| --- | --- | --- |
| `cwd` | Default workspace directory for `agy` | Current working directory |
| `agy_bin` | Path to the `agy` executable (supports `~`) | `which agy` or `~/.local/bin/agy` |
| `host` | Bind address (`127.0.0.1` for local, `0.0.0.0` for LAN) | `127.0.0.1` |
| `port` | HTTP listen port | `8088` |
| `mode` | Default execution mode (`auto`, `accept-edits`, `plan`) | `auto` |

**Priority**: CLI arguments (`--cwd`, `--agy-bin`, `--host`, `--port`, `--mode`) override `config.json`, which overrides built-in defaults.

## Usage

```bash
cp config.example.json config.json
# Edit config.json as needed

python3 server.py
```

Or override via CLI flags:

```bash
python3 server.py --host 0.0.0.0 --port 8088 --cwd /path/to/workspace
```

Run persistently in `tmux`:

```bash
tmux new-session -d -s agy-web "python3 /path/to/agy_mobile_web/server.py --host 0.0.0.0 --port 8088 > /tmp/agy_web.log 2>&1"
```

Bind automatically to Tailscale IPv4:

```bash
python3 server.py --tailscale --port 8088
```

## Project Structure

```text
agy_mobile_web/
├── config.json              # Local configuration (ignored by git)
├── config.example.json      # Template configuration
├── session_names.json       # Custom session nicknames (ignored by git)
├── README.md
├── .gitignore
├── server.py                # Main CLI entrypoint (~80 lines)
└── agy_web/                 # Core modular package (stdlib only)
    ├── __init__.py
    ├── config.py            # Config loading, default paths, Tailscale detection
    ├── static/              # Dedicated frontend assets
    │   ├── index.html       # Clean semantic HTML skeleton
    │   ├── style.css        # Mobile-first 100dvh dark theme CSS
    │   └── app.js           # Frontend logic (SSE, state sync, modals, image viewer)
    ├── files.py             # File inspection, image thumbnailing, path sandboxing
    ├── transcript.py        # Transcript parser, token/TPS usage metrics, tool naming
    ├── session.py           # ConvSlot & SessionManager process lifecycle controller
    └── handler.py           # HTTP router, REST endpoints, and SSE stream handler
```

## Security Notice

This server does **not** include built-in authentication. Only expose `--host 0.0.0.0` on a trusted LAN or private overlay network (such as Tailscale), and never expose it directly to the public internet without an authenticating reverse proxy.
