# Playback Atlas

A zero-backend Spotify listening-history analyzer. Spotify export JSON is read into DuckDB-WASM and queried entirely in browser workers. Users can rank tracks by play count or listening time, explore custom date ranges, and independently generate yearly or monthly Spotify playlists.

## Architecture

- Vite, React, TypeScript, Tailwind CSS, and Lucide icons
- DuckDB-WASM with all file reads, normalization, indexing, and SQL queries behind `src/workers/duckdb.worker.ts`
- Spotify Authorization Code Flow with PKCE using Web Crypto; no client secret
- Static GitHub Pages deployment via GitHub Actions
- No application server, analytics endpoint, database, or file upload

The worker accepts current Extended Streaming History fields (`ts`, `master_metadata_*`, `ms_played`, `spotify_track_uri`) and legacy streaming history fields (`endTime`, `artistName`, `trackName`, `msPlayed`). Legacy records do not include Spotify URIs or albums, so they can be analyzed but cannot be directly added to playlists.

## Prerequisites

- Node.js 22.12 or newer
- npm
- A Spotify developer account for playlist export

## Run Locally

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create local environment configuration:

   ```bash
   cp .env.example .env.local
   ```

3. Configure Spotify as described below, then start Vite:

   ```bash
   npm run dev
   ```

4. Open `http://127.0.0.1:5174/`. The development server listens on all interfaces so it also works through an SSH tunnel.

For development on a remote machine, create the tunnel from your local computer:

```bash
ssh -L 5174:127.0.0.1:5174 USER@REMOTE_HOST
```

Run `npm run dev` inside that SSH session, then open `http://127.0.0.1:5174/` in your local browser. Keep the tunnel open while using the app. The Spotify redirect URI should remain `http://127.0.0.1:5174/` so the callback returns through the same tunnel.

Playlist export is optional. History ingestion and analytics work without Spotify configuration.

## Spotify App Setup

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Copy its Client ID into `VITE_SPOTIFY_CLIENT_ID`. Do not create or expose a client secret.
3. Add `http://127.0.0.1:5174/` under the app's Redirect URIs for local development.
4. Set `VITE_SPOTIFY_REDIRECT_URI=http://127.0.0.1:5174/` in `.env.local`. The value must match the dashboard entry exactly, including the trailing slash.
5. Add your Spotify account under the app's user access settings if the app remains in development mode.

The app requests only `playlist-modify-public playlist-modify-private`. The PKCE verifier and OAuth state are generated with Web Crypto. The access/refresh token is retained in browser storage with its expiration time and refreshed directly against Spotify when necessary. Disconnecting removes the stored token.

## Spotify Export Data

Request **Extended streaming history** from Spotify's account privacy/download page. Select all relevant `Streaming_History_Audio_*.json` or `endsong_*.json` files at once. Processing large archives can take time, but parsing and SQL execution occur off the UI thread.

The default 30-second minimum excludes likely skips. Change it to include shorter plays. Playlist export ignores null URIs, podcast episodes, local files, and duplicate track URIs.

After a valid import, the original JSON files are cached in browser IndexedDB. This lets the app rebuild its in-memory DuckDB tables automatically after a reload or Spotify OAuth redirect. Use **Clear cache** to keep the current session but remove the persisted files, or **Replace files** to remove them and return to the uploader. The cache is never sent to the application or any other server.

Playlist generation has its own filters and does not use the overview's date range or ranking metric. The playlist workshop supports a selected year's Top 50, 100, 250, or 500 tracks, or separate Top 50 playlists for any selected months across multiple years. Monthly playlists use names such as `2025 — January`. Spotify's Web API cannot create playlist folders, so the year prefix keeps monthly sets grouped when sorted by name.

## Insights

The independent **Insights** tab aggregates chart data in the DuckDB worker and defaults to the full archive. It includes:

- Summary totals for plays, listening time, unique tracks, and unique artists
- Listening volume with day, week, and month grouping plus plays/time toggles
- A browser-local weekday/hour activity heatmap
- First-ever track plays versus repeat listening
- Top 10 artist share, rank, and total views
- Linked timeline selections that open the matching overview ranking
- CSV and JSON exports of the current Insights result

Core Insights work without Spotify authentication. When Spotify is connected, the app optionally enriches the top 100 tracks in the selected Insights range with artist genres, track duration, popularity, and release era. Up to 500 enriched track records are cached in local browser storage to reduce repeated Spotify API requests.

## Generate Realistic Test History

The local generator fetches real track names, artists, albums, durations, and playable `spotify:track:` URIs from Spotify. It wraps them in synthetic Extended Streaming History records spread evenly across a calendar year. Timestamps and playback behavior are synthetic; the catalog metadata is real.

Use the Client ID and Client Secret from a Spotify developer app as command-scoped environment variables:

```bash
SPOTIFY_CLIENT_ID=your_client_id \
SPOTIFY_CLIENT_SECRET=your_client_secret \
npm run generate:test-history -- --year 2025
```

This writes 100 unique records to:

```text
test-data/Streaming_History_Audio_Test.json
```

Upload that file through the normal interface. Its real track URIs also allow end-to-end playlist export testing. Never use a `VITE_*` variable for the Client Secret and never commit the secret; command-scoped values are available only to this Node.js process.

Generator options:

```bash
npm run generate:test-history -- --year 2024 --count 100 --output test-data/custom.json
npm run generate:test-history -- --help
```

You can alternatively supply a current Spotify access token as `SPOTIFY_ACCESS_TOKEN`, in which case a Client Secret is not needed.

## Deploy to GitHub Pages

1. Push the repository to GitHub with `main` as the deployment branch.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. In **Settings → Secrets and variables → Actions → Variables**, create `SPOTIFY_CLIENT_ID` with the public Spotify Client ID.
4. Add the production callback to the Spotify dashboard:

   ```text
   https://YOUR_USERNAME.github.io/YOUR_REPOSITORY/
   ```

5. Push to `main` or run the **Deploy to GitHub Pages** workflow manually.

The workflow sets `VITE_BASE_PATH` to `/<repository>/` and builds the matching Spotify redirect URI automatically. For a user/organization Pages repository named `USERNAME.github.io`, change `VITE_BASE_PATH` and `VITE_SPOTIFY_REDIRECT_URI` in `.github/workflows/deploy.yml` to `/` and `https://USERNAME.github.io/` respectively.

Vite environment variables are compiled into public browser assets. A Spotify Client ID is intentionally public; never put a client secret in this project or in any `VITE_*` variable.

## Commands

```bash
npm run dev      # development server
npm run build    # type-check and production build
npm run preview  # serve the production build locally
npm run lint     # ESLint
npm run generate:test-history -- --year 2025
```

## Privacy and Limits

- Imported history files persist locally in browser IndexedDB until **Clear cache** or **Replace files** is used. DuckDB tables and query results remain in memory and are rebuilt locally after reload.
- Visible Spotify track IDs are sent to Spotify's public oEmbed endpoint to retrieve album artwork. Playlist data and authenticated API requests are sent only when the user connects.
- Spotify-enriched Insights metadata is cached locally in the browser and can be removed by clearing site data.
- Tokens in browser storage are accessible to JavaScript on this origin. The app avoids third-party runtime scripts, but normal client-side security practices and dependency review still apply.
- DuckDB's WASM binary is about 40 MB uncompressed and is cached by the browser after first load.
