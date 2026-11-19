# Prompt Predictor

Antigravity auxiliary-pane UI plugin that predicts likely next user prompts after each agent turn (inspired by Codex Composer Predictions), featuring gray ghost-text completion with `Tab` acceptance and one-click direct sending.

## Features

- **Automatic turn detection**: Watches the active conversation's `transcript.jsonl` and triggers predictions once the agent finishes a turn.
- **Multiple providers**: Supports any **OpenAI-compatible** endpoint (OpenAI, DeepSeek, Ark/Doubao, Ollama, etc.) and **Google Gemini** REST API (`generateContent`).
- **Quick Composer with ghost text**:
  - `Tab`: accept the active gray ghost-text prediction into the composer.
  - `↑` / `↓` (when composer is empty): cycle through predicted suggestions.
  - `Enter`: send directly to the active conversation.
  - `Shift+Enter`: insert newline.
- **Card actions**: Click a card to load it into the composer, click **发送** to send immediately, or **复制** to copy.

## Configuration

Open the **Prompt Predictor** panel in Antigravity's auxiliary side pane and click the `⚙` icon (auto-opens on first run).

Settings are saved locally at:

```text
~/.gemini/config/plugins/prompt-predictor/settings.local.json
```

The file is written atomically with `0600` permissions so your API key stays readable only by your local OS user, and raw keys are never returned on unauthenticated `GET` routes.
