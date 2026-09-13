import {
  ActionRowBuilder,
  AttachmentBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Guild,
  Message,
  ModalActionRowComponentBuilder,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  WebhookClient,
} from "discord.js";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// 1. CONFIGURATION & CLIENT SETUP
// ============================================================================

const TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID || "658381489175658506";
const DATA_FILE = path.join(__dirname, "bot_data.json");

// Dedicated Channel IDs
const SECURITY_TERMINAL_CHANNEL_ID = "1547049689394978886"; // Security Check Terminal
const DASHBOARD_CHANNEL_ID = "1547034942784016475";        // Mission Control Dashboard
const RELAY_HUB_CHANNEL_ID = "1547037303543824384";        // Launcher Hub
const ARCHIVE_CONTAINER_ID = "1547041316175880223";        // Server Archive Category

// Master Passkey (Unlock & Deactivate)
const MASTER_PASSKEY = process.env.MASTER_PASSKEY || "ilovecock";

const WEBHOOK_URL =
  process.env.WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1546989479120867398/YliG1VZJG36E68hnBG5CqZE7SrCMgApn0mzk2R7Qy_EKuIKF4QZjpo8yxlQkRs600vkG";

if (!TOKEN) {
  console.error("FATAL: DISCORD_TOKEN is not defined in environment variables.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const auditWebhook = WEBHOOK_URL ? new WebhookClient({ url: WEBHOOK_URL }) : null;

// ============================================================================
// 2. AUDIT LOGGING (DIRECT DM TO OWNER + BACKUP WEBHOOK)
// ============================================================================

async function sendAuditLog(embed: EmbedBuilder, files: AttachmentBuilder[] = []) {
  // 1. Direct Message to Master Operator (658381489175658506)
  try {
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      await owner.send({ embeds: [embed], files }).catch((err) => {
        console.warn("Could not DM audit log to owner (check if DMs are open):", err.message);
      });
    }
  } catch (dmErr) {
    console.error("Failed to DM audit log to owner:", dmErr);
  }

  // 2. Backup transmit to webhook
  if (auditWebhook) {
    try {
      await auditWebhook.send({
        username: "Mission Control Audit",
        avatarURL: "https://i.imgur.com/4M34hi2.png",
        embeds: [embed],
        files,
      });
    } catch (err) {
      console.error("Failed to transmit to audit webhook:", err);
    }
  }
}

// ============================================================================
// 3. PERSISTENCE & DATA STRUCTURES
// ============================================================================

interface TranscriptEntry {
  author: string;
  authorId: string;
  content: string;
  timestamp: string;
  isOperator: boolean;
  attachments: string[];
}

interface BridgeSettings {
  realisticTyping: boolean;
  archiveEnabled: boolean;
  attachmentsEnabled: boolean;
  notificationsEnabled: boolean;
}

interface SerializedBridge {
  bridgeChannelId: string;
  targetChannelId: string;
  targetGuildId: string;
  targetGuildName: string;
  targetChannelName: string;
  bridgeType?: "channel" | "dm";
  targetUserId?: string;
  targetUserTag?: string;
  operatorGuildId?: string;
  isVoiceChat: boolean;
  operatorId: string;
  createdAt: number;
  settings?: BridgeSettings;
}

interface BotStorage {
  whitelist: string[];
  securityTerminalMessageId: string | null;
  dashboardMessageId: string | null;
  relayHubMessageId: string | null;
  sessionExpiresAt: number | null;
  bridges: SerializedBridge[];
  liveLoggingEnabled: boolean;
}

function loadStorage(): BotStorage {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      return {
        whitelist: Array.from(new Set([OWNER_ID, ...(parsed.whitelist || [])])),
        securityTerminalMessageId: parsed.securityTerminalMessageId || null,
        dashboardMessageId: parsed.dashboardMessageId || null,
        relayHubMessageId: parsed.relayHubMessageId || null,
        sessionExpiresAt: parsed.sessionExpiresAt || null,
        bridges: parsed.bridges || [],
        liveLoggingEnabled: parsed.liveLoggingEnabled ?? true,
      };
    }
  } catch (err) {
    console.error("Failed to load storage, initializing defaults:", err);
  }
  return {
    whitelist: [OWNER_ID],
    securityTerminalMessageId: null,
    dashboardMessageId: null,
    relayHubMessageId: null,
    sessionExpiresAt: null,
    bridges: [],
    liveLoggingEnabled: true,
  };
}

function saveStorage(data: BotStorage) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save storage:", err);
  }
}

const botData = loadStorage();
const whitelist = new Set<string>(botData.whitelist);

function isAuthorized(userId: string): boolean {
  return userId === OWNER_ID || whitelist.has(userId);
}

function isSessionActive(): boolean {
  if (!botData.sessionExpiresAt) return false;
  return Date.now() < botData.sessionExpiresAt;
}

interface BridgeSession extends SerializedBridge {
  messages: TranscriptEntry[];
  messageMap: Map<string, string>;
  realisticTyping: boolean;
  settings: BridgeSettings;
}

const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  realisticTyping: true,
  archiveEnabled: true,
  attachmentsEnabled: true,
  notificationsEnabled: true,
};

function getBridgeSettings(session: BridgeSession): BridgeSettings {
  session.settings ||= { ...DEFAULT_BRIDGE_SETTINGS, realisticTyping: session.realisticTyping };
  session.realisticTyping = session.settings.realisticTyping;
  return session.settings;
}

const activeBridges = new Map<string, BridgeSession>();

for (const b of botData.bridges) {
  activeBridges.set(b.bridgeChannelId, {
    ...b,
    bridgeType: b.bridgeType || "channel",
    messages: [],
    messageMap: new Map(),
    realisticTyping: b.settings?.realisticTyping ?? true,
    settings: { ...DEFAULT_BRIDGE_SETTINGS, ...(b.settings || {}) },
  });
}

function syncBridgesToDisk() {
  const list: SerializedBridge[] = [];
  for (const s of activeBridges.values()) {
    list.push({
      bridgeChannelId: s.bridgeChannelId,
      targetChannelId: s.targetChannelId,
      targetGuildId: s.targetGuildId,
      targetGuildName: s.targetGuildName,
      targetChannelName: s.targetChannelName,
      bridgeType: s.bridgeType || "channel",
      targetUserId: s.targetUserId,
      targetUserTag: s.targetUserTag,
      operatorGuildId: s.operatorGuildId,
      isVoiceChat: s.isVoiceChat,
      operatorId: s.operatorId,
      createdAt: s.createdAt,
      settings: { ...DEFAULT_BRIDGE_SETTINGS, ...s.settings, realisticTyping: s.settings?.realisticTyping ?? s.realisticTyping },
    });
  }
  botData.bridges = list;
  saveStorage(botData);
}

function calculateTypingDelay(text: string, hasAttachments: boolean): number {
  if (!text && hasAttachments) return 1200;
  const charCount = text.length;
  const baseDelay = Math.min(Math.max(charCount * 45, 1200), 4500);
  const variance = Math.floor(Math.random() * 400) - 200;
  return Math.max(baseDelay + variance, 800);
}

// ============================================================================
// 4. ARCHIVE REPOSITORIES & TACTICAL RATE-LIMIT SHIELD
// ============================================================================

function generateCleanTextTranscript(session: BridgeSession): string {
  const generatedAt = new Date().toISOString();
  const isDM = session.bridgeType === "dm";
  const settings = getBridgeSettings(session);
  const title = isDM
    ? `PRIVATE DM CONVERSATION — ${session.targetUserTag || session.targetUserId || "Unknown User"}`
    : `TRANSMISSION ARCHIVE — #${session.targetChannelName}`;

  let out = "=".repeat(88) + "\n";
  out += `${title}\n`;
  out += "=".repeat(88) + "\n\n";
  out += `Bridge Type: ${isDM ? "Discord DM" : (session.isVoiceChat ? "Voice Channel Text Chat" : "Text Channel")}\n`;
  out += `Operator: ${session.operatorId}\n`;
  out += `Bridge Channel ID: ${session.bridgeChannelId}\n`;
  out += `Created At: ${new Date(session.createdAt).toISOString()}\n`;
  out += `Generated At: ${generatedAt}\n`;
  out += `Message Count: ${session.messages.length}\n`;

  if (isDM) {
    out += `Target User: ${session.targetUserTag || "Unknown"}\n`;
    out += `Target User ID: ${session.targetUserId || "Unknown"}\n`;
  } else {
    out += `Target Server: ${session.targetGuildName} (${session.targetGuildId})\n`;
    out += `Target Channel: #${session.targetChannelName} (${session.targetChannelId})\n`;
  }

  out += "\nSETTINGS\n";
  out += `- Realistic typing: ${settings.realisticTyping ? "ON" : "OFF"}\n`;
  out += `- Archive on close: ${settings.archiveEnabled ? "ON" : "OFF"}\n`;
  out += `- Attachments: ${settings.attachmentsEnabled ? "ON" : "OFF"}\n`;
  out += `- Notifications: ${settings.notificationsEnabled ? "ON" : "OFF"}\n\n`;
  out += "=".repeat(88) + "\n\n";

  if (session.messages.length === 0) {
    out += "[No messages were exchanged during this session]\n";
    return out;
  }

  session.messages.forEach((msg, index) => {
    const role = msg.isOperator ? "OPERATOR" : "REMOTE USER";
    out += `[#${String(index + 1).padStart(3, "0")}] ${msg.timestamp} — ${role}\n`;
    out += `Author: ${msg.author} (${msg.authorId})\n`;
    out += `Message: ${msg.content || "<No text content>"}\n`;
    if (msg.attachments.length) {
      out += `Attachments (${msg.attachments.length}):\n`;
      msg.attachments.forEach((url, i) => {
        out += `  ${i + 1}. ${url}\n`;
      });
    }
    out += "-".repeat(88) + "\n";
  });

  return out;
}

function generateTranscriptJson(session: BridgeSession) {
  const settings = getBridgeSettings(session);
  return {
    format: "bridge-transcript-v2",
    generatedAt: new Date().toISOString(),
    bridge: {
      id: session.bridgeChannelId,
      type: session.bridgeType || "channel",
      createdAt: new Date(session.createdAt).toISOString(),
      operatorId: session.operatorId,
      operatorGuildId: session.operatorGuildId || null,
      target: session.bridgeType === "dm"
        ? { type: "dm", userId: session.targetUserId || null, userTag: session.targetUserTag || null }
        : { type: "channel", guildId: session.targetGuildId, guildName: session.targetGuildName, channelId: session.targetChannelId, channelName: session.targetChannelName, voice: session.isVoiceChat },
    },
    settings,
    messageCount: session.messages.length,
    messages: session.messages.map((msg, index) => ({
      index: index + 1,
      role: msg.isOperator ? "operator" : "remote",
      author: { tag: msg.author, id: msg.authorId },
      timestamp: msg.timestamp,
      content: msg.content,
      attachments: msg.attachments,
    })),
  };
}

function buildCleanInChatLogEmbed(session: BridgeSession): EmbedBuilder {
  const isDM = session.bridgeType === "dm";
  const channelType = isDM ? "💬 Private Discord DM" : (session.isVoiceChat ? "🔊 Voice Channel Text Chat" : "💬 Text Channel");

  let previewText = "";
  const recent = session.messages.slice(-15);

  for (const m of recent) {
    const icon = m.isOperator ? "🟢" : "👤";
    const authorName = m.isOperator ? `**${m.author} (Op)**` : `**${m.author}**`;
    const cleanContent = m.content ? m.content.replace(/[\n\r]+/g, " ") : "*[Attachment]*";
    previewText += `• \`${m.timestamp}\` ${icon} ${authorName}: ${cleanContent}\n`;
  }

  if (session.messages.length > 15) {
    previewText = `*... [${session.messages.length - 15} earlier messages in attached file] ...*\n` + previewText;
  }

  return new EmbedBuilder()
    .setTitle(`📁 ${session.bridgeType === "dm" ? "DM Archive" : "Session Archive"}: ${session.bridgeType === "dm" ? (session.targetUserTag || session.targetUserId || "Unknown User") : `#${session.targetChannelName}`}`)
    .setColor(session.isVoiceChat ? 0x57f287 : 0x5865f2)
    .setDescription(
      `${isDM ? `**Target User:** ${session.targetUserTag || "Unknown"} (\`${session.targetUserId || "Unknown"}\`)` : `**Server:** ${session.targetGuildName} (\`${session.targetGuildId}\`)`}\n` +
      `**Channel Type:** ${channelType}\n` +
      `**Total Messages:** \`${session.messages.length}\`\n\n` +
      `**Chat History:**\n${previewText || "*No messages exchanged.*"}`
    )
    .setFooter({ text: "Clean transcript attached below (.txt)" })
    .setTimestamp();
}

async function getOrCreateDMArchiveChannel(client: Client, operatorGuild: Guild): Promise<TextChannel | null> {
  try {
    const existing = operatorGuild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === "dm-archives"
    ) as TextChannel | undefined;
    if (existing) return existing;

    const hub = (await client.channels.fetch(RELAY_HUB_CHANNEL_ID).catch(() => null)) as TextChannel | null;
    const categoryId = hub?.parentId || undefined;

    const archiveChannel = await operatorGuild.channels.create({
      name: "dm-archives",
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: "Automatic archive repository for completed private DM bridge conversations.",
      permissionOverwrites: [
        { id: operatorGuild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: client.user!.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        },
        {
          id: OWNER_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
      ],
    });

    await archiveChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("📁 DM Archive Repository")
          .setDescription("Completed private DM bridge transcripts are automatically stored here.")
          .setColor(0x5865f2)
          .setTimestamp(),
      ],
    }).catch(() => null);

    return archiveChannel;
  } catch (err) {
    console.error("Failed to create DM archive channel:", err);
    return null;
  }
}

async function getOrCreateServerArchiveChannel(client: Client, targetGuild: Guild): Promise<TextChannel | null> {
  try {
    const container = await client.channels.fetch(ARCHIVE_CONTAINER_ID).catch(() => null);
    if (!container) return null;

    const hostGuild = "guild" in container ? container.guild : null;
    if (!hostGuild) return null;

    const categoryId = container.type === ChannelType.GuildCategory ? container.id : (container as TextChannel).parentId || undefined;
    const sanitizedName = `archive-${targetGuild.name.toLowerCase().replace(/[^a-z0-9-_]/g, "-").slice(0, 24)}`;

    let archiveChannel = hostGuild.channels.cache.find(
      (c) => c.isTextBased() && (c.topic?.includes(targetGuild.id) || c.name === sanitizedName)
    ) as TextChannel | undefined;

    if (archiveChannel) return archiveChannel;

    archiveChannel = await hostGuild.channels.create({
      name: sanitizedName,
      type: ChannelType.GuildText,
      parent: categoryId,
      topic: `24/7 Live Stream & Transcripts for: ${targetGuild.name} (ID: ${targetGuild.id})`,
    });

    return archiveChannel;
  } catch (err) {
    console.error("Failed to resolve server archive channel:", err);
    return null;
  }
}

// ----------------------------------------------------------------------------
// TACTICAL LOG QUEUE BUFFER (1.2s BATCHING SHIELD)
// ----------------------------------------------------------------------------

interface LogQueueItem {
  embed: EmbedBuilder;
}

const liveLogQueues = new Map<string, LogQueueItem[]>();
const liveLogTimers = new Map<string, NodeJS.Timeout>();

function queueLiveLog(guildId: string, embed: EmbedBuilder, targetGuild: Guild) {
  if (!botData.liveLoggingEnabled) return;

  if (!liveLogQueues.has(guildId)) {
    liveLogQueues.set(guildId, []);
  }

  const queue = liveLogQueues.get(guildId)!;
  queue.push({ embed });

  // Flush buffer every 1.2s to prevent rate limits
  if (!liveLogTimers.has(guildId)) {
    const timer = setTimeout(async () => {
      liveLogTimers.delete(guildId);
      const itemsToFlush = queue.splice(0, 5);
      if (itemsToFlush.length === 0) return;

      try {
        const archiveChannel = await getOrCreateServerArchiveChannel(client, targetGuild);
        if (archiveChannel) {
          const embeds = itemsToFlush.map((i) => i.embed);
          await archiveChannel.send({ embeds }).catch(() => null);
        }
      } catch (err) {
        console.error("Failed to flush live log queue:", err);
      }

      if (queue.length > 0) {
        queueLiveLog(guildId, queue.shift()!.embed, targetGuild);
      }
    }, 1200);

    liveLogTimers.set(guildId, timer);
  }
}

function formatAttachmentsSummary(attachments: Message["attachments"]): string {
  if (attachments.size === 0) return "";
  const lines: string[] = [];
  attachments.forEach((a) => {
    let typeEmoji = "📁";
    if (a.contentType?.startsWith("image/")) typeEmoji = "🖼️";
    else if (a.contentType?.startsWith("video/")) typeEmoji = "🎥";
    else if (a.contentType?.startsWith("audio/")) typeEmoji = "🎵";
    else if (a.contentType?.includes("pdf") || a.contentType?.includes("text")) typeEmoji = "📄";

    const sizeKb = (a.size / 1024).toFixed(1);
    lines.push(`• ${typeEmoji} [${a.name || "Attachment"}](${a.url}) (\`${sizeKb} KB\`)`);
  });
  return `\n\n**Attachments (${attachments.size}):**\n` + lines.join("\n");
}

// ============================================================================
// 5. CONTROL PANELS & IN-PLACE MORPHING
// ============================================================================

// A. SECURITY TERMINAL (Channel: 1547049689394978886)
function buildSecurityTerminalPayload() {
  const active = isSessionActive();

  if (!active) {
    const embed = new EmbedBuilder()
      .setTitle("🛡️ Security Access Terminal & Master Keygate")
      .setColor(0xed4245)
      .setDescription(
        "### 🔒 SYSTEM ACCESS: LOCKED (DEFCON 1)\n" +
        "All operational command decks, bridge transmitters, and telemetry systems are currently **offline and secured**.\n\n" +
        "Click the button below and enter the master passkey to grant **Level 5 Clearance** and boot up all systems for **24 Hours**."
      )
      .addFields(
        { name: "🛡️ Terminal Status", value: "`STANDBY / SECURE`", inline: true },
        { name: "⏱️ Session Duration", value: "`24 Hours upon Auth`", inline: true },
        { name: "🚨 Clearance Level", value: "`Restricted (Level 0)`", inline: true }
      )
      .setFooter({ text: "Authentication required to enable Mission Control and Bridge Launchers" })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("btn_auth_session")
        .setLabel("Authenticate Session")
        .setStyle(ButtonStyle.Success)
        .setEmoji("🔑")
    );

    return { embeds: [embed], components: [row] };
  }

  const expiresAt = botData.sessionExpiresAt!;
  const embed = new EmbedBuilder()
    .setTitle("🛡️ Security Access Terminal & Master Keygate")
    .setColor(0x57f287)
    .setDescription(
      "### 🟢 SYSTEM ACCESS: ACTIVE (LEVEL 5 CLEARANCE)\n" +
      "All operational decks, server directory telemetry, and two-way tactical bridges are **online and fully functional**.\n\n" +
      `• **Session Expiration:** <t:${Math.floor(expiresAt / 1000)}:R>\n` +
      `• **Exact Expiration Time:** <t:${Math.floor(expiresAt / 1000)}:F>`
    )
    .addFields(
      { name: "🛡️ Terminal Status", value: "`ONLINE / DEPLOYED`", inline: true },
      { name: "⏱️ Active TTL", value: `<t:${Math.floor(expiresAt / 1000)}:R>`, inline: true },
      { name: "🚨 Clearance Level", value: "`Level 5 (Unrestricted)`", inline: true }
    )
    .setFooter({ text: "Click Deactivate System to enter passkey and shut down all decks" })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_lock_session")
      .setLabel("Deactivate System")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("🛑")
  );

  return { embeds: [embed], components: [row] };
}

// B. MISSION CONTROL DASHBOARD (Channel: 1547034942784016475)
function buildDashboardPayload(client: Client) {
  const active = isSessionActive();

  if (!active) {
    const lockedEmbed = new EmbedBuilder()
      .setTitle("🛰️ Mission Control & Operations Center")
      .setColor(0xed4245)
      .setDescription(
        "### 🔒 COMMAND DECK LOCKED\n" +
        "Telemetry exploration, server directory inspection, and command links are **restricted**.\n\n" +
        `Head over to <#${SECURITY_TERMINAL_CHANNEL_ID}> and authenticate the master passkey to unlock this console.`
      )
      .addFields(
        { name: "Status", value: "`DEFCON 1 (Locked)`", inline: true },
        { name: "Authentication Point", value: `<#${SECURITY_TERMINAL_CHANNEL_ID}>`, inline: true }
      )
      .setFooter({ text: "Security clearance required" })
      .setTimestamp();

    return { embeds: [lockedEmbed], components: [] };
  }

  const ping = client.ws.ping >= 0 ? `${client.ws.ping}ms` : "calculating...";
  const uptimeHours = (process.uptime() / 3600).toFixed(1);
  const memUsedMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  const guilds = client.guilds.cache;
  const totalMembers = guilds.reduce((acc, g) => acc + g.memberCount, 0);

  const embed = new EmbedBuilder()
    .setTitle("🛰️ Mission Control & Operations Center")
    .setColor(0x5865f2)
    .setThumbnail(client.user?.displayAvatarURL() || null)
    .setDescription("Central command deck for multi-server administration, telemetry & operator permissions.")
    .addFields(
      { name: "🌐 Connected Servers", value: `\`${guilds.size} guilds\``, inline: true },
      { name: "👥 Total Reach", value: `\`${totalMembers.toLocaleString()} members\``, inline: true },
      { name: "⚡ Gateway Ping", value: `\`${ping}\``, inline: true },
      { name: "⏱️ System Uptime", value: `\`${uptimeHours} hrs\``, inline: true },
      { name: "💾 Memory Load", value: `\`${memUsedMb} MB\``, inline: true },
      { name: "👑 Master Operator", value: `<@${OWNER_ID}>`, inline: true },
      { name: "👥 Whitelisted Operators", value: `\`${whitelist.size} authorized\``, inline: true },
      { name: "🎙️ Active Bridges", value: `\`${activeBridges.size} running\``, inline: true },
      { name: "📡 24/7 Live Stream", value: botData.liveLoggingEnabled ? `\`ACTIVE (${guilds.size} channels)\`` : "`PAUSED`", inline: true }
    )
    .setFooter({ text: "Select a server below to inspect channels & quick deploy • Whitelist restricted to Owner" })
    .setTimestamp();

  const serverOptions = guilds.map((g) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(g.name.slice(0, 50))
      .setDescription(`ID: ${g.id} • ${g.memberCount} members`)
      .setValue(g.id)
      .setEmoji("🌐")
  );

  const rows: ActionRowBuilder<any>[] = [];
  if (serverOptions.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("dash_server_select")
          .setPlaceholder("🔍 Inspect server topology & quick deploy...")
          .addOptions(serverOptions.slice(0, 25))
      )
    );
  }

  // Two Clean Buttons on the main command center
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("btn_dash_refresh")
        .setLabel("Refresh Metrics")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🔄"),
      new ButtonBuilder()
        .setCustomId("btn_manage_whitelist")
        .setLabel("Manage Whitelist")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("👥")
    )
  );

  return { embeds: [embed], components: rows };
}

// C. TACTICAL BRIDGE LAUNCHER HUB (Channel: 1547037303543824384)
function buildRelayHubPayload() {
  const active = isSessionActive();

  if (!active) {
    const lockedEmbed = new EmbedBuilder()
      .setTitle("🎙️ Live Two-Way Communication Bridge Launcher")
      .setColor(0xed4245)
      .setDescription(
        "### 🔒 TRANSMISSION UPLINK LOCKED\n" +
        "Direct communication channels and bridging protocols are currently **offline**.\n\n" +
        `Authenticate via the Security Terminal in <#${SECURITY_TERMINAL_CHANNEL_ID}> to activate the launcher.`
      )
      .addFields(
        { name: "📡 Active Bridges", value: "`0 (Locked)`", inline: true },
        { name: "🛡️ Access Protocol", value: "`Authentication Required`", inline: true }
      )
      .setFooter({ text: "Terminal locked • Clearance required" })
      .setTimestamp();

    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("btn_locked_placeholder")
        .setLabel("Uplink Locked")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🔒")
        .setDisabled(true)
    );

    return { embeds: [lockedEmbed], components: [disabledRow] };
  }

  const count = activeBridges.size;

  const embed = new EmbedBuilder()
    .setTitle("🎙️ Live Two-Way Communication Bridge Launcher")
    .setColor(0x5865f2)
    .setDescription(
      "Deploy an isolated, real-time two-way communication bridge to any external server or voice channel.\n\n" +
      "### 🛠️ Core Capabilities\n" +
      "• **Dynamic Channel Creation:** Spawns an isolated bridge channel (`#bridge-...`).\n" +
      "• **DM Bridge:** Open a private operator channel for direct messages to a Discord user.\n" +
      "• **Typing & Reactions:** Realistic typing emulation & live emoji reactions mirrored.\n" +
      "• **Voice Chat (VC) Support:** Full two-way support for voice channel text chats (`🔊 [VC]`).\n" +
      "• **Remote Moderation:** Use `;whois`, `;timeout`, `;untimeout`, `;kick`, and `;ban` from the bridge.\n\n" +
      "### ⚡ Tactical Protocols\n" +
      "• **Ghost Sync:** Live message edits & deletions mirrored instantly without a trace.\n" +
      "• **Forensics & Clean Archives:** Auto-compiles in-chat logs & `.txt` transcripts on `;end`."
    )
    .addFields(
      { name: "📡 Active Bridges", value: `\`${count} running\``, inline: true },
      { name: "🛡️ Access Protocol", value: `\`${whitelist.size} Authorized Operators\``, inline: true }
    )
    .setFooter({ text: "Bridge Launcher Hub • Click [Launch Bridge Channel] below to start" })
    .setTimestamp();

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_launch_bridge")
      .setLabel("Launch Bridge Channel")
      .setStyle(ButtonStyle.Success)
      .setEmoji("🎙️"),
    new ButtonBuilder()
      .setCustomId("btn_dm_user")
      .setLabel("DM User")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("💬")
  );

  return { embeds: [embed], components: [buttonRow] };
}

// ----------------------------------------------------------------------------
// SMART CLEANER & IN-PLACE UPDATER ACROSS ALL 3 TERMINALS
// ----------------------------------------------------------------------------

async function deployOrUpdateSecurityTerminal(client: Client) {
  try {
    const channel = (await client.channels.fetch(SECURITY_TERMINAL_CHANNEL_ID).catch(() => null)) as TextChannel;
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;

    const payload = buildSecurityTerminalPayload();
    const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
    const botMessages = recent ? Array.from(recent.values()).filter((m) => m.author.id === client.user!.id) : [];

    if (botMessages.length > 0) {
      const primaryMsg = botMessages.find((m) => m.id === botData.securityTerminalMessageId) || botMessages[0];
      await primaryMsg.edit(payload);
      botData.securityTerminalMessageId = primaryMsg.id;
      saveStorage(botData);

      for (const extra of botMessages) {
        if (extra.id !== primaryMsg.id) await extra.delete().catch(() => null);
      }
      return;
    }

    const newMsg = await channel.send(payload);
    botData.securityTerminalMessageId = newMsg.id;
    saveStorage(botData);
  } catch (err) {
    console.error("Failed to deploy Security Terminal:", err);
  }
}

async function deployOrUpdateDashboard(client: Client) {
  try {
    const channel = (await client.channels.fetch(DASHBOARD_CHANNEL_ID).catch(() => null)) as TextChannel;
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;

    const payload = buildDashboardPayload(client);
    const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
    const botMessages = recent ? Array.from(recent.values()).filter((m) => m.author.id === client.user!.id) : [];

    if (botMessages.length > 0) {
      const primaryMsg = botMessages.find((m) => m.id === botData.dashboardMessageId) || botMessages[0];
      await primaryMsg.edit(payload);
      botData.dashboardMessageId = primaryMsg.id;
      saveStorage(botData);

      for (const extra of botMessages) {
        if (extra.id !== primaryMsg.id) await extra.delete().catch(() => null);
      }
      return;
    }

    const newMsg = await channel.send(payload);
    botData.dashboardMessageId = newMsg.id;
    saveStorage(botData);
  } catch (err) {
    console.error("Failed to deploy Dashboard:", err);
  }
}

async function deployOrUpdateRelayHub(client: Client) {
  try {
    const channel = (await client.channels.fetch(RELAY_HUB_CHANNEL_ID).catch(() => null)) as TextChannel;
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;

    const payload = buildRelayHubPayload();
    const recent = await channel.messages.fetch({ limit: 30 }).catch(() => null);
    const botMessages = recent ? Array.from(recent.values()).filter((m) => m.author.id === client.user!.id) : [];

    if (botMessages.length > 0) {
      const primaryMsg = botMessages.find((m) => m.id === botData.relayHubMessageId) || botMessages[0];
      await primaryMsg.edit(payload);
      botData.relayHubMessageId = primaryMsg.id;
      saveStorage(botData);

      for (const extra of botMessages) {
        if (extra.id !== primaryMsg.id) await extra.delete().catch(() => null);
      }
      return;
    }

    const newMsg = await channel.send(payload);
    botData.relayHubMessageId = newMsg.id;
    saveStorage(botData);
  } catch (err) {
    console.error("Failed to deploy Relay Hub:", err);
  }
}

async function deployOrUpdateAllPanels(client: Client) {
  await Promise.allSettled([
    deployOrUpdateSecurityTerminal(client),
    deployOrUpdateDashboard(client),
    deployOrUpdateRelayHub(client),
  ]);
}

// ============================================================================
// 6. SLASH COMMANDS
// ============================================================================

const commandsData = [
  new SlashCommandBuilder().setName("ping").setDescription("Check bot latency"),
  new SlashCommandBuilder().setName("dashboard").setDescription("Refresh all Command Decks").setDMPermission(false).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((cmd) => cmd.toJSON());

// ============================================================================
// 7. READY EVENT & 24H WATCHDOG
// ============================================================================

client.once("ready", async () => {
  console.log(`✓ Bot logged in as ${client.user?.tag}`);
  const rest = new REST({ version: "10" }).setToken(TOKEN!);
  await rest.put(Routes.applicationCommands(client.user!.id), { body: commandsData }).catch(console.error);
  
  await deployOrUpdateAllPanels(client);

  // 24-HOUR AUTO-LOCKDOWN WATCHDOG
  setInterval(async () => {
    if (botData.sessionExpiresAt && Date.now() > botData.sessionExpiresAt) {
      console.log("24-Hour session expired. Locking down command decks...");
      botData.sessionExpiresAt = null;
      saveStorage(botData);

      for (const [channelId, session] of Array.from(activeBridges.entries())) {
        try {
          const chan = (await client.channels.fetch(channelId).catch(() => null)) as TextChannel;
          if (chan && chan.isTextBased() && "delete" in chan) {
            await chan.send("🔒 **24-Hour session expired. Auto-closing bridge.**").catch(() => null);
            const operatorGuild = client.guilds.cache.get(session.operatorGuildId || "");
            await archiveBridgeSession(session, operatorGuild).catch(console.error);
            await chan.delete("24-Hour session expired").catch(() => null);
          }
        } catch (e) {}
        activeBridges.delete(channelId);
      }
      syncBridgesToDisk();
      await deployOrUpdateAllPanels(client);
      await sendAuditLog(
        new EmbedBuilder()
          .setTitle("🔒 Session Expired (24 Hours)")
          .setDescription("All command decks have been secured and returned to DEFCON 1 lock.")
          .setColor(0xed4245)
          .setTimestamp()
      );
    }
  }, 30000);
});

// ============================================================================
// 8. TYPING & REACTION MIRRORING
// ============================================================================

client.on("typingStart", async (typing) => {
  if (typing.user?.bot || !isSessionActive()) return;

  const session = activeBridges.get(typing.channel.id);
  if (session) {
    const targetChannel = await resolveBridgeTargetChannel(session);
    if (targetChannel && "sendTyping" in targetChannel) {
      await targetChannel.sendTyping().catch(() => null);
    }
    return;
  }

  for (const [bridgeId, bridgeSession] of activeBridges.entries()) {
    if (typing.channel.id === bridgeSession.targetChannelId) {
      const bridgeChannel = await client.channels.fetch(bridgeId).catch(() => null);
      if (bridgeChannel && bridgeChannel.isTextBased() && "sendTyping" in bridgeChannel) {
        await (bridgeChannel as TextChannel).sendTyping().catch(() => null);
      }
    }
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot || !isSessionActive()) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (e) {
      return;
    }
  }

  const emoji = reaction.emoji.id ? reaction.emoji.id : reaction.emoji.name;
  if (!emoji) return;

  const session = activeBridges.get(reaction.message.channel.id);
  if (session) {
    const targetMsgId = session.messageMap.get(reaction.message.id);
    if (targetMsgId) {
      const targetChannel = (await client.channels.fetch(session.targetChannelId).catch(() => null)) as TextChannel;
      if (targetChannel) {
        const targetMsg = await targetChannel.messages.fetch(targetMsgId).catch(() => null);
        if (targetMsg) await targetMsg.react(reaction.emoji).catch(() => null);
      }
    }
    return;
  }

  for (const [bridgeId, bridgeSession] of activeBridges.entries()) {
    if (reaction.message.channel.id === bridgeSession.targetChannelId) {
      const bridgeMsgId = bridgeSession.messageMap.get(reaction.message.id);
      if (bridgeMsgId) {
        const bridgeChannel = (await client.channels.fetch(bridgeId).catch(() => null)) as TextChannel;
        if (bridgeChannel) {
          const bridgeMsg = await bridgeChannel.messages.fetch(bridgeMsgId).catch(() => null);
          if (bridgeMsg) await bridgeMsg.react(reaction.emoji).catch(() => null);
        }
      }
    }
  }
});

// ============================================================================
// 9. GHOST SYNC & 24/7 EDIT/DELETE TRACKER (WITH AUDIT SNIFFER)
// ============================================================================

client.on("messageUpdate", async (oldMsg, newMsg) => {
  if (newMsg.author?.bot) return;
  if (newMsg.partial) await newMsg.fetch().catch(() => null);

  // 1. Bridge Ghost Sync
  const session = activeBridges.get(newMsg.channel.id);
  if (session) {
    const targetMsgId = session.messageMap.get(newMsg.id);
    if (targetMsgId) {
      try {
        const targetChannel = (await client.channels.fetch(session.targetChannelId).catch(() => null)) as TextChannel;
        if (targetChannel) {
          const targetMsg = await targetChannel.messages.fetch(targetMsgId).catch(() => null);
          if (targetMsg) {
            await targetMsg.edit({ content: newMsg.content || undefined });
            await newMsg.react("✏️").catch(() => null);
          }
        }
      } catch (err) {}
    }
  }

  // 2. 24/7 Live Stream Edit Tracker
  const hostGuildId = (client.channels.cache.get(DASHBOARD_CHANNEL_ID) as TextChannel)?.guildId;
  if (
    botData.liveLoggingEnabled &&
    newMsg.guild &&
    newMsg.guild.id !== hostGuildId &&
    !activeBridges.has(newMsg.channel.id)
  ) {
    const oldText = oldMsg.content || "*[Message was not cached prior to edit]*";
    const newText = newMsg.content || "*[No new text content]*";

    if (oldText !== newText) {
      const editEmbed = new EmbedBuilder()
        .setTitle(`✏️ Message Edited: #${(newMsg.channel as TextChannel).name}`)
        .setColor(0x5865f2)
        .setAuthor({
          name: `${newMsg.author?.tag || "Unknown User"} (${newMsg.author?.id || ""})`,
          iconURL: newMsg.author?.displayAvatarURL(),
        })
        .setDescription(
          `**Original Message:**\n> ${oldText.slice(0, 1000).replace(/[\n\r]+/g, " ")}\n\n` +
          `### 📝 New Message:\n` +
          `## ${newText.slice(0, 1000)}\n\n` +
          `[Jump to Message](${newMsg.url})`
        )
        .setFooter({ text: "24/7 Live Log • Edit Intercept" })
        .setTimestamp();

      queueLiveLog(newMsg.guild.id, editEmbed, newMsg.guild);
    }
  }
});

client.on("messageDelete", async (deletedMsg) => {
  // 1. Bridge Ghost Sync
  const session = activeBridges.get(deletedMsg.channel.id);
  if (session) {
    const targetMsgId = session.messageMap.get(deletedMsg.id);
    if (targetMsgId) {
      session.messageMap.delete(deletedMsg.id);
      session.messageMap.delete(targetMsgId);
      try {
        const targetChannel = (await client.channels.fetch(session.targetChannelId).catch(() => null)) as TextChannel;
        if (targetChannel) {
          const targetMsg = await targetChannel.messages.fetch(targetMsgId).catch(() => null);
          if (targetMsg) await targetMsg.delete().catch(() => null);
        }
      } catch (err) {}
    }
  }

  // 2. 24/7 Live Stream Ghost Sniffer (Deletions + Audit Log Detection)
  const hostGuildId = (client.channels.cache.get(DASHBOARD_CHANNEL_ID) as TextChannel)?.guildId;
  if (
    botData.liveLoggingEnabled &&
    deletedMsg.guild &&
    deletedMsg.guild.id !== hostGuildId &&
    !activeBridges.has(deletedMsg.channel.id)
  ) {
    const delText = deletedMsg.content || "*[No cached text or attachment only]*";
    const authorTag = deletedMsg.author ? `${deletedMsg.author.tag} (${deletedMsg.author.id})` : "Unknown Author";

    let executorInfo = "Deleted by Author";
    try {
      if (deletedMsg.guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
        const auditLogs = await deletedMsg.guild.fetchAuditLogs({
          type: AuditLogEvent.MessageDelete,
          limit: 1,
        }).catch(() => null);
        const entry = auditLogs?.entries.first();
        if (entry && entry.targetId === deletedMsg.author?.id && Date.now() - entry.createdTimestamp < 5000) {
          executorInfo = `🚨 Deleted by Staff: <@${entry.executorId}> (\`${entry.executorId}\`)`;
        }
      }
    } catch (e) {}

    const deleteEmbed = new EmbedBuilder()
      .setTitle(`🗑️ Message Deleted: #${(deletedMsg.channel as TextChannel).name}`)
      .setColor(0xed4245)
      .setAuthor({
        name: authorTag,
        iconURL: deletedMsg.author?.displayAvatarURL(),
      })
      .setDescription(
        `### ⚠️ Sniffed Deleted Content:\n` +
        `## ${delText.slice(0, 1500)}\n\n` +
        `📍 **Channel:** <#${deletedMsg.channel.id}> (\`${deletedMsg.channel.id}\`)\n` +
        `⚖️ **Action Origin:** ${executorInfo}`
      )
      .setFooter({ text: "24/7 Live Log • Ghost Sniffer" })
      .setTimestamp();

    queueLiveLog(deletedMsg.guild.id, deleteEmbed, deletedMsg.guild);
  }
});

// ============================================================================
// 10. 24/7 LIVE STREAM MULTI-SERVER LOGGER & TWO-WAY HANDLER
// ============================================================================

client.on("messageCreate", async (message: Message) => {
  if (message.author.id === client.user!.id) return;

  // Incoming user DMs -> linked private operator bridge channel.
  if (!message.guild) {
    for (const [bridgeId, bridgeSession] of activeBridges.entries()) {
      if (bridgeSession.bridgeType !== "dm" || bridgeSession.targetUserId !== message.author.id) continue;

      try {
        const localBridgeChannel = await client.channels.fetch(bridgeId).catch(() => null);
        if (!localBridgeChannel || !localBridgeChannel.isTextBased() || !("send" in localBridgeChannel)) continue;

        const settings = getBridgeSettings(bridgeSession);
        const files = settings.attachmentsEnabled ? message.attachments.map((a) => a.url) : [];
        const incomingEmbed = new EmbedBuilder()
          .setTitle("📥 Incoming DM")
          .setAuthor({
            name: `${message.author.tag} (${message.author.id})`,
            iconURL: message.author.displayAvatarURL(),
          })
          .setDescription(message.content || "*[Attachment / Embed]*")
          .setColor(0x57f287)
          .setTimestamp();

        if (files.length > 0) {
          const firstFile = message.attachments.first();
          if (firstFile?.contentType?.startsWith("image/")) {
            incomingEmbed.setImage(firstFile.url);
          } else {
            incomingEmbed.addFields({
              name: "Attachments",
              value: files.map((url, i) => `• [Attachment ${i + 1}](${url})`).join("\n"),
            });
          }
        }

        const relayedMsg = settings.notificationsEnabled
          ? await (localBridgeChannel as TextChannel).send({ embeds: [incomingEmbed] })
          : await (localBridgeChannel as TextChannel).send({ content: "📥 Incoming DM received while notifications are OFF.", embeds: [] });
        bridgeSession.messageMap.set(message.id, relayedMsg.id);
        bridgeSession.messageMap.set(relayedMsg.id, message.id);

        if (bridgeSession.messages.length >= 250) bridgeSession.messages.shift();
        bridgeSession.messages.push({
          author: message.author.tag,
          authorId: message.author.id,
          content: message.content,
          timestamp: new Date().toLocaleTimeString(),
          isOperator: false,
          attachments: files,
        });
      } catch (err) {
        console.error("DM bridge receive error:", err);
      }
    }
    return;
  }

  const hostGuildId = (client.channels.cache.get(DASHBOARD_CHANNEL_ID) as TextChannel)?.guildId;

  // 24/7 LIVE STREAM MULTI-SERVER LOGGER (OPTION A)
  if (
    botData.liveLoggingEnabled &&
    message.guild &&
    message.guild.id !== hostGuildId &&
    !activeBridges.has(message.channel.id) &&
    !message.author.bot
  ) {
    const cleanContent = message.content?.trim() || "";
    let contentDisplay = "*[Attachment / Embed only]*";

    if (cleanContent) {
      if (cleanContent.length <= 600) {
        contentDisplay = cleanContent
          .split("\n")
          .map((line) => (line.trim() ? `## ${line}` : ""))
          .join("\n");
      } else {
        contentDisplay = `### 💬 Full Message Content:\n>>> **${cleanContent.slice(0, 2000)}**`;
      }
    }

    const attachmentsFormatted = formatAttachmentsSummary(message.attachments);

    const liveEmbed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setAuthor({
        name: `${message.author.tag} (${message.author.id})`,
        iconURL: message.author.displayAvatarURL(),
      })
      .setDescription(
        `### 💬 #${(message.channel as TextChannel).name}\n` +
        `${contentDisplay}` +
        `${attachmentsFormatted}\n\n` +
        `[Jump to Message](${message.url})`
      )
      .setFooter({ text: `24/7 Live Stream • #${(message.channel as TextChannel).name}` })
      .setTimestamp();

    const firstImg = message.attachments.find((a) => a.contentType?.startsWith("image/"));
    if (firstImg) liveEmbed.setImage(firstImg.url);

    queueLiveLog(message.guild.id, liveEmbed, message.guild);
  }

  if (message.channel.id === RELAY_HUB_CHANNEL_ID) {
    if (!isSessionActive()) {
      await message.reply(`🔒 System is locked. Authenticate first in <#${SECURITY_TERMINAL_CHANNEL_ID}>.`);
      return;
    }
    if (activeBridges.size === 0) {
      await message.reply("⚠️ Click **[Launch Bridge Channel]** above to deploy a transmission channel!");
    } else {
      const activeList = Array.from(activeBridges.keys()).map((id) => `<#${id}>`).join(", ");
      await message.reply(`⚠️ Active bridge session: ${activeList}. Head over there to talk!`);
    }
    return;
  }

  let session = activeBridges.get(message.channel.id);
  if (!session && "topic" in message.channel && (message.channel as TextChannel).name.startsWith("bridge-")) {
    const topic = (message.channel as TextChannel).topic || "";
    const match = topic.match(/\((\d{17,20})\)/);
    if (match) {
      const targetChanId = match[1];
      const targetChan = (await client.channels.fetch(targetChanId).catch(() => null)) as TextChannel;
      if (targetChan && "guild" in targetChan) {
        const isVC = targetChan.type === ChannelType.GuildVoice || targetChan.type === ChannelType.GuildStageVoice;
        session = {
          bridgeChannelId: message.channel.id,
          targetChannelId: targetChan.id,
          targetGuildId: targetChan.guild.id,
          targetGuildName: targetChan.guild.name,
          targetChannelName: targetChan.name,
          bridgeType: "channel",
          operatorGuildId: (message.channel as TextChannel).guildId,
          isVoiceChat: isVC,
          operatorId: OWNER_ID,
          createdAt: Date.now(),
          messages: [],
          messageMap: new Map(),
          realisticTyping: true,
          settings: { ...DEFAULT_BRIDGE_SETTINGS },
        };
        activeBridges.set(message.channel.id, session);
        syncBridgesToDisk();
      }
    }
  }

  // A. OPERATOR IN BRIDGE CHANNEL
  if (session) {
    const isAuthorizedOperator = isAuthorized(message.author.id) || message.author.id === session.operatorId;
    if (!isAuthorizedOperator) {
      await message.reply("❌ You are not authorized to send messages through this bridge.");
      return;
    }

    if (!isSessionActive()) {
      await message.reply(`🔒 **System Locked.** Please re-authenticate your 24-hour session in <#${SECURITY_TERMINAL_CHANNEL_ID}>.`);
      return;
    }

    const trimmed = message.content.trim();

    // 1. ;end command
    if (trimmed.toLowerCase() === ";end") {
      activeBridges.delete(message.channel.id);
      syncBridgesToDisk();

      await message.channel.send("⏳ **Archiving session and compiling clean logs...**");

      await archiveBridgeSession(
        session,
        client.guilds.cache.get(session.operatorGuildId || "") || message.guild
      ).catch(console.error);
      await message.channel.send(getBridgeSettings(session).archiveEnabled
        ? "✓ **Archived!** Transcript files posted to the archive repository and audit log. Deleting bridge channel in **5 seconds**..."
        : "✓ **Conversation closed.** Archiving is disabled for this bridge. Deleting bridge channel in **5 seconds**...");

      await deployOrUpdateAllPanels(client);

      setTimeout(async () => {
        try {
          await (message.channel as TextChannel).delete("Bridge session closed via ;end");
        } catch (e) {}
      }, 5000);
      return;
    }

    // 2. Typing toggles
    if (trimmed.toLowerCase() === ";typing off") {
      session.realisticTyping = false;
      getBridgeSettings(session).realisticTyping = false;
      syncBridgesToDisk();
      await message.reply("⚡ Realistic typing simulation **OFF**.");
      return;
    }
    if (trimmed.toLowerCase() === ";typing on") {
      session.realisticTyping = true;
      getBridgeSettings(session).realisticTyping = true;
      syncBridgesToDisk();
      await message.reply("⏳ Realistic typing simulation **ON**.");
      return;
    }

    if (trimmed.toLowerCase() === ";settings") {
      const settings = getBridgeSettings(session);
      await message.reply({ embeds: [buildBridgeSettingsEmbed(session, settings)] });
      return;
    }

    // 3. Moderation commands
    if (trimmed.startsWith(";")) {
      const args = trimmed.slice(1).split(/ +/);
      const command = args[0].toLowerCase();
      const targetGuild = client.guilds.cache.get(session.targetGuildId);

      if (!targetGuild) return;

      if (command === "whois" || command === "user") {
        const userId = args[1]?.match(/\d{17,20}/)?.[0];
        if (!userId) {
          await message.reply("Usage: `;whois <userId>`");
          return;
        }
        try {
          const member = await targetGuild.members.fetch(userId);
          const roles = member.roles.cache.filter((r) => r.id !== targetGuild.id).map((r) => r.name).join(", ") || "None";
          const whoisEmbed = new EmbedBuilder()
            .setTitle(`👤 Whois: ${member.user.tag}`)
            .setThumbnail(member.user.displayAvatarURL())
            .setColor(0x5865f2)
            .addFields(
              { name: "User ID", value: `\`${member.id}\``, inline: true },
              { name: "Joined Server", value: member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime() / 1000)}:R>` : "Unknown", inline: true },
              { name: "Timed Out?", value: member.isCommunicationDisabled() ? "Yes ⚠️" : "No ✓", inline: true },
              { name: "Roles", value: roles.slice(0, 500) }
            );
          await message.reply({ embeds: [whoisEmbed] });
        } catch (err) {
          await message.reply(`❌ Member not found in **${session.targetGuildName}**.`);
        }
        return;
      }

      if (command === "timeout" || command === "mute") {
        const userId = args[1]?.match(/\d{17,20}/)?.[0];
        const minutes = parseInt(args[2], 10);
        const reason = args.slice(3).join(" ") || "Timed out via Remote Bridge";
        if (!userId || isNaN(minutes)) {
          await message.reply("Usage: `;timeout <userId> <minutes> [reason]`");
          return;
        }
        try {
          const member = await targetGuild.members.fetch(userId);
          await member.timeout(minutes * 60 * 1000, reason);
          await message.reply(`✓ Timed out **${member.user.tag}** for **${minutes}m** in **${session.targetGuildName}**.`);
        } catch (err) {
          await message.reply(`❌ Timeout failed: ${(err as Error).message}`);
        }
        return;
      }

      if (command === "untimeout" || command === "unmute") {
        const userId = args[1]?.match(/\d{17,20}/)?.[0];
        if (!userId) return;
        try {
          const member = await targetGuild.members.fetch(userId);
          await member.timeout(null);
          await message.reply(`✓ Cleared timeout for **${member.user.tag}**.`);
        } catch (err) {
          await message.reply(`❌ Untimeout failed: ${(err as Error).message}`);
        }
        return;
      }

      if (command === "kick") {
        const userId = args[1]?.match(/\d{17,20}/)?.[0];
        const reason = args.slice(2).join(" ") || "Kicked via Remote Bridge";
        if (!userId) return;
        try {
          const member = await targetGuild.members.fetch(userId);
          await member.kick(reason);
          await message.reply(`✓ Kicked **${member.user.tag}** from **${session.targetGuildName}**.`);
        } catch (err) {
          await message.reply(`❌ Kick failed: ${(err as Error).message}`);
        }
        return;
      }

      if (command === "ban") {
        const userId = args[1]?.match(/\d{17,20}/)?.[0];
        const reason = args.slice(2).join(" ") || "Banned via Remote Bridge";
        if (!userId) return;
        try {
          await targetGuild.members.ban(userId, { reason });
          await message.reply(`✓ Banned user \`${userId}\` from **${session.targetGuildName}**.`);
        } catch (err) {
          await message.reply(`❌ Ban failed: ${(err as Error).message}`);
        }
        return;
      }

      if (command === "help") {
        await message.reply("Commands: `;end`, `;settings`, `;typing on|off`, `;whois`, `;timeout`, `;untimeout`, `;kick`, `;ban`");
        return;
      }
    }

    // 4. Normal Direct Message Relay
    try {
      const targetChannel = await resolveBridgeTargetChannel(session);
      if (!targetChannel) {
        await message.reply(`❌ Could not reach remote channel <#${session.targetChannelId}>.`);
        return;
      }

      const settings = getBridgeSettings(session);
      const files = settings.attachmentsEnabled ? message.attachments.map((a) => a.url) : [];
      if (!message.content && files.length === 0) {
        await message.reply("⚠️ Message cannot be empty.");
        return;
      }

      if (session.realisticTyping) {
        await (targetChannel as TextChannel).sendTyping().catch(() => null);
        await message.react("⏳").catch(() => null);
        const delay = calculateTypingDelay(message.content, files.length > 0);
        await new Promise((r) => setTimeout(r, delay));
      }

      const standardMsg = await (targetChannel as TextChannel).send({
        content: message.content || undefined,
        files,
      });
      const sentMsgId = standardMsg.id;

      session.messageMap.set(message.id, sentMsgId);
      session.messageMap.set(sentMsgId, message.id);

      if (session.messages.length > 250) session.messages.shift();
      session.messages.push({
        author: message.author.tag,
        authorId: message.author.id,
        content: message.content,
        timestamp: new Date().toLocaleTimeString(),
        isOperator: true,
        attachments: files,
      });

      if (session.realisticTyping) {
        await message.reactions.cache.get("⏳")?.users.remove(client.user!.id).catch(() => null);
      }
      await message.react("📡").catch(() => null);
    } catch (err) {
      await message.reply(`❌ **Failed to send:** ${(err as Error).message}`);
    }
    return;
  }

  // B. REMOTE MEMBERS TALKING -> RELAY IN
  for (const [bridgeId, bridgeSession] of activeBridges.entries()) {
    if (bridgeSession.bridgeType !== "dm" && message.channel.id === bridgeSession.targetChannelId) {
      try {
        const localBridgeChannel = await client.channels.fetch(bridgeId).catch(() => null);
        if (!localBridgeChannel || !localBridgeChannel.isTextBased() || !("send" in localBridgeChannel)) continue;

        const vcBadge = bridgeSession.isVoiceChat ? " [🔊 Voice Chat]" : "";

        const incomingEmbed = new EmbedBuilder()
          .setAuthor({
            name: `${message.author.tag} (${message.author.id})${vcBadge}`,
            iconURL: message.author.displayAvatarURL(),
          })
          .setDescription(message.content || "*[Attachment / Embed]*")
          .setColor(bridgeSession.isVoiceChat ? 0x57f287 : 0x5865f2)
          .setTimestamp();

        const files = message.attachments.map((a) => a.url);
        if (files.length > 0) {
          const firstImg = message.attachments.first();
          if (firstImg?.contentType?.startsWith("image/")) {
            incomingEmbed.setImage(firstImg.url);
          } else {
            incomingEmbed.addFields({
              name: "Attachments",
              value: files.map((u, i) => `• [Attachment ${i + 1}](${u})`).join("\n"),
            });
          }
        }

        const relayedMsg = await (localBridgeChannel as TextChannel).send({ embeds: [incomingEmbed] });

        bridgeSession.messageMap.set(message.id, relayedMsg.id);
        bridgeSession.messageMap.set(relayedMsg.id, message.id);

        if (bridgeSession.messages.length > 250) bridgeSession.messages.shift();
        bridgeSession.messages.push({
          author: message.author.tag,
          authorId: message.author.id,
          content: message.content,
          timestamp: new Date().toLocaleTimeString(),
          isOperator: false,
          attachments: files,
        });
      } catch (err) {
        console.error("Relay in error:", err);
      }
    }
  }
});

// ============================================================================
// 11. BRIDGE TARGET RESOLUTION & ARCHIVING HELPERS
// ============================================================================

async function resolveBridgeTargetChannel(session: BridgeSession): Promise<TextChannel | null> {
  try {
    if (session.bridgeType === "dm" && session.targetUserId) {
      const user = await client.users.fetch(session.targetUserId);
      const dm = await user.createDM();
      return dm as TextChannel;
    }

    const channel = await client.channels.fetch(session.targetChannelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return null;
    return channel as TextChannel;
  } catch {
    return null;
  }
}

async function archiveBridgeSession(
  session: BridgeSession,
  operatorGuild: Guild | null | undefined
): Promise<void> {
  const settings = getBridgeSettings(session);
  const logEmbed = buildCleanInChatLogEmbed(session);
  const cleanText = generateCleanTextTranscript(session);
  const transcriptJson = generateTranscriptJson(session);

  const prefix = session.bridgeType === "dm" ? "dm-" : (session.isVoiceChat ? "vc-" : "");
  const baseName = session.bridgeType === "dm"
    ? (session.targetUserTag || session.targetUserId || "user")
    : session.targetChannelName;
  const safeBaseName = baseName.toLowerCase().replace(/[^a-z0-9-_.]/g, "-").slice(0, 48) || "conversation";

  const txtName = `${prefix}${safeBaseName}-transcript.txt`;
  const jsonName = `${prefix}${safeBaseName}-transcript.json`;
  const txtAttachment = new AttachmentBuilder(Buffer.from(cleanText, "utf-8"), { name: txtName });
  const jsonAttachment = new AttachmentBuilder(Buffer.from(JSON.stringify(transcriptJson, null, 2), "utf-8"), { name: jsonName });

  const archiveGuild = operatorGuild || client.guilds.cache.get(session.operatorGuildId || "") || undefined;

  if (settings.archiveEnabled && archiveGuild) {
    const archiveChannel = session.bridgeType === "dm"
      ? await getOrCreateDMArchiveChannel(client, archiveGuild)
      : await getOrCreateServerArchiveChannel(client, archiveGuild);

    if (archiveChannel) {
      await archiveChannel.send({
        embeds: [logEmbed],
        files: [txtAttachment, jsonAttachment],
      }).catch(() => null);
    }
  }

  if (settings.archiveEnabled) {
    await sendAuditLog(logEmbed, [txtAttachment, jsonAttachment]);
  }
}

function buildBridgeSettingsEmbed(session: BridgeSession, settings: BridgeSettings): EmbedBuilder {
  const typeLabel = session.bridgeType === "dm" ? "💬 DM Bridge" : (session.isVoiceChat ? "🔊 VC Bridge" : "💬 Channel Bridge");
  return new EmbedBuilder()
    .setTitle(`⚙️ Conversation Settings — ${typeLabel}`)
    .setColor(0x5865f2)
    .setDescription(
      `**Target:** ${session.bridgeType === "dm" ? (session.targetUserTag || session.targetUserId || "Unknown") : `#${session.targetChannelName}`}\n\n` +
      `⏳ Realistic typing: ${settings.realisticTyping ? "🟢 ON" : "🔴 OFF"}\n` +
      `📁 Archive on close: ${settings.archiveEnabled ? "🟢 ON" : "🔴 OFF"}\n` +
      `📎 Attachments: ${settings.attachmentsEnabled ? "🟢 ON" : "🔴 OFF"}\n` +
      `🔔 Notifications: ${settings.notificationsEnabled ? "🟢 ON" : "🔴 OFF"}`
    )
    .setFooter({ text: "Settings apply to this conversation only." })
    .setTimestamp();
}

function buildBridgeSettingsComponents(session: BridgeSession, settings: BridgeSettings) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`bridge_settings_typing:${session.bridgeChannelId}`).setLabel(`Typing ${settings.realisticTyping ? "ON" : "OFF"}`).setStyle(settings.realisticTyping ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji("⏳"),
      new ButtonBuilder().setCustomId(`bridge_settings_archive:${session.bridgeChannelId}`).setLabel(`Archive ${settings.archiveEnabled ? "ON" : "OFF"}`).setStyle(settings.archiveEnabled ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji("📁"),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`bridge_settings_attachments:${session.bridgeChannelId}`).setLabel(`Attachments ${settings.attachmentsEnabled ? "ON" : "OFF"}`).setStyle(settings.attachmentsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji("📎"),
      new ButtonBuilder().setCustomId(`bridge_settings_notifications:${session.bridgeChannelId}`).setLabel(`Notifications ${settings.notificationsEnabled ? "ON" : "OFF"}`).setStyle(settings.notificationsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji("🔔"),
    ),
  ];
}

// ============================================================================
// 11. BULLETPROOF INTERACTION HANDLER (ZERO TIMEOUTS & UNIVERSAL DEFENSE)
// ============================================================================

client.on("interactionCreate", async (interaction) => {
  try {
    if (!isAuthorized(interaction.user.id)) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "❌ Unauthorized.", ephemeral: true }).catch(() => null);
      }
      return;
    }

    // ------------------------------------------------------------------------
    // 1. BUTTON INTERACTIONS
    // ------------------------------------------------------------------------
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("bridge_settings_")) {
        const [action, bridgeChannelId] = interaction.customId.split(":");
        const session = activeBridges.get(bridgeChannelId);
        if (!session) {
          await interaction.reply({ content: "❌ This bridge is no longer active.", ephemeral: true });
          return;
        }
        if (interaction.user.id !== session.operatorId && interaction.user.id !== OWNER_ID) {
          await interaction.reply({ content: "❌ You are not authorized to change this bridge's settings.", ephemeral: true });
          return;
        }
        const settings = getBridgeSettings(session);
        if (action === "bridge_settings_typing") settings.realisticTyping = !settings.realisticTyping;
        if (action === "bridge_settings_archive") settings.archiveEnabled = !settings.archiveEnabled;
        if (action === "bridge_settings_attachments") settings.attachmentsEnabled = !settings.attachmentsEnabled;
        if (action === "bridge_settings_notifications") settings.notificationsEnabled = !settings.notificationsEnabled;
        session.realisticTyping = settings.realisticTyping;
        syncBridgesToDisk();
        await interaction.update({ embeds: [buildBridgeSettingsEmbed(session, settings)], components: buildBridgeSettingsComponents(session, settings) });
        return;
      }

      // Authenticate Button -> Opens Modal immediately (No pre-deferrals allowed before showModal)
      if (interaction.customId === "btn_auth_session") {
        const modal = new ModalBuilder()
          .setCustomId("modal_auth_terminal")
          .setTitle("Security Keygate Authentication");

        modal.addComponents(
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("passkey_input")
              .setLabel("Enter Master Passkey")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("Passkey required for 24-hour clearance...")
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      // Deactivate Button -> Opens Modal immediately
      if (interaction.customId === "btn_lock_session") {
        const modal = new ModalBuilder()
          .setCustomId("modal_lock_terminal")
          .setTitle("Authorize System Shutdown");

        modal.addComponents(
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("shutdown_passkey_input")
              .setLabel("Enter Master Passkey to Deactivate")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("Enter passkey to lock all decks...")
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      // Single Whitelist Manager Button: Owner Only
      if (interaction.customId === "btn_manage_whitelist") {
        if (interaction.user.id !== OWNER_ID) {
          await interaction.reply({
            content: `❌ **Access Denied:** Only the Master Bot Owner (<@${OWNER_ID}>) is authorized to view or manage the operator whitelist.`,
            ephemeral: true,
          });
          return;
        }

        const rosterList = Array.from(whitelist)
          .map((id) => {
            const isOwner = id === OWNER_ID ? " 👑 *(Master Owner)*" : "";
            return `• <@${id}> — \`${id}\`${isOwner}`;
          })
          .join("\n");

        const rosterEmbed = new EmbedBuilder()
          .setTitle("👥 Operator Whitelist Manager")
          .setColor(0x5865f2)
          .setDescription(
            `**Total Authorized Operators:** \`${whitelist.size}\`\n\n` +
            `### Current Authorized Roster\n${rosterList || "*No operators registered.*"}\n\n` +
            `*Click below to add a new operator ID or revoke access.*`
          )
          .setFooter({ text: "Changes are saved immediately to disk" });

        const manageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("btn_whitelist_add")
            .setLabel("Add ID")
            .setStyle(ButtonStyle.Success)
            .setEmoji("➕"),
          new ButtonBuilder()
            .setCustomId("btn_whitelist_remove")
            .setLabel("Remove ID")
            .setStyle(ButtonStyle.Danger)
            .setEmoji("➖")
        );

        await interaction.reply({ embeds: [rosterEmbed], components: [manageRow], ephemeral: true });
        return;
      }

      // Modal Trigger: Add Whitelist ID (Owner Only)
      if (interaction.customId === "btn_whitelist_add") {
        if (interaction.user.id !== OWNER_ID) {
          await interaction.reply({ content: "❌ **Access Denied:** Only the Master Bot Owner is authorized to modify the whitelist.", ephemeral: true });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId("modal_whitelist_add")
          .setTitle("Whitelist Operator ID");

        modal.addComponents(
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("whitelist_user_id")
              .setLabel("Discord User ID")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("e.g. 123456789012345678")
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      // Modal Trigger: Remove Whitelist ID (Owner Only)
      if (interaction.customId === "btn_whitelist_remove") {
        if (interaction.user.id !== OWNER_ID) {
          await interaction.reply({ content: "❌ **Access Denied:** Only the Master Bot Owner is authorized to modify the whitelist.", ephemeral: true });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId("modal_whitelist_remove")
          .setTitle("Remove Whitelisted Operator");

        modal.addComponents(
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("remove_user_id")
              .setLabel("Discord User ID to Remove")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("e.g. 123456789012345678")
              .setRequired(true)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      // Launch Bridge Manual Button
      if (interaction.customId === "btn_launch_bridge") {
        if (!isSessionActive()) {
          await interaction.reply({ content: `🔒 System is currently locked. Authenticate first in <#${SECURITY_TERMINAL_CHANNEL_ID}>.`, ephemeral: true });
          return;
        }

        const modal = new ModalBuilder().setCustomId("modal_launch_bridge").setTitle("Launch Bridge (Text or VC)");
        modal.addComponents(
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
            new TextInputBuilder().setCustomId("target_channel_id").setLabel("Remote Channel ID (Text or VC)").setStyle(TextInputStyle.Short).setRequired(true)
          ),
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
            new TextInputBuilder().setCustomId("opening_message").setLabel("Opening Message (Optional)").setStyle(TextInputStyle.Paragraph).setRequired(false)
          )
        );
        await interaction.showModal(modal);
        return;
      }

      // DM User Button
      if (interaction.customId === "btn_dm_user") {
        if (!isSessionActive()) {
          await interaction.reply({
            content: `🔒 System is currently locked. Authenticate first in <#${SECURITY_TERMINAL_CHANNEL_ID}>.`,
            ephemeral: true,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId("modal_dm_user")
          .setTitle("Open DM Bridge");

        modal.addComponents(
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("target_user_id")
              .setLabel("Discord User ID")
              .setPlaceholder("123456789012345678")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
          ),
          new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("opening_message")
              .setLabel("Opening Message (Optional)")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
          )
        );

        await interaction.showModal(modal);
        return;
      }

      // Refresh Metrics Button (Safe in-place update)
      if (interaction.customId === "btn_dash_refresh") {
        await interaction.deferUpdate().catch(() => null);
        await interaction.editReply(buildDashboardPayload(client)).catch(() => null);
        return;
      }

      // Catch-all unhandled button fallback to prevent 3s timeout
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate().catch(() => null);
      }
      return;
    }

    // ------------------------------------------------------------------------
    // 2. MODAL SUBMISSIONS
    // ------------------------------------------------------------------------
    if (interaction.isModalSubmit()) {
      // Passkey Unlock Modal
      if (interaction.customId === "modal_auth_terminal") {
        await interaction.deferReply({ ephemeral: true });
        const submittedKey = interaction.fields.getTextInputValue("passkey_input").trim();

        if (submittedKey === MASTER_PASSKEY) {
          botData.sessionExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
          saveStorage(botData);

          await interaction.editReply({
            content: `🟢 **Clearance Granted.** Level 5 Access unlocked across all command decks for **24 Hours** (expires: <t:${Math.floor(botData.sessionExpiresAt / 1000)}:R>).`,
          });

          // Run panel updates & audit dispatch in background
          deployOrUpdateAllPanels(client).catch(console.error);
          sendAuditLog(
            new EmbedBuilder()
              .setTitle("🔑 Terminal Unlocked (24 Hours)")
              .setDescription(`Operator <@${interaction.user.id}> successfully authenticated Level 5 Clearance.`)
              .setColor(0x57f287)
              .setTimestamp()
          ).catch(console.error);
        } else {
          await interaction.editReply({
            content: "❌ **Access Denied:** Incorrect master passkey.",
          });

          sendAuditLog(
            new EmbedBuilder()
              .setTitle("⚠️ Unauthorized Access Attempt")
              .setDescription(`Failed authentication attempt in <#${SECURITY_TERMINAL_CHANNEL_ID}> by <@${interaction.user.id}> (\`${interaction.user.id}\`).`)
              .setColor(0xed4245)
              .setTimestamp()
          ).catch(console.error);
        }
        return;
      }

      // Shutdown Deactivate Modal
      if (interaction.customId === "modal_lock_terminal") {
        await interaction.deferReply({ ephemeral: true });
        const submittedKey = interaction.fields.getTextInputValue("shutdown_passkey_input").trim();

        if (submittedKey === MASTER_PASSKEY) {
          botData.sessionExpiresAt = null;
          saveStorage(botData);

          await interaction.editReply("🔒 **System Deactivating & Securing...** Decommissioning active bridges.");

          for (const [channelId, session] of Array.from(activeBridges.entries())) {
            try {
              const chan = (await client.channels.fetch(channelId).catch(() => null)) as TextChannel;
              if (chan && chan.isTextBased() && "delete" in chan) {
                await chan.send("🔒 **Emergency Shutdown Initiated. Archiving bridge...**").catch(() => null);
                const operatorGuild = client.guilds.cache.get(session.operatorGuildId || "") || interaction.guild;
                await archiveBridgeSession(session, operatorGuild).catch(console.error);
                await chan.delete("System deactivated with master passkey").catch(() => null);
              }
            } catch (e) {}
            activeBridges.delete(channelId);
          }
          syncBridgesToDisk();

          await deployOrUpdateAllPanels(client);
          await interaction.editReply("🔒 **System Deactivated & Locked.** All operational decks are secured.");

          sendAuditLog(
            new EmbedBuilder()
              .setTitle("🛑 Manual System Deactivation")
              .setDescription(`Operator <@${interaction.user.id}> authorized a manual system shutdown with the master passkey.`)
              .setColor(0xed4245)
              .setTimestamp()
          ).catch(console.error);
        } else {
          await interaction.editReply({
            content: "❌ **Deactivation Denied:** Incorrect master passkey.",
          });

          sendAuditLog(
            new EmbedBuilder()
              .setTitle("⚠️ Unauthorized Shutdown Attempt")
              .setDescription(`Failed shutdown attempt in <#${SECURITY_TERMINAL_CHANNEL_ID}> by <@${interaction.user.id}> (\`${interaction.user.id}\`).`)
              .setColor(0xed4245)
              .setTimestamp()
          ).catch(console.error);
        }
        return;
      }

      // Whitelist Add Modal
      if (interaction.customId === "modal_whitelist_add") {
        await interaction.deferReply({ ephemeral: true });

        if (interaction.user.id !== OWNER_ID) {
          await interaction.editReply("❌ **Access Denied:** Only the Master Bot Owner is authorized to modify the whitelist.");
          return;
        }

        const rawId = interaction.fields.getTextInputValue("whitelist_user_id").trim();
        const targetId = rawId.replace(/[<@!>]/g, "").trim();

        if (!/^\d{17,20}$/.test(targetId)) {
          await interaction.editReply("❌ **Invalid ID:** Discord User IDs must be a 17-20 digit number.");
          return;
        }

        if (whitelist.has(targetId)) {
          await interaction.editReply(`⚠️ User <@${targetId}> (\`${targetId}\`) is already on the whitelist.`);
          return;
        }

        whitelist.add(targetId);
        botData.whitelist = Array.from(whitelist);
        saveStorage(botData);

        await interaction.editReply(`✓ **Authorized:** User <@${targetId}> (\`${targetId}\`) has been added to the operator whitelist.`);

        // Update dashboards in background
        deployOrUpdateDashboard(client).catch(console.error);
        deployOrUpdateRelayHub(client).catch(console.error);
        sendAuditLog(
          new EmbedBuilder()
            .setTitle("👤 Operator Whitelisted")
            .setDescription(`Master Owner <@${interaction.user.id}> added <@${targetId}> (\`${targetId}\`) to the whitelist.`)
            .setColor(0x57f287)
            .setTimestamp()
        ).catch(console.error);
        return;
      }

      // Whitelist Remove Modal
      if (interaction.customId === "modal_whitelist_remove") {
        await interaction.deferReply({ ephemeral: true });

        if (interaction.user.id !== OWNER_ID) {
          await interaction.editReply("❌ **Access Denied:** Only the Master Bot Owner is authorized to modify the whitelist.");
          return;
        }

        const rawId = interaction.fields.getTextInputValue("remove_user_id").trim();
        const targetId = rawId.replace(/[<@!>]/g, "").trim();

        if (targetId === OWNER_ID) {
          await interaction.editReply("❌ **Action Denied:** You cannot remove the Master Bot Owner from the whitelist.");
          return;
        }

        if (!whitelist.has(targetId)) {
          await interaction.editReply(`⚠️ User <@${targetId}> (\`${targetId}\`) is not on the whitelist.`);
          return;
        }

        whitelist.delete(targetId);
        botData.whitelist = Array.from(whitelist);
        saveStorage(botData);

        await interaction.editReply(`✓ **Removed:** User <@${targetId}> (\`${targetId}\`) has been removed from the operator whitelist.`);

        deployOrUpdateDashboard(client).catch(console.error);
        deployOrUpdateRelayHub(client).catch(console.error);
        sendAuditLog(
          new EmbedBuilder()
            .setTitle("👤 Operator Whitelist Revoked")
            .setDescription(`Master Owner <@${interaction.user.id}> removed <@${targetId}> (\`${targetId}\`) from the whitelist.`)
            .setColor(0xed4245)
            .setTimestamp()
        ).catch(console.error);
        return;
      }

      // DM User Modal
      if (interaction.customId === "modal_dm_user") {
        await interaction.deferReply({ ephemeral: true });

        if (!isSessionActive()) {
          await interaction.editReply(`❌ System locked. Authenticate first in <#${SECURITY_TERMINAL_CHANNEL_ID}>.`);
          return;
        }

        const targetUserId = interaction.fields.getTextInputValue("target_user_id").trim();
        const openingMsg = interaction.fields.getTextInputValue("opening_message")?.trim();

        if (!/^\d{17,20}$/.test(targetUserId)) {
          await interaction.editReply("❌ Invalid Discord User ID. IDs must be 17-20 digits.");
          return;
        }

        if (!interaction.guild) {
          await interaction.editReply("❌ Run this from your Discord server's Bridge Launcher.");
          return;
        }

        try {
          const targetUser = await client.users.fetch(targetUserId);

          if (targetUser.bot) {
            await interaction.editReply("❌ This DM bridge is intended for human users, not bots.");
            return;
          }

          const dmChannel = await targetUser.createDM();
          const hub = (await client.channels.fetch(RELAY_HUB_CHANNEL_ID).catch(() => null)) as TextChannel;
          const categoryId = hub?.parentId || undefined;

          const safeName = (targetUser.globalName || targetUser.username || targetUser.id)
            .toLowerCase()
            .replace(/[^a-z0-9-_]/g, "")
            .slice(0, 24);
          const channelName = `dm-${safeName || targetUser.id.slice(-8)}`;

          const existingDmBridge = Array.from(activeBridges.values()).find(
            (bridge) => bridge.bridgeType === "dm" && bridge.targetUserId === targetUser.id
          );

          if (existingDmBridge) {
            await interaction.editReply(`⚠️ A DM bridge for **${targetUser.tag}** is already active: <#${existingDmBridge.bridgeChannelId}>`);
            return;
          }

          const newBridgeChannel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: categoryId,
            topic: `Private DM Bridge to ${targetUser.tag} (${targetUser.id}) | Operator: ${interaction.user.tag} | Type ;end to archive`,
            permissionOverwrites: [
              {
                id: interaction.guild.id,
                deny: [PermissionFlagsBits.ViewChannel],
              },
              {
                id: interaction.user.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.AttachFiles,
                  PermissionFlagsBits.AddReactions,
                  PermissionFlagsBits.EmbedLinks,
                ],
              },
              {
                id: client.user!.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.ManageChannels,
                  PermissionFlagsBits.AttachFiles,
                  PermissionFlagsBits.AddReactions,
                  PermissionFlagsBits.EmbedLinks,
                ],
              },
              ...(interaction.user.id !== OWNER_ID ? [{
                id: OWNER_ID,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                ],
              }] : []),
            ],
          });

          const notice = await newBridgeChannel.send({
            content:
              `📌 **PRIVATE DM BRIDGE ACTIVE**\n\n` +
              `👤 **User:** ${targetUser.tag}\n` +
              `🆔 **ID:** \`${targetUser.id}\`\n` +
              `👑 **Operator:** <@${interaction.user.id}>\n\n` +
              `Anything you send here is sent to the user's DMs. Their replies appear here automatically.\n` +
              `Type \`;end\` to archive and close this conversation.`,
          });
          await notice.pin().catch(() => null);

          const session: BridgeSession = {
            bridgeChannelId: newBridgeChannel.id,
            targetChannelId: dmChannel.id,
            targetGuildId: "",
            targetGuildName: "Discord DM",
            targetChannelName: targetUser.tag,
            bridgeType: "dm",
            targetUserId: targetUser.id,
            targetUserTag: targetUser.tag,
            operatorGuildId: interaction.guild.id,
            isVoiceChat: false,
            operatorId: interaction.user.id,
            createdAt: Date.now(),
            messages: [],
            messageMap: new Map<string, string>(),
            realisticTyping: true,
            settings: { ...DEFAULT_BRIDGE_SETTINGS },
          };

          activeBridges.set(newBridgeChannel.id, session);
          await newBridgeChannel.send({ embeds: [buildBridgeSettingsEmbed(session, session.settings)], components: buildBridgeSettingsComponents(session, session.settings) }).catch(() => null);
          syncBridgesToDisk();

          if (openingMsg) {
            const sent = await dmChannel.send(openingMsg);
            session.messageMap.set(newBridgeChannel.id, sent.id);
            session.messageMap.set(sent.id, newBridgeChannel.id);
            session.messages.push({
              author: interaction.user.tag,
              authorId: interaction.user.id,
              content: openingMsg,
              timestamp: new Date().toLocaleTimeString(),
              isOperator: true,
              attachments: [],
            });
            await newBridgeChannel.send(`📤 **Opening message sent:**\n> ${openingMsg}`);
          }

          deployOrUpdateAllPanels(client).catch(console.error);

          await interaction.editReply(
            `✓ **DM Bridge Created!**\n` +
            `👤 ${targetUser.tag} (\`${targetUser.id}\`)\n` +
            `💬 Talk to them in <#${newBridgeChannel.id}>.`
          );
        } catch (err) {
          await interaction.editReply(`❌ Could not create DM bridge: ${(err as Error).message}`);
        }
        return;
      }

      // Bridge Launcher Modal
      if (interaction.customId === "modal_launch_bridge") {
        await interaction.deferReply({ ephemeral: true });

        if (!isSessionActive()) {
          await interaction.editReply(`❌ System locked. Authenticate first in <#${SECURITY_TERMINAL_CHANNEL_ID}>.`);
          return;
        }

        const targetChannelId = interaction.fields.getTextInputValue("target_channel_id").trim();
        const openingMsg = interaction.fields.getTextInputValue("opening_message")?.trim();

        const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
        if (!targetChannel || !targetChannel.isTextBased() || !("send" in targetChannel)) {
          await interaction.editReply(`❌ Could not locate a valid text or voice channel with ID \`${targetChannelId}\`.`);
          return;
        }

        const isVC = targetChannel.type === ChannelType.GuildVoice || targetChannel.type === ChannelType.GuildStageVoice;
        const targetGuild = "guild" in targetChannel ? targetChannel.guild : null;
        const operatorGuild = interaction.guild;
        if (!operatorGuild) {
          await interaction.editReply("❌ Run this inside your Discord server.");
          return;
        }

        try {
          const hub = (await client.channels.fetch(RELAY_HUB_CHANNEL_ID).catch(() => null)) as TextChannel;
          const categoryId = hub?.parentId || undefined;

          const vcPrefix = isVC ? "bridge-vc-" : "bridge-";
          const channelName = `${vcPrefix}${targetChannel.name}`.toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 32);

          const newBridgeChannel = await operatorGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: categoryId,
            topic: `Live Bridge to ${targetGuild?.name} ${isVC ? "🔊 VC Chat" : "💬"} #${targetChannel.name} (${targetChannel.id}) | Operator: ${interaction.user.tag} | Type ;end to archive`,
            permissionOverwrites: [
              {
                id: operatorGuild.id,
                deny: [PermissionFlagsBits.ViewChannel],
              },
              {
                id: interaction.user.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.AttachFiles,
                  PermissionFlagsBits.AddReactions,
                  PermissionFlagsBits.EmbedLinks,
                ],
              },
              {
                id: client.user!.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                  PermissionFlagsBits.ManageChannels,
                  PermissionFlagsBits.AttachFiles,
                  PermissionFlagsBits.AddReactions,
                  PermissionFlagsBits.EmbedLinks,
                ],
              },
              ...(interaction.user.id !== OWNER_ID ? [{
                id: OWNER_ID,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                  PermissionFlagsBits.ReadMessageHistory,
                ],
              }] : []),
            ],
          });

          const typeLabel = isVC ? "🔊 Voice Channel Text Chat" : "💬 Text Channel";

          const pinNotice = await newBridgeChannel.send({
            content:
              `📌 **ACTIVE CONVERSATION LINKED TO ${targetGuild?.name || "Server"} (${typeLabel}: <#${targetChannel.id}>)**\n` +
              `• **Operator:** <@${interaction.user.id}>\n` +
              `• **Ghost Sync:** Live edits & deletes are mirrored to the remote server.\n` +
              `• **Realistic Typing:** Typing delay simulation is active (;typing on|off).\n` +
              `• **Archive:** Type \`;end\` to export a clean in-chat log and text archive.`,
          });
          await pinNotice.pin().catch(() => null);

          if (openingMsg) {
            await (targetChannel as TextChannel).send(openingMsg);
            await newBridgeChannel.send(`*Opening message dispatched:*\n> ${openingMsg}`);
          }

          activeBridges.set(newBridgeChannel.id, {
            bridgeChannelId: newBridgeChannel.id,
            targetChannelId: targetChannel.id,
            targetGuildId: targetGuild?.id || "Unknown",
            targetGuildName: targetGuild?.name || "Unknown Server",
            targetChannelName: targetChannel.name,
            bridgeType: "channel",
            operatorGuildId: operatorGuild.id,
            isVoiceChat: isVC,
            operatorId: interaction.user.id,
            createdAt: Date.now(),
            messages: openingMsg
              ? [{ author: client.user!.tag, authorId: client.user!.id, content: openingMsg, timestamp: new Date().toLocaleTimeString(), isOperator: true, attachments: [] }]
              : [],
            messageMap: new Map<string, string>(),
            realisticTyping: true,
            settings: { ...DEFAULT_BRIDGE_SETTINGS },
          });

          const createdSession = activeBridges.get(newBridgeChannel.id)!;
          await newBridgeChannel.send({
            embeds: [buildBridgeSettingsEmbed(createdSession, createdSession.settings)],
            components: buildBridgeSettingsComponents(createdSession, createdSession.settings),
          }).catch(() => null);

          syncBridgesToDisk();
          deployOrUpdateAllPanels(client).catch(console.error);

          await interaction.editReply(`✓ **${isVC ? "Voice Chat" : "Text"} Bridge Created!** Jump to <#${newBridgeChannel.id}>.`);
        } catch (err) {
          await interaction.editReply(`❌ Failed to create channel: ${(err as Error).message}`);
        }
        return;
      }
    }

    // ------------------------------------------------------------------------
    // 3. SELECT MENUS
    // ------------------------------------------------------------------------
    if (interaction.isStringSelectMenu() && interaction.customId === "dash_server_select") {
      await interaction.deferReply({ ephemeral: true });

      if (!isSessionActive()) {
        await interaction.editReply(`🔒 System is locked. Authenticate in <#${SECURITY_TERMINAL_CHANNEL_ID}> first.`);
        return;
      }

      const guildId = interaction.values[0];
      const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        await interaction.editReply("❌ Server not found or bot lacks access.");
        return;
      }

      // Ensure channels are fetched
      const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
      const accessible = channels.filter(
        (c) => c && c.isTextBased() && "permissionsFor" in c && c.permissionsFor(client.user!.id)?.has(PermissionFlagsBits.SendMessages)
      );

      const textArr = accessible
        .filter((c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
        .map((c) => ({ name: c!.name, id: c!.id }))
        .slice(0, 15);

      const voiceArr = accessible
        .filter((c) => c && (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice))
        .map((c) => ({ name: c!.name, id: c!.id }))
        .slice(0, 15);

      let textTree = "";
      textArr.forEach((c, idx) => {
        const isLast = idx === textArr.length - 1;
        textTree += `${isLast ? "└" : "├"} 💬 **#${c.name}** • \`${c.id}\`\n`;
      });

      let voiceTree = "";
      voiceArr.forEach((c, idx) => {
        const isLast = idx === voiceArr.length - 1;
        voiceTree += `${isLast ? "└" : "├"} 🔊 **#${c.name}** \`[VC]\` • \`${c.id}\`\n`;
      });

      let desc = `> **Server ID:** \`${guild.id}\` • **Members:** \`${guild.memberCount.toLocaleString()}\`\n`;
      desc += `> **24/7 Live Stream:** 🟢 **STREAMING TO ARCHIVE**\n\n`;
      if (textTree) desc += `### 💬 Text Channels\n${textTree}\n`;
      if (voiceTree) desc += `### 🔊 Voice Channel Chats (VC)\n${voiceTree}\n`;
      if (!textTree && !voiceTree) desc += `*No accessible text or voice channels found.*`;

      const embed = new EmbedBuilder()
        .setTitle(`🌐 Server Topology: ${guild.name}`)
        .setColor(0x57f287)
        .setDescription(desc)
        .setFooter({ text: "Select a channel below to 1-click deploy a bridge" });

      const channelOptions = accessible.map((c) => {
        const isVC = c!.type === ChannelType.GuildVoice || c!.type === ChannelType.GuildStageVoice;
        return new StringSelectMenuOptionBuilder()
          .setLabel(c!.name.slice(0, 50))
          .setDescription(`ID: ${c!.id} ${isVC ? "[Voice Chat]" : "[Text]"}`.slice(0, 50))
          .setValue(c!.id)
          .setEmoji(isVC ? "🔊" : "💬");
      }).slice(0, 25);

      const components: ActionRowBuilder<any>[] = [];
      if (channelOptions.length > 0) {
        components.push(
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("quick_launch_bridge_select")
              .setPlaceholder("🚀 Quick Launch Bridge into selected channel...")
              .addOptions(channelOptions)
          )
        );
      }

      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    // 1-Click Quick Bridge Deploy Menu Action
    if (interaction.isStringSelectMenu() && interaction.customId === "quick_launch_bridge_select") {
      await interaction.deferReply({ ephemeral: true });

      if (!isSessionActive()) {
        await interaction.editReply(`❌ System locked. Authenticate first in <#${SECURITY_TERMINAL_CHANNEL_ID}>.`);
        return;
      }

      const targetChannelId = interaction.values[0];
      const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);

      if (!targetChannel || !targetChannel.isTextBased() || !("send" in targetChannel)) {
        await interaction.editReply(`❌ Could not locate channel \`${targetChannelId}\`.`);
        return;
      }

      const isVC = targetChannel.type === ChannelType.GuildVoice || targetChannel.type === ChannelType.GuildStageVoice;
      const targetGuild = "guild" in targetChannel ? targetChannel.guild : null;
      const operatorGuild = interaction.guild;

      if (!operatorGuild) {
        await interaction.editReply("❌ Run this inside your Discord server.");
        return;
      }

      try {
        const hub = (await client.channels.fetch(RELAY_HUB_CHANNEL_ID).catch(() => null)) as TextChannel;
        const categoryId = hub?.parentId || undefined;

        const vcPrefix = isVC ? "bridge-vc-" : "bridge-";
        const channelName = `${vcPrefix}${targetChannel.name}`.toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 32);

        const newBridgeChannel = await operatorGuild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: categoryId,
          topic: `Live Bridge to ${targetGuild?.name} ${isVC ? "🔊 VC Chat" : "💬"} #${targetChannel.name} (${targetChannel.id}) | Operator: ${interaction.user.tag} | Type ;end to archive`,
          permissionOverwrites: [
            {
              id: operatorGuild.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.EmbedLinks,
              ],
            },
            {
              id: client.user!.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.EmbedLinks,
              ],
            },
            ...(interaction.user.id !== OWNER_ID ? [{
              id: OWNER_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            }] : []),
          ],
        });

        const typeLabel = isVC ? "🔊 Voice Channel Text Chat" : "💬 Text Channel";
        const pinNotice = await newBridgeChannel.send({
          content:
            `📌 **ACTIVE CONVERSATION LINKED TO ${targetGuild?.name || "Server"} (${typeLabel}: <#${targetChannel.id}>)**\n` +
            `• **Operator:** <@${interaction.user.id}>\n` +
            `• **Ghost Sync:** Live edits & deletes are mirrored to the remote server.\n` +
            `• **Realistic Typing:** Typing delay simulation is active (;typing on|off).\n` +
            `• **Archive:** Type \`;end\` to export a clean in-chat log and text archive.`,
        });
        await pinNotice.pin().catch(() => null);

        activeBridges.set(newBridgeChannel.id, {
          bridgeChannelId: newBridgeChannel.id,
          targetChannelId: targetChannel.id,
          targetGuildId: targetGuild?.id || "Unknown",
          targetGuildName: targetGuild?.name || "Unknown Server",
          targetChannelName: targetChannel.name,
          bridgeType: "channel",
          operatorGuildId: operatorGuild.id,
          isVoiceChat: isVC,
          operatorId: interaction.user.id,
          createdAt: Date.now(),
          messages: [],
          messageMap: new Map<string, string>(),
          realisticTyping: true,
          settings: { ...DEFAULT_BRIDGE_SETTINGS },
        });

        const createdSession = activeBridges.get(newBridgeChannel.id)!;
        await newBridgeChannel.send({
          embeds: [buildBridgeSettingsEmbed(createdSession, createdSession.settings)],
          components: buildBridgeSettingsComponents(createdSession, createdSession.settings),
        }).catch(() => null);

        syncBridgesToDisk();
        deployOrUpdateAllPanels(client).catch(console.error);

        await interaction.editReply(`✓ **Bridge Deployed!** Jump right into <#${newBridgeChannel.id}>.`);
      } catch (err) {
        await interaction.editReply(`❌ Failed to deploy bridge: ${(err as Error).message}`);
      }
      return;
    }

    // ------------------------------------------------------------------------
    // 4. SLASH COMMANDS
    // ------------------------------------------------------------------------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ping") {
        await interaction.reply({ content: `🏓 Latency: **${client.ws.ping}ms**`, ephemeral: true });
        return;
      } else if (interaction.commandName === "dashboard") {
        await interaction.deferReply({ ephemeral: true });
        await deployOrUpdateAllPanels(client);
        await interaction.editReply("✓ Refreshed all command decks.");
        return;
      }
    }
  } catch (globalErr) {
    console.error("Critical Interaction Error Caught:", globalErr);
    if (interaction.isRepliable()) {
      const errMsg = `❌ **Interaction Error:** ${(globalErr as Error).message || "Unknown error occurred"}`;
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errMsg }).catch(() => null);
      } else {
        await interaction.reply({ content: errMsg, ephemeral: true }).catch(() => null);
      }
    }
  }
});

// Process-level error and signal handling
function handleExit() {
  console.log("Saving state and safely exiting...");
  syncBridgesToDisk();
  process.exit(0);
}

process.on("SIGINT", handleExit);
process.on("SIGTERM", handleExit);
process.on("unhandledRejection", (r) => console.error("Unhandled:", r));

client.login(TOKEN);

