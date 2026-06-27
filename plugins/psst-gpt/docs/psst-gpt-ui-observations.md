# PsstGPT UI Observations

Verified locally on macOS with `ChatGPT.app` bundle id `com.openai.chat`.

PsstGPT is an independent desktop-app implementation, inspired by the original Chrome-backed GPT Relay by Prompt Case. Thanks to him for the relay concept and Codex plugin workflow.

## App

- `/Applications/ChatGPT.app` existed locally.
- `Info.plist` reported bundle id `com.openai.chat`.
- The local app version observed was `1.2026.160`.
- The app declares URL schemes including `chatgpt:` and `openai:`.

## Accessibility

- `System Events` reported UI elements enabled.
- The main window is exposed as `AXWindow/AXStandardWindow` named `ChatGPT`.
- The visible composer is exposed as `AXTextArea` with description `text entry area`.
- Setting the `AXTextArea` value directly worked for plain prompt text.
- The toolbar exposes buttons including `New chat` and the visible model label, for example `ChatGPT 5.5 Pro`.
- The composer row exposes the current model as an `AXButton` value, for example `5.5 Pro`.
- Assistant and user visible transcript text is exposed through `AXStaticText` entries above the composer.
- Background send was verified using `AXTextArea.value` plus `AXPress` on the ChatGPT app controls while another app remained frontmost.
- Direct Swift Accessibility can read the ChatGPT window even when `System Events` cannot inspect ChatGPT windows.
- Foreground upload was verified through the app's Attach menu, native file picker path entry, and visible response polling.

## Verified Smoke

The prompt `Reply exactly: OK PsstGPT smoke 2026-06-26` was sent through the app and the visible response included `OK PsstGPT smoke 2026-06-26`.

The live upload harness on 2026-06-27 created a tiny marker project, uploaded the generated source archive bundle, and verified the visible response contained the generated `PSST_HARNESS_UPLOAD_OK_*` marker.

## Boundaries

- The model picker opened as an `AXPopover`, but its option buttons did not expose model/mode text labels in this local run.
- Because model options were not text-addressable through Accessibility, app-backed model/mode/effort selection is not implemented.
- PsstGPT reads visible UI only. It does not inspect app storage or hidden session state.
- If the ChatGPT app has zero windows, verified recovery paths such as Dock activation can create a visible interruption. The strict-background relay therefore refuses this state instead of recovering the window.
