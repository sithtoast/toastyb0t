// Shared verification-panel logic, used by both the /verify command and the web dashboard.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { getGuild, setGuild } from './store.js';

export const VERIFY_BUTTON_ID = 'verify:button';

export const DEFAULTS = {
  title: 'Verification',
  message: 'Welcome! Please read the rules, then click the button below to get access to the rest of the server.',
  buttonLabel: 'Verify',
  minAccountAgeDays: 0,
};

export const LIMITS = { title: 256, message: 2000, buttonLabel: 80, minAccountAgeDays: 365 };

const PANEL_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const POST_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
];

/** An error whose message is safe to show to the person configuring the bot. */
export class ConfigError extends Error {}

/** Returns a reason string if the bot can't assign this role, otherwise null. */
export function roleProblem(guild, role) {
  const me = guild.members.me;
  if (role.id === guild.id) return 'You can’t use @everyone here.';
  if (role.managed) return `“${role.name}” is managed by an integration and can’t be assigned.`;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return 'The bot needs the Manage Roles permission.';
  }
  if (role.comparePositionTo(me.roles.highest) >= 0) {
    return `“${role.name}” is above (or equal to) the bot’s highest role. In Server Settings → Roles, drag the bot’s role above it.`;
  }
  return null;
}

/** Returns a reason string if the bot can't post the panel in this channel, otherwise null. */
export function channelProblem(guild, channel) {
  if (!PANEL_CHANNEL_TYPES.includes(channel.type)) return `#${channel.name} isn’t a text channel.`;
  if (!channel.permissionsFor(guild.members.me).has(POST_PERMISSIONS)) {
    return `The bot needs View Channel, Send Messages and Embed Links in #${channel.name}.`;
  }
  return null;
}

export function isPanelChannel(channel) {
  return PANEL_CHANNEL_TYPES.includes(channel.type);
}

/** The guild's saved settings with defaults filled in, or null if never set up. */
export function getConfig(guildId) {
  const saved = getGuild(guildId);
  return saved && { ...DEFAULTS, ...saved };
}

export function buildPanel({ title, message, buttonLabel }) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(message);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(VERIFY_BUTTON_ID)
      .setLabel(buttonLabel)
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
  );
  return { embeds: [embed], components: [row] };
}

function cleanText(value, field) {
  const text = String(value ?? '').trim() || DEFAULTS[field];
  if (text.length > LIMITS[field]) throw new ConfigError(`${field} must be ${LIMITS[field]} characters or fewer.`);
  return text;
}

/**
 * Validates settings, posts or updates the panel message, and saves.
 * If the panel channel is unchanged the existing message is edited in place;
 * otherwise a new panel is posted and the old one is deleted.
 */
export async function applyConfig(guild, input) {
  const channel = guild.channels.cache.get(input.channelId);
  if (!channel) throw new ConfigError('Pick a channel for the verification panel.');
  const channelIssue = channelProblem(guild, channel);
  if (channelIssue) throw new ConfigError(channelIssue);

  const role = guild.roles.cache.get(input.roleId);
  if (!role) throw new ConfigError('Pick a role to give verified members.');
  const roleIssue = roleProblem(guild, role);
  if (roleIssue) throw new ConfigError(roleIssue);

  let unverifiedRole = null;
  if (input.unverifiedRoleId) {
    unverifiedRole = guild.roles.cache.get(input.unverifiedRoleId);
    if (!unverifiedRole) throw new ConfigError('The unverified role no longer exists.');
    if (unverifiedRole.id === role.id) throw new ConfigError('The unverified role must be different from the verified role.');
    const issue = roleProblem(guild, unverifiedRole);
    if (issue) throw new ConfigError(issue);
  }

  let logChannel = null;
  if (input.logChannelId) {
    logChannel = guild.channels.cache.get(input.logChannelId);
    if (!logChannel?.isTextBased()) throw new ConfigError('The log channel no longer exists.');
    if (!logChannel.permissionsFor(guild.members.me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      throw new ConfigError(`The bot needs View Channel and Send Messages in #${logChannel.name} to log there.`);
    }
  }

  const minAccountAgeDays = Number(input.minAccountAgeDays ?? 0);
  if (!Number.isInteger(minAccountAgeDays) || minAccountAgeDays < 0 || minAccountAgeDays > LIMITS.minAccountAgeDays) {
    throw new ConfigError(`Minimum account age must be a whole number from 0 to ${LIMITS.minAccountAgeDays}.`);
  }

  const panelText = {
    title: cleanText(input.title, 'title'),
    message: cleanText(input.message, 'message'),
    buttonLabel: cleanText(input.buttonLabel, 'buttonLabel'),
  };
  const panel = buildPanel(panelText);

  const previous = getGuild(guild.id);
  let panelMessage = null;
  if (previous?.panelChannelId === channel.id && previous.panelMessageId) {
    panelMessage = await channel.messages.edit(previous.panelMessageId, panel).catch(() => null);
  }
  if (!panelMessage) {
    panelMessage = await channel.send(panel);
    if (previous?.panelChannelId && previous.panelMessageId) {
      const oldChannel = guild.channels.cache.get(previous.panelChannelId);
      await oldChannel?.messages.delete(previous.panelMessageId).catch(() => {});
    }
  }

  return {
    ...DEFAULTS,
    ...setGuild(guild.id, {
      ...panelText,
      roleId: role.id,
      unverifiedRoleId: unverifiedRole?.id ?? null,
      minAccountAgeDays,
      logChannelId: logChannel?.id ?? null,
      panelChannelId: channel.id,
      panelMessageId: panelMessage.id,
    }),
  };
}

export function panelUrl(guildId, config) {
  return config?.panelMessageId
    ? `https://discord.com/channels/${guildId}/${config.panelChannelId}/${config.panelMessageId}`
    : null;
}
