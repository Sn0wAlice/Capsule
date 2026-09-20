# Capsule

Self-hosted web app for managing and watching your video library. Organise your
libraries, share them with other users, and stream from any browser.

## Features

### Libraries
- Add local folders, videos are indexed automatically
- **Covers** — Cover thumbnail shown on the dashboard
- **Folder browsing** with a video count per folder
- **Grid and list views** with sorting by name, date, size or view count
- **"Unwatched" filter** — Show only videos you have never played
- **File watcher** — New files are picked up automatically
- **Duplicate detection** across libraries

### Video player
- Built-in player (ArtPlayer) that resumes where you left off
- **Autoplay** — Play through a library randomly or alphabetically
- **Persistent playback speed** — Kept between sessions
- **Multiple audio tracks** — Available tracks listed with language and codec
- Full keyboard shortcuts

### Organisation
- **Coloured tags** — 9 colours, central management, search by tag
- **Playlists** — Create and reorder with drag & drop
- **Smart playlists** — Generated from criteria (tag, duration, resolution, library)
- **Continuous playback** — "Play all" on any playlist
- **Favourites, watchlist and history** — Progress tracking with a "Continue watching" row

### Dashboard
- **Statistics** — Total videos, disk usage, total runtime
- **Continue watching** — In-progress videos with a progress bar
- Favourites, watchlist and recent history sections

### Multi-user
- Admin and user roles, library sharing (read / read+write)
- **Account creation** by an admin
- **Disable accounts** without deleting them
- **Last sign-in** visible in the admin panel
- **Force sign-out** for any user
- **Disk usage per library** in the admin panel
- Audit log of admin actions

### Under the hood
- **Thumbnails** — Generated automatically with ffmpeg
- **Separate worker** — ffmpeg runs in its own process
- **Dark interface** — Monochrome design system inspired by shadcn/ui
- **Docker ready** — Multi-arch image (amd64/arm64), GitHub Actions CI/CD
- Security: CSRF, rate limiting, path traversal protection

## Stack

- **Backend** — Node.js >= 20.19, Express 5, EJS 6
- **Database** — MySQL 8.4 (LTS)
- **Frontend** — Vanilla JS/CSS (in-house shadcn/ui-style design system, dark theme only), ArtPlayer 5
- **Infrastructure** — Docker (`node:24-alpine`), GitHub Actions, GHCR

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/sn0walice/capsule.git
cd capsule
cp .env.example .env
```

Edit `.env` with your own values:

```env
PORT=3000
DB_HOST=mysql
DB_PORT=3306
DB_USER=capsule
DB_PASSWORD=a_strong_password
DB_NAME=capsule
SESSION_SECRET=a_long_random_string
DISABLE_REGISTER=false
```

### 2. Start with Docker Compose

**Development (local build):**

```bash
docker compose up -d
```

**Production (pre-built image from GHCR):**

```bash
docker compose -f docker-compose.prod.yml up -d
```

The app is then available at `http://localhost:3000`.

### 3. First run

1. Open the app in your browser
2. Create an account — the **first user to register automatically becomes an admin**
3. Add a library, pointing it at a mounted folder (e.g. `/media/movies`)
4. Run a scan to index the videos

## Upgrading from a version older than 1.1.0

Version 1.1.0 moves the MySQL image from `8.0` (end of life) to `8.4` (LTS).
MySQL migrates the data volume automatically on first start, but **this change is
not reversible**: going back to `mysql:8.0` on the same volume will fail.

Back the database up before `docker compose pull && docker compose up -d`:

```bash
docker compose exec mysql mysqldump -u root -p"$DB_PASSWORD" --all-databases > capsule-backup.sql
```

To stay on MySQL 8.0, replace `image: mysql:8.4` with `image: mysql:8.0` in your
`docker-compose.yml` — the app still works with it.

## Volumes

| Container path | Description |
|---|---|
| `/media` | Mount point for your video files |
| `/var/lib/mysql` | MySQL data (Docker volume) |

Mount the **same volumes** on the `app` and `worker` containers. The worker needs
access to the files to generate thumbnails.

Mount as many folders as you need, then add them as libraries in the UI:

```yaml
volumes:
  - /local/path/movies:/media/movies
  - /local/path/shows:/media/shows
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Application port | `3000` |
| `DB_HOST` | MySQL host | `mysql` |
| `DB_PORT` | MySQL port | `3306` |
| `DB_USER` | MySQL user | `capsule` |
| `DB_PASSWORD` | MySQL password | — |
| `DB_NAME` | Database name | `capsule` |
| `SESSION_SECRET` | Session signing secret | — |
| `DISABLE_REGISTER` | Disable self-registration | `false` |
| `MEDIA_PATH` | Local media path (compose) | `./media` |
| `WORKER_CONCURRENCY` | Parallel ffmpeg jobs (worker) | `2` |
| `WORKER_POLL_INTERVAL` | Worker poll interval (ms) | `3000` |
| `DB_POOL_SIZE` | MySQL connection pool size | `30` |
| `NODE_ENV` | `production` marks the session cookie `Secure` (requires HTTPS) | — |

## CI/CD

The GitHub Actions workflow (`.github/workflows/docker.yml`) runs the test suite,
then builds and pushes the Docker image to GHCR. The build is blocked if the tests
fail:

- **`test` job** — `npm ci` + `npm test` on Node 24
- **Push to `main`** — build and push tagged `latest` + commit SHA
- **Tag `v*`** — build and push with the version tag (e.g. `v1.0.0` → `1.0.0`, `1.0`)
- **Pull request** — build only (no push), verifies the image still compiles
- **Multi-arch** — `linux/amd64` and `linux/arm64`

The image is published at `ghcr.io/sn0walice/capsule`.

## Architecture

```
┌─────────┐     ┌─────────┐     ┌─────────┐
│   app   │────▶│  MySQL  │◀────│ worker  │
│  (web)  │     │         │     │ (ffmpeg)│
└─────────┘     └─────────┘     └─────────┘
```

- **app** — Express web server (scanning, streaming, API). Never calls ffmpeg.
- **worker** — Separate process that polls the `jobs` table and runs the ffmpeg
  work (thumbnails, sprites, metadata). If the worker crashes, the web server
  keeps serving.
- **MySQL** — Shared database. The `jobs` table is the queue between app and worker.

## Administration

The admin panel (`/admin`) lets you:

- Create user accounts
- List users with their last sign-in
- Change roles (admin/user)
- Enable and disable accounts
- Reset passwords
- Force a user to sign out
- See disk usage per library
- Monitor the ffmpeg job queue
- Read the audit log

## Library sharing

Each user can share their libraries with others:

- **Read** — Browse and stream videos
- **Read/Write** — Browse, stream, rename, tag and scan

## Keyboard shortcuts (player)

| Key | Action |
|---|---|
| `F` | Toggle favourite |
| `W` | Toggle watchlist |
| `N` | Next video |
| `L` | Fullscreen |
| `M` | Cycle autoplay mode |
| `T` | Add a tag |

## Licence

MIT
