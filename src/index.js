import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  ConfigError,
  LIMITS,
  VERIFY_BUTTON_ID,
  applyConfig,
  getConfig,
  panelUrl,
  roleProblem,
} from './panel.js';
import { startWebServer } from './web.js';

const DAY_MS = 24 * 60 * 60 * 1000;

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is not set. Put it in .env (see .env.example) or in your container\'s environment variables.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Slash command definition
// ---------------------------------------------------------------------------

const verifyCommand = new SlashCommandBuilder()
  .setName('verify')
  .setDescription('Configure the verification button')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Post (or update) the verification button. Options you leave out keep their current value.')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Channel to post the button in')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addRoleOption((o) =>
        o.setName('role').setDescription('Role to give when someone clicks the button').setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('title').setDescription('Panel title').setMaxLength(LIMITS.title),
      )
      .addStringOption((o) =>
        o
          .setName('message')
          .setDescription('Panel text (use \\n for new lines)')
          .setMaxLength(LIMITS.message),
      )
      .addStringOption((o) =>
        o.setName('button_label').setDescription('Text on the button').setMaxLength(LIMITS.buttonLabel),
      )
      .addRoleOption((o) =>
        o
          .setName('unverified_role')
          .setDescription('Optional role to REMOVE when someone verifies'),
      )
      .addIntegerOption((o) =>
        o
          .setName('min_account_age_days')
          .setDescription('Reject Discord accounts younger than this many days (0 = off)')
          .setMinValue(0)
          .setMaxValue(LIMITS.minAccountAgeDays),
      )
      .addChannelOption((o) =>
        o
          .setName('log_channel')
          .setDescription('Optional channel to log verifications to')
          .addChannelTypes(ChannelType.GuildText),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show the current verification settings'),
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function log(guild, config, text) {
  if (!config.logChannelId) return;
  try {
    const channel = await guild.channels.fetch(config.logChannelId);
    await channel?.send({ content: text, allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn(`[${guild.id}] Could not write to log channel:`, err.message);
  }
}

function dashboardLine(guildId) {
  return web ? `\nYou can also change these settings in the dashboard: ${web.url}/#/guild/${guildId}` : '';
}

// ---------------------------------------------------------------------------
// /verify setup and /verify status
// ---------------------------------------------------------------------------

async function handleSetup(interaction) {
  const { guild, options } = interaction;
  const previous = getConfig(guild.id) ?? {};

  let config;
  try {
    config = await applyConfig(guild, {
      ...previous,
      channelId: options.getChannel('channel', true).id,
      roleId: options.getRole('role', true).id,
      title: options.getString('title') ?? previous.title,
      message: options.getString('message')?.replaceAll('\\n', '\n') ?? previous.message,
      buttonLabel: options.getString('button_label') ?? previous.buttonLabel,
      unverifiedRoleId: options.getRole('unverified_role')?.id ?? previous.unverifiedRoleId,
      minAccountAgeDays: options.getInteger('min_account_age_days') ?? previous.minAccountAgeDays,
      logChannelId: options.getChannel('log_channel')?.id ?? previous.logChannelId,
    });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({
    content:
      `✅ Verification panel is live in <#${config.panelChannelId}>. Clicking it gives <@&${config.roleId}>` +
      (config.unverifiedRoleId ? ` and removes <@&${config.unverifiedRoleId}>` : '') +
      '.' +
      dashboardLine(guild.id),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleStatus(interaction) {
  const config = getConfig(interaction.guildId);
  if (!config) {
    return interaction.reply({
      content: 'Verification isn’t set up yet. Run `/verify setup`.' + dashboardLine(interaction.guildId),
      flags: MessageFlags.Ephemeral,
    });
  }
  const lines = [
    `**Verified role:** <@&${config.roleId}>`,
    `**Unverified role (removed):** ${config.unverifiedRoleId ? `<@&${config.unverifiedRoleId}>` : 'none'}`,
    `**Minimum account age:** ${config.minAccountAgeDays ? `${config.minAccountAgeDays} day(s)` : 'off'}`,
    `**Log channel:** ${config.logChannelId ? `<#${config.logChannelId}>` : 'none'}`,
    `**Panel:** ${panelUrl(interaction.guildId, config)}`,
  ];
  const role = interaction.guild.roles.cache.get(config.roleId);
  const problem = role ? roleProblem(interaction.guild, role) : 'The verified role no longer exists.';
  if (problem) lines.push('', `⚠️ ${problem}`);
  await interaction.reply({
    content: lines.join('\n') + dashboardLine(interaction.guildId),
    flags: MessageFlags.Ephemeral,
  });
}

// ---------------------------------------------------------------------------
// Button click
// ---------------------------------------------------------------------------

async function handleVerifyButton(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { guild, member, user } = interaction;

  const config = getConfig(guild.id);
  const role = config && guild.roles.cache.get(config.roleId);
  if (!role) {
    return interaction.editReply('Verification isn’t configured correctly here. Please let a moderator know.');
  }

  const unverifiedRole = config.unverifiedRoleId && guild.roles.cache.get(config.unverifiedRoleId);

  if (member.roles.cache.has(role.id)) {
    if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
      await member.roles.remove(unverifiedRole, 'Already verified').catch(() => {});
    }
    return interaction.editReply('You’re already verified. 👍');
  }

  if (config.minAccountAgeDays > 0) {
    const ageMs = Date.now() - user.createdTimestamp;
    if (ageMs < config.minAccountAgeDays * DAY_MS) {
      const readyAt = Math.floor((user.createdTimestamp + config.minAccountAgeDays * DAY_MS) / 1000);
      await log(guild, config, `⛔ ${user} (${user.tag}, \`${user.id}\`) was blocked: account is too new (created <t:${Math.floor(user.createdTimestamp / 1000)}:R>).`);
      return interaction.editReply(
        `Your Discord account is too new to verify here. You can try again <t:${readyAt}:R>.`,
      );
    }
  }

  try {
    await member.roles.add(role, 'Clicked the verification button');
    if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
      await member.roles.remove(unverifiedRole, 'Clicked the verification button');
    }
  } catch (err) {
    console.error(`[${guild.id}] Failed to update roles for ${user.id}:`, err);
    const problem = roleProblem(guild, role);
    await log(guild, config, `⚠️ Could not verify ${user} (\`${user.id}\`): ${problem ?? err.message}`);
    return interaction.editReply('Something went wrong giving you the role. Please let a moderator know.');
  }

  await log(guild, config, `✅ ${user} (${user.tag}, \`${user.id}\`) verified.`);
  await interaction.editReply(`You’re verified! You now have the **${role.name}** role. Welcome in.`);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// Only the Guilds intent is needed: clicks arrive as interactions, and role
// changes go through the REST API. No privileged intents required.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let web = null;

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag} — in ${c.guilds.cache.size} server(s).`);
  const devGuildId = process.env.DEV_GUILD_ID?.trim();
  if (devGuildId) {
    await c.application.commands.set([verifyCommand], devGuildId);
    console.log(`Registered /verify in guild ${devGuildId}.`);
  } else {
    await c.application.commands.set([verifyCommand]);
    console.log('Registered /verify globally.');
  }

  if (process.env.DISCORD_CLIENT_SECRET) {
    web = await startWebServer(c).catch((err) => {
      console.error(`Dashboard failed to start: ${err.message}`);
      return null;
    });
  } else {
    console.log('Web dashboard is off (set DISCORD_CLIENT_SECRET to turn it on).');
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inCachedGuild()) return;
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'verify') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'setup') await handleSetup(interaction);
      else if (sub === 'status') await handleStatus(interaction);
    } else if (interaction.isButton() && interaction.customId === VERIFY_BUTTON_ID) {
      await handleVerifyButton(interaction);
    }
  } catch (err) {
    console.error('Interaction failed:', err);
    const content = 'Something went wrong. Please try again.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.on(Events.Error, (err) => console.error('Client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// Docker, systemd and process managers send SIGTERM to stop the bot; Ctrl+C sends SIGINT.
async function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  web?.server.close();
  await client.destroy();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error(`Login failed: ${err.message} Check the DISCORD_TOKEN setting.`);
  process.exit(1);
});
