# crumbtrail-tauri

Tauri v2 plugin for [Crumbtrail](https://crumbtrail.ai). Replaces the HTTP transport with native IPC — no separate server process needed.

## Install

```bash
npm install crumbtrail-tauri crumbtrail-core
```

Plus the Rust crate, below.

## Setup

### 1. Rust side

Add the plugin to your `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-crumbtrail = { path = "../packages/tauri/rust" }
```

Register it in `src-tauri/src/lib.rs` (the Tauri v2 CLI scaffold's `run()`
entry point — `src-tauri/src/main.rs` just calls that `run()` and does not
build the `tauri::Builder` itself, so the plugin is registered here, not in
`main.rs`):

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_crumbtrail::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 2. Permissions

Add to `src-tauri/capabilities/default.json`:

```json
{
  "permissions": ["crumbtrail:default"]
}
```

### 3. JavaScript side

```bash
pnpm add crumbtrail-core crumbtrail-tauri
```

```typescript
import { Crumbtrail } from "crumbtrail-core";
import { TauriTransport } from "crumbtrail-tauri";

const logger = Crumbtrail.init({
  transportInstance: new TauriTransport(),
});

// Use as normal
logger.mark("app-ready");

// When done
await logger.stop();
```

## How it works

The `TauriTransport` class implements `CrumbtrailTransport` using Tauri's `invoke()` IPC instead of HTTP `fetch()`. Events flow directly to the Rust backend which handles:

- **Session management** — creates session directories, writes `meta.json`
- **NDJSON writing** — appends events to `events.ndjson`
- **Blob storage** — writes binary files (screenshots, video chunks)
- **Post-processing** — generates `index.json` with error/request/navigation summaries

## Session storage

Sessions are stored at:

```
<app_data_dir>/crumbtrail-sessions/<session_id>/
├── meta.json
├── events.ndjson
├── index.json
├── frames/
└── (blobs)
```

On macOS: `~/Library/Application Support/<bundle-id>/crumbtrail-sessions/`

## MCP compatibility

The MCP server from `crumbtrail-node` reads session directories directly. Point it at the same output path to use MCP tools with Tauri-captured sessions:

```bash
crumbtrail-server --output ~/Library/Application\ Support/<bundle-id>/crumbtrail-sessions
```

## Requirements

- Tauri v2
- Rust toolchain (rustup)

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
