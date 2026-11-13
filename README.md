# Chinese-to-English Subtitle Translator

Translate a full episode of Chinese subtitles into English, refine individual lines in chat, and reuse approved translations across episodes. This local web app connects to Tencent Hunyuan and Alibaba Qwen through their OpenAI-compatible APIs. A typical workflow uses Hunyuan for a first draft and switches to Qwen to discuss lines that need more work.

## Model and prompt controls

- **Switch models in the same conversation.** Use the model dropdown to choose which model handles your next subtitle upload or chat message. The conversation keeps its history when you switch.
- **Manage models and API keys in Settings.** Enter or update each provider's key separately. Add models by ID, edit their labels and capability settings, and enable the models you want in the dropdown. You can also fetch the model list from Qwen. Newly discovered models stay disabled until you choose to enable them.
- **Save different system prompts.** Create and edit named presets for tasks such as first-pass translation, dialogue polishing or keeping within subtitle reading limits. Choose a default for new conversations. Switching prompts from the conversation toolbar applies the selected prompt to that conversation and makes it the default for new ones.

## Translation and review workflow

1. **Generate an English draft.** Upload a Chinese `.srt` file. The app translates up to 60 cues per batch, shows progress and downloads an `_EN.srt` file. If the model skips a cue, the app retains the Chinese text for review. Short adjacent fragments can be merged for context. Turn merging off to keep the original cue boundaries.
2. **Refine difficult lines.** Paste a line into chat to discuss tone, idioms or alternative phrasings. You can attach a screenshot when using an image-capable model. Chat replies stream as they arrive, and conversations are stored locally so you can return to them.
3. **Reuse approved terminology.** In **资料库** (Reference Library), upload or remove `.txt` and `.srt` references. To update a glossary, edit it and upload the revised file under the same name. The app automatically adds the current reference files to the chosen system prompt for both translation and chat. You decide which corrections enter the library.

## Run locally

Use Python 3.11 or later. On Windows PowerShell, run these commands from the repository root.

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app\main.py
```

Open [the local app](http://127.0.0.1:5000), then open **设置** (Settings) to enter your own API key for the provider you want to use. The interface is in Chinese. API keys are stored in the local, Git-ignored `app/config.json`. Translation and chat requests send the relevant input and reference text to the selected model provider.

## Try the sample

- [Original Chinese SRT](examples/zh-sample.srt)
- [Approved terminology](examples/approved-terms.txt)
- [Illustrative English SRT](examples/en-sample.srt)

A first draft might translate **灯塔站** as **Lighthouse Station**. If you settle on **Beacon Station**, upload the approved terminology file to the Reference Library. The next translation request includes that preferred wording. The English sample shows an illustrative edited result.
