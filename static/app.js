// ===== Tiny helpers =====
const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ct = res.headers.get("Content-Type") || "";
  if (!res.ok) {
    let msg = res.statusText;
    if (ct.includes("application/json")) {
      try { msg = (await res.json()).error || msg; } catch {}
    }
    throw new Error(msg);
  }
  return ct.includes("application/json") ? res.json() : res;
}

// ===== App state =====
const state = {
  models: [],
  modelsById: {},
  currentModel: null,
  conversations: [],
  currentConvId: null,
  pendingImages: [],   // [{name, dataUrl}]
  busy: false,
  prompts: [],          // [{id, name, content}]
  defaultPromptId: null,
  editingPromptId: null, // null while form is for "new"; id while editing
  allModels: [],         // full inventory (enabled + disabled) - settings UI
  maxEnabled: 10,
  editingModelId: null,  // null while editor is for "new"; id while editing
  disabledExpanded: false,
};

// ===== Boot =====
(async function init() {
  bindGlobalEvents();
  try {
    const cfg = await api("/api/config");
    state.models = cfg.models || [];
    state.modelsById = Object.fromEntries(state.models.map((m) => [m.id, m]));
    state.currentModel = cfg.default_chat_model || (state.models[0] && state.models[0].id);
    state.prompts = cfg.prompts || [];
    state.defaultPromptId = cfg.default_prompt_id || null;
    state.maxEnabled = cfg.max_enabled_models || 10;
    populateModelSelect();
    populatePromptSelect();
    populateSettingsUI(cfg);
    renderPromptList();
    await refreshConversations();
    // Auto-open the most recent conversation, or just show empty state.
    if (state.conversations.length) {
      await openConversation(state.conversations[0].id);
    } else {
      renderEmpty();
    }
    // If neither API key is set yet, flag the settings button and auto-open
    // the drawer so the user immediately sees where to paste keys.
    if (!cfg.hunyuan_key_set && !cfg.qwen_key_set) {
      $("open-settings").classList.add("attention");
      $("settings-drawer").hidden = false;
    }
  } catch (e) {
    alert("初始化失败: " + e.message);
  }
})();

// ===== Model selector =====
let _modelSelectWired = false;
function populateModelSelect() {
  const sel = $("model-select");
  sel.innerHTML = "";
  if (!state.models.length) {
    const o = document.createElement("option");
    o.textContent = "(无启用模型 - 请在设置里启用)";
    o.disabled = true;
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  state.models.forEach((m) => {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label;
    sel.appendChild(o);
  });
  // Make sure currentModel is among enabled; otherwise fall back to first.
  if (!state.models.some((m) => m.id === state.currentModel)) {
    state.currentModel = state.models[0].id;
  }
  sel.value = state.currentModel;
  if (_modelSelectWired) return;
  _modelSelectWired = true;
  sel.addEventListener("change", async () => {
    state.currentModel = sel.value;
    if (state.currentConvId) {
      try {
        await api(`/api/conversations/${state.currentConvId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: state.currentModel }),
        });
      } catch {}
    }
  });
}

// Re-read /api/config to get the current enabled subset and rebuild topbar dropdown
// after the user toggles enable/disable in settings.
async function reloadEnabledModelsIntoTopbar() {
  try {
    const cfg = await api("/api/config");
    state.models = cfg.models || [];
    state.modelsById = Object.fromEntries(state.models.map((m) => [m.id, m]));
    populateModelSelect();
  } catch {}
}

// Distribute one or more attachments by file type:
//   .srt  -> kick off a translation job (one at a time)
//   .txt  -> read text and append into composer input
//   image -> queue as a pending image for next chat send (requires vision model)
async function handleAttachments(files) {
  if (!files.length) return;
  const srts = files.filter((f) => /\.srt$/i.test(f.name));
  const txts = files.filter((f) => /\.txt$/i.test(f.name));
  const imgs = files.filter((f) => f.type && f.type.startsWith("image/"));
  const unknown = files.filter(
    (f) => !srts.includes(f) && !txts.includes(f) && !imgs.includes(f)
  );
  if (unknown.length) {
    alert("不支持的文件类型: " + unknown.map((f) => f.name).join(", "));
  }

  // Images: require vision-capable model
  if (imgs.length) {
    const meta = state.modelsById[state.currentModel] || {};
    if (!meta.vision) {
      const ok = confirm(
        "当前模型不支持图文。要切换到 Qwen 3.6 Plus 再上传截图吗?"
      );
      if (ok) {
        const visionModel = state.models.find((m) => m.vision);
        if (visionModel) {
          state.currentModel = visionModel.id;
          $("model-select").value = visionModel.id;
        }
      } else {
        // skip image attachments
        imgs.length = 0;
      }
    }
    for (const f of imgs) {
      const dataUrl = await fileToDataUrl(f);
      state.pendingImages.push({ name: f.name, dataUrl });
    }
  }

  // Text files: append into composer input
  for (const f of txts) {
    const text = await f.text();
    const ta = $("composer-input");
    const cur = ta.value;
    ta.value = (cur ? cur + "\n\n" : "") + `// ${f.name}\n${text}`;
  }

  renderAttachments();

  // SRT files: translate one by one (sequentially to avoid 2 jobs at once)
  for (const f of srts) {
    await translateSrt(f);
  }
}

// ===== Settings drawer =====
function populateSettingsUI(cfg) {
  $("hunyuan-key").placeholder = cfg.hunyuan_key_set ? cfg.hunyuan_key_masked : "未设置";
  $("qwen-key").placeholder = cfg.qwen_key_set ? cfg.qwen_key_masked : "未设置";
  $("hunyuan-status").textContent = cfg.hunyuan_key_set ? "已配置" : "未配置";
  $("hunyuan-status").style.color = cfg.hunyuan_key_set ? "#2a9d4a" : "";
  $("qwen-status").textContent = cfg.qwen_key_set ? "已配置" : "未配置";
  $("qwen-status").style.color = cfg.qwen_key_set ? "#2a9d4a" : "";
}

function bindGlobalEvents() {
  // Drawer open/close
  $("open-refs").addEventListener("click", async () => {
    await refreshReferences();
    $("refs-drawer").hidden = false;
  });
  $("open-settings").addEventListener("click", async () => {
    try {
      const cfg = await api("/api/config");
      populateSettingsUI(cfg);
      await refreshAllModels();
    } catch {}
    $("settings-drawer").hidden = false;
  });
  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => { $(el.dataset.close).hidden = true; });
  });

  // Save keys / prompt
  $("save-keys").addEventListener("click", async () => {
    const payload = {};
    const h = $("hunyuan-key").value.trim();
    const q = $("qwen-key").value.trim();
    if (h) payload.hunyuan_key = h;
    if (q) payload.qwen_key = q;
    if (!Object.keys(payload).length) return;
    try {
      await api("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      $("hunyuan-key").value = "";
      $("qwen-key").value = "";
      const cfg = await api("/api/config");
      populateSettingsUI(cfg);
      if (cfg.hunyuan_key_set || cfg.qwen_key_set) {
        $("open-settings").classList.remove("attention");
      }
    } catch (e) { alert("保存失败: " + e.message); }
  });

  // ---- Prompt library ----
  $("new-prompt-btn").addEventListener("click", () => openPromptEditor(null));
  $("cancel-prompt-btn").addEventListener("click", () => closePromptEditor());
  $("save-prompt-btn").addEventListener("click", savePromptFromEditor);

  // Topbar prompt selector: switching binds the prompt to the current
  // conversation AND sets it as the new global default (per user spec).
  $("prompt-select").addEventListener("change", async () => {
    const pid = $("prompt-select").value || null;
    state.defaultPromptId = pid;
    try {
      if (pid) {
        await api("/api/prompts/default", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: pid }),
        });
      }
      if (state.currentConvId) {
        await api(`/api/conversations/${state.currentConvId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt_id: pid }),
        });
      }
      renderPromptList();
    } catch (e) { alert("切换指令失败: " + e.message); }
  });

  // ---- Model management ----
  $("refresh-qwen-btn").addEventListener("click", async () => {
    const btn = $("refresh-qwen-btn");
    btn.disabled = true;
    btn.textContent = "拉取中...";
    try {
      const r = await api("/api/models/refresh", { method: "POST" });
      alert(`从 Qwen 抓回 ${r.total_in_api} 个模型：新增 ${r.added}，更新 ${r.updated}。\n新模型默认未启用，请到下方"已禁用"区挑选。`);
      await refreshAllModels();
      await reloadEnabledModelsIntoTopbar();
    } catch (e) {
      alert("拉取失败: " + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "↻ 拉取 Qwen 清单";
    }
  });
  $("add-model-btn").addEventListener("click", () => openModelEditor(null));
  $("cancel-model-btn").addEventListener("click", () => closeModelEditor());
  $("save-model-btn").addEventListener("click", saveModelFromEditor);
  $("toggle-disabled-btn").addEventListener("click", () => {
    state.disabledExpanded = !state.disabledExpanded;
    $("disabled-model-list").hidden = !state.disabledExpanded;
    $("toggle-disabled-btn").textContent = state.disabledExpanded ? "收起" : "展开";
  });

  // Reference upload
  $("ref-upload").addEventListener("change", async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append("file", f);
    try {
      await api("/api/references", { method: "POST", body: fd });
      await refreshReferences();
    } catch (e) { alert("上传失败: " + e.message); }
    ev.target.value = "";
  });

  // New conversation
  $("new-chat-btn").addEventListener("click", async () => { await createConversation(); });

  // Conversation title rename (inline)
  const titleEl = $("conv-title");
  titleEl.addEventListener("blur", saveTitleIfChanged);
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
  });

  // Composer
  $("send-btn").addEventListener("click", sendChat);
  $("composer-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); sendChat();
    }
  });

  $("attach-upload").addEventListener("change", async (ev) => {
    const files = Array.from(ev.target.files || []);
    ev.target.value = "";
    await handleAttachments(files);
  });

  // Ctrl+V image paste in the composer textarea
  $("composer-input").addEventListener("paste", async (ev) => {
    const items = (ev.clipboardData && ev.clipboardData.items) || [];
    const imgs = [];
    for (const it of items) {
      if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (!imgs.length) return; // let normal text paste happen
    ev.preventDefault();
    flashComposer();
    await handleAttachments(imgs);
  });

  // Close any open hist menu on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".hist-menu") && !e.target.closest(".menu-btn")) {
      closeHistMenu();
    }
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ===== Conversations =====
async function refreshConversations() {
  const { items } = await api("/api/conversations");
  state.conversations = items;
  renderHistList();
}

function renderHistList() {
  const ul = $("hist-list");
  ul.innerHTML = "";
  state.conversations.forEach((c) => {
    const li = document.createElement("li");
    li.textContent = c.title || "未命名";
    li.title = c.title || "未命名";
    li.dataset.id = c.id;
    if (c.id === state.currentConvId) li.classList.add("active");
    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("menu-btn")) return;
      openConversation(c.id);
    });

    const menuBtn = document.createElement("button");
    menuBtn.className = "menu-btn";
    menuBtn.textContent = "⋯";
    menuBtn.title = "更多";
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openHistMenu(c, menuBtn);
    });
    li.appendChild(menuBtn);

    ul.appendChild(li);
  });
}

let openMenuEl = null;
function closeHistMenu() {
  if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
}
function openHistMenu(conv, anchor) {
  closeHistMenu();
  const menu = document.createElement("div");
  menu.className = "hist-menu";
  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.right + "px";
  menu.style.top = rect.bottom + "px";

  const renameBtn = document.createElement("button");
  renameBtn.textContent = "✎ 重命名";
  renameBtn.addEventListener("click", async () => {
    closeHistMenu();
    const name = prompt("新名称", conv.title || "");
    if (name === null) return;
    const t = name.trim();
    if (!t) return;
    try {
      await api(`/api/conversations/${conv.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t }),
      });
      await refreshConversations();
      if (state.currentConvId === conv.id) $("conv-title").value = t;
    } catch (e) { alert("重命名失败: " + e.message); }
  });
  menu.appendChild(renameBtn);

  const delBtn = document.createElement("button");
  delBtn.className = "danger";
  delBtn.textContent = "🗑 删除";
  delBtn.addEventListener("click", async () => {
    closeHistMenu();
    if (!confirm(`删除「${conv.title}」?\n这条历史对话将永久删除,不可恢复。`)) return;
    try {
      await api(`/api/conversations/${conv.id}`, { method: "DELETE" });
      if (state.currentConvId === conv.id) {
        state.currentConvId = null;
      }
      await refreshConversations();
      if (!state.currentConvId) {
        if (state.conversations.length) await openConversation(state.conversations[0].id);
        else renderEmpty();
      }
    } catch (e) { alert("删除失败: " + e.message); }
  });
  menu.appendChild(delBtn);

  document.body.appendChild(menu);
  openMenuEl = menu;
}

async function createConversation() {
  const c = await api("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: state.currentModel,
      prompt_id: state.defaultPromptId,
    }),
  });
  await refreshConversations();
  await openConversation(c.id);
  $("composer-input").focus();
}

async function openConversation(cid) {
  const conv = await api(`/api/conversations/${cid}`);
  state.currentConvId = cid;
  $("conv-title").value = conv.title || "";
  if (conv.model && state.modelsById[conv.model]) {
    state.currentModel = conv.model;
    $("model-select").value = conv.model;
  }
  const sel = $("prompt-select");
  if (sel) {
    const pid = conv.prompt_id || state.defaultPromptId || "";
    if (pid && state.prompts.some((p) => p.id === pid)) sel.value = pid;
    else if (state.prompts.length) sel.value = state.prompts[0].id;
  }
  renderConversation(conv);
  // refresh hist list to update active highlight
  renderHistList();
}

async function saveTitleIfChanged() {
  if (!state.currentConvId) return;
  const newTitle = $("conv-title").value.trim();
  if (!newTitle) return;
  const conv = state.conversations.find((c) => c.id === state.currentConvId);
  if (conv && conv.title === newTitle) return;
  try {
    await api(`/api/conversations/${state.currentConvId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTitle }),
    });
    await refreshConversations();
  } catch (e) { alert("改名失败: " + e.message); }
}

// ===== Chat log rendering =====
function renderEmpty() {
  $("empty-state").classList.remove("hidden");
  $("chat-log").innerHTML = "";
  $("conv-title").value = "";
}

function renderConversation(conv) {
  const log = $("chat-log");
  log.innerHTML = "";
  if (!conv.messages || !conv.messages.length) {
    $("empty-state").classList.remove("hidden");
    return;
  }
  $("empty-state").classList.add("hidden");
  conv.messages.forEach((m) => {
    if (m.meta && m.meta.kind === "translate_result") {
      renderTranslateResult(m);
    } else if (m.meta && m.meta.kind === "translate_request") {
      renderUserMessage(m.content, null);
    } else {
      if (m.role === "user") renderUserMessage(m.content, m.images);
      else renderAssistantBubble(m.content);
    }
  });
  scrollChatToBottom();
}

function renderUserMessage(text, images) {
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  if (images && images.length) {
    const row = document.createElement("div");
    row.className = "imgs";
    images.forEach((src) => {
      const im = document.createElement("img");
      im.src = src;
      im.addEventListener("click", () => openLightbox(src));
      row.appendChild(im);
    });
    wrap.appendChild(row);
  }
  if (text) {
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = text;
    wrap.appendChild(b);
  }
  $("chat-log").appendChild(wrap);
  $("empty-state").classList.add("hidden");
  scrollChatToBottom();
  return wrap;
}

function renderAssistantBubble(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  wrap.appendChild(b);
  $("chat-log").appendChild(wrap);
  $("empty-state").classList.add("hidden");
  scrollChatToBottom();
  return wrap;
}

function renderTranslateResult(msg) {
  // History rendering: read-only summary, no SRT body available (only generated live).
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const card = document.createElement("div");
  card.className = "translate-card";
  const meta = msg.meta || {};
  card.innerHTML = `
    <div class="tc-title">翻译完成 · ${meta.output_filename || ""}</div>
    <div class="tc-sub">共 ${meta.total_entries || "?"} 条,分 ${meta.total_batches || "?"} 批 · 模型 ${meta.model || ""}</div>
    <div class="tc-sub">(历史记录中不保存 SRT 文件,如需重新生成请重新上传)</div>
  `;
  wrap.appendChild(card);
  $("chat-log").appendChild(wrap);
  $("empty-state").classList.add("hidden");
}

function startAssistantStreaming() {
  $("empty-state").classList.add("hidden");
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";

  const thinkBox = document.createElement("details");
  thinkBox.className = "thinking";
  thinkBox.open = false;
  const summary = document.createElement("summary");
  summary.textContent = "思考过程";
  const thinkBody = document.createElement("div");
  thinkBody.className = "think-body";
  thinkBox.appendChild(summary);
  thinkBox.appendChild(thinkBody);
  thinkBox.style.display = "none";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  wrap.appendChild(thinkBox);
  wrap.appendChild(bubble);
  $("chat-log").appendChild(wrap);
  scrollChatToBottom();
  return { thinkBox, thinkBody, bubble };
}

function scrollChatToBottom() {
  const chat = $("chat");
  chat.scrollTop = chat.scrollHeight;
}

// ===== Attachments =====
function renderAttachments() {
  const wrap = $("composer-attachments");
  wrap.innerHTML = "";
  state.pendingImages.forEach((img, idx) => {
    const t = document.createElement("div");
    t.className = "thumb";
    const im = document.createElement("img");
    im.src = img.dataUrl;
    im.title = img.name || "";
    im.addEventListener("click", () => openLightbox(img.dataUrl));
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "×";
    rm.title = "移除";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      state.pendingImages.splice(idx, 1);
      renderAttachments();
    });
    t.appendChild(im); t.appendChild(rm);
    wrap.appendChild(t);
  });
}

// Full-size image preview overlay; click anywhere / press Esc to close.
function openLightbox(src) {
  const box = document.createElement("div");
  box.className = "lightbox";
  const im = document.createElement("img");
  im.src = src;
  box.appendChild(im);
  const close = () => {
    box.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  box.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(box);
}

// ===== Chat sending =====
async function ensureCurrentConv() {
  if (state.currentConvId) return state.currentConvId;
  const c = await api("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: state.currentModel }),
  });
  state.currentConvId = c.id;
  $("conv-title").value = c.title || "";
  return c.id;
}

async function sendChat() {
  if (state.busy) return;
  const input = $("composer-input");
  const text = input.value.trim();
  const images = state.pendingImages.slice();
  if (!text && !images.length) return;

  state.busy = true;
  $("send-btn").disabled = true;

  // Render user message immediately, before round-trip.
  renderUserMessage(text, images.map((i) => i.dataUrl));
  input.value = "";
  state.pendingImages = [];
  renderAttachments();

  const convId = await ensureCurrentConv();

  const { thinkBox, thinkBody, bubble } = startAssistantStreaming();
  let assistantText = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: state.currentModel,
        conv_id: convId,
        message: text,
        images: images.map((i) => i.dataUrl),
      }),
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    await readSseStream(res, (evt) => {
      if (evt.type === "thinking") {
        thinkBox.style.display = "";
        thinkBody.textContent += evt.text;
      } else if (evt.type === "content") {
        assistantText += evt.text;
        bubble.textContent = assistantText;
      } else if (evt.type === "error") {
        bubble.textContent = "[错误] " + evt.text;
        bubble.style.color = "var(--danger)";
      }
      scrollChatToBottom();
    });
  } catch (e) {
    bubble.textContent = "[请求失败] " + e.message;
    bubble.style.color = "var(--danger)";
  } finally {
    state.busy = false;
    $("send-btn").disabled = false;
    refreshConversations().catch(() => {});
  }
}

// ===== Translation flow (integrated into the chat) =====
async function translateSrt(file) {
  if (state.busy) { alert("有任务正在进行,请稍候"); return; }
  state.busy = true;
  $("send-btn").disabled = true;

  const convId = await ensureCurrentConv();
  const merge = $("merge-toggle").checked ? "1" : "0";
  const model = state.currentModel;

  // Show the user-side "upload" message
  renderUserMessage(`[上传字幕] ${file.name}`, null);

  // Insert a live translate-card under an assistant bubble
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const card = document.createElement("div");
  card.className = "translate-card";
  card.innerHTML = `
    <div class="tc-title">准备翻译…</div>
    <div class="tc-sub" id="tc-sub-${Date.now()}">读取字幕中</div>
    <div class="progress"><div class="progress-bar"></div></div>
    <div class="tc-actions"></div>
  `;
  wrap.appendChild(card);
  $("chat-log").appendChild(wrap);
  scrollChatToBottom();

  const titleEl = card.querySelector(".tc-title");
  const subEl = card.querySelector(".tc-sub");
  const barEl = card.querySelector(".progress-bar");
  const actEl = card.querySelector(".tc-actions");

  let finalFilename = "";
  let finalSrt = "";
  let errorText = "";

  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("model", model);
    fd.append("merge", merge);
    fd.append("conv_id", convId);

    const res = await fetch("/api/translate", { method: "POST", body: fd });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }

    await readSseStream(res, (evt) => {
      if (evt.type === "start") {
        titleEl.textContent = `翻译中 · ${evt.model_label}`;
        subEl.textContent = `共 ${evt.total_entries} 条 / ${evt.total_batches} 批(每批 ${evt.batch_size} 条)`;
        finalFilename = evt.output_filename;
      } else if (evt.type === "batch") {
        const pct = Math.round((evt.index / evt.total) * 100);
        barEl.style.width = pct + "%";
        subEl.textContent = `第 ${evt.index} / ${evt.total} 批  ·  ${evt.done_entries} / ${evt.total_entries} 条`;
      } else if (evt.type === "done") {
        finalSrt = evt.srt || "";
        finalFilename = evt.filename || finalFilename;
      } else if (evt.type === "error") {
        errorText = evt.text || "未知错误";
      }
    });

    if (errorText) throw new Error(errorText);
    if (!finalSrt) throw new Error("未收到最终 SRT");

    // Done state
    barEl.style.width = "100%";
    titleEl.textContent = `翻译完成 · ${finalFilename}`;
    subEl.textContent = `已使用 ${state.modelsById[model]?.label || model}`;

    // Auto-download once + offer a manual re-download link
    const blob = new Blob([finalSrt], { type: "application/x-subrip;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = finalFilename; a.textContent = "再次下载";
    a.className = "download";
    actEl.appendChild(a);
    // Auto-click once
    const trigger = document.createElement("a");
    trigger.href = url; trigger.download = finalFilename;
    document.body.appendChild(trigger); trigger.click(); trigger.remove();
  } catch (e) {
    card.classList.add("error");
    titleEl.textContent = "翻译失败";
    subEl.textContent = e.message;
    barEl.style.width = "0%";
  } finally {
    state.busy = false;
    $("send-btn").disabled = false;
    refreshConversations().catch(() => {});
  }
}

// ===== SSE reader =====
async function readSseStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      onEvent(evt);
    }
  }
}

// ===== Prompt library =====
function populatePromptSelect() {
  const sel = $("prompt-select");
  if (!sel) return;
  sel.innerHTML = "";
  state.prompts.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name + (p.id === state.defaultPromptId ? "  (默认)" : "");
    sel.appendChild(o);
  });
  if (state.defaultPromptId) sel.value = state.defaultPromptId;
}

function renderPromptList() {
  const ul = $("prompt-list");
  if (!ul) return;
  ul.innerHTML = "";
  state.prompts.forEach((p) => {
    const li = document.createElement("li");
    if (p.id === state.defaultPromptId) li.classList.add("active");

    const dot = document.createElement("button");
    dot.className = "dot";
    dot.title = "设为默认";
    dot.addEventListener("click", () => setDefaultPrompt(p.id));
    li.appendChild(dot);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = p.name || "(未命名)";
    name.title = "点击编辑";
    name.addEventListener("click", () => openPromptEditor(p));
    li.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "actions";

    const editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", () => openPromptEditor(p));
    actions.appendChild(editBtn);

    if (state.prompts.length > 1) {
      const delBtn = document.createElement("button");
      delBtn.className = "icon-btn danger";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", () => deletePrompt(p));
      actions.appendChild(delBtn);
    }

    li.appendChild(actions);
    ul.appendChild(li);
  });
}

function openPromptEditor(prompt) {
  state.editingPromptId = prompt ? prompt.id : null;
  $("prompt-name").value = prompt ? prompt.name : "";
  $("prompt-content").value = prompt ? prompt.content : "";
  $("prompt-editor").hidden = false;
  $("prompt-name").focus();
}
function closePromptEditor() {
  state.editingPromptId = null;
  $("prompt-name").value = "";
  $("prompt-content").value = "";
  $("prompt-editor").hidden = true;
}

async function savePromptFromEditor() {
  const name = $("prompt-name").value.trim();
  const content = $("prompt-content").value;
  if (!name) { alert("请填写名称"); return; }
  try {
    if (state.editingPromptId) {
      await api(`/api/prompts/${state.editingPromptId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content }),
      });
    } else {
      await api("/api/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, content }),
      });
    }
    await refreshPrompts();
    closePromptEditor();
  } catch (e) { alert("保存失败: " + e.message); }
}

async function deletePrompt(p) {
  if (!confirm(`删除指令「${p.name}」?`)) return;
  try {
    await api(`/api/prompts/${p.id}`, { method: "DELETE" });
    await refreshPrompts();
  } catch (e) { alert("删除失败: " + e.message); }
}

async function setDefaultPrompt(pid) {
  try {
    await api("/api/prompts/default", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: pid }),
    });
    state.defaultPromptId = pid;
    if (state.currentConvId) {
      await api(`/api/conversations/${state.currentConvId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_id: pid }),
      });
    }
    populatePromptSelect();
    renderPromptList();
  } catch (e) { alert("设为默认失败: " + e.message); }
}

async function refreshPrompts() {
  const cfg = await api("/api/config");
  state.prompts = cfg.prompts || [];
  state.defaultPromptId = cfg.default_prompt_id || null;
  populatePromptSelect();
  renderPromptList();
}

// Brief visual confirmation that a Ctrl+V image was captured.
function flashComposer() {
  const host = document.querySelector(".composer-box");
  if (!host) return;
  const f = document.createElement("div");
  f.className = "paste-flash";
  host.appendChild(f);
  setTimeout(() => f.remove(), 450);
}

// ===== Model management =====
async function refreshAllModels() {
  try {
    const r = await api("/api/models");
    state.allModels = r.items || [];
    state.maxEnabled = r.max_enabled || 10;
    renderModelLists();
  } catch (e) { /* drawer may be closed; ignore */ }
}

function renderModelLists() {
  const enabled  = state.allModels.filter((m) => m.enabled);
  const disabled = state.allModels.filter((m) => !m.enabled);
  $("enabled-count").textContent  = `(${enabled.length}/${state.maxEnabled})`;
  $("disabled-count").textContent = `(${disabled.length})`;
  const cap = $("model-cap-hint");
  cap.textContent = `· 启用上限 ${state.maxEnabled}`;
  cap.classList.toggle("over", enabled.length >= state.maxEnabled);
  renderModelList($("enabled-model-list"),  enabled,  true);
  renderModelList($("disabled-model-list"), disabled, false);
}

function renderModelList(ul, items, isEnabledList) {
  ul.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.style.color = "var(--muted)";
    li.style.justifyContent = "center";
    li.textContent = isEnabledList ? "（无启用模型）" : "（无）";
    ul.appendChild(li);
    return;
  }
  items.forEach((m) => {
    const li = document.createElement("li");

    const name = document.createElement("div");
    name.className = "m-name";
    const lab = document.createElement("div");
    lab.className = "m-label";
    lab.textContent = m.label;
    name.appendChild(lab);
    const meta = document.createElement("div");
    meta.className = "m-meta";
    const badge = document.createElement("span");
    badge.className = "badge " + m.provider;
    badge.textContent = m.provider;
    meta.appendChild(badge);
    const idSpan = document.createElement("span");
    idSpan.textContent = m.id;
    meta.appendChild(idSpan);
    if (m.thinking) { const c = document.createElement("span"); c.className = "cap"; c.textContent = "thinking"; meta.appendChild(c); }
    if (m.vision)   { const c = document.createElement("span"); c.className = "cap"; c.textContent = "vision";   meta.appendChild(c); }
    if (m.source === "qwen")    { const c = document.createElement("span"); c.className = "cap"; c.textContent = "扫描"; meta.appendChild(c); }
    if (m.source === "manual")  { const c = document.createElement("span"); c.className = "cap"; c.textContent = "手动"; meta.appendChild(c); }
    if (m.source === "builtin") { const c = document.createElement("span"); c.className = "cap"; c.textContent = "内置"; meta.appendChild(c); }
    name.appendChild(meta);
    li.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "m-actions";

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = m.enabled ? "禁用" : "启用";
    toggleBtn.addEventListener("click", () => toggleModelEnabled(m));
    actions.appendChild(toggleBtn);

    const editBtn = document.createElement("button");
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", () => openModelEditor(m));
    actions.appendChild(editBtn);

    if (m.source !== "qwen") {
      const delBtn = document.createElement("button");
      delBtn.className = "danger";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", () => deleteModel(m));
      actions.appendChild(delBtn);
    }

    li.appendChild(actions);
    ul.appendChild(li);
  });
}

async function toggleModelEnabled(m) {
  try {
    await api(`/api/models/${encodeURIComponent(m.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !m.enabled }),
    });
    await refreshAllModels();
    await reloadEnabledModelsIntoTopbar();
  } catch (e) { alert(e.message); }
}

async function deleteModel(m) {
  if (!confirm(`删除模型「${m.label}」(${m.id})?`)) return;
  try {
    await api(`/api/models/${encodeURIComponent(m.id)}`, { method: "DELETE" });
    await refreshAllModels();
    await reloadEnabledModelsIntoTopbar();
  } catch (e) { alert("删除失败: " + e.message); }
}

function openModelEditor(m) {
  state.editingModelId = m ? m.id : null;
  $("model-editor-title").textContent = m ? "编辑模型" : "新增模型";
  $("model-id").value       = m ? m.id : "";
  $("model-id").disabled    = !!m; // id is immutable once created
  $("model-label").value    = m ? m.label : "";
  $("model-provider").value = m ? m.provider : "hunyuan";
  $("model-thinking").checked = m ? !!m.thinking : false;
  $("model-vision").checked   = m ? !!m.vision   : false;
  $("model-editor").hidden = false;
  $("model-id").focus();
}
function closeModelEditor() {
  state.editingModelId = null;
  $("model-editor").hidden = true;
}

async function saveModelFromEditor() {
  const id       = $("model-id").value.trim();
  const label    = $("model-label").value.trim() || id;
  const provider = $("model-provider").value;
  const thinking = $("model-thinking").checked;
  const vision   = $("model-vision").checked;
  if (!id) { alert("请填写模型 ID"); return; }
  try {
    if (state.editingModelId) {
      await api(`/api/models/${encodeURIComponent(state.editingModelId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, thinking, vision }),
      });
    } else {
      await api("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, label, provider, thinking, vision, enabled: true }),
      });
    }
    closeModelEditor();
    await refreshAllModels();
    await reloadEnabledModelsIntoTopbar();
  } catch (e) { alert("保存失败: " + e.message); }
}

// ===== References drawer =====
async function refreshReferences() {
  const { files } = await api("/api/references");
  const ul = $("ref-list");
  ul.innerHTML = "";
  files.forEach((name) => {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = name;
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "删除";
    del.addEventListener("click", async () => {
      if (!confirm(`删除 ${name}?`)) return;
      try {
        await api("/api/references/" + encodeURIComponent(name), { method: "DELETE" });
        await refreshReferences();
      } catch (e) { alert("删除失败: " + e.message); }
    });
    li.appendChild(span); li.appendChild(del);
    ul.appendChild(li);
  });
}
