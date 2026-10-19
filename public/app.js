// toastyb0t: a tiny hash-routed page. All text from Discord is inserted
// with textContent (never innerHTML), so server or role names can't inject markup.

const app = document.getElementById('app');
const accountEl = document.getElementById('account');
const toastEl = document.getElementById('toast');

let me = null;
let dirty = false;

// ---- helpers ---------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Replaces the main view; accepts nested arrays and skips false/null.
function render(...children) {
  app.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'toastyb0t', ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    me = null;
    renderLogin();
    throw new Error('Not logged in.');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 3500);
}

function guildIcon(guild, large = false) {
  const cls = `server-icon${large ? ' lg' : ''}`;
  if (guild.icon) {
    return h('img', {
      class: cls,
      src: `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=96`,
      alt: '',
      width: large ? 52 : 48,
      height: large ? 52 : 48,
    });
  }
  const initials = guild.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3);
  return h('div', { class: cls, 'aria-hidden': 'true' }, initials);
}

function userAvatarUrl(user) {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
}

function renderAccount() {
  accountEl.replaceChildren();
  if (!me) return;
  accountEl.append(
    h('img', { class: 'avatar', src: userAvatarUrl(me.user), alt: '', width: 28, height: 28 }),
    h('span', { class: 'name' }, me.user.name),
    h('button', { class: 'btn ghost', type: 'button', onclick: logout }, 'Log out'),
  );
}

async function logout() {
  await api('/logout', { method: 'POST' }).catch(() => {});
  me = null;
  renderAccount();
  renderLogin();
}

// ---- views -------------------------------------------------------------------

function renderLogin() {
  renderAccount();
  const failed = new URLSearchParams(location.search).has('login');
  render(
    h('div', { class: 'login' },
      h('div', { class: 'card' },
        h('img', { class: 'logo', src: 'favicon.svg', alt: '', width: 56, height: 56 }),
        h('h1', {}, 'toastyb0t'),
        h('p', { class: 'muted' }, 'Set up the verification button for your Discord servers. Log in with the Discord account you use to manage them.'),
        failed && h('div', { class: 'banner error' }, h('p', {}, 'Login didn’t complete. Please try again.')),
        h('a', { class: 'btn big', href: '/auth/login' }, 'Log in with Discord'),
      ),
    ),
  );
}

async function renderServers(refresh = false) {
  if (refresh) me = await api('/me?refresh=1');
  const withBot = me.guilds.filter((g) => g.botIn);
  const withoutBot = me.guilds.filter((g) => !g.botIn);

  // Every card is one link: servers with the bot open their settings,
  // servers without it open Discord's invite page in a new tab.
  const card = (g) =>
    g.botIn
      ? h('a', { class: 'server', href: `#/guild/${g.id}`, title: g.name },
          guildIcon(g),
          h('div', { class: 'info' },
            h('div', { class: 'title' }, g.name),
            g.configured
              ? h('div', { class: 'status ok' }, 'Verification on')
              : h('div', { class: 'status' }, 'Not set up yet'),
          ),
          h('span', { class: 'go', 'aria-hidden': 'true' }, '›'),
        )
      : h('a', { class: 'server pending', href: g.inviteUrl, target: '_blank', rel: 'noopener', title: g.name },
          guildIcon(g),
          h('div', { class: 'info' },
            h('div', { class: 'title' }, g.name),
            h('div', { class: 'status add' }, 'Add toastyb0t ↗'),
          ),
        );

  render(
    h('div', { class: 'page-head' },
      h('h1', {}, 'Your servers'),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn secondary',
        type: 'button',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          await renderServers(true).catch((err) => toast(err.message));
        },
      }, 'Refresh'),
    ),
    me.guilds.length === 0
      ? h('div', { class: 'card empty' },
          h('p', {}, 'You don’t manage any servers. You need the Manage Server permission to set up verification.'),
          h('a', { class: 'btn', href: me.inviteUrl, target: '_blank', rel: 'noopener' }, 'Add the bot to a server'),
        )
      : [
          withBot.length > 0 && h('div', { class: 'servers' }, withBot.map(card)),
          withoutBot.length > 0 && [
            h('div', { class: 'section-head' },
              h('h2', {}, 'Other servers you manage'),
              h('p', { class: 'muted small' }, 'toastyb0t isn’t in these yet. After you add it, press Refresh.'),
            ),
            h('div', { class: 'servers' }, withoutBot.map(card)),
          ],
        ],
  );
}

// `data` can be passed in (e.g. the response to a save) to skip the fetch.
async function renderGuild(guildId, data = null) {
  try {
    if (!data) {
      render(h('p', { class: 'muted center' }, 'Loading server…'));
      data = await api(`/guilds/${guildId}`);
    }
  } catch (err) {
    if (!me) return;
    render(
      h('div', { class: 'banner error' }, h('p', {}, err.message)),
      h('a', { href: '#/' }, '← Back to your servers'),
    );
    return;
  }

  const { config, limits } = data;
  const form = h('form', { novalidate: true });

  // --- form controls ---
  const channelSelect = h('select', { id: 'channel', name: 'channelId', required: true },
    h('option', { value: '' }, 'Choose a channel…'),
    groupByCategory(data.channels, (c) =>
      h('option', { value: c.id, disabled: !!c.problem && c.id !== config.panelChannelId },
        `#${c.name}${c.problem ? ' (bot can’t post here)' : ''}`),
    ),
  );
  const roleSelect = h('select', { id: 'role', name: 'roleId', required: true },
    h('option', { value: '' }, 'Choose a role…'),
    data.roles.map((r) =>
      h('option', { value: r.id, disabled: !!r.problem && r.id !== config.roleId },
        `@${r.name}${r.problem ? ' (above the bot’s role)' : ''}`),
    ),
  );
  const unverifiedSelect = h('select', { id: 'unverified', name: 'unverifiedRoleId' },
    h('option', { value: '' }, 'None'),
    data.roles.map((r) =>
      h('option', { value: r.id, disabled: !!r.problem && r.id !== config.unverifiedRoleId },
        `@${r.name}${r.problem ? ' (above the bot’s role)' : ''}`),
    ),
  );
  const logSelect = h('select', { id: 'log', name: 'logChannelId' },
    h('option', { value: '' }, 'Don’t log'),
    groupByCategory(data.channels.filter((c) => c.canLog || c.id === config.logChannelId), (c) =>
      h('option', { value: c.id }, `#${c.name}`),
    ),
  );
  const titleInput = h('input', { id: 'title', name: 'title', type: 'text', maxLength: limits.title, value: config.title });
  const messageInput = h('textarea', { id: 'message', name: 'message', maxLength: limits.message, rows: 5 });
  messageInput.value = config.message;
  const buttonInput = h('input', { id: 'button', name: 'buttonLabel', type: 'text', maxLength: limits.buttonLabel, value: config.buttonLabel });
  const ageInput = h('input', { id: 'age', name: 'minAccountAgeDays', type: 'number', min: 0, max: limits.minAccountAgeDays, step: 1, value: config.minAccountAgeDays });

  channelSelect.value = config.panelChannelId ?? '';
  roleSelect.value = config.roleId ?? '';
  unverifiedSelect.value = config.unverifiedRoleId ?? '';
  logSelect.value = config.logChannelId ?? '';

  const counter = (input, max) => {
    const el = h('span', { class: 'counter' });
    const update = () => {
      el.textContent = `${input.value.length}/${max}`;
      el.classList.toggle('over', input.value.length > max);
    };
    input.addEventListener('input', update);
    update();
    return el;
  };

  const field = (id, label, control, hint, extra) =>
    h('div', { class: 'field' },
      h('div', { class: 'label-row' }, h('label', { for: id }, label), extra),
      control,
      hint && h('div', { class: 'hint' }, hint),
    );

  form.append(
    h('section', { class: 'card' },
      h('h2', {}, 'Verification panel'),
      h('p', { class: 'muted' }, 'The message with the button that new members click.'),
      field('channel', 'Post in channel', channelSelect, 'Pick a channel that new members can see. If you change it, the bot posts a new panel there and deletes the old one.'),
      field('title', 'Title', titleInput, null, counter(titleInput, limits.title)),
      field('message', 'Message', messageInput, 'Discord formatting like **bold** works.', counter(messageInput, limits.message)),
      field('button', 'Button label', buttonInput, null, counter(buttonInput, limits.buttonLabel)),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Roles'),
      h('p', { class: 'muted' }, `The bot can only hand out roles below its own role (“${data.botRoleName}”). Drag it higher in Server Settings → Roles if a role you want is greyed out.`),
      field('role', 'Give this role when someone verifies', roleSelect, 'Give this role access to your channels, and hide them from @everyone.'),
      field('unverified', 'Remove this role when someone verifies', unverifiedSelect, 'Optional. Use this if another bot gives new members an “Unverified” role.'),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Protection & logging'),
      h('p', { class: 'muted' }, 'Optional extras.'),
      field('age', 'Minimum account age (days)', ageInput, 'Turns away Discord accounts younger than this. 0 turns it off. 7 is a good setting against raids.'),
      field('log', 'Log channel', logSelect, 'The bot posts a line here each time someone verifies or is turned away.'),
    ),
  );

  // --- live preview ---
  const pvTitle = h('div', { class: 'embed-title' });
  const pvDesc = h('div', { class: 'embed-desc' });
  const pvButton = h('span', {});
  const preview = h('div', { class: 'preview-col' },
    h('p', { class: 'preview-label' }, 'Preview'),
    h('div', { class: 'dc', 'aria-label': 'Preview of the verification message' },
      h('img', { class: 'avatar', src: data.botAvatar, alt: '', width: 40, height: 40 }),
      h('div', { class: 'body' },
        h('div', { class: 'author' }, data.botName, h('span', { class: 'tag' }, 'APP'), h('span', { class: 'time' }, 'Today')),
        h('div', { class: 'embed' }, pvTitle, pvDesc),
        h('div', { class: 'dc-button' }, h('span', { 'aria-hidden': 'true' }, '✅'), pvButton),
      ),
    ),
  );
  const updatePreview = () => {
    pvTitle.textContent = titleInput.value.trim() || 'Verification';
    pvDesc.textContent = messageInput.value.trim() || 'Welcome! Please read the rules, then click the button below to get access to the rest of the server.';
    pvButton.textContent = buttonInput.value.trim() || 'Verify';
  };
  updatePreview();

  // --- save bar ---
  const status = h('div', { class: 'status' });
  const saveBtn = h('button', { class: 'btn', type: 'submit' }, data.configured ? 'Save changes' : 'Save & post panel');
  const panelLink = h('a', { class: 'btn secondary', target: '_blank', rel: 'noopener', hidden: !data.panelUrl, href: data.panelUrl ?? '#' }, 'View panel in Discord');
  const savebar = h('div', { class: 'savebar' }, h('div', { class: 'inner' }, status, panelLink, saveBtn));
  form.append(savebar);

  const values = () => ({
    channelId: channelSelect.value,
    roleId: roleSelect.value,
    unverifiedRoleId: unverifiedSelect.value || null,
    logChannelId: logSelect.value || null,
    minAccountAgeDays: Number(ageInput.value || 0),
    title: titleInput.value,
    message: messageInput.value,
    buttonLabel: buttonInput.value,
  });
  const saved = JSON.stringify(values());
  const refreshState = () => {
    dirty = JSON.stringify(values()) !== saved;
    status.textContent = dirty ? 'You have unsaved changes.' : data.configured ? 'All changes saved.' : 'Not set up yet.';
    saveBtn.disabled = !dirty && data.configured;
  };
  form.addEventListener('input', () => { updatePreview(); refreshState(); });
  form.addEventListener('change', refreshState);
  refreshState();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!channelSelect.value) return channelSelect.focus(), toast('Pick a channel for the panel.');
    if (!roleSelect.value) return roleSelect.focus(), toast('Pick the role to give verified members.');
    saveBtn.disabled = true;
    status.textContent = 'Saving…';
    try {
      const next = await api(`/guilds/${guildId}`, { method: 'PUT', body: JSON.stringify(values()) });
      dirty = false;
      const g = me.guilds.find((x) => x.id === guildId);
      if (g) g.configured = true;
      toast(data.configured ? 'Saved. The panel in Discord is updated.' : 'Saved. The panel is posted in Discord.');
      renderGuild(guildId, next);
    } catch (err) {
      status.textContent = err.message;
      saveBtn.disabled = false;
    }
  });

  render(
    h('div', { class: 'page-head' },
      guildIcon(data.guild, true),
      h('div', {}, h('a', { href: '#/', class: 'small' }, '← All servers'), h('h1', {}, data.guild.name)),
    ),
    data.warnings.map((w) => h('div', { class: 'banner' }, h('span', { 'aria-hidden': 'true' }, '⚠️'), h('p', {}, w))),
    h('div', { class: 'config-grid' }, form, preview),
  );
}

function groupByCategory(channels, makeOption) {
  const groups = new Map();
  for (const c of channels) {
    const key = c.category ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return [...groups].map(([category, list]) =>
    category ? h('optgroup', { label: category }, list.map(makeOption)) : list.map(makeOption),
  );
}

// ---- router ------------------------------------------------------------------

async function route() {
  if (!me) {
    try {
      me = await api('/me');
    } catch {
      return; // api() already showed the login screen
    }
    renderAccount();
    if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  }
  const match = location.hash.match(/^#\/guild\/(\d+)$/);
  if (match) await renderGuild(match[1]);
  else await renderServers();
  window.scrollTo(0, 0);
}

let currentHash = location.hash;
window.addEventListener('hashchange', () => {
  if (dirty && !confirm('You have unsaved changes. Leave anyway?')) {
    history.replaceState(null, '', currentHash || location.pathname);
    return;
  }
  currentHash = location.hash;
  dirty = false;
  route();
});
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

route();
