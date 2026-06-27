# PsstGPT Codex Plugin

PsstGPT lets Codex send prompts to the macOS ChatGPT desktop app, bring the visible ChatGPT response back to Codex, and optionally automate source-archive uploads for large codebase audits.

It does not use Chrome, Playwright, browser cookies, local storage, or ChatGPT web internals. It uses macOS Accessibility and the ChatGPT macOS app's own UI.

> This is an independent community plugin. It is not an official OpenAI or ChatGPT product.
>
> Credit: PsstGPT is an independent desktop-app implementation, inspired by the original Chrome-backed [GPT Relay](https://github.com/Toolsai/GPT-Relay-Codex-Plugin-) by Prompt Case. Thanks to him for the relay concept and Codex plugin workflow.

## Quick Start

Install the marketplace:

```bash
codex plugin marketplace add jake-w-liu/PsstGPT-Codex-Plugin
```

Install the plugin from that marketplace:

```bash
codex plugin add psst-gpt@psst-gpt
```

Confirm it is installed:

```bash
codex plugin list | grep psst-gpt
```

Expected status:

```text
psst-gpt@psst-gpt  installed, enabled
```

Restart Codex or start a new Codex thread so the `psst-gpt` skill is loaded.

## Use It

In Codex CLI, invoke the skill directly with `$psst-gpt`:

```text
$psst-gpt Plan this refactor in the ChatGPT app and bring the result back.
```

You can also open the skill picker:

```text
/skills
```

Then select `psst-gpt` and add the task you want sent to the ChatGPT app.

In the Codex desktop app, type `/` and select the enabled `psst-gpt` skill from the command list, then add your task.

### Important: Not `/psst-gpt` In Codex CLI

Codex CLI currently documents plugin skills as `$skill-name` invocations or `/skills` selections. A plugin does not automatically create a top-level CLI slash command like `/psst-gpt`.

If you type `/pss` in Codex CLI and see `no matches`, that means you are using the slash-command path. Use this instead:

```text
$psst-gpt Your task here
```

## Required Setup

- macOS.
- ChatGPT desktop app installed in `/Applications` or `~/Applications`.
- ChatGPT app signed in and ready to use.
- One ChatGPT app window already open somewhere on the desktop.
- macOS Accessibility permission enabled for the process running Codex, `/usr/bin/osascript`, and `/usr/bin/swift` if macOS prompts for them.

The standard text relay will not open, recover, or foreground a missing ChatGPT window. If there is no app window, it fails with `PSST_GPT_WINDOW_MISSING_BACKGROUND` instead of interrupting your work. The upload workflow may foreground an existing ChatGPT window while it drives the native file picker.

## Cross-Platform Status

PsstGPT is currently macOS-only.

The idea can be made cross-platform, but not by reusing the current macOS automation code. Each desktop platform needs its own verified background automation backend:

| Platform | Status | What would be needed |
| --- | --- | --- |
| macOS | Implemented and live-tested | Current backend: `open -g`, `/usr/bin/osascript`/JXA for strict-background text relay, `/usr/bin/swift` direct Accessibility for foreground uploads, and macOS Accessibility. |
| Windows | Feasible, not implemented | A separate Windows backend using the ChatGPT Windows app plus Windows UI Automation. It must be tested for strict no-focus/no-popup behavior before release. |
| Linux | Not currently targeted | OpenAI's current desktop download page lists macOS and Windows desktop apps, not a Linux ChatGPT desktop app. |

The repository should not ship a Windows backend until it has been tested on Windows with the real ChatGPT app. The strict background guarantee is platform-specific; a backend that steals focus or opens windows would violate PsstGPT's core behavior.

## What Happens

When you invoke PsstGPT:

1. Codex loads the `psst-gpt` skill.
2. The helper wakes `ChatGPT.app` with `open -g`.
3. It finds the existing ChatGPT app window through Accessibility.
4. It writes your prompt into the app composer.
5. It presses the app send button through `AXPress`.
6. It waits for the visible assistant response to stabilize.
7. It returns `finalDeliveryText` to Codex.

The ChatGPT app is not activated or brought to the foreground during the verified strict-background text flow. The upload workflow is foreground automatic because the macOS file picker is a visible native UI.

## Example Prompts

```text
$psst-gpt Think through a migration plan for this codebase. Return a concise implementation checklist.
```

```text
$psst-gpt Review this architecture decision and list the biggest risks before Codex starts editing.
```

```text
$psst-gpt Continue in the active ChatGPT app chat and summarize the previous answer in one paragraph.
```

## Direct Script Usage

From the repository root:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"task","prompt":"Reply exactly: OK from PsstGPT"}'
```

For long tasks, start first and poll later:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"start","prompt":"Draft a detailed migration plan.","background":true}'
```

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"poll","query":"migration plan","background":true}'
```

Create a source upload bundle without sending it:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"upload-bundle","root":"/absolute/path/to/project"}'
```

Run the automatic task router for a foreground upload audit:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"task","prompt":"debug audit the full codebase","root":"/absolute/path/to/project"}'
```

The upload audit workflow writes the returned visible response to `chatgpt-audit-response.md` and the structured result to `chatgpt-audit-result.json` inside the generated upload bundle directory.

Inspect routing without sending:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"plan","prompt":"debug audit the full codebase","root":"/absolute/path/to/project"}'
```

Run the live harness:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"harness","timeoutMs":300000}'
```

The harness creates a tiny marker project, routes through the same `task` planner, uploads the generated zip bundle through the ChatGPT macOS app, verifies ChatGPT returned the marker from the uploaded files, and verifies the local response/result files were written.

## Troubleshooting

### `/pss` Shows `no matches`

Use `$psst-gpt`, or run `/skills` and select `psst-gpt`. Codex CLI does not currently expose this plugin as a top-level `/psst-gpt` slash command.

### `psst-gpt` Does Not Appear

Check installation:

```bash
codex plugin list | grep psst-gpt
```

If it is missing or says `not installed`, run:

```bash
codex plugin marketplace add jake-w-liu/PsstGPT-Codex-Plugin
codex plugin add psst-gpt@psst-gpt
```

Then restart Codex or start a new thread.

### Marketplace Is Named `personal`

An early build used the marketplace name `personal`. Remove it and add the current marketplace:

```bash
codex plugin marketplace remove personal
codex plugin marketplace add jake-w-liu/PsstGPT-Codex-Plugin
codex plugin add psst-gpt@psst-gpt
```

### ChatGPT Window Missing

Open a ChatGPT app window manually, leave it open, then rerun PsstGPT. The relay intentionally does not recover a missing window because that can steal focus.

### Accessibility Fails

Enable Accessibility for the process running Codex, `/usr/bin/osascript`, and `/usr/bin/swift` if macOS prompts for them. Text relay uses JXA/osascript; upload relay uses the direct Swift Accessibility helper.

### Unsupported Option

PsstGPT supports verified strict-background text prompt relay through the active ChatGPT app. Model selection, Projects, GPT Apps, Create image artifact export, and Deep Research Markdown export fail explicitly with `PSST_GPT_UNSUPPORTED_OPTION`.

For file upload, use the explicit foreground automatic `upload-audit` workflow. Regular `run`/`start` still reject attachment options so strict-background behavior is not accidentally weakened.

## Local Development

Run the checks:

```bash
node --check plugins/psst-gpt/scripts/psst_gpt.mjs
/usr/bin/swiftc -parse plugins/psst-gpt/scripts/psst_ax_upload.swift
node --test plugins/psst-gpt/scripts/psst_gpt.test.mjs
```

Validate the plugin with Codex's plugin validator if available:

```bash
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/psst-gpt
```

## Self-Contained Layout

The implementation lives under `plugins/psst-gpt` and does not import code from the original Chrome-backed GPT Relay repository.

Runtime dependencies are:

- Node built-ins.
- `/usr/bin/open -g`.
- `/usr/bin/osascript`.
- `/usr/bin/swift`.
- `/usr/bin/zip` for source upload bundles.
- macOS Accessibility.
- `ChatGPT.app` bundle id `com.openai.chat`.

## Current Boundaries

- macOS only.
- Requires a signed-in ChatGPT desktop app.
- Requires an already-open ChatGPT app window.
- Strict background mode for text relay.
- Foreground automatic mode for source upload audits.
- No Chrome, browser extension, browser session, cookies, local storage, screenshots, or OCR.
- No model picker automation until the app UI path is verified end to end without interruption.
