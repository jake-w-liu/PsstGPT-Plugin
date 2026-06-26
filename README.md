# PsstGPT Codex Plugin

PsstGPT is a standalone Codex plugin that relays prompts to the macOS ChatGPT desktop app instead of Chrome.

It wakes `ChatGPT.app` in the background, writes the prompt into an existing app composer through macOS Accessibility, sends it with Accessibility actions, waits for the visible assistant response to stabilize, stores a local app-session record, and returns the response to Codex.

> This is an independent community plugin. It is not an official OpenAI or ChatGPT product.
>
> Credit: PsstGPT is an independent desktop-app implementation, inspired by the original Chrome-backed [GPT Relay](https://github.com/Toolsai/GPT-Relay-Codex-Plugin-) by Prompt Case. Thanks to him for the relay concept and Codex plugin workflow.

## Install From GitHub

After this repository is available on GitHub:

```bash
codex plugin marketplace add jake-w-liu/PsstGPT-Codex-Plugin
codex plugin add psst-gpt@psst-gpt
```

Then start a new Codex thread.

If you previously added the early marketplace build and Codex printed `Added marketplace personal`, refresh it with:

```bash
codex plugin marketplace remove personal
codex plugin marketplace add jake-w-liu/PsstGPT-Codex-Plugin
codex plugin add psst-gpt@psst-gpt
```

## Install Locally

In Codex, add this folder as a plugin marketplace source:

| Field | Value |
| --- | --- |
| Source | Local path to this folder |
| Sparse paths | Leave blank |

Then install **PsstGPT** and start a new Codex thread.

## How To Use

After installing the plugin in Codex, use the skill directly:

```text
$psst-gpt Plan this refactor in the ChatGPT app and bring the result back.
```

In the Codex app, type `/` in the composer and select the enabled `psst-gpt` skill from the slash command list, then add the task you want sent to the ChatGPT app.

You can also ask for PsstGPT explicitly in normal text:

```text
Use PsstGPT to plan this refactor in the ChatGPT app, then bring the result back.
```

```text
Ask PsstGPT: compare these two architecture options in the ChatGPT desktop app.
```

```text
Continue in the active ChatGPT app chat and ask for a shorter implementation checklist.
```

For direct Node usage:

```bash
node plugins/psst-gpt/scripts/psst_gpt.mjs \
  '{"command":"run","prompt":"Reply exactly: OK from PsstGPT","background":true}'
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

## Requirements

- macOS.
- ChatGPT desktop app installed in `/Applications` or `~/Applications`.
- ChatGPT app signed in and ready to use.
- A ChatGPT app window already open. The relay will not open or foreground one.
- macOS Accessibility permission enabled for the process running Codex/`osascript`.

## What It Can Do

- Start a new ChatGPT app conversation in an existing background window.
- Send a text prompt.
- Continue in the active ChatGPT app conversation.
- Poll a pending active app session.
- Store session metadata under `~/.codex/psst-gpt/app-sessions.json`.
- Return the visible assistant response to Codex.

## Current Boundaries

PsstGPT does not use Chrome, Playwright, browser page assets, cookies, local storage, or ChatGPT web internals.

The current verified desktop-app Accessibility path supports strict-background text prompt relay. Model selection, file upload, GPT Apps, Projects, Create image artifact export, Deep Research Markdown export, foreground mode, and window recovery are rejected with explicit errors until those app UI paths are verified end to end without interruption.

## Self-Contained Layout

The implementation lives under `plugins/psst-gpt` and does not import code from the original Chrome-backed GPT Relay repository. Runtime code uses Node built-ins, `/usr/bin/open -g`, `/usr/bin/osascript`, and macOS Accessibility against `ChatGPT.app`.

## Slash-Style Command

PsstGPT is packaged as a Codex skill named `psst-gpt`.

In Codex CLI, plugin skills are invoked with `$` or selected through `/skills`:

```text
$psst-gpt <task to send to the ChatGPT app>
```

```text
/skills
```

In the Codex desktop app, current Codex documentation says enabled skills also appear in the app slash command list, so `psst-gpt` can be selected there after the plugin is installed and enabled.

Current Codex CLI documentation does not expose plugin-defined top-level commands such as `/psst-gpt`. If you want a local CLI slash prompt, use Codex's custom prompt form `/prompts:psst-gpt`, but Codex documentation marks custom prompts as deprecated in favor of skills.

## Example

```js
const { runPsstGPT } = await import("/absolute/path/to/plugins/psst-gpt/scripts/psst_gpt.mjs");
const result = await runPsstGPT({
  prompt: "Reply exactly: OK from the ChatGPT app",
  timeoutMs: 10 * 60 * 1000
});
nodeRepl.write(result.finalDeliveryText);
```

To continue in the currently active app chat:

```js
const { continuePsstGPT } = await import("/absolute/path/to/plugins/psst-gpt/scripts/psst_gpt.mjs");
const result = await continuePsstGPT({
  prompt: "Now summarize the previous answer in one sentence."
});
nodeRepl.write(result.finalDeliveryText);
```
