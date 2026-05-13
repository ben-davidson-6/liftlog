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
    const url = `https://github.com/settings/personal-access-tokens/new?name=weight-log&target_name=${encodeURIComponent(cfg.OWNER)}&description=weight-log+commit+access`;
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
    if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
    const j = await r.json();
    return { sha: j.sha, content: b64decode(j.content) };
  }

  async function putFile(path, content, sha, message) {
    const r = await fetch(`${ghBase()}/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${getToken()}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        content: b64encode(content),
        sha,
        branch: cfg.BRANCH,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      const err = new Error(`PUT ${path}: ${r.status} ${body}`);
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
    try {
      return await tryOnce();
    } catch (e) {
      if (e.status === 409 || e.status === 422) return await tryOnce();
      throw e;
    }
  }

  async function replaceFile(path, content, message) {
    const tryOnce = async () => {
      const { sha } = await getFile(path);
      return putFile(path, content, sha, message);
    };
    try {
      return await tryOnce();
    } catch (e) {
      if (e.status === 409 || e.status === 422) return await tryOnce();
      throw e;
    }
  }

  // ---------- exercises ----------

  let exercises = []; // [{slug, name}]
  let exercisesSha = null;

  async function loadExercises() {
    const { sha, content } = await getFile("data/exercises.yaml");
    exercisesSha = sha;
    const parsed = jsyaml.load(content);
    exercises = Array.isArray(parsed) ? parsed : [];
  }

  function renderExerciseSelect() {
    const sel = $("exercise-select");
    sel.innerHTML = "";
    for (const ex of exercises) {
      const o = document.createElement("option");
      o.value = ex.slug;
      o.textContent = ex.name;
      sel.appendChild(o);
    }
  }

  function slugify(name) {
    return name.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

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
    const slug = slugify(name);
    if (exercises.some((e) => e.slug === slug)) {
      $("add-exercise-status").textContent = "An exercise with that slug already exists.";
      $("add-exercise-status").className = "status err";
      return;
    }
    $("add-exercise-status").textContent = "Saving…";
    $("add-exercise-status").className = "status";
    try {
      const next = [...exercises, { slug, name }];
      const yaml = jsyaml.dump(next);
      await replaceFile("data/exercises.yaml", yaml, `add exercise ${slug}`);
      await loadExercises();
      renderExerciseSelect();
      $("exercise-select").value = slug;
      saveWorkoutDraft();
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
    if (!draft.value) {
      localStorage.removeItem(WEIGHT_DRAFT_KEY);
      return;
    }
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
      refreshRecent();
    } catch (e) {
      $("weight-status").textContent = `Failed: ${e.message}`;
      $("weight-status").className = "status err";
    } finally {
      $("log-weight").disabled = false;
    }
  });

  // ---------- workout form ----------

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
      row.remove();
      renumberSets();
      saveWorkoutDraft();
    });
    return row;
  }

  function renumberSets() {
    document.querySelectorAll("#sets-container .set-row").forEach((row, i) => {
      row.querySelector(".set-num").textContent = i + 1;
    });
  }

  function addSetRow(weight = "", reps = "") {
    const container = $("sets-container");
    container.appendChild(makeSetRow(container.children.length, weight, reps));
  }

  function readSets() {
    const out = [];
    document.querySelectorAll("#sets-container .set-row").forEach((row) => {
      out.push({
        weight: row.querySelector(".set-weight").value,
        reps: row.querySelector(".set-reps").value,
      });
    });
    return out;
  }

  function saveWorkoutDraft() {
    const draft = {
      date: $("workout-date").value,
      exercise: $("exercise-select").value,
      sets: readSets(),
      updated_at: new Date().toISOString(),
    };
    const hasContent = draft.sets.some((s) => s.weight || s.reps);
    if (!hasContent) {
      localStorage.removeItem(WORKOUT_DRAFT_KEY);
      hideResumeBanner();
      return;
    }
    localStorage.setItem(WORKOUT_DRAFT_KEY, JSON.stringify(draft));
  }

  function loadWorkoutDraft() {
    const raw = localStorage.getItem(WORKOUT_DRAFT_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function hideResumeBanner() {
    $("resume-banner").classList.add("hidden");
  }

  function showResumeBanner(updatedAt) {
    const banner = $("resume-banner");
    const when = new Date(updatedAt);
    const text = `Resumed in-progress workout from ${when.toLocaleString()}.`;
    $("resume-text").textContent = text;
    banner.classList.remove("hidden");
  }

  $("discard-draft").addEventListener("click", () => {
    localStorage.removeItem(WORKOUT_DRAFT_KEY);
    $("sets-container").innerHTML = "";
    addSetRow();
    hideResumeBanner();
  });

  $("workout-date").addEventListener("change", saveWorkoutDraft);
  $("exercise-select").addEventListener("change", saveWorkoutDraft);
  $("add-set").addEventListener("click", () => {
    addSetRow();
    saveWorkoutDraft();
  });

  $("log-workout").addEventListener("click", async () => {
    const date = $("workout-date").value;
    const exercise = $("exercise-select").value;
    const sets = readSets().filter((s) => s.weight !== "" && s.reps !== "");
    if (!date || !exercise || sets.length === 0) {
      $("workout-status").textContent = "Date, exercise, and at least one complete set required.";
      $("workout-status").className = "status err";
      return;
    }
    const lines = sets.map((s, i) => `${date},${exercise},${i + 1},${s.weight},${s.reps}`);
    $("log-workout").disabled = true;
    $("workout-status").textContent = "Saving…";
    $("workout-status").className = "status";
    try {
      await appendLines("data/workouts.csv", lines, `log workout ${date} ${exercise}`);
      localStorage.removeItem(WORKOUT_DRAFT_KEY);
      $("sets-container").innerHTML = "";
      addSetRow();
      hideResumeBanner();
      $("workout-status").textContent = `Logged ${sets.length} set${sets.length === 1 ? "" : "s"}.`;
      $("workout-status").className = "status ok";
      refreshRecent();
    } catch (e) {
      $("workout-status").textContent = `Failed: ${e.message}`;
      $("workout-status").className = "status err";
    } finally {
      $("log-workout").disabled = false;
    }
  });

  // ---------- recent ----------

  async function refreshRecent() {
    const renderEntries = (el, lines) => {
      if (lines.length === 0) {
        el.innerHTML = `<span class="muted">No entries yet.</span>`;
        return;
      }
      el.innerHTML = lines.map((l) => `<div class="entry">${l}</div>`).join("");
    };

    try {
      const w = await getFile("data/weight.csv");
      const wLines = w.content.trim().split("\n").slice(1).reverse().slice(0, 10);
      renderEntries($("recent-weights"), wLines);
    } catch (e) {
      $("recent-weights").innerHTML = `<span class="muted">Error: ${e.message}</span>`;
    }
    try {
      const wo = await getFile("data/workouts.csv");
      const woLines = wo.content.trim().split("\n").slice(1).reverse().slice(0, 10);
      renderEntries($("recent-workouts"), woLines);
    } catch (e) {
      $("recent-workouts").innerHTML = `<span class="muted">Error: ${e.message}</span>`;
    }
  }

  $("refresh-recent").addEventListener("click", refreshRecent);

  // ---------- init ----------

  async function init() {
    $("weight-date").value = todayISO();
    $("workout-date").value = todayISO();

    // weight draft
    const wd = loadWeightDraft();
    if (wd) {
      if (wd.date) $("weight-date").value = wd.date;
      if (wd.value) $("weight-value").value = wd.value;
    }

    try {
      await loadExercises();
      renderExerciseSelect();
    } catch (e) {
      $("workout-status").textContent = `Failed to load exercises: ${e.message}`;
      $("workout-status").className = "status err";
    }

    // workout draft
    const draft = loadWorkoutDraft();
    $("sets-container").innerHTML = "";
    if (draft && draft.sets && draft.sets.some((s) => s.weight || s.reps)) {
      if (draft.date) $("workout-date").value = draft.date;
      if (draft.exercise && exercises.some((e) => e.slug === draft.exercise)) {
        $("exercise-select").value = draft.exercise;
      }
      for (const s of draft.sets) addSetRow(s.weight, s.reps);
      if (draft.sets.length === 0) addSetRow();
      showResumeBanner(draft.updated_at);
    } else {
      addSetRow();
    }

    refreshRecent();
  }

  // ---------- boot ----------

  if (!cfg || cfg.OWNER === "YOUR_GITHUB_USERNAME") {
    document.querySelector("main").innerHTML =
      `<h1>weight-log</h1><div class="card"><p>Edit <code>config.js</code> and set <code>OWNER</code> and <code>REPO</code> before using the site.</p></div>`;
    return;
  }

  if (!getToken()) {
    showSetup();
  } else {
    showApp();
  }
})();
