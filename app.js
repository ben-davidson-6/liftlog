(() => {
  const cfg = window.WEIGHT_LOG_CONFIG;
  const TOKEN_KEY = "gh_token";
  const WORKOUT_DRAFT_KEY = "workout_draft";
  const WEIGHT_DRAFT_KEY = "weight_draft";

  const $ = (id) => document.getElementById(id);

  // ---------- token / setup ----------

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  function showSetup() {
    $("setup").classList.remove("hidden");
    $("app").classList.add("hidden");
    const url = `https://github.com/settings/personal-access-tokens/new?name=liftlog&target_name=${encodeURIComponent(cfg.OWNER)}&description=liftlog+commit+access`;
    $("setup-link").href = url;
  }

  function showApp() {
    $("setup").classList.add("hidden");
    $("app").classList.remove("hidden");
    init();
  }

  $("save-token").addEventListener("click", () => {
    const t = $("token-input").value.trim();
    if (!t) {
      $("setup-status").textContent = "Token cannot be empty.";
      $("setup-status").className = "status err";
      return;
    }
    setToken(t);
    $("token-input").value = "";
    $("setup-status").textContent = "Saved.";
    $("setup-status").className = "status ok";
    showApp();
  });

  $("reset-token").addEventListener("click", () => {
    if (!confirm("Clear the saved token from this browser?")) return;
    clearToken();
    location.reload();
  });

  // ---------- GitHub API ----------

  const ghBase = () => `https://api.github.com/repos/${cfg.OWNER}/${cfg.REPO}/contents`;

  function b64encode(s) {
    return btoa(unescape(encodeURIComponent(s)));
  }
  function b64decode(s) {
    return decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));
  }

  async function getFile(path) {
    const r = await fetch(`${ghBase()}/${path}?ref=${cfg.BRANCH}`, {
      headers: {
        Authorization: `Bearer ${getToken()}`,
        Accept: "application/vnd.github+json",
      },
      cache: "no-store",
    });
    if (r.status === 404) {
      const err = new Error(`GET ${path}: 404`);
      err.status = 404;
      throw err;
    }
    if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    return { sha: j.sha, content: b64decode(j.content) };
  }

  async function putFile(path, content, sha, message) {
    const body = { message, content: b64encode(content), branch: cfg.BRANCH };
    if (sha) body.sha = sha;
    const r = await fetch(`${ghBase()}/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${getToken()}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text();
      const err = new Error(`PUT ${path}: ${r.status} ${txt}`);
      err.status = r.status;
      throw err;
    }
    return r.json();
  }

  async function appendLines(path, lines, message) {
    const tryOnce = async () => {
      const { sha, content } = await getFile(path);
      const sep = content.endsWith("\n") || content === "" ? "" : "\n";
      const newContent = content + sep + lines.join("\n") + "\n";
      return putFile(path, newContent, sha, message);
    };
    try { return await tryOnce(); }
    catch (e) {
      if (e.status === 409 || e.status === 422) return await tryOnce();
      throw e;
    }
  }

  async function writeFile(path, content, message) {
    let sha = null;
    try {
      const f = await getFile(path);
      sha = f.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    return putFile(path, content, sha, message);
  }

  // ---------- data state ----------

  let exercises = [];   // [{slug, name}]
  let templates = [];   // [{slug, name, exercises:[slug...]}]
  let workoutHistory = []; // [{date, exercise, set_number, weight_kg, reps}]

  function exerciseName(slug) {
    const ex = exercises.find((e) => e.slug === slug);
    return ex ? ex.name : slug;
  }

  async function loadExercises() {
    const { content } = await getFile("data/exercises.yaml");
    exercises = jsyaml.load(content) || [];
  }

  async function loadTemplates() {
    try {
      const { content } = await getFile("data/templates.yaml");
      templates = jsyaml.load(content) || [];
    } catch (e) {
      if (e.status === 404) { templates = []; return; }
      throw e;
    }
  }

  async function loadWorkoutHistory() {
    try {
      const { content } = await getFile("data/workouts.csv");
      const lines = content.trim().split("\n").slice(1).filter((l) => l.trim());
      workoutHistory = lines.map((l) => {
        const [date, exercise, set_number, weight_kg, reps] = l.split(",");
        return {
          date,
          exercise,
          set_number: parseInt(set_number, 10),
          weight_kg: parseFloat(weight_kg),
          reps: parseInt(reps, 10),
        };
      });
    } catch (e) {
      workoutHistory = [];
    }
  }

  function lastSessionFor(slug, excludeDate) {
    const rows = workoutHistory.filter((r) => r.exercise === slug && r.date !== excludeDate);
    if (rows.length === 0) return null;
    const maxDate = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date);
    const sets = rows.filter((r) => r.date === maxDate).sort((a, b) => a.set_number - b.set_number);
    return { date: maxDate, sets };
  }

  function formatLastSession(slug, date) {
    const last = lastSessionFor(slug, date);
    if (!last) return `<span class="muted">No previous session.</span>`;
    const summary = last.sets.map((s) => {
      const w = s.weight_kg === 0 ? "BW" : `${s.weight_kg}kg`;
      return `${w}×${s.reps}`;
    }).join(", ");
    return `<span class="muted">Last (${last.date}): ${summary}</span>`;
  }

  // ---------- workout mode picker ----------

  function renderModePicker() {
    const sel = $("workout-mode");
    const current = sel.value;
    sel.innerHTML = `<option value="">— choose —</option>`;
    for (const t of templates) {
      const o = document.createElement("option");
      o.value = `template:${t.slug}`;
      o.textContent = t.name;
      sel.appendChild(o);
    }
    const o = document.createElement("option");
    o.value = "individual";
    o.textContent = "Individual exercise";
    sel.appendChild(o);
    if (current) sel.value = current;
  }

  // ---------- workout body ----------

  function exerciseBlock(slug, presetSets) {
    const block = document.createElement("div");
    block.className = "exercise-block";
    block.dataset.slug = slug;
    block.innerHTML = `
      <h3 class="ex-heading">${exerciseName(slug)}</h3>
      <div class="last-session">${formatLastSession(slug, $("workout-date").value)}</div>
      <div class="sets-container"></div>
      <button class="secondary add-set-btn" type="button">+ Add set</button>
    `;
    const setsContainer = block.querySelector(".sets-container");
    const setsToAdd = presetSets && presetSets.length > 0 ? presetSets : [{ weight: "", reps: "" }];
    for (const s of setsToAdd) setsContainer.appendChild(makeSetRow(setsContainer.children.length, s.weight, s.reps));
    block.querySelector(".add-set-btn").addEventListener("click", () => {
      setsContainer.appendChild(makeSetRow(setsContainer.children.length));
      renumberSetsIn(setsContainer);
      saveWorkoutDraft();
    });
    return block;
  }

  function makeSetRow(idx, weight = "", reps = "") {
    const row = document.createElement("div");
    row.className = "row set-row";
    row.innerHTML = `
      <div class="set-num">${idx + 1}</div>
      <input type="number" inputmode="decimal" step="0.5" min="0" class="set-weight" placeholder="kg" value="${weight}">
      <input type="number" inputmode="numeric" step="1" min="0" class="set-reps" placeholder="reps" value="${reps}">
      <button class="secondary remove-set" type="button" aria-label="Remove set">×</button>
    `;
    row.querySelector(".set-weight").addEventListener("input", saveWorkoutDraft);
    row.querySelector(".set-reps").addEventListener("input", saveWorkoutDraft);
    row.querySelector(".remove-set").addEventListener("click", () => {
      const container = row.parentElement;
      row.remove();
      renumberSetsIn(container);
      saveWorkoutDraft();
    });
    return row;
  }

  function renumberSetsIn(container) {
    container.querySelectorAll(".set-row").forEach((row, i) => {
      row.querySelector(".set-num").textContent = i + 1;
    });
  }

  function readBlocks() {
    const blocks = [];
    document.querySelectorAll("#workout-body .exercise-block").forEach((b) => {
      const sets = [];
      b.querySelectorAll(".set-row").forEach((row) => {
        sets.push({
          weight: row.querySelector(".set-weight").value,
          reps: row.querySelector(".set-reps").value,
        });
      });
      blocks.push({ slug: b.dataset.slug, sets });
    });
    return blocks;
  }

  function renderIndividualPicker(presetSlug, presetSets) {
    const body = $("workout-body");
    body.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="field">
        <label for="individual-exercise">Exercise</label>
        <select id="individual-exercise"></select>
      </div>
    `;
    const sel = wrap.querySelector("#individual-exercise");
    for (const ex of exercises) {
      const o = document.createElement("option");
      o.value = ex.slug;
      o.textContent = ex.name;
      sel.appendChild(o);
    }
    if (presetSlug && exercises.some((e) => e.slug === presetSlug)) sel.value = presetSlug;
    body.appendChild(wrap);

    const block = exerciseBlock(sel.value, presetSets);
    body.appendChild(block);

    sel.addEventListener("change", () => {
      const newBlock = exerciseBlock(sel.value);
      block.replaceWith(newBlock);
      saveWorkoutDraft();
    });
  }

  function renderTemplateBody(templateSlug, draftBlocks) {
    const body = $("workout-body");
    body.innerHTML = "";
    const t = templates.find((x) => x.slug === templateSlug);
    if (!t) return;
    for (const slug of t.exercises) {
      const draftBlock = draftBlocks && draftBlocks.find((b) => b.slug === slug);
      body.appendChild(exerciseBlock(slug, draftBlock ? draftBlock.sets : null));
    }
  }

  function renderWorkoutBody(draft) {
    const mode = $("workout-mode").value;
    $("log-workout-wrap").classList.toggle("hidden", !mode);
    if (!mode) { $("workout-body").innerHTML = ""; return; }
    if (mode === "individual") {
      renderIndividualPicker(
        draft && draft.individual_exercise,
        draft && draft.blocks && draft.blocks[0] && draft.blocks[0].sets
      );
    } else if (mode.startsWith("template:")) {
      renderTemplateBody(mode.slice("template:".length), draft && draft.blocks);
    }
  }

  $("workout-mode").addEventListener("change", () => {
    renderWorkoutBody();
    saveWorkoutDraft();
  });
  $("workout-date").addEventListener("change", () => {
    // refresh last-session labels
    document.querySelectorAll(".exercise-block").forEach((b) => {
      const slug = b.dataset.slug;
      b.querySelector(".last-session").innerHTML = formatLastSession(slug, $("workout-date").value);
    });
    saveWorkoutDraft();
  });

  // ---------- draft persistence ----------

  function readWorkoutState() {
    const mode = $("workout-mode").value;
    const state = {
      date: $("workout-date").value,
      mode,
      blocks: readBlocks(),
      updated_at: new Date().toISOString(),
    };
    if (mode === "individual") {
      const sel = document.getElementById("individual-exercise");
      state.individual_exercise = sel ? sel.value : null;
    }
    return state;
  }

  function workoutHasContent(state) {
    return state.blocks.some((b) => b.sets.some((s) => s.weight || s.reps));
  }

  function saveWorkoutDraft() {
    const state = readWorkoutState();
    if (!state.mode || !workoutHasContent(state)) {
      localStorage.removeItem(WORKOUT_DRAFT_KEY);
      hideResumeBanner();
      return;
    }
    localStorage.setItem(WORKOUT_DRAFT_KEY, JSON.stringify(state));
  }

  function loadWorkoutDraft() {
    const raw = localStorage.getItem(WORKOUT_DRAFT_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function showResumeBanner(updatedAt) {
    const when = new Date(updatedAt);
    $("resume-text").textContent = `Resumed in-progress workout from ${when.toLocaleString()}.`;
    $("resume-banner").classList.remove("hidden");
  }
  function hideResumeBanner() { $("resume-banner").classList.add("hidden"); }

  $("discard-draft").addEventListener("click", () => {
    localStorage.removeItem(WORKOUT_DRAFT_KEY);
    $("workout-mode").value = "";
    renderWorkoutBody();
    hideResumeBanner();
  });

  // ---------- log workout ----------

  $("log-workout").addEventListener("click", async () => {
    const state = readWorkoutState();
    if (!state.mode) {
      $("workout-status").textContent = "Pick a workout first.";
      $("workout-status").className = "status err";
      return;
    }
    const lines = [];
    const exerciseSlugs = [];
    for (const block of state.blocks) {
      const slug = block.slug;
      const validSets = block.sets.filter((s) => s.weight !== "" && s.reps !== "");
      if (validSets.length === 0) continue;
      exerciseSlugs.push(slug);
      validSets.forEach((s, i) => {
        lines.push(`${state.date},${slug},${i + 1},${s.weight},${s.reps}`);
      });
    }
    if (lines.length === 0) {
      $("workout-status").textContent = "Add at least one complete set.";
      $("workout-status").className = "status err";
      return;
    }
    $("log-workout").disabled = true;
    $("workout-status").textContent = "Saving…";
    $("workout-status").className = "status";
    try {
      const msg = state.mode.startsWith("template:")
        ? `log workout ${state.date} ${state.mode.slice("template:".length)}`
        : `log workout ${state.date} ${exerciseSlugs.join(",")}`;
      await appendLines("data/workouts.csv", lines, msg);
      localStorage.removeItem(WORKOUT_DRAFT_KEY);
      hideResumeBanner();
      $("workout-status").textContent = `Logged ${lines.length} set${lines.length === 1 ? "" : "s"}.`;
      $("workout-status").className = "status ok";
      $("workout-mode").value = "";
      renderWorkoutBody();
      await loadWorkoutHistory();
    } catch (e) {
      $("workout-status").textContent = `Failed: ${e.message}`;
      $("workout-status").className = "status err";
    } finally {
      $("log-workout").disabled = false;
    }
  });

  // ---------- templates UI ----------

  function renderTemplatesList() {
    const el = $("templates-list");
    if (templates.length === 0) {
      el.innerHTML = `<span class="muted">No templates yet.</span>`;
      return;
    }
    el.innerHTML = templates.map((t) => {
      const exList = t.exercises.map(exerciseName).join(", ");
      return `<div class="entry"><strong>${t.name}</strong><div class="muted">${exList}</div></div>`;
    }).join("");
  }

  let newTemplatePicked = []; // [slug]

  function renderNewTemplatePicked() {
    const el = $("new-template-picked");
    if (newTemplatePicked.length === 0) {
      el.innerHTML = `<em>none yet</em>`;
      return;
    }
    el.innerHTML = newTemplatePicked.map((slug, i) =>
      `<div class="entry">${i + 1}. ${exerciseName(slug)} <button class="link-remove" data-i="${i}" type="button">remove</button></div>`
    ).join("");
    el.querySelectorAll(".link-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = parseInt(btn.dataset.i, 10);
        newTemplatePicked.splice(i, 1);
        renderNewTemplatePicked();
      });
    });
  }

  function renderNewTemplatePicker() {
    const sel = $("new-template-exercise-picker");
    sel.innerHTML = "";
    for (const ex of exercises) {
      const o = document.createElement("option");
      o.value = ex.slug;
      o.textContent = ex.name;
      sel.appendChild(o);
    }
  }

  $("manage-templates-btn").addEventListener("click", () => {
    newTemplatePicked = [];
    $("new-template-name").value = "";
    $("new-template-status").textContent = "";
    renderNewTemplatePicked();
    renderNewTemplatePicker();
    $("new-template-form").classList.remove("hidden");
  });
  $("cancel-template").addEventListener("click", () => {
    $("new-template-form").classList.add("hidden");
  });
  $("add-exercise-to-template").addEventListener("click", () => {
    const slug = $("new-template-exercise-picker").value;
    if (!slug) return;
    newTemplatePicked.push(slug);
    renderNewTemplatePicked();
  });
  $("save-template").addEventListener("click", async () => {
    const name = $("new-template-name").value.trim();
    if (!name) {
      $("new-template-status").textContent = "Name required.";
      $("new-template-status").className = "status err";
      return;
    }
    if (newTemplatePicked.length === 0) {
      $("new-template-status").textContent = "Pick at least one exercise.";
      $("new-template-status").className = "status err";
      return;
    }
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (templates.some((t) => t.slug === slug)) {
      $("new-template-status").textContent = "Template with that slug already exists.";
      $("new-template-status").className = "status err";
      return;
    }
    $("new-template-status").textContent = "Saving…";
    $("new-template-status").className = "status";
    try {
      const next = [...templates, { slug, name, exercises: [...newTemplatePicked] }];
      const yaml = jsyaml.dump(next);
      await writeFile("data/templates.yaml", yaml, `add template ${slug}`);
      await loadTemplates();
      renderTemplatesList();
      renderModePicker();
      $("new-template-form").classList.add("hidden");
      $("new-template-status").textContent = "";
    } catch (e) {
      $("new-template-status").textContent = `Failed: ${e.message}`;
      $("new-template-status").className = "status err";
    }
  });

  // ---------- exercises UI ----------

  $("add-exercise-btn").addEventListener("click", () => {
    $("add-exercise-form").classList.remove("hidden");
    $("new-exercise-name").focus();
  });
  $("cancel-add-exercise").addEventListener("click", () => {
    $("add-exercise-form").classList.add("hidden");
    $("new-exercise-name").value = "";
    $("add-exercise-status").textContent = "";
  });
  $("confirm-add-exercise").addEventListener("click", async () => {
    const name = $("new-exercise-name").value.trim();
    if (!name) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (exercises.some((e) => e.slug === slug)) {
      $("add-exercise-status").textContent = "Already exists.";
      $("add-exercise-status").className = "status err";
      return;
    }
    $("add-exercise-status").textContent = "Saving…";
    $("add-exercise-status").className = "status";
    try {
      const next = [...exercises, { slug, name }];
      const yaml = jsyaml.dump(next);
      await writeFile("data/exercises.yaml", yaml, `add exercise ${slug}`);
      await loadExercises();
      renderNewTemplatePicker();
      $("new-exercise-name").value = "";
      $("add-exercise-form").classList.add("hidden");
      $("add-exercise-status").textContent = "";
    } catch (e) {
      $("add-exercise-status").textContent = `Failed: ${e.message}`;
      $("add-exercise-status").className = "status err";
    }
  });

  // ---------- weight form ----------

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function saveWeightDraft() {
    const draft = {
      date: $("weight-date").value,
      value: $("weight-value").value,
      updated_at: new Date().toISOString(),
    };
    if (!draft.value) { localStorage.removeItem(WEIGHT_DRAFT_KEY); return; }
    localStorage.setItem(WEIGHT_DRAFT_KEY, JSON.stringify(draft));
  }
  function loadWeightDraft() {
    const raw = localStorage.getItem(WEIGHT_DRAFT_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  $("weight-date").addEventListener("change", saveWeightDraft);
  $("weight-value").addEventListener("input", saveWeightDraft);

  $("log-weight").addEventListener("click", async () => {
    const date = $("weight-date").value;
    const value = $("weight-value").value;
    if (!date || !value) {
      $("weight-status").textContent = "Date and weight required.";
      $("weight-status").className = "status err";
      return;
    }
    $("log-weight").disabled = true;
    $("weight-status").textContent = "Saving…";
    $("weight-status").className = "status";
    try {
      await appendLines("data/weight.csv", [`${date},${value}`], `log weight ${date}`);
      localStorage.removeItem(WEIGHT_DRAFT_KEY);
      $("weight-value").value = "";
      $("weight-status").textContent = "Logged.";
      $("weight-status").className = "status ok";
    } catch (e) {
      $("weight-status").textContent = `Failed: ${e.message}`;
      $("weight-status").className = "status err";
    } finally {
      $("log-weight").disabled = false;
    }
  });

  // ---------- init ----------

  async function init() {
    $("weight-date").value = todayISO();
    $("workout-date").value = todayISO();

    const wd = loadWeightDraft();
    if (wd) {
      if (wd.date) $("weight-date").value = wd.date;
      if (wd.value) $("weight-value").value = wd.value;
    }

    try {
      await Promise.all([loadExercises(), loadTemplates(), loadWorkoutHistory()]);
    } catch (e) {
      $("workout-status").textContent = `Failed to load data: ${e.message}`;
      $("workout-status").className = "status err";
      return;
    }

    renderModePicker();
    renderTemplatesList();
    renderNewTemplatePicker();

    const draft = loadWorkoutDraft();
    if (draft && draft.mode && workoutHasContent(draft)) {
      if (draft.date) $("workout-date").value = draft.date;
      $("workout-mode").value = draft.mode;
      renderWorkoutBody(draft);
      showResumeBanner(draft.updated_at);
    }
  }

  // ---------- boot ----------

  if (!cfg || cfg.OWNER === "YOUR_GITHUB_USERNAME") {
    document.querySelector("main").innerHTML =
      `<h1>liftlog</h1><div class="card"><p>Edit <code>config.js</code> and set <code>OWNER</code> and <code>REPO</code> before using the site.</p></div>`;
    return;
  }

  if (!getToken()) showSetup();
  else showApp();
})();
