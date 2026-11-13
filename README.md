# Chinese-to-English Subtitle Translator

A local web app for translating Chinese SubRip subtitles into English and keeping names and recurring expressions consistent across episodes. It uses Tencent Hunyuan and Alibaba Qwen through their OpenAI-compatible APIs.

## Workflow

1. Upload a Chinese `.srt` file and select a translation model. The app translates in batches and exports a new SRT. Turn off the short-line merge option if you want to retain every original cue boundary.
2. Review the draft and use the Qwen chat to discuss alternative phrasings.
3. Save approved translations of recurring terms in a text file and upload it under **资料库** (Reference Library). Later requests include those reference files in the system prompt. You choose which corrections to save.

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

For example, a first draft might translate **灯塔站** as **Lighthouse Station**. Upload the approved terminology file to give later requests the preferred wording **Beacon Station**. The English sample is an illustrative, edited result. Review the model's own output before exporting final subtitles.
