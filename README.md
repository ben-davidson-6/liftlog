# weight-log

Personal weight & workout logger. Static site, deployed to GitHub Pages. Data lives in this repo as CSV — git is the database.

## Setup

1. Push this repo to GitHub.
2. Edit `config.js` and set `OWNER` and `REPO` to match.
3. GitHub repo → Settings → Pages → Source: Deploy from branch `main` / root.
4. Mint a fine-grained Personal Access Token:
   - github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   - Resource owner: you. Repository access: Only select repositories → this repo.
   - Permissions: Repository permissions → **Contents: Read and write**.
   - Set an expiry, generate, copy the token.
5. Open `https://<you>.github.io/<repo>/`, paste the token into the setup panel. It's saved to `localStorage` on this device only.

## Data files

- `data/weight.csv` — one row per measurement: `date,weight_kg`.
- `data/workouts.csv` — one row per *set*: `date,exercise,set_number,weight_kg,reps`. `exercise` is a slug from `exercises.yaml`.
- `data/exercises.yaml` — curated list of exercises.

Edit these files directly on github.com if you ever need to fix typos.

## Pages

- `index.html` — daily log (weight + workout forms).
- `charts.html` — time-series charts.
