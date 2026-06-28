# PsstGPT

PsstGPT is a Codex plugin skill for relaying text prompts to the macOS ChatGPT desktop app and running source upload audits.

For the full install guide, see the repository [README](../../README.md).

## Invoke

Use the skill directly:

```text
$psst-gpt <task to send to the ChatGPT app>
```

In Codex CLI, `/psst-gpt` is not the supported command path. Use `$psst-gpt`, or run `/skills` and select `psst-gpt`.

## Accessibility Setup

Before first use, open macOS **System Settings > Privacy & Security > Accessibility** and turn on the app that is running Codex. Depending on where you use Codex, that is usually the Codex app, Terminal, iTerm, VS Code, Cursor, or another editor host.

If macOS prompts for helper binaries while PsstGPT runs:

- Allow `/usr/bin/osascript` for strict-background text relay.
- Allow `/usr/bin/swift` for the foreground upload relay.

You normally do not enable Accessibility for `ChatGPT.app` itself. The controlling host app and helper binaries are the permissions PsstGPT needs.

PsstGPT shows a local reminder on first use when Accessibility is missing, then rate-limits that reminder to at most once per day.

## Requirements

- macOS.
- ChatGPT desktop app installed and signed in.
- One ChatGPT app window already open.
- Accessibility enabled for the app running Codex.
- `/usr/bin/osascript` approved if macOS prompts during text relay.
- `/usr/bin/swift` approved if macOS prompts during upload relay.

## Cross-Platform Status

PsstGPT is currently macOS-only.

Windows support is feasible, but it needs a separate Windows UI Automation backend for the ChatGPT Windows app and must be tested for strict no-focus/no-popup behavior before release.

Linux is not currently targeted because OpenAI's current desktop download page lists macOS and Windows desktop apps, not a Linux ChatGPT desktop app.

## Scope

- Uses `open -g` and Accessibility so the ChatGPT desktop app is not brought to the foreground.
- Requires an existing ChatGPT app window; it will not open, recover, or foreground a missing window.
- Starts a new chat by default.
- Writes text prompts directly into the app composer.
- Sends the prompt through `AXPress` Accessibility actions, not screenshots, OCR, or foreground keyboard focus.
- Reads full Accessibility text values from the ChatGPT transcript nodes instead of OCR or screenshots.
- Fails explicitly if it cannot prove that the final assistant response was captured completely.
- Waits for the assistant response to become stable.
- Uses no overall response timeout by default for `run`, `continue`, `task`, `audit`, and `upload-audit`.
- Supports continuing in the active app conversation.
- Supports polling the active app conversation for a stored pending session.
- Supports strict-background codebase audits by packaging local text files into a line-numbered Markdown bundle and relaying it as text chunks.
- Supports automatic source uploads for large codebase audits by packaging the tree into one `source-archive.zip`, using a direct Swift Accessibility helper for the native file picker, and saving the returned response locally.
- Retries audit-final responses that are only short acknowledgements such as "I will audit..." instead of treating them as the completed audit. Exact-output marker prompts are not retried.
- Returns `finalDeliveryText` for verbatim Codex delivery.

Unsupported options fail with `PSST_GPT_UNSUPPORTED_OPTION`.

Strict-background audits use the text-bundle path and do not open upload dialogs:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"audit","root":"/absolute/path/to/project","background":true}'
```

If no auditable text files remain after filtering, `audit` now fails with `PSST_GPT_AUDIT_BUNDLE_EMPTY` instead of generating an empty bundle.
Unreadable text files are skipped with a recorded reason instead of aborting the whole audit bundle.

Run the deterministic preflight first when you want to know whether the current Mac/session can actually use background text relay, foreground upload relay, or both:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"doctor"}'
```

The foreground upload probe may briefly bring ChatGPT to the foreground because the native file-picker path is not strict-background, then restore the previous frontmost app after the probe.

`audit` and `upload-audit` also preflight ChatGPT before they build local bundle output, so a shell-only or missing-window session fails early instead of wasting time packaging files first.

The robust task router chooses the transport automatically:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"task","prompt":"debug audit the full codebase","root":"/absolute/path/to/project"}'
```

This mode is still standalone PsstGPT. It uses the ChatGPT macOS app's own Upload file menu and native file picker. It may bring ChatGPT forward while selecting files, and if macOS Accessibility later collapses the chat into a transient shell-only state during the same wait, it may foreground ChatGPT once more to recover the usable window before continuing. It then writes `chatgpt-audit-response.md` and `chatgpt-audit-result.json` in the generated upload bundle directory.

If upload bundling finds no eligible files, it now fails with `PSST_GPT_UPLOAD_BUNDLE_EMPTY` without leaving a stale output directory behind.
Unreadable files are skipped with a recorded reason instead of aborting the whole upload bundle.
If you pass a previously created bundle object back into PsstGPT, its referenced paths must still be readable, and upload bundle output directories must still be writable, or PsstGPT fails explicitly with `PSST_GPT_AUDIT_BUNDLE_INVALID` or `PSST_GPT_UPLOAD_BUNDLE_INVALID`.
If you pass `outputDir`, it must either not exist yet or already be a readable, writable directory. Existing files at that path now fail explicitly with `PSST_GPT_AUDIT_OUTPUT_DIR_INVALID` or `PSST_GPT_UPLOAD_OUTPUT_DIR_INVALID`.

Main relay commands wait indefinitely by default for ChatGPT to finish. Pass `timeoutMs` only when you want to cap a run yourself. `timeoutMs: 0` explicitly keeps the response wait unbounded. The `poll` helper remains the bounded check-in path for pending sessions, and uploads still use `uploadTimeoutMs` for the file-picker wait.

Check routing without sending:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"plan","prompt":"debug audit the full codebase","root":"/absolute/path/to/project"}'
```

Run the live harness:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"harness","timeoutMs":300000}'
```

For complete stored sessions, `poll` can return the persisted assistant response even if the original prompt is no longer visible in the active ChatGPT transcript. Pending sessions still require the active app conversation because PsstGPT cannot reopen older conversations by URL.

Credit: PsstGPT is an independent desktop-app implementation, inspired by the original Chrome-backed [GPT Relay](https://github.com/Toolsai/GPT-Relay-Codex-Plugin-) by Prompt Case. Thanks to him for the relay concept and Codex plugin workflow.
