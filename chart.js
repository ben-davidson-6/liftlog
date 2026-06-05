(() => {
  const cfg = window.WEIGHT_LOG_CONFIG;
  const $ = (id) => document.getElementById(id);

  function getToken() { return localStorage.getItem("gh_token"); }

  function b64decode(s) {
    return decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));
  }

  async function fetchFile(path) {
    const token = getToken();
    const headers = { Accept: "application/vnd.github+json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `https://api.github.com/repos/${cfg.OWNER}/${cfg.REPO}/contents/${path}?ref=${cfg.BRANCH}`;
    const r = await fetch(url, { headers, cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    const j = await r.json();
    return b64decode(j.content);
  }

  function parseCSV(text) {
    const lines = text.trim().split("\n");
    if (lines.length <= 1) return { header: [], rows: [] };
    const header = lines[0].split(",");
    const rows = lines.slice(1).filter((l) => l.trim()).map((l) => {
      const cells = l.split(",");
      const obj = {};
      header.forEach((h, i) => obj[h] = cells[i]);
      return obj;
    });
    return { header, rows };
  }

  const chartTextColor = () =>
    getComputedStyle(document.documentElement).getPropertyValue("--fg").trim() || "#1a1a1a";

  function baseOptions(yLabel) {
    const fg = chartTextColor();
    return {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: fg }, grid: { color: "rgba(128,128,128,0.15)" } },
        y: {
          ticks: { color: fg },
          grid: { color: "rgba(128,128,128,0.15)" },
          title: { display: true, text: yLabel, color: fg },
        },
      },
      plugins: {
        legend: { labels: { color: fg } },
      },
    };
  }

  // ---------- weight chart ----------

  // Trailing moving average over a window of calendar days. Using a date
  // window (rather than a fixed number of points) keeps the average honest
  // when there are gaps between weigh-ins.
  function trailingMovingAverage(dates, values, windowDays) {
    const MS_PER_DAY = 86400000;
    const ts = dates.map((d) => new Date(d + "T00:00:00").getTime());
    return values.map((_, i) => {
      const cutoff = ts[i] - (windowDays - 1) * MS_PER_DAY;
      let sum = 0, n = 0;
      for (let j = i; j >= 0 && ts[j] >= cutoff; j--) {
        if (Number.isFinite(values[j])) { sum += values[j]; n++; }
      }
      return n ? Math.round((sum / n) * 10) / 10 : null;
    });
  }

  async function renderWeight() {
    try {
      const text = await fetchFile("data/weight.csv");
      const { rows } = parseCSV(text);
      rows.sort((a, b) => a.date.localeCompare(b.date));
      const labels = rows.map((r) => r.date);
      const data = rows.map((r) => parseFloat(r.weight_kg));
      if (rows.length === 0) {
        $("weight-status").textContent = "No weight entries yet.";
        return;
      }
      const AVG_DAYS = 7;
      const avg = trailingMovingAverage(labels, data, AVG_DAYS);
      new Chart($("weight-chart"), {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: `${AVG_DAYS}-day average (kg)`,
              data: avg,
              borderColor: "#2563eb",
              backgroundColor: "rgba(37,99,235,0.1)",
              tension: 0.3,
              pointRadius: 0,
              borderWidth: 2.5,
              spanGaps: true,
            },
            {
              label: "Weight (kg)",
              data,
              borderColor: "rgba(37,99,235,0.35)",
              backgroundColor: "rgba(37,99,235,0.05)",
              tension: 0.2,
              pointRadius: 2,
              borderWidth: 1,
            },
          ],
        },
        options: baseOptions("kg"),
      });
    } catch (e) {
      $("weight-status").textContent = `Failed: ${e.message}`;
      $("weight-status").className = "status err";
    }
  }

  // ---------- exercise chart ----------

  let workoutRows = [];
  let exercisesByslug = {};
  let exerciseChart = null;

  async function loadWorkoutData() {
    const [woText, exText] = await Promise.all([
      fetchFile("data/workouts.csv"),
      fetchFile("data/exercises.yaml"),
    ]);
    workoutRows = parseCSV(woText).rows.map((r) => ({
      date: r.date,
      exercise: r.exercise,
      set_number: parseInt(r.set_number, 10),
      weight_kg: parseFloat(r.weight_kg),
      reps: parseInt(r.reps, 10),
    }));
    const list = jsyaml.load(exText) || [];
    exercisesByslug = {};
    for (const e of list) exercisesByslug[e.slug] = e.name;

    const picker = $("exercise-picker");
    picker.innerHTML = "";
    // only show exercises that have entries
    const slugs = [...new Set(workoutRows.map((r) => r.exercise))];
    if (slugs.length === 0) {
      $("exercise-status").textContent = "No workout entries yet.";
      return;
    }
    for (const slug of slugs) {
      const o = document.createElement("option");
      o.value = slug;
      o.textContent = exercisesByslug[slug] || slug;
      picker.appendChild(o);
    }
    renderExerciseChart();
  }

  function renderExerciseChart() {
    const slug = $("exercise-picker").value;
    const metric = $("metric-picker").value;
    if (!slug) return;

    const byDate = new Map();
    for (const r of workoutRows) {
      if (r.exercise !== slug) continue;
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    }
    const dates = [...byDate.keys()].sort();
    const epley = (w, r) => w * (1 + r / 30);
    const data = dates.map((d) => {
      const sets = byDate.get(d);
      if (metric === "top_weight") return Math.max(...sets.map((s) => s.weight_kg));
      if (metric === "e1rm") {
        const candidates = sets
          .filter((s) => s.weight_kg > 0 && s.reps > 0)
          .map((s) => epley(s.weight_kg, s.reps));
        if (candidates.length === 0) return null;
        return Math.round(Math.max(...candidates) * 10) / 10;
      }
      return sets.reduce((sum, s) => sum + s.weight_kg * s.reps, 0);
    });

    if (exerciseChart) exerciseChart.destroy();
    const label =
      metric === "top_weight" ? "Top-set weight (kg)" :
      metric === "e1rm" ? "Estimated 1RM (kg)" :
      "Volume (kg·reps)";
    const yUnit = metric === "volume" ? "kg·reps" : "kg";
    exerciseChart = new Chart($("exercise-chart"), {
      type: "line",
      data: {
        labels: dates,
        datasets: [{
          label: `${exercisesByslug[slug] || slug} — ${label}`,
          data,
          borderColor: "#15803d",
          backgroundColor: "rgba(21,128,61,0.1)",
          tension: 0.2,
          pointRadius: 3,
        }],
      },
      options: baseOptions(yUnit),
    });
  }

  $("exercise-picker").addEventListener("change", renderExerciseChart);
  $("metric-picker").addEventListener("change", renderExerciseChart);

  // ---------- boot ----------

  if (!cfg || cfg.OWNER === "YOUR_GITHUB_USERNAME") {
    document.querySelector("main").innerHTML =
      `<h1>Charts</h1><div class="card"><p>Edit <code>config.js</code> first.</p></div>`;
    return;
  }
  if (!getToken()) $("setup-msg").classList.remove("hidden");

  renderWeight();
  loadWorkoutData().catch((e) => {
    $("exercise-status").textContent = `Failed: ${e.message}`;
    $("exercise-status").className = "status err";
  });
})();
