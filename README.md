# toastyb0t

A small self-hosted Discord bot. New members click a button and get a role. That role unlocks the rest of the server.

- Free and self-hosted. It has two dependencies (`discord.js`, `express`) and needs no database.
- An optional web dashboard: log in with Discord, pick your server, and set everything up from dropdowns with a live preview.
- The button keeps working after the bot restarts.
- Optional: removes an "Unverified" role when someone verifies.
- Optional: turns away accounts younger than N days, which stops a lot of throwaway raid accounts.
- Optional: logs each verification to a channel you pick.
- Needs no privileged intents, so you don't have to turn anything on in the developer portal.

## 1. Create the bot (one time)

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy the token.
3. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: **Manage Roles**, **View Channels**, **Send Messages**, **Embed Links**
   - Open the generated URL and invite the bot to your server.

## 2. Run it

Requires Node.js 20.6 or newer.

```bash
npm install
cp .env.example .env     # then paste your token into .env
npm start
```

While testing, put your server's ID in `DEV_GUILD_ID` in `.env`. The `/verify` command then shows up instantly in that server. If you leave it blank, the command is registered globally.

## 3. Set up your server

**Role order matters.** In *Server Settings → Roles*, drag the bot's role **above** the role it hands out. Discord won't let a bot assign a role that sits above its own.

Then lock the server down so only verified members can chat:

1. Create a role, for example `Verified`.
2. For `@everyone`, turn off **View Channels** at the server level (*Roles → @everyone*). Or deny it on each category you want hidden.
3. Give `Verified` the **View Channels** permission, either server-wide or on those categories.
4. Make a `#verify` channel that `@everyone` **can** see but can't send messages in.
5. Run this in any channel:

   ```
   /verify setup channel:#verify role:@Verified
   ```

   Optional extras:

   | Option | What it does |
   |---|---|
   | `title`, `message`, `button_label` | Customize the panel. Use `\n` in `message` for line breaks. |
   | `unverified_role` | A role to **remove** on verify. Use this if you already auto-assign an "Unverified" role. |
   | `min_account_age_days` | Rejects accounts younger than this. `7` is a good choice against raids. |
   | `log_channel` | Posts a line for each verification or rejection. |

Running `/verify setup` again updates the panel in place. If you pick a different channel, the bot moves the panel there and deletes the old one. Options you leave out keep their current values.
`/verify status` shows the current settings and warns you if the role order is broken.

Only members with **Manage Server** can see or use `/verify`. You can change this under *Server Settings → Integrations*.

## Web dashboard (optional)

The dashboard is easier than the slash command. You pick channels and roles from dropdowns and see a live preview of the panel. Roles the bot can't hand out are greyed out with the reason. It runs inside the bot process, so there's nothing extra to host.

To turn it on:

1. In the developer portal, open **OAuth2**:
   - Copy the **Client Secret** (use **Reset Secret** if needed) into `DISCORD_CLIENT_SECRET` in `.env`.
   - Under **Redirects**, add `http://localhost:3000/auth/callback`. Use your `PUBLIC_URL` plus `/auth/callback` if you changed it.
2. Restart the bot, then open <http://localhost:3000>.

You log in with your own Discord account. The dashboard lists every server where you have **Manage Server**. For servers the bot isn't in yet, it shows an **Add bot** button. Each time you save, the bot checks with Discord that you still have Manage Server in that server.

**Making it reachable from other machines.** By default the dashboard only listens on this computer (`WEB_HOST=127.0.0.1`). To use it from elsewhere, put it behind a reverse proxy with HTTPS, such as Caddy, nginx or a Cloudflare Tunnel. Then set `PUBLIC_URL` to the public address, for example `https://verify.example.com`, and add the matching redirect in the portal. Don't expose it over plain HTTP on the internet: your login cookie would travel unencrypted.

Logins are kept in memory, so restarting the bot logs everyone out of the dashboard.

## Running with Docker

Each push to `main` publishes a prebuilt image for amd64 and arm64 (Raspberry Pi works too):

```
ghcr.io/sithtoast/toastyb0t:latest
```

On a server you only need `docker-compose.yml` and a filled-in `.env` next to it (see `.env.example`):

```bash
docker compose pull && docker compose up -d
```

- **Logs:** `docker compose logs -f`
- **Stop:** `docker compose down`
- **Update to the newest image:** run `docker compose pull && docker compose up -d` again.
- **Pin a version:** push a git tag like `v1.0.0`, then set `TOASTYB0T_TAG=1.0.0`.
- **Run your local code:** `docker build -t ghcr.io/sithtoast/toastyb0t:dev . && TOASTYB0T_TAG=dev docker compose up -d`

How the container is set up:

- **Settings** live in the `toastyb0t_data` Docker volume, so they survive updates and `down`/`up`. `docker compose down -v` would delete them.
- **The dashboard** is published on `127.0.0.1:3000` by default, so only this machine can reach it. Set `DASHBOARD_LISTEN=3000` to allow your network, or point a reverse proxy at it for HTTPS.
- **Security:** the bot runs as the unprivileged `node` user. Secrets are passed in as environment variables, never baked into the image.

To move over settings from running the bot without Docker:

```bash
docker compose cp data/config.json toastyb0t:/app/data/config.json && docker compose restart
```

## Running in Portainer

Use a **Stack** that pulls `docker-compose.yml` straight from GitHub, so Portainer stays in sync with the repo.

1. **Stacks → Add stack**, name it `toastyb0t`, and choose **Repository**.
2. Fill in the repository settings:
   - Repository URL: `https://github.com/sithtoast/toastyb0t`
   - Repository reference: `refs/heads/main`
   - Compose path: `docker-compose.yml`
   - Leave authentication off. The repo and image are public.
3. Under **Environment variables**, add:

   | Name | Value |
   |---|---|
   | `DISCORD_TOKEN` | your bot token (required) |
   | `DISCORD_CLIENT_SECRET` | your OAuth2 client secret (turns on the dashboard) |
   | `PUBLIC_URL` | the address you open the dashboard at, e.g. `https://toasty.example.com` or `http://192.168.1.20:3000` |
   | `DASHBOARD_LISTEN` | `3000` to reach the dashboard from your network, or leave it out if a reverse proxy on the same host connects to it |

   In the developer portal, add `PUBLIC_URL` + `/auth/callback` under **OAuth2 → Redirects**. It must match exactly. If your site is served over HTTPS, `PUBLIC_URL` has to start with `https://` too, or Discord rejects the login as an invalid redirect. The bot logs a warning when the address people actually use doesn't match `PUBLIC_URL`.
4. **Deploy the stack.**

**Updating.** Open the stack and click **Pull and redeploy**, with **Re-pull image** turned on. Your settings in the `toastyb0t_data` volume are kept.

The stack's **GitOps updates** option redeploys only when the repo changes. The new image takes a few minutes to build after a push, so an automatic redeploy can pull the previous image. Redeploy by hand after the GitHub build finishes.

If you'd rather not link the repo, choose **Web editor** in step 1, paste in `docker-compose.yml`, and do steps 3–4 the same way.

## Hosting

The bot has to stay running for the button to respond. Some options:

- A home machine or Raspberry Pi, with Docker (above), `pm2` or a `systemd` service.
- A cheap VPS, or a free tier on a host such as Oracle Cloud, Fly.io or Railway.

Settings are stored in `data/config.json`. Keep that file when you move the bot.
