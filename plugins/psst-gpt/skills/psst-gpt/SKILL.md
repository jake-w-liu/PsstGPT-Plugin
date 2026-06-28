---
name: psst-gpt
description: Use when the user asks to relay a prompt through the ChatGPT macOS desktop app instead of Chrome, or explicitly says to use the ChatGPT app from Codex.
---

# PsstGPT

This skill relays a Codex task to the macOS ChatGPT desktop app through Accessibility automation.
It is separate from Chrome-backed GPT Relay and does not use the Codex Chrome extension.

Credit: PsstGPT is an independent desktop-app implementation, inspired by the original Chrome-backed GPT Relay by Prompt Case. Thanks to him for the relay concept and Codex plugin workflow.

When the user invokes `$psst-gpt` or selects `psst-gpt` from the slash command list, pass the remaining user text to `runPsstGPTTask`. The helper routes the task internally.

Do not manually choose a transport in Codex. `runPsstGPTTask` decides:

- Automatic full-file upload: requests that say or imply full codebase, full repo, all files, full upload, zip, upload, large codebase, or no truncation route to `uploadAuditPsstGPT`. A prompt such as `$psst-gpt debug audit the full codebase` routes to this path. It packages the source tree into one `source-archive.zip`, uses the direct Swift Accessibility helper to drive the native file picker, sends the audit request, verifies the upload audit header, and writes the returned response to local Markdown/JSON files.
- Main relay commands wait with no overall response timeout by default. Set `timeoutMs` only if you want an explicit cap. `poll` is the bounded check-in path for pending sessions.
- Strict background/no popups: requests that explicitly ask for strict background/no popups, or are clearly lightweight text-only audits, route to `auditPsstGPT`. It builds a line-numbered Markdown audit bundle from local text files, sends it to the ChatGPT app as strict-background text chunks, then sends the final audit request.

## What It Does

Use the helper script at `../../scripts/psst_gpt.mjs` to:

1. Launch or wake `ChatGPT.app` with `open -g`, without foregrounding it.
2. Ensure an existing app window and composer are available.
3. Start a new app chat by default.
4. Write the user's text prompt into the app composer.
5. Send the prompt.
6. Wait until the assistant response is stable and fail if the capture cannot be proven complete.
7. Store app-session metadata.
8. Return `finalDeliveryText` to Codex.

## Required Setup

- macOS.
- ChatGPT desktop app installed in `/Applications` or `~/Applications`.
- A ChatGPT app window is already open. The helper will not open, recover, or foreground a missing window.
- User is already signed in to the ChatGPT app.
- macOS Accessibility automation is enabled for the process running Codex, `/usr/bin/osascript`, and `/usr/bin/swift` if macOS prompts for them.

You usually do not enable Accessibility for `ChatGPT.app` itself. The controlling host app and helper binaries are the permissions that matter.

Do not inspect cookies, local storage, passwords, app databases, browser session stores, or hidden ChatGPT state.

## Safety Boundaries

- Only send prompts that the user explicitly asks to relay to the ChatGPT app.
- PsstGPT supports text prompts in the active ChatGPT app surface.
- For codebase audits, PsstGPT supports strict-background text-bundle relay through `auditPsstGPT`.
- The standard text relay is strict-background only. Do not pass `background: false`; do not request window recovery.
- File upload relay is foreground automatic, not strict background. Use it only when the user explicitly asks for full upload or accepts foreground automation.
- If the helper returns `PSST_GPT_WINDOW_MISSING_BACKGROUND`, ask the user to manually open a ChatGPT app window when convenient. Do not auto-click Dock, use screenshots, or foreground the app.
- Model selection, reasoning mode selection, Projects, GPT Apps, Create image artifact export, and Deep Research Markdown export are not implemented in strict background mode. If requested, report `PSST_GPT_UNSUPPORTED_OPTION`.
- Do not use macOS file upload dialogs, clipboard file paste, Finder automation, screenshots, or foreground activation for strict-background PsstGPT. The dedicated `uploadAuditPsstGPT` path may use the native file picker and a temporary, restored clipboard path paste because that mode is explicitly foreground automatic.
- If the app shows login, CAPTCHA, verification, permission, or account prompts, stop and report the helper error.
- If the app is still answering, keep waiting or poll the same session. Do not answer the user's task locally as a substitute.
- For audit workflows, the helper retries short acknowledgement-only final replies such as "I will audit..." and asks ChatGPT to do the audit immediately. Treat the retried result as the helper output; do not manually summarize or replace it.
- The helper reports only visible app UI state. Do not claim hidden backend model state.
- Polling can return an already complete stored response when the active transcript no longer exposes the original prompt. Pending sessions still require the currently visible app conversation; PsstGPT cannot reopen stored conversations by URL.

## Node REPL Usage

Use an absolute import path resolved from this skill file:

```text
<plugin-root>/scripts/psst_gpt.mjs
```

Start a new app chat:

```js
const { runPsstGPTTask } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
const result = await runPsstGPTTask({
  prompt: "User prompt here",
  root: process.cwd()
});
nodeRepl.write(result.finalDeliveryText);
```

Inspect the route without sending:

```js
const { planPsstGPTTask } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
nodeRepl.write(JSON.stringify(planPsstGPTTask({
  prompt: "debug audit the full codebase",
  root: process.cwd()
}), null, 2));
```

Run the deterministic preflight:

```js
const { doctorPsstGPT } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
nodeRepl.write(JSON.stringify(await doctorPsstGPT(), null, 2));
```

Run the live upload harness:

```js
const { harnessPsstGPT } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
nodeRepl.write(JSON.stringify(await harnessPsstGPT({
  timeoutMs: 5 * 60 * 1000
}), null, 2));
```

Audit the current codebase in strict background mode:

```js
const { auditPsstGPT } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
const result = await auditPsstGPT({
  root: process.cwd(),
  background: true
});
nodeRepl.write(result.finalDeliveryText);
```

Create an audit bundle without sending it:

```js
const { createPsstGPTAuditBundle } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
nodeRepl.write(JSON.stringify(await createPsstGPTAuditBundle({
  root: process.cwd()
}), null, 2));
```

Audit the current codebase with automatic file upload:

```js
const { uploadAuditPsstGPT } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
const result = await uploadAuditPsstGPT({
  root: process.cwd(),
  timeoutMs: 0
});
nodeRepl.write(result.finalDeliveryText);
```

Continue in the active app chat:

```js
const { continuePsstGPT } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
const result = await continuePsstGPT({
  background: true,
  prompt: "Continue with one more paragraph."
});
nodeRepl.write(result.finalDeliveryText);
```

Poll a pending active app session:

```js
const { pollPsstGPT } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
const result = await pollPsstGPT({
  query: "keyword from the original prompt",
  background: true,
  timeoutMs: 90 * 1000
});
nodeRepl.write(result.finalDeliveryText);
```

List stored app sessions:

```js
const { listPsstGPTSessions } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
nodeRepl.write(JSON.stringify(await listPsstGPTSessions({ limit: 10 }), null, 2));
```

CRITICAL FINAL OUTPUT RULE:
If any helper returns `status: "complete"`, `mustReturnFinalDelivery: true` or
`mustReturnVerbatim: true`, and a non-empty `finalDeliveryText`, the Codex final answer MUST be
exactly `result.finalDeliveryText`.
Do not add a summary before it. Do not shorten it. Do not rewrite it. Do not omit lines.
