# PsstGPT

PsstGPT is a Codex plugin skill for relaying text prompts to the macOS ChatGPT desktop app and running source upload audits.

For the full install guide, see the repository [README](../../README.md).

## Invoke

Use the skill directly:

```text
$psst-gpt <task to send to the ChatGPT app>
```

In Codex CLI, `/psst-gpt` is not the supported command path. Use `$psst-gpt`, or run `/skills` and select `psst-gpt`.

## Requirements

- macOS.
- ChatGPT desktop app installed and signed in.
- One ChatGPT app window already open.
- Accessibility permission for Codex, `/usr/bin/osascript`, and `/usr/bin/swift` if macOS prompts for them.

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
- Reads visible transcript text from Accessibility.
- Waits for the assistant response to become stable.
- Supports continuing in the active app conversation.
- Supports polling the active app conversation for a stored pending session.
- Supports strict-background codebase audits by packaging local text files into a line-numbered Markdown bundle and relaying it as text chunks.
- Supports automatic source uploads for large codebase audits by packaging the tree into zip shards plus an upload manifest, using a direct Swift Accessibility helper for the native file picker, and saving the returned response locally.
- Returns `finalDeliveryText` for verbatim Codex delivery.

Unsupported options fail with `PSST_GPT_UNSUPPORTED_OPTION`.

Strict-background audits use the text-bundle path and do not open upload dialogs:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"audit","root":"/absolute/path/to/project","background":true}'
```

The robust task router chooses the transport automatically:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"task","prompt":"debug audit the full codebase","root":"/absolute/path/to/project"}'
```

This mode is still standalone PsstGPT. It uses the ChatGPT macOS app's own Upload file menu and native file picker. It may bring ChatGPT forward while selecting files, then writes `chatgpt-audit-response.md` and `chatgpt-audit-result.json` in the generated upload bundle directory.

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

Credit: PsstGPT is an independent desktop-app implementation, inspired by the original Chrome-backed [GPT Relay](https://github.com/Toolsai/GPT-Relay-Codex-Plugin-) by Prompt Case. Thanks to him for the relay concept and Codex plugin workflow.
