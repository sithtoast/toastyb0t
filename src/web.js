// Web dashboard: Discord login + a small JSON API the page in public/ talks to.
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import express from 'express';
import {
  ConfigError,
  DEFAULTS,
  LIMITS,
  applyConfig,
  channelProblem,
  getConfig,
  isPanelChannel,
  panelUrl,
  roleProblem,
} from './panel.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BOT_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
]).bitfield.toString();
const MANAGE_BITS = PermissionFlagsBits.ManageGuild | PermissionFlagsBits.Administrator;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function discordGet(path, accessToken) {
  const res = await fetch(`${DISCORD_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Discord ${path} returned ${res.status}`);
  return res.json();
}

/** Builds the Express app. Split from startWebServer so it can be exercised without listening. */
export function createApp(client, { publicUrl, clientSecret }) {
  const clientId = client.application.id;
  const redirectUri = `${publicUrl}/auth/callback`;
  const secureCookies = publicUrl.startsWith('https://');
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/' };

  // Sessions live in memory: a restart just means logging in again.
  const sessions = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.expires < now) sessions.delete(id);
  }, 60 * 60 * 1000).unref();

  function createSession(data) {
    const id = randomBytes(32).toString('hex');
    sessions.set(id, { ...data, expires: Date.now() + SESSION_TTL_MS });
    return id;
  }

  function inviteUrl(guildId) {
    const params = new URLSearchParams({
      client_id: clientId,
      scope: 'bot applications.commands',
      permissions: BOT_PERMISSIONS,
    });
    if (guildId) {
      params.set('guild_id', guildId);
      params.set('disable_guild_select', 'true');
    }
    return `https://discord.com/oauth2/authorize?${params}`;
  }

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    const sid = parseCookies(req.headers.cookie).sid;
    const session = sid && sessions.get(sid);
    if (session && session.expires > Date.now()) {
      req.session = session;
      req.sessionId = sid;
    }
    next();
  });

  // ---- Discord login ------------------------------------------------------

  app.get('/auth/login', (req, res) => {
    const state = randomBytes(16).toString('hex');
    res.cookie('oauth_state', state, { ...cookieOptions, maxAge: 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'identify guilds',
      state,
      prompt: 'none',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    const expected = parseCookies(req.headers.cookie).oauth_state;
    res.clearCookie('oauth_state', cookieOptions);
    if (!code || !state || state !== expected) return res.redirect('/?login=failed');

    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      console.warn('OAuth token exchange failed:', tokenRes.status, await tokenRes.text());
      return res.redirect('/?login=failed');
    }
    const { access_token: accessToken } = await tokenRes.json();
    const [user, guilds] = await Promise.all([
      discordGet('/users/@me', accessToken),
      discordGet('/users/@me/guilds', accessToken),
    ]);

    const sid = createSession({ accessToken, user, guilds });
    res.cookie('sid', sid, { ...cookieOptions, maxAge: SESSION_TTL_MS });
    res.redirect('/');
  });

  // ---- JSON API -----------------------------------------------------------

  const api = express.Router();
  api.use(express.json({ limit: '16kb' }));

  // Every API call needs a session. State-changing calls also need a custom
  // header, which a cross-site form or <img> can't send (basic CSRF guard).
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'toastyb0t') {
      return res.status(403).json({ error: 'Missing request header.' });
    }
    if (!req.session) return res.status(401).json({ error: 'Not logged in.' });
    next();
  });

  api.post('/logout', (req, res) => {
    sessions.delete(req.sessionId);
    res.clearCookie('sid', cookieOptions);
    res.json({ ok: true });
  });

  api.get('/me', async (req, res) => {
    const s = req.session;
    if (req.query.refresh) {
      try {
        s.guilds = await discordGet('/users/@me/guilds', s.accessToken);
      } catch (err) {
        console.warn('Guild refresh failed:', err.message);
      }
    }
    const manageable = s.guilds.filter((g) => g.owner || (BigInt(g.permissions) & MANAGE_BITS) !== 0n);
    res.json({
      user: { id: s.user.id, name: s.user.global_name ?? s.user.username, avatar: s.user.avatar },
      inviteUrl: inviteUrl(),
      guilds: manageable
        .map((g) => {
          const botIn = client.guilds.cache.has(g.id);
          return {
            id: g.id,
            name: g.name,
            icon: g.icon,
            botIn,
            configured: botIn && !!getConfig(g.id),
            inviteUrl: botIn ? null : inviteUrl(g.id),
          };
        })
        .sort((a, b) => b.botIn - a.botIn || a.name.localeCompare(b.name)),
    });
  });

  // Checks, live against Discord, that the logged-in user can manage this server.
  async function managedGuild(req, res) {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) {
      res.status(404).json({ error: 'The bot isn’t in that server.' });
      return null;
    }
    const member = await guild.members.fetch({ user: req.session.user.id, force: true }).catch(() => null);
    if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      res.status(403).json({ error: 'You need the Manage Server permission there.' });
      return null;
    }
    return guild;
  }

  function guildPayload(guild) {
    const config = getConfig(guild.id);
    const byPosition = (a, b) =>
      (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition;
    const channels = [...guild.channels.cache.values()].filter(isPanelChannel).sort(byPosition);

    const warnings = [];
    if (config) {
      const role = guild.roles.cache.get(config.roleId);
      const problem = role ? roleProblem(guild, role) : 'The verified role was deleted. Pick a new one.';
      if (problem) warnings.push(problem);
      if (!guild.channels.cache.has(config.panelChannelId)) warnings.push('The panel channel was deleted. Pick a new one.');
    }

    return {
      guild: { id: guild.id, name: guild.name, icon: guild.icon },
      botName: client.user.username,
      botAvatar: client.user.displayAvatarURL({ size: 64 }),
      botRoleName: guild.members.me.roles.highest.name,
      configured: !!config,
      config: config ?? { ...DEFAULTS, roleId: null, unverifiedRoleId: null, logChannelId: null, panelChannelId: null },
      panelUrl: panelUrl(guild.id, config),
      limits: LIMITS,
      warnings,
      channels: channels.map((c) => ({
        id: c.id,
        name: c.name,
        category: c.parent?.name ?? null,
        problem: channelProblem(guild, c),
        canLog:
          c.type === ChannelType.GuildText &&
          c.permissionsFor(guild.members.me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]),
      })),
      roles: [...guild.roles.cache.values()]
        .filter((r) => r.id !== guild.id && !r.managed)
        .sort((a, b) => b.position - a.position)
        .map((r) => ({ id: r.id, name: r.name, color: r.hexColor, problem: roleProblem(guild, r) })),
    };
  }

  api.get('/guilds/:guildId', async (req, res) => {
    const guild = await managedGuild(req, res);
    if (guild) res.json(guildPayload(guild));
  });

  api.put('/guilds/:guildId', async (req, res) => {
    const guild = await managedGuild(req, res);
    if (!guild) return;
    const b = req.body ?? {};
    try {
      await applyConfig(guild, {
        channelId: b.channelId,
        roleId: b.roleId,
        unverifiedRoleId: b.unverifiedRoleId || null,
        logChannelId: b.logChannelId || null,
        minAccountAgeDays: b.minAccountAgeDays,
        title: b.title,
        message: b.message,
        buttonLabel: b.buttonLabel,
      });
    } catch (err) {
      if (err instanceof ConfigError) return res.status(400).json({ error: err.message });
      throw err;
    }
    console.log(`[${guild.id}] Settings updated from the dashboard by ${req.session.user.id}.`);
    res.json(guildPayload(guild));
  });

  app.use('/api', api);
  app.use(express.static(PUBLIC_DIR));

  app.use((err, req, res, _next) => {
    console.error('Web request failed:', err);
    if (req.path.startsWith('/api/')) res.status(500).json({ error: 'Something went wrong. Check the bot’s console.' });
    else res.redirect('/?login=failed');
  });

  return { app, createSession };
}

export function startWebServer(client) {
  const port = Number(process.env.WEB_PORT) || 3000;
  const host = process.env.WEB_HOST || '127.0.0.1';
  const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const { app } = createApp(client, { publicUrl, clientSecret: process.env.DISCORD_CLIENT_SECRET });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, (err) => {
      if (err) return reject(err);
      console.log(`Dashboard running at ${publicUrl} (listening on ${host}:${port}).`);
      console.log(`  Make sure ${publicUrl}/auth/callback is listed under OAuth2 → Redirects in the developer portal.`);
      resolve({ url: publicUrl, server });
    });
    server.on('error', reject);
  });
}
