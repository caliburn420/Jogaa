# Prefill Alchemy

Prefill Alchemy helps SillyTavern make a model begin its reply with your assistant prefill, including models that do not support normal prefilling.

## Install

Paste the repository URL into SillyTavern's **Extensions > Install Extension** dialog.

For a manual installation, copy this folder into `public/scripts/extensions/third-party/prefill-alchemy`. No build step is needed.

## Use

1. Open **Extensions > Prefill Alchemy** and select Auto or On. On Gemini 3, Prefill Alchemy requests only the new continuation at the lowest supported thinking level and restores the assistant prefix locally, avoiding a prohibited final model turn.
2. Add an enabled, in-chat assistant injection at the end of the Prompt Manager order.
3. Generate normally.

If this fork's built-in **Chat Completion > Structured Prefill** control is enabled, turn it Off while testing the extension. The extension detects an already-converted request and will not apply the schema twice.

Supported markers are `[[w:N]]`, `[[w:N-M]]`, `[[opt:a|b]]`, `[[re:pattern]]`, `[[free]]`, and `[[keep]]`.

If **Hide prefill text** is enabled, the hidden prefix is withheld and the visible continuation starts streaming as soon as the prefix is complete.

Prefill Alchemy leaves requests that already use a JSON schema unchanged.

## How it works

The extension turns the last assistant prefill into a structured-output rule, sends it through SillyTavern's normal generation request, and changes the structured response back into ordinary chat text. It does not contact any separate service.

## License

AGPL-3.0-or-later, matching SillyTavern and the core implementation from which this extension was isolated.

## Publishing

Before publishing, set `author` and `homePage` in `manifest.json` to your preferred name and final repository URL. Keep `manifest.json`, `index.js`, and the other extension files at the repository root so SillyTavern can install the Git URL directly.
