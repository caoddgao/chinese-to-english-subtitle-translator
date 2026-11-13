# 中文字幕英译工具

[简体中文](#中文字幕英译工具) · [English](#chinese-to-english-subtitle-translator)

把整集中文字幕翻成英文，在同一个对话里精修个别台词，并让已确认的人名、称呼和固定译法在后续剧集中保持一致。工具在本地浏览器里运行，通过兼容 OpenAI 格式的 API 接入腾讯混元和阿里千问。常见用法是先用混元出初稿，再切换到千问推敲难译的台词。

## 模型和提示词设置

- **在同一对话里切换模型。** 顶部下拉菜单决定下一次字幕翻译或聊天使用哪个模型，切换后仍可继续使用当前对话。
- **在设置中管理模型和 API Key。** 可以分别填写或更新混元和千问的密钥，按模型 ID 手动添加模型，调整显示名称和能力设置，并选择哪些模型出现在下拉菜单里。也可以从千问接口刷新模型列表，新发现的模型由你决定是否启用。
- **保存多套系统提示词。** 可以为初译、台词润色、字幕长度控制等任务建立不同的指令。通过顶部下拉菜单切换时，选中的指令会应用于当前对话，并成为新对话的默认指令。

## 从整集初译到术语复用

1. **生成英文初稿。** 上传中文 `.srt` 文件，工具每批处理最多 60 条字幕，显示翻译进度，完成后下载 `_EN.srt`。模型漏译某条时，工具保留该条中文，方便复查。可开启短句合并来补充上下文，也可关闭以保留原来的字幕分段。
2. **精修个别台词。** 把想修改的句子贴到对话里，讨论语气、习语和替代译法。使用支持图像输入的模型时，也可以附上截图提供场景信息。回复实时显示，对话保存在本机，方便之后继续。
3. **让确认过的译法在下一集生效。** 在「资料库」中上传或删除 `.txt` 和 `.srt` 文件。要更新术语表，编辑后用同名文件重新上传即可。之后每次翻译或聊天，工具都会自动把资料库里的内容加入系统提示词。由你决定哪些纠错结果值得保留。

## 本地运行

使用 Python 3.11 或更新版本。以下以 Python 3.11 为例，在 Windows PowerShell 中进入仓库目录后执行。如果你安装的是更新版本，将第一行的 `3.11` 换成对应版本。

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app\main.py
```

打开 [本地应用](http://127.0.0.1:5000)，在「设置」里填写你要使用的模型服务的 API Key。密钥保存在本机的 `app/config.json`，该文件已设为 Git 忽略。执行翻译或聊天时，相关输入和参考资料会发送给选中的模型服务。

## 试用示例

- [原创中文字幕](examples/zh-sample.srt)
- [示例术语表](examples/approved-terms.txt)
- [英文字幕示例](examples/en-sample.srt)

初稿可能把「灯塔站」译成 **Lighthouse Station**。如果你定稿用 **Beacon Station**，就把这条译法存入术语表并上传到资料库。下次翻译时，工具会把这条术语提供给模型参考。仓库里的英文字幕展示的是人工定稿示例。

---

# Chinese-to-English Subtitle Translator

[简体中文](#中文字幕英译工具) · [English](#chinese-to-english-subtitle-translator)

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
