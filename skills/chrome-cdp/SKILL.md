---
name: chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Prerequisites

- Chrome (or Chromium, Brave, Edge, Vivaldi) with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path
- Optional Lightpanda backend: start `lightpanda serve --host 127.0.0.1 --port 9222` yourself, then run commands with `CDP_BROWSER=lightpanda`. Lightpanda support is attach-only; this skill does not launch it.

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

Chrome-family browsers are the default. Use `CDP_BROWSER=chrome|chromium|brave|edge|vivaldi` to pin one, or `CDP_BROWSER=lightpanda` to attach to Lightpanda. Lightpanda endpoint env vars are `CDP_LIGHTPANDA_WS_URL`, `CDP_LIGHTPANDA_URL`, or `CDP_LIGHTPANDA_HOST` plus `CDP_LIGHTPANDA_PORT`.

### List open pages

```bash
scripts/cdp.mjs list
```

### Take a screenshot

```bash
scripts/cdp.mjs shot <target> [file]    # default: screenshot-<target>.png in runtime dir
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>
```

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # resource timing entries
scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs open    [url]                  # open new tab (each triggers Allow prompt)
scripts/cdp.mjs stop    [target]               # stop daemon(s)
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Lightpanda fallback approval

[tag:lightpanda_fallback_consent] If a Lightpanda command prints `LIGHTPANDA_UNSUPPORTED_FALLBACK_REQUIRED`, stop. Do **not** run a fallback command automatically. Do **not** connect to a fallback browser, clone the URL, reuse the Lightpanda target id, create a sticky target mapping, or retry in Chrome/Brave/etc. without explicit user approval.

Explain that the fallback browser is separate state and may lack cookies, login, localStorage, DOM mutations, typed text, JS heap, and current workflow state. Ask the user whether they want to continue in a fallback browser.

If the user approves fallback execution:

1. Use only the approved browser with explicit `CDP_BROWSER=<approved browser>`.
2. Enable remote debugging in that fallback browser if needed.
3. Run `CDP_BROWSER=<approved browser> scripts/cdp.mjs list` or `open` in that backend.
4. Select the target from the fallback browser list; do not reuse the Lightpanda target id.
5. Rerun the requested command against that approved fallback target.

`CDP_FALLBACK_BROWSER=chrome|chromium|brave|edge|vivaldi|none` changes prompt text only. It is not permission to execute fallback.

## Tips

- Prefer `snap --compact` over `html` for page structure.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Chrome shows an "Allow debugging" modal once per tab on first access. A background daemon keeps the session alive so subsequent commands need no further approval. Daemons auto-exit after 20 minutes of inactivity.
