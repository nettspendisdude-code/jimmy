import os
import json
import re
import asyncio
import random
import signal
from pathlib import Path
from datetime import datetime, timezone, timedelta

import discord
from discord.ext import commands, tasks

# ============================================================
# Configuration
# ============================================================

TOKEN = os.getenv("DISCORD_TOKEN")
OWNER_ID = os.getenv("OWNER_ID", "658381489175658506")

SECURITY_TERMINAL_CHANNEL_ID = os.getenv("SECURITY_TERMINAL_CHANNEL_ID", "1547049689394978886")
DASHBOARD_CHANNEL_ID = os.getenv("DASHBOARD_CHANNEL_ID", "1547034942784016475")
RELAY_HUB_CHANNEL_ID = os.getenv("RELAY_HUB_CHANNEL_ID", "1547037303543824384")
ARCHIVE_CONTAINER_ID = os.getenv("ARCHIVE_CONTAINER_ID", "1547041316175880223")

MASTER_PASSKEY = os.getenv("MASTER_PASSKEY")
WEBHOOK_URL = os.getenv("WEBHOOK_URL")

DATA_FILE = Path(os.getenv("DATA_FILE", "bot_data.json"))

if not TOKEN:
    raise RuntimeError("DISCORD_TOKEN is not defined in Railway Variables.")

if not MASTER_PASSKEY:
    raise RuntimeError("MASTER_PASSKEY is not defined in Railway Variables.")

# Message content + members are required by the original bot.
intents = discord.Intents.default()
intents.guilds = True
intents.members = True
intents.presences = True
intents.messages = True
intents.message_content = True
intents.reactions = True
intents.dm_messages = True

bot = commands.Bot(command_prefix="!", intents=intents)

DEFAULT_SETTINGS = {
    "realisticTyping": True,
    "archiveEnabled": True,
    "attachmentsEnabled": True,
    "notificationsEnabled": True,
}

bot_data = {
    "whitelist": [OWNER_ID],
    "securityTerminalMessageId": None,
    "dashboardMessageId": None,
    "relayHubMessageId": None,
    "sessionExpiresAt": None,
    "bridges": [],
    "liveLoggingEnabled": True,
}

# bridge channel id -> session dict
active_bridges = {}

# guild id -> queued embeds
live_log_queues = {}
live_log_tasks = {}


# ============================================================
# Persistence
# ============================================================

def load_storage():
    global bot_data
    try:
        if DATA_FILE.exists():
            parsed = json.loads(DATA_FILE.read_text(encoding="utf-8"))
            bot_data.update({
                "whitelist": list(dict.fromkeys([OWNER_ID] + parsed.get("whitelist", []))),
                "securityTerminalMessageId": parsed.get("securityTerminalMessageId"),
                "dashboardMessageId": parsed.get("dashboardMessageId"),
                "relayHubMessageId": parsed.get("relayHubMessageId"),
                "sessionExpiresAt": parsed.get("sessionExpiresAt"),
                "bridges": parsed.get("bridges", []),
                "liveLoggingEnabled": parsed.get("liveLoggingEnabled", True),
            })
    except Exception as exc:
        print(f"Failed to load storage, using defaults: {exc}")


def save_storage():
    try:
        DATA_FILE.write_text(json.dumps(bot_data, indent=2), encoding="utf-8")
    except Exception as exc:
        print(f"Failed to save storage: {exc}")


def restore_bridges():
    active_bridges.clear()
    for b in bot_data.get("bridges", []):
        bridge_id = str(b.get("bridgeChannelId", ""))
        if not bridge_id:
            continue
        active_bridges[bridge_id] = {
            **b,
            "bridgeType": b.get("bridgeType", "channel"),
            "messages": [],
            "messageMap": {},
            "realisticTyping": b.get("settings", {}).get("realisticTyping", True),
            "settings": {**DEFAULT_SETTINGS, **b.get("settings", {})},
        }


def sync_bridges_to_disk():
    serialized = []
    for s in active_bridges.values():
        serialized.append({
            "bridgeChannelId": s["bridgeChannelId"],
            "targetChannelId": s.get("targetChannelId", ""),
            "targetGuildId": s.get("targetGuildId", ""),
            "targetGuildName": s.get("targetGuildName", ""),
            "targetChannelName": s.get("targetChannelName", ""),
            "bridgeType": s.get("bridgeType", "channel"),
            "targetUserId": s.get("targetUserId"),
            "targetUserTag": s.get("targetUserTag"),
            "operatorGuildId": s.get("operatorGuildId"),
            "isVoiceChat": s.get("isVoiceChat", False),
            "operatorId": s.get("operatorId", OWNER_ID),
            "createdAt": s.get("createdAt", int(datetime.now(timezone.utc).timestamp() * 1000)),
            "settings": {**DEFAULT_SETTINGS, **s.get("settings", {})},
        })
    bot_data["bridges"] = serialized
    save_storage()


load_storage()
restore_bridges()


# ============================================================
# Helpers
# ============================================================

def authorized(user_id: int | str) -> bool:
    return str(user_id) == OWNER_ID or str(user_id) in set(map(str, bot_data["whitelist"]))


def session_active() -> bool:
    expires = bot_data.get("sessionExpiresAt")
    if not expires:
        return False
    return datetime.now(timezone.utc).timestamp() * 1000 < int(expires)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def now_time():
    return datetime.now().strftime("%H:%M:%S")


def typing_delay(text: str, has_attachments: bool) -> float:
    if not text and has_attachments:
        return 1.2
    base = min(max(len(text) * 0.045, 1.2), 4.5)
    return max(base + random.uniform(-0.2, 0.2), 0.8)


def clean_name(value: str, fallback="conversation", max_len=48):
    value = re.sub(r"[^a-zA-Z0-9\-_.]", "-", value.lower())
    return (value[:max_len] or fallback)


def get_settings(session):
    settings = session.setdefault("settings", {**DEFAULT_SETTINGS})
    for key, value in DEFAULT_SETTINGS.items():
        settings.setdefault(key, value)
    session["realisticTyping"] = settings["realisticTyping"]
    return settings


def append_message(session, author, author_id, content, is_operator, attachments=None):
    attachments = attachments or []
    messages = session.setdefault("messages", [])
    if len(messages) >= 250:
        messages.pop(0)
    messages.append({
        "author": author,
        "authorId": str(author_id),
        "content": content or "",
        "timestamp": now_time(),
        "isOperator": is_operator,
        "attachments": attachments,
    })


def safe_exception(exc):
    return str(exc)[:1800] or exc.__class__.__name__


# ============================================================
# Audit logging
# ============================================================

async def send_audit_log(embed: discord.Embed, files=None):
    files = files or []

    try:
        owner = await bot.fetch_user(int(OWNER_ID))
        if owner:
            await owner.send(embed=embed, files=files)
    except Exception as exc:
        print(f"Could not DM audit log to owner: {exc}")

    if WEBHOOK_URL:
        try:
            webhook = discord.Webhook.from_url(WEBHOOK_URL, client=bot)
            await webhook.send(
                username="Mission Control Audit",
                embed=embed,
                files=files,
                wait=False,
            )
        except Exception as exc:
            print(f"Failed to transmit audit webhook: {exc}")


# ============================================================
# Transcript generation
# ============================================================

def transcript_text(session):
    is_dm = session.get("bridgeType") == "dm"
    settings = get_settings(session)

    title = (
        f"PRIVATE DM CONVERSATION — {session.get('targetUserTag') or session.get('targetUserId') or 'Unknown User'}"
        if is_dm else
        f"TRANSMISSION ARCHIVE — #{session.get('targetChannelName', 'unknown')}"
    )

    lines = [
        "=" * 88,
        title,
        "=" * 88,
        "",
        f"Bridge Type: {'Discord DM' if is_dm else ('Voice Channel Text Chat' if session.get('isVoiceChat') else 'Text Channel')}",
        f"Operator: {session.get('operatorId', OWNER_ID)}",
        f"Bridge Channel ID: {session.get('bridgeChannelId', '')}",
        f"Created At: {datetime.fromtimestamp(session.get('createdAt', 0) / 1000, tz=timezone.utc).isoformat()}",
        f"Generated At: {now_iso()}",
        f"Message Count: {len(session.get('messages', []))}",
    ]

    if is_dm:
        lines += [
            f"Target User: {session.get('targetUserTag', 'Unknown')}",
            f"Target User ID: {session.get('targetUserId', 'Unknown')}",
        ]
    else:
        lines += [
            f"Target Server: {session.get('targetGuildName', '')} ({session.get('targetGuildId', '')})",
            f"Target Channel: #{session.get('targetChannelName', '')} ({session.get('targetChannelId', '')})",
        ]

    lines += [
        "",
        "SETTINGS",
        f"- Realistic typing: {'ON' if settings['realisticTyping'] else 'OFF'}",
        f"- Archive on close: {'ON' if settings['archiveEnabled'] else 'OFF'}",
        f"- Attachments: {'ON' if settings['attachmentsEnabled'] else 'OFF'}",
        f"- Notifications: {'ON' if settings['notificationsEnabled'] else 'OFF'}",
        "",
        "=" * 88,
        "",
    ]

    messages = session.get("messages", [])
    if not messages:
        lines.append("[No messages were exchanged during this session]")
        return "\n".join(lines)

    for i, msg in enumerate(messages, 1):
        role = "OPERATOR" if msg.get("isOperator") else "REMOTE USER"
        lines += [
            f"[#{i:03d}] {msg.get('timestamp', '')} — {role}",
            f"Author: {msg.get('author', 'Unknown')} ({msg.get('authorId', '')})",
            f"Message: {msg.get('content') or '<No text content>'}",
        ]
        attachments = msg.get("attachments", [])
        if attachments:
            lines.append(f"Attachments ({len(attachments)}):")
            for n, url in enumerate(attachments, 1):
                lines.append(f"  {n}. {url}")
        lines.append("-" * 88)

    return "\n".join(lines)


def transcript_json(session):
    return {
        "format": "bridge-transcript-v2",
        "generatedAt": now_iso(),
        "bridge": {
            "id": session.get("bridgeChannelId"),
            "type": session.get("bridgeType", "channel"),
            "createdAt": datetime.fromtimestamp(
                session.get("createdAt", 0) / 1000, tz=timezone.utc
            ).isoformat(),
            "operatorId": session.get("operatorId"),
            "operatorGuildId": session.get("operatorGuildId"),
            "target": (
                {
                    "type": "dm",
                    "userId": session.get("targetUserId"),
                    "userTag": session.get("targetUserTag"),
                }
                if session.get("bridgeType") == "dm"
                else {
                    "type": "channel",
                    "guildId": session.get("targetGuildId"),
                    "guildName": session.get("targetGuildName"),
                    "channelId": session.get("targetChannelId"),
                    "channelName": session.get("targetChannelName"),
                    "voice": session.get("isVoiceChat", False),
                }
            ),
        },
        "settings": get_settings(session),
        "messageCount": len(session.get("messages", [])),
        "messages": [
            {
                "index": i,
                "role": "operator" if m.get("isOperator") else "remote",
                "author": {"tag": m.get("author"), "id": m.get("authorId")},
                "timestamp": m.get("timestamp"),
                "content": m.get("content"),
                "attachments": m.get("attachments", []),
            }
            for i, m in enumerate(session.get("messages", []), 1)
        ],
    }


def archive_embed(session):
    is_dm = session.get("bridgeType") == "dm"
    recent = session.get("messages", [])[-15:]

    preview = []
    for m in recent:
        icon = "🟢" if m.get("isOperator") else "👤"
        name = f"**{m.get('author', 'Unknown')} ({'Op' if m.get('isOperator') else ''})**"
        content = (m.get("content") or "*[Attachment]*").replace("\n", " ").replace("\r", " ")
        preview.append(f"• `{m.get('timestamp', '')}` {icon} {name}: {content}")

    if len(session.get("messages", [])) > 15:
        preview.insert(0, f"*... [{len(session['messages']) - 15} earlier messages in attached file] ...*")

    target = (
        f"**Target User:** {session.get('targetUserTag', 'Unknown')} (`{session.get('targetUserId', 'Unknown')}`)"
        if is_dm else
        f"**Server:** {session.get('targetGuildName', '')} (`{session.get('targetGuildId', '')}`)"
    )

    embed = discord.Embed(
        title=(
            f"📁 DM Archive: {session.get('targetUserTag') or session.get('targetUserId') or 'Unknown User'}"
            if is_dm else
            f"📁 Session Archive: #{session.get('targetChannelName', 'unknown')}"
        ),
        description=(
            f"{target}\n"
            f"**Channel Type:** {'💬 Private Discord DM' if is_dm else ('🔊 Voice Channel Text Chat' if session.get('isVoiceChat') else '💬 Text Channel')}\n"
            f"**Total Messages:** `{len(session.get('messages', []))}`\n\n"
            f"**Chat History:**\n{chr(10).join(preview) if preview else '*No messages exchanged.*'}"
        ),
        color=discord.Color.blurple(),
        timestamp=datetime.now(timezone.utc),
    )
    embed.set_footer(text="Clean transcripts attached below (.txt + .json)")
    return embed


# ============================================================
# Archive channels
# ============================================================

async def get_or_create_dm_archive_channel(guild: discord.Guild):
    existing = discord.utils.get(guild.text_channels, name="dm-archives")
    if existing:
        return existing

    hub = bot.get_channel(int(RELAY_HUB_CHANNEL_ID))
    category = hub.category if isinstance(hub, discord.TextChannel) else None

    overwrites = {
        guild.default_role: discord.PermissionOverwrite(view_channel=False),
        guild.me: discord.PermissionOverwrite(
            view_channel=True,
            send_messages=True,
            read_message_history=True,
            attach_files=True,
            embed_links=True,
        ),
    }

    owner = guild.get_member(int(OWNER_ID))
    if owner:
        overwrites[owner] = discord.PermissionOverwrite(
            view_channel=True,
            send_messages=True,
            read_message_history=True,
            attach_files=True,
        )

    try:
        channel = await guild.create_text_channel(
            "dm-archives",
            category=category,
            topic="Automatic archive repository for completed private DM bridge conversations.",
            overwrites=overwrites,
        )
        await channel.send(
            embed=discord.Embed(
                title="📁 DM Archive Repository",
                description="Completed private DM bridge transcripts are automatically stored here.",
                color=discord.Color.blurple(),
                timestamp=datetime.now(timezone.utc),
            )
        )
        return channel
    except Exception as exc:
        print(f"Failed to create DM archive channel: {exc}")
        return None


async def get_or_create_server_archive_channel(target_guild: discord.Guild):
    container = bot.get_channel(int(ARCHIVE_CONTAINER_ID))
    if not container:
        return None

    host_guild = getattr(container, "guild", None)
    if not host_guild:
        return None

    category = container if isinstance(container, discord.CategoryChannel) else getattr(container, "category", None)
    name = clean_name(f"archive-{target_guild.name}", "archive", 32)

    for channel in host_guild.text_channels:
        if channel.name == name or (channel.topic and target_guild.id.__str__() in channel.topic):
            return channel

    try:
        return await host_guild.create_text_channel(
            name,
            category=category,
            topic=f"24/7 Live Stream & Transcripts for: {target_guild.name} (ID: {target_guild.id})",
        )
    except Exception as exc:
        print(f"Failed to create server archive channel: {exc}")
        return None


async def archive_bridge(session, operator_guild):
    settings = get_settings(session)
    if not settings["archiveEnabled"]:
        return

    txt = transcript_text(session).encode("utf-8")
    js = json.dumps(transcript_json(session), indent=2).encode("utf-8")

    is_dm = session.get("bridgeType") == "dm"
    prefix = "dm-" if is_dm else ("vc-" if session.get("isVoiceChat") else "")
    base = session.get("targetUserTag") if is_dm else session.get("targetChannelName")
    base = clean_name(base or "user")
    txt_name = f"{prefix}{base}-transcript.txt"
    json_name = f"{prefix}{base}-transcript.json"

    archive = None
    if operator_guild:
        archive = (
            await get_or_create_dm_archive_channel(operator_guild)
            if is_dm else
            await get_or_create_server_archive_channel(operator_guild)
        )

    if archive:
        await archive.send(
            embed=archive_embed(session),
            files=[
                discord.File(__import__("io").BytesIO(txt), filename=txt_name),
                discord.File(__import__("io").BytesIO(js), filename=json_name),
            ],
        )

    await send_audit_log(
        archive_embed(session),
        files=[
            discord.File(__import__("io").BytesIO(txt), filename=txt_name),
            discord.File(__import__("io").BytesIO(js), filename=json_name),
        ],
    )


# ============================================================
# Bridge UI
# ============================================================

class BridgeSettingsView(discord.ui.View):
    def __init__(self, bridge_id):
        super().__init__(timeout=None)
        self.bridge_id = str(bridge_id)

    async def interaction_check(self, interaction):
        session = active_bridges.get(self.bridge_id)
        if not session:
            await interaction.response.send_message("❌ This bridge is no longer active.", ephemeral=True)
            return False
        if not authorized(interaction.user.id) or str(interaction.user.id) not in {
            OWNER_ID, str(session.get("operatorId"))
        }:
            await interaction.response.send_message("❌ You are not authorized to change this bridge's settings.", ephemeral=True)
            return False
        return True

    @discord.ui.button(label="Typing ON", emoji="⏳", style=discord.ButtonStyle.success)
    async def typing(self, interaction, button):
        session = active_bridges[self.bridge_id]
        s = get_settings(session)
        s["realisticTyping"] = not s["realisticTyping"]
        session["realisticTyping"] = s["realisticTyping"]
        sync_bridges_to_disk()
        await interaction.response.edit_message(embed=build_settings_embed(session), view=BridgeSettingsView(self.bridge_id))

    @discord.ui.button(label="Archive ON", emoji="📁", style=discord.ButtonStyle.success)
    async def archive(self, interaction, button):
        session = active_bridges[self.bridge_id]
        s = get_settings(session)
        s["archiveEnabled"] = not s["archiveEnabled"]
        sync_bridges_to_disk()
        await interaction.response.edit_message(embed=build_settings_embed(session), view=BridgeSettingsView(self.bridge_id))

    @discord.ui.button(label="Attachments ON", emoji="📎", style=discord.ButtonStyle.success)
    async def attachments(self, interaction, button):
        session = active_bridges[self.bridge_id]
        s = get_settings(session)
        s["attachmentsEnabled"] = not s["attachmentsEnabled"]
        sync_bridges_to_disk()
        await interaction.response.edit_message(embed=build_settings_embed(session), view=BridgeSettingsView(self.bridge_id))

    @discord.ui.button(label="Notifications ON", emoji="🔔", style=discord.ButtonStyle.success)
    async def notifications(self, interaction, button):
        session = active_bridges[self.bridge_id]
        s = get_settings(session)
        s["notificationsEnabled"] = not s["notificationsEnabled"]
        sync_bridges_to_disk()
        await interaction.response.edit_message(embed=build_settings_embed(session), view=BridgeSettingsView(self.bridge_id))


def build_settings_embed(session):
    s = get_settings(session)
    is_dm = session.get("bridgeType") == "dm"
    label = "💬 DM Bridge" if is_dm else ("🔊 VC Bridge" if session.get("isVoiceChat") else "💬 Channel Bridge")
    target = (
        session.get("targetUserTag") or session.get("targetUserId") or "Unknown"
        if is_dm else
        f"#{session.get('targetChannelName', 'unknown')}"
    )

    return discord.Embed(
        title=f"⚙️ Conversation Settings — {label}",
        description=(
            f"**Target:** {target}\n\n"
            f"⏳ Realistic typing: {'🟢 ON' if s['realisticTyping'] else '🔴 OFF'}\n"
            f"📁 Archive on close: {'🟢 ON' if s['archiveEnabled'] else '🔴 OFF'}\n"
            f"📎 Attachments: {'🟢 ON' if s['attachmentsEnabled'] else '🔴 OFF'}\n"
            f"🔔 Notifications: {'🟢 ON' if s['notificationsEnabled'] else '🔴 OFF'}"
        ),
        color=discord.Color.blurple(),
        timestamp=datetime.now(timezone.utc),
    ).set_footer(text="Settings apply to this conversation only.")


# ============================================================
# Security / dashboard / launcher
# ============================================================

class AuthModal(discord.ui.Modal, title="Security Keygate Authentication"):
    passkey = discord.ui.TextInput(
        label="Enter Master Passkey",
        placeholder="Passkey required for 24-hour clearance...",
        required=True,
        max_length=200,
    )

    async def on_submit(self, interaction):
        if self.passkey.value.strip() == MASTER_PASSKEY:
            bot_data["sessionExpiresAt"] = int(
                (datetime.now(timezone.utc) + timedelta(hours=24)).timestamp() * 1000
            )
            save_storage()
            await interaction.response.send_message(
                f"🟢 **Clearance Granted.** Level 5 access unlocked for **24 hours** "
                f"(expires <t:{int(bot_data['sessionExpiresAt']/1000)}:R>).",
                ephemeral=True,
            )
            await deploy_all_panels()
            await send_audit_log(
                discord.Embed(
                    title="🔑 Terminal Unlocked (24 Hours)",
                    description=f"Operator <@{interaction.user.id}> authenticated Level 5 clearance.",
                    color=discord.Color.green(),
                    timestamp=datetime.now(timezone.utc),
                )
            )
        else:
            await interaction.response.send_message(
                "❌ **Access Denied:** Incorrect master passkey.", ephemeral=True
            )
            await send_audit_log(
                discord.Embed(
                    title="⚠️ Unauthorized Access Attempt",
                    description=f"Failed authentication attempt by <@{interaction.user.id}>.",
                    color=discord.Color.red(),
                    timestamp=datetime.now(timezone.utc),
                )
            )


class LockModal(discord.ui.Modal, title="Authorize System Shutdown"):
    passkey = discord.ui.TextInput(
        label="Enter Master Passkey to Deactivate",
        required=True,
        max_length=200,
    )

    async def on_submit(self, interaction):
        if self.passkey.value.strip() != MASTER_PASSKEY:
            await interaction.response.send_message(
                "❌ **Deactivation Denied:** Incorrect master passkey.", ephemeral=True
            )
            return

        bot_data["sessionExpiresAt"] = None
        save_storage()
        await interaction.response.send_message(
            "🔒 **System Deactivating & Securing...**", ephemeral=True
        )

        for bridge_id, session in list(active_bridges.items()):
            try:
                channel = bot.get_channel(int(bridge_id))
                if channel:
                    await channel.send("🔒 **System shutdown initiated. Archiving bridge...**")
                    guild = bot.get_guild(int(session.get("operatorGuildId", 0)))
                    await archive_bridge(session, guild)
                    await channel.delete(reason="System deactivated with master passkey")
            except Exception as exc:
                print(f"Shutdown bridge error: {exc}")
            active_bridges.pop(bridge_id, None)

        sync_bridges_to_disk()
        await deploy_all_panels()
        await send_audit_log(
            discord.Embed(
                title="🛑 Manual System Deactivation",
                description=f"Operator <@{interaction.user.id}> authorized a system shutdown.",
                color=discord.Color.red(),
                timestamp=datetime.now(timezone.utc),
            )
        )


class WhitelistAddModal(discord.ui.Modal, title="Whitelist Operator ID"):
    user_id = discord.ui.TextInput(
        label="Discord User ID",
        placeholder="123456789012345678",
        required=True,
        max_length=30,
    )

    async def on_submit(self, interaction):
        if str(interaction.user.id) != OWNER_ID:
            await interaction.response.send_message("❌ Access denied.", ephemeral=True)
            return

        target = re.sub(r"[<@!>]", "", self.user_id.value.strip())
        if not re.fullmatch(r"\d{17,20}", target):
            await interaction.response.send_message(
                "❌ Invalid Discord User ID. IDs must be 17-20 digits.", ephemeral=True
            )
            return

        if target in map(str, bot_data["whitelist"]):
            await interaction.response.send_message("⚠️ User is already whitelisted.", ephemeral=True)
            return

        bot_data["whitelist"].append(target)
        bot_data["whitelist"] = list(dict.fromkeys(bot_data["whitelist"]))
        save_storage()
        await interaction.response.send_message(f"✓ Authorized <@{target}>.", ephemeral=True)
        await deploy_all_panels()


class WhitelistRemoveModal(discord.ui.Modal, title="Remove Whitelisted Operator"):
    user_id = discord.ui.TextInput(
        label="Discord User ID to Remove",
        required=True,
        max_length=30,
    )

    async def on_submit(self, interaction):
        if str(interaction.user.id) != OWNER_ID:
            await interaction.response.send_message("❌ Access denied.", ephemeral=True)
            return

        target = re.sub(r"[<@!>]", "", self.user_id.value.strip())
        if target == OWNER_ID:
            await interaction.response.send_message("❌ You cannot remove the owner.", ephemeral=True)
            return

        bot_data["whitelist"] = [x for x in bot_data["whitelist"] if str(x) != target]
        save_storage()
        await interaction.response.send_message(f"✓ Removed <@{target}>.", ephemeral=True)
        await deploy_all_panels()


class BridgeLaunchModal(discord.ui.Modal, title="Launch Bridge"):
    target_channel_id = discord.ui.TextInput(
        label="Remote Channel ID",
        required=True,
        max_length=30,
    )
    opening_message = discord.ui.TextInput(
        label="Opening Message (Optional)",
        style=discord.TextStyle.paragraph,
        required=False,
        max_length=1900,
    )

    async def on_submit(self, interaction):
        if not session_active():
            await interaction.response.send_message("🔒 System is locked.", ephemeral=True)
            return

        try:
            target_id = self.target_channel_id.value.strip()
            channel = bot.get_channel(int(target_id))
            if not channel:
                channel = await bot.fetch_channel(int(target_id))

            if not isinstance(channel, discord.TextChannel):
                await interaction.response.send_message(
                    "❌ The selected target must be a text channel.", ephemeral=True
                )
                return

            await create_channel_bridge(interaction, channel, self.opening_message.value.strip())
        except Exception as exc:
            await interaction.response.send_message(
                f"❌ Failed to create bridge: {safe_exception(exc)}", ephemeral=True
            )


class DMBridgeModal(discord.ui.Modal, title="Open DM Bridge"):
    target_user_id = discord.ui.TextInput(
        label="Discord User ID",
        placeholder="123456789012345678",
        required=True,
        max_length=30,
    )
    opening_message = discord.ui.TextInput(
        label="Opening Message (Optional)",
        style=discord.TextStyle.paragraph,
        required=False,
        max_length=1900,
    )

    async def on_submit(self, interaction):
        if not session_active():
            await interaction.response.send_message("🔒 System is locked.", ephemeral=True)
            return

        if not interaction.guild:
            await interaction.response.send_message(
                "❌ Run this from a Discord server.", ephemeral=True
            )
            return

        target_id = re.sub(r"[<@!>]", "", self.target_user_id.value.strip())
        if not re.fullmatch(r"\d{17,20}", target_id):
            await interaction.response.send_message("❌ Invalid Discord User ID.", ephemeral=True)
            return

        try:
            user = await bot.fetch_user(int(target_id))
            if user.bot:
                await interaction.response.send_message(
                    "❌ DM bridge is intended for human users.", ephemeral=True
                )
                return

            existing = next(
                (s for s in active_bridges.values()
                 if s.get("bridgeType") == "dm" and str(s.get("targetUserId")) == str(user.id)),
                None,
            )
            if existing:
                await interaction.response.send_message(
                    f"⚠️ A DM bridge is already active: <#{existing['bridgeChannelId']}>",
                    ephemeral=True,
                )
                return

            dm = await user.create_dm()
            hub = bot.get_channel(int(RELAY_HUB_CHANNEL_ID))
            category = hub.category if isinstance(hub, discord.TextChannel) else None

            safe = clean_name(user.global_name or user.name, user.id.__str__(), 24)
            channel_name = f"dm-{safe}"[:100]

            overwrites = {
                interaction.guild.default_role: discord.PermissionOverwrite(view_channel=False),
                interaction.user: discord.PermissionOverwrite(
                    view_channel=True,
                    send_messages=True,
                    read_message_history=True,
                    attach_files=True,
                    add_reactions=True,
                    embed_links=True,
                ),
                interaction.guild.me: discord.PermissionOverwrite(
                    view_channel=True,
                    send_messages=True,
                    read_message_history=True,
                    manage_channels=True,
                    attach_files=True,
                    add_reactions=True,
                    embed_links=True,
                ),
            }

            if interaction.user.id != int(OWNER_ID):
                owner = interaction.guild.get_member(int(OWNER_ID))
                if owner:
                    overwrites[owner] = discord.PermissionOverwrite(
                        view_channel=True,
                        send_messages=True,
                        read_message_history=True,
                    )

            bridge_channel = await interaction.guild.create_text_channel(
                channel_name,
                category=category,
                topic=f"Private DM Bridge to {user} ({user.id}) | Type ;end to archive",
                overwrites=overwrites,
            )

            await bridge_channel.send(
                f"📌 **PRIVATE DM BRIDGE ACTIVE**\n\n"
                f"👤 **User:** {user}\n"
                f"🆔 **ID:** `{user.id}`\n"
                f"👑 **Operator:** <@{interaction.user.id}>\n\n"
                f"Anything sent here is sent to the user's DMs. Replies appear here automatically.\n"
                f"Type `;end` to archive and close."
            )

            session = {
                "bridgeChannelId": str(bridge_channel.id),
                "targetChannelId": str(dm.id),
                "targetGuildId": "",
                "targetGuildName": "Discord DM",
                "targetChannelName": str(user),
                "bridgeType": "dm",
                "targetUserId": str(user.id),
                "targetUserTag": str(user),
                "operatorGuildId": str(interaction.guild.id),
                "isVoiceChat": False,
                "operatorId": str(interaction.user.id),
                "createdAt": int(datetime.now(timezone.utc).timestamp() * 1000),
                "messages": [],
                "messageMap": {},
                "realisticTyping": True,
                "settings": {**DEFAULT_SETTINGS},
            }
            active_bridges[str(bridge_channel.id)] = session

            await bridge_channel.send(
                embed=build_settings_embed(session),
                view=BridgeSettingsView(str(bridge_channel.id)),
            )

            opening = self.opening_message.value.strip()
            if opening:
                sent = await dm.send(opening)
                session["messageMap"][str(bridge_channel.id)] = str(sent.id)
                session["messageMap"][str(sent.id)] = str(bridge_channel.id)
                append_message(session, str(interaction.user), interaction.user.id, opening, True)
                await bridge_channel.send(f"📤 **Opening message sent:**\n> {opening}")

            sync_bridges_to_disk()
            await deploy_all_panels()
            await interaction.response.send_message(
                f"✓ **DM Bridge Created!** Talk to {user} in <#{bridge_channel.id}>.",
                ephemeral=True,
            )
        except Exception as exc:
            await interaction.response.send_message(
                f"❌ Could not create DM bridge: {safe_exception(exc)}", ephemeral=True
            )


# ============================================================
# Panel views
# ============================================================

class SecurityView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Authenticate Session",
        emoji="🔑",
        style=discord.ButtonStyle.success,
        custom_id="btn_auth_session",
    )
    async def auth(self, interaction, button):
        if not authorized(interaction.user.id):
            await interaction.response.send_message("❌ Unauthorized.", ephemeral=True)
            return
        await interaction.response.send_modal(AuthModal())

    @discord.ui.button(
        label="Deactivate System",
        emoji="🛑",
        style=discord.ButtonStyle.danger,
        custom_id="btn_lock_session",
    )
    async def lock(self, interaction, button):
        if not authorized(interaction.user.id):
            await interaction.response.send_message("❌ Unauthorized.", ephemeral=True)
            return
        await interaction.response.send_modal(LockModal())


class LauncherView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Launch Bridge Channel",
        emoji="🎙️",
        style=discord.ButtonStyle.success,
        custom_id="btn_launch_bridge",
    )
    async def launch(self, interaction, button):
        if not authorized(interaction.user.id):
            await interaction.response.send_message("❌ Unauthorized.", ephemeral=True)
            return
        if not session_active():
            await interaction.response.send_message("🔒 System is locked.", ephemeral=True)
            return
        await interaction.response.send_modal(BridgeLaunchModal())

    @discord.ui.button(
        label="DM User",
        emoji="💬",
        style=discord.ButtonStyle.primary,
        custom_id="btn_dm_user",
    )
    async def dm(self, interaction, button):
        if not authorized(interaction.user.id):
            await interaction.response.send_message("❌ Unauthorized.", ephemeral=True)
            return
        if not session_active():
            await interaction.response.send_message("🔒 System is locked.", ephemeral=True)
            return
        await interaction.response.send_modal(DMBridgeModal())


class DashboardView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    @discord.ui.button(
        label="Refresh Metrics",
        emoji="🔄",
        style=discord.ButtonStyle.secondary,
        custom_id="btn_dash_refresh",
    )
    async def refresh(self, interaction, button):
        if not authorized(interaction.user.id):
            await interaction.response.send_message("❌ Unauthorized.", ephemeral=True)
            return
        await interaction.response.edit_message(
            embed=build_dashboard_embed(),
            view=DashboardView(),
        )

    @discord.ui.button(
        label="Manage Whitelist",
        emoji="👥",
        style=discord.ButtonStyle.primary,
        custom_id="btn_manage_whitelist",
    )
    async def whitelist(self, interaction, button):
        if str(interaction.user.id) != OWNER_ID:
            await interaction.response.send_message("❌ Owner only.", ephemeral=True)
            return

        roster = "\n".join(
            f"• <@{uid}> — `{uid}`" + (" 👑" if str(uid) == OWNER_ID else "")
            for uid in bot_data["whitelist"]
        )
        embed = discord.Embed(
            title="👥 Operator Whitelist Manager",
            description=(
                f"**Total Authorized Operators:** `{len(bot_data['whitelist'])}`\n\n"
                f"### Current Authorized Roster\n{roster or '*None*'}"
            ),
            color=discord.Color.blurple(),
        )

        view = discord.ui.View(timeout=120)

        add = discord.ui.Button(label="Add ID", emoji="➕", style=discord.ButtonStyle.success)
        remove = discord.ui.Button(label="Remove ID", emoji="➖", style=discord.ButtonStyle.danger)

        async def add_cb(i):
            await i.response.send_modal(WhitelistAddModal())

        async def remove_cb(i):
            await i.response.send_modal(WhitelistRemoveModal())

        add.callback = add_cb
        remove.callback = remove_cb
        view.add_item(add)
        view.add_item(remove)

        await interaction.response.send_message(embed=embed, view=view, ephemeral=True)


def build_security_embed():
    if not session_active():
        return discord.Embed(
            title="🛡️ Security Access Terminal & Master Keygate",
            description=(
                "### 🔒 SYSTEM ACCESS: LOCKED\n"
                "Operational command decks and bridge systems are secured.\n\n"
                "Authenticate to grant Level 5 clearance for 24 hours."
            ),
            color=discord.Color.red(),
            timestamp=datetime.now(timezone.utc),
        )
    expires = int(bot_data["sessionExpiresAt"] / 1000)
    return discord.Embed(
        title="🛡️ Security Access Terminal & Master Keygate",
        description=(
            "### 🟢 SYSTEM ACCESS: ACTIVE\n"
            "Command decks and two-way bridges are online.\n\n"
            f"• **Session Expiration:** <t:{expires}:R>\n"
            f"• **Exact Expiration:** <t:{expires}:F>"
        ),
        color=discord.Color.green(),
        timestamp=datetime.now(timezone.utc),
    )


def build_dashboard_embed():
    guilds = list(bot.guilds)
    total_members = sum(g.member_count or 0 for g in guilds)

    if not session_active():
        return discord.Embed(
            title="🛰️ Mission Control & Operations Center",
            description=(
                "### 🔒 COMMAND DECK LOCKED\n"
                f"Authenticate in <#{SECURITY_TERMINAL_CHANNEL_ID}> to unlock this console."
            ),
            color=discord.Color.red(),
            timestamp=datetime.now(timezone.utc),
        )

    return discord.Embed(
        title="🛰️ Mission Control & Operations Center",
        description="Central command deck for server administration, telemetry and bridge operations.",
        color=discord.Color.blurple(),
        timestamp=datetime.now(timezone.utc),
    ).add_field(
        name="🌐 Connected Servers", value=f"`{len(guilds)}`", inline=True
    ).add_field(
        name="👥 Total Reach", value=f"`{total_members:,}`", inline=True
    ).add_field(
        name="⚡ Gateway Ping", value=f"`{round(bot.latency * 1000)}ms`", inline=True
    ).add_field(
        name="👥 Whitelisted Operators", value=f"`{len(bot_data['whitelist'])}`", inline=True
    ).add_field(
        name="🎙️ Active Bridges", value=f"`{len(active_bridges)}`", inline=True
    ).add_field(
        name="📡 Live Stream", value="`ACTIVE`" if bot_data["liveLoggingEnabled"] else "`PAUSED`", inline=True
    )


def build_launcher_embed():
    if not session_active():
        return discord.Embed(
            title="🎙️ Live Two-Way Communication Bridge Launcher",
            description=(
                "### 🔒 TRANSMISSION UPLINK LOCKED\n"
                f"Authenticate via <#{SECURITY_TERMINAL_CHANNEL_ID}> to activate the launcher."
            ),
            color=discord.Color.red(),
            timestamp=datetime.now(timezone.utc),
        )

    return discord.Embed(
        title="🎙️ Live Two-Way Communication Bridge Launcher",
        description=(
            "Deploy an isolated two-way communication bridge.\n\n"
            "### 🛠️ Core Capabilities\n"
            "• Dynamic bridge channel creation\n"
            "• DM bridge by Discord user ID\n"
            "• Typing and reaction mirroring\n"
            "• Clean TXT + JSON archives\n"
            "• `;end`, `;settings`, `;typing on|off`\n"
            "• Optional remote moderation commands\n"
        ),
        color=discord.Color.blurple(),
        timestamp=datetime.now(timezone.utc),
    ).add_field(
        name="📡 Active Bridges", value=f"`{len(active_bridges)} running`", inline=True
    ).add_field(
        name="🛡️ Authorized Operators", value=f"`{len(bot_data['whitelist'])}`", inline=True
    )


async def update_panel(channel_id, embed, view):
    channel = bot.get_channel(int(channel_id))
    if not isinstance(channel, discord.TextChannel):
        return None

    message_id_key = {
        SECURITY_TERMINAL_CHANNEL_ID: "securityTerminalMessageId",
        DASHBOARD_CHANNEL_ID: "dashboardMessageId",
        RELAY_HUB_CHANNEL_ID: "relayHubMessageId",
    }[channel_id]

    msg = None
    saved_id = bot_data.get(message_id_key)

    if saved_id:
        try:
            msg = await channel.fetch_message(int(saved_id))
        except Exception:
            msg = None

    if msg:
        await msg.edit(embed=embed, view=view)
        return msg

    async for old in channel.history(limit=30):
        if old.author.id == bot.user.id:
            msg = old
            break

    if msg:
        await msg.edit(embed=embed, view=view)
    else:
        msg = await channel.send(embed=embed, view=view)

    bot_data[message_id_key] = str(msg.id)
    save_storage()
    return msg


async def deploy_all_panels():
    try:
        await update_panel(SECURITY_TERMINAL_CHANNEL_ID, build_security_embed(), SecurityView())
        await update_panel(DASHBOARD_CHANNEL_ID, build_dashboard_embed(), DashboardView())
        await update_panel(RELAY_HUB_CHANNEL_ID, build_launcher_embed(), LauncherView())
    except Exception as exc:
        print(f"Panel deployment error: {exc}")


# ============================================================
# Bridge creation / commands
# ============================================================

async def create_channel_bridge(interaction, target_channel, opening_message=""):
    if not interaction.guild:
        raise RuntimeError("Run this inside a Discord server.")

    if not isinstance(target_channel, discord.TextChannel):
        raise RuntimeError("Target must be a text channel.")

    hub = bot.get_channel(int(RELAY_HUB_CHANNEL_ID))
    category = hub.category if isinstance(hub, discord.TextChannel) else None

    name = clean_name(f"bridge-{target_channel.name}", "bridge", 90)

    overwrites = {
        interaction.guild.default_role: discord.PermissionOverwrite(view_channel=False),
        interaction.user: discord.PermissionOverwrite(
            view_channel=True,
            send_messages=True,
            read_message_history=True,
            attach_files=True,
            add_reactions=True,
            embed_links=True,
        ),
        interaction.guild.me: discord.PermissionOverwrite(
            view_channel=True,
            send_messages=True,
            read_message_history=True,
            manage_channels=True,
            attach_files=True,
            add_reactions=True,
            embed_links=True,
        ),
    }

    if interaction.user.id != int(OWNER_ID):
        owner = interaction.guild.get_member(int(OWNER_ID))
        if owner:
            overwrites[owner] = discord.PermissionOverwrite(
                view_channel=True,
                send_messages=True,
                read_message_history=True,
            )

    bridge = await interaction.guild.create_text_channel(
        name[:100],
        category=category,
        topic=f"Live Bridge to {target_channel.guild.name} #{target_channel.name} ({target_channel.id}) | Type ;end to archive",
        overwrites=overwrites,
    )

    await bridge.send(
        f"📌 **ACTIVE CONVERSATION LINKED TO {target_channel.guild.name}**\n"
        f"• **Operator:** <@{interaction.user.id}>\n"
        f"• **Typing:** Use `;typing on|off`\n"
        f"• **Archive:** Use `;end`"
    )

    session = {
        "bridgeChannelId": str(bridge.id),
        "targetChannelId": str(target_channel.id),
        "targetGuildId": str(target_channel.guild.id),
        "targetGuildName": target_channel.guild.name,
        "targetChannelName": target_channel.name,
        "bridgeType": "channel",
        "operatorGuildId": str(interaction.guild.id),
        "isVoiceChat": False,
        "operatorId": str(interaction.user.id),
        "createdAt": int(datetime.now(timezone.utc).timestamp() * 1000),
        "messages": [],
        "messageMap": {},
        "realisticTyping": True,
        "settings": {**DEFAULT_SETTINGS},
    }
    active_bridges[str(bridge.id)] = session

    await bridge.send(embed=build_settings_embed(session), view=BridgeSettingsView(str(bridge.id)))

    if opening_message:
        sent = await target_channel.send(opening_message)
        append_message(session, str(interaction.user), interaction.user.id, opening_message, True)
        session["messageMap"][str(bridge.id)] = str(sent.id)
        session["messageMap"][str(sent.id)] = str(bridge.id)

    sync_bridges_to_disk()
    await deploy_all_panels()

    await interaction.response.send_message(
        f"✓ **Bridge Created!** Jump to <#{bridge.id}>.", ephemeral=True
    )


async def send_to_target(session, message):
    if session.get("bridgeType") == "dm":
        user = await bot.fetch_user(int(session["targetUserId"]))
        return await user.send(
            content=message.content or None,
            files=[
                await attachment_to_file(a)
                for a in message.attachments
            ] if get_settings(session)["attachmentsEnabled"] else [],
        )

    target = bot.get_channel(int(session["targetChannelId"]))
    if not isinstance(target, discord.TextChannel):
        raise RuntimeError("Remote target channel is unavailable.")

    files = []
    if get_settings(session)["attachmentsEnabled"]:
        for attachment in message.attachments:
            files.append(await attachment_to_file(attachment))

    return await target.send(content=message.content or None, files=files)


async def attachment_to_file(attachment):
    data = await attachment.read()
    return discord.File(__import__("io").BytesIO(data), filename=attachment.filename)


# ============================================================
# Message handling
# ============================================================

async def handle_bridge_command(message, session):
    content = message.content.strip()
    lower = content.lower()

    if lower == ";end":
        bridge_id = str(message.channel.id)
        active_bridges.pop(bridge_id, None)
        sync_bridges_to_disk()

        await message.channel.send("⏳ **Archiving session and compiling clean logs...**")
        guild = bot.get_guild(int(session.get("operatorGuildId", 0))) if session.get("operatorGuildId") else message.guild
        try:
            await archive_bridge(session, guild)
        except Exception as exc:
            print(f"Archive error: {exc}")

        await message.channel.send("✓ **Conversation closed.** Deleting bridge channel in 5 seconds...")
        await deploy_all_panels()
        await asyncio.sleep(5)
        try:
            await message.channel.delete(reason="Bridge session closed via ;end")
        except Exception:
            pass
        return True

    if lower == ";typing off":
        get_settings(session)["realisticTyping"] = False
        session["realisticTyping"] = False
        sync_bridges_to_disk()
        await message.reply("⚡ Realistic typing simulation **OFF**.")
        return True

    if lower == ";typing on":
        get_settings(session)["realisticTyping"] = True
        session["realisticTyping"] = True
        sync_bridges_to_disk()
        await message.reply("⏳ Realistic typing simulation **ON**.")
        return True

    if lower == ";settings":
        await message.reply(embed=build_settings_embed(session), view=BridgeSettingsView(str(message.channel.id)))
        return True

    if lower == ";help":
        await message.reply(
            "Commands: `;end`, `;settings`, `;typing on|off`, "
            "`;whois <userId>`, `;timeout <userId> <minutes> [reason]`, "
            "`;untimeout <userId>`, `;kick <userId> [reason]`, `;ban <userId> [reason]`"
        )
        return True

    if not lower.startswith(";") or session.get("bridgeType") == "dm":
        return False

    args = content[1:].split()
    command = args[0].lower()
    target_guild = bot.get_guild(int(session["targetGuildId"]))
    if not target_guild:
        return True

    try:
        user_id = re.search(r"\d{17,20}", args[1]).group(0) if len(args) > 1 else None

        if command in ("whois", "user"):
            if not user_id:
                await message.reply("Usage: `;whois <userId>`")
                return True
            member = await target_guild.fetch_member(int(user_id))
            roles = [r.name for r in member.roles if r != target_guild.default_role]
            embed = discord.Embed(
                title=f"👤 Whois: {member}",
                color=discord.Color.blurple(),
                timestamp=datetime.now(timezone.utc),
            )
            embed.add_field(name="User ID", value=f"`{member.id}`", inline=True)
            embed.add_field(name="Joined Server", value=discord.utils.format_dt(member.joined_at, "R") if member.joined_at else "Unknown", inline=True)
            embed.add_field(name="Timed Out?", value="Yes ⚠️" if member.is_timed_out() else "No ✓", inline=True)
            embed.add_field(name="Roles", value=", ".join(roles)[:1000] or "None")
            await message.reply(embed=embed)
            return True

        if command in ("timeout", "mute"):
            if not user_id or len(args) < 3:
                await message.reply("Usage: `;timeout <userId> <minutes> [reason]`")
                return True
            minutes = int(args[2])
            reason = " ".join(args[3:]) or "Timed out via Remote Bridge"
            member = await target_guild.fetch_member(int(user_id))
            await member.timeout(timedelta(minutes=minutes), reason=reason)
            await message.reply(f"✓ Timed out **{member}** for **{minutes}m**.")
            return True

        if command in ("untimeout", "unmute"):
            if not user_id:
                await message.reply("Usage: `;untimeout <userId>`")
                return True
            member = await target_guild.fetch_member(int(user_id))
            await member.timeout(None, reason="Cleared via Remote Bridge")
            await message.reply(f"✓ Cleared timeout for **{member}**.")
            return True

        if command == "kick":
            if not user_id:
                await message.reply("Usage: `;kick <userId> [reason]`")
                return True
            reason = " ".join(args[2:]) or "Kicked via Remote Bridge"
            member = await target_guild.fetch_member(int(user_id))
            await member.kick(reason=reason)
            await message.reply(f"✓ Kicked **{member}**.")
            return True

        if command == "ban":
            if not user_id:
                await message.reply("Usage: `;ban <userId> [reason]`")
                return True
            reason = " ".join(args[2:]) or "Banned via Remote Bridge"
            await target_guild.ban(discord.Object(id=int(user_id)), reason=reason)
            await message.reply(f"✓ Banned user `{user_id}`.")
            return True

    except Exception as exc:
        await message.reply(f"❌ Command failed: {safe_exception(exc)}")

    return True


@bot.event
async def on_message(message):
    if message.author.bot:
        return

    # Incoming DM -> matching DM bridge.
    if message.guild is None:
        for session in list(active_bridges.values()):
            if (
                session.get("bridgeType") == "dm"
                and str(session.get("targetUserId")) == str(message.author.id)
            ):
                try:
                    channel = bot.get_channel(int(session["bridgeChannelId"]))
                    if not isinstance(channel, discord.TextChannel):
                        continue

                    settings = get_settings(session)
                    files = [a.url for a in message.attachments] if settings["attachmentsEnabled"] else []

                    if settings["notificationsEnabled"]:
                        embed = discord.Embed(
                            title="📥 Incoming DM",
                            description=message.content or "*[Attachment / Embed]*",
                            color=discord.Color.green(),
                            timestamp=datetime.now(timezone.utc),
                        )
                        embed.set_author(name=f"{message.author} ({message.author.id})")
                        if files:
                            embed.add_field(
                                name="Attachments",
                                value="\n".join(f"• {url}" for url in files)[:1000],
                            )
                        await channel.send(embed=embed)
                    else:
                        await channel.send("📥 Incoming DM received while notifications are OFF.")

                    session["messageMap"][str(message.id)] = str(channel.last_message_id or "")
                    append_message(
                        session, str(message.author), message.author.id,
                        message.content, False, files
                    )
                except Exception as exc:
                    print(f"DM bridge receive error: {exc}")
        return

    # Bridge operator messages.
    session = active_bridges.get(str(message.channel.id))
    if session:
        if not authorized(message.author.id) and str(message.author.id) != str(session.get("operatorId")):
            await message.reply("❌ You are not authorized to send messages through this bridge.")
            return

        if not session_active():
            await message.reply(f"🔒 System locked. Authenticate in <#{SECURITY_TERMINAL_CHANNEL_ID}>.")
            return

        handled = await handle_bridge_command(message, session)
        if handled:
            return

        settings = get_settings(session)
        if not message.content and not message.attachments:
            await message.reply("⚠️ Message cannot be empty.")
            return

        try:
            target = bot.get_channel(int(session["targetChannelId"]))

            if session.get("realisticTyping"):
                if isinstance(target, discord.TextChannel):
                    await target.typing()
                await asyncio.sleep(typing_delay(message.content, bool(message.attachments)))

            sent = await send_to_target(session, message)
            session["messageMap"][str(message.id)] = str(sent.id)
            session["messageMap"][str(sent.id)] = str(message.id)

            append_message(
                session, str(message.author), message.author.id,
                message.content, True,
                [a.url for a in message.attachments] if settings["attachmentsEnabled"] else [],
            )

            try:
                await message.add_reaction("📡")
            except Exception:
                pass

        except Exception as exc:
            await message.reply(f"❌ **Failed to send:** {safe_exception(exc)}")
        return

    # Remote channel -> bridge.
    for bridge_id, bridge in list(active_bridges.items()):
        if (
            bridge.get("bridgeType") != "dm"
            and str(message.channel.id) == str(bridge.get("targetChannelId"))
        ):
            try:
                local = bot.get_channel(int(bridge_id))
                if not isinstance(local, discord.TextChannel):
                    continue

                files = [a.url for a in message.attachments]
                embed = discord.Embed(
                    description=message.content or "*[Attachment / Embed]*",
                    color=discord.Color.blurple(),
                    timestamp=datetime.now(timezone.utc),
                )
                embed.set_author(name=f"{message.author} ({message.author.id})")
                if files:
                    embed.add_field(name="Attachments", value="\n".join(files)[:1000])

                relayed = await local.send(embed=embed)
                bridge["messageMap"][str(message.id)] = str(relayed.id)
                bridge["messageMap"][str(relayed.id)] = str(message.id)
                append_message(
                    bridge, str(message.author), message.author.id,
                    message.content, False, files
                )
            except Exception as exc:
                print(f"Relay in error: {exc}")

    await bot.process_commands(message)


# ============================================================
# Edits, deletes, reactions, typing
# ============================================================

@bot.event
async def on_message_edit(before, after):
    if after.author.bot:
        return

    session = active_bridges.get(str(after.channel.id))
    if session:
        target_id = session.get("messageMap", {}).get(str(after.id))
        if target_id:
            try:
                target = bot.get_channel(int(session["targetChannelId"]))
                if isinstance(target, discord.TextChannel):
                    msg = await target.fetch_message(int(target_id))
                    await msg.edit(content=after.content or "\u200b")
            except Exception:
                pass

    # Keep the original live edit logging behavior, but only for guild messages
    # outside bridge channels.
    if (
        bot_data["liveLoggingEnabled"]
        and after.guild
        and str(after.channel.id) not in active_bridges
        and before.content != after.content
    ):
        embed = discord.Embed(
            title=f"✏️ Message Edited: #{getattr(after.channel, 'name', 'unknown')}",
            description=(
                f"**Original Message:**\n> {before.content[:1000] or '[empty]'}\n\n"
                f"**New Message:**\n{after.content[:1000] or '[empty]'}\n\n"
                f"[Jump to Message]({after.jump_url})"
            ),
            color=discord.Color.blurple(),
            timestamp=datetime.now(timezone.utc),
        )
        embed.set_author(name=f"{after.author} ({after.author.id})")
        await queue_live_log(after.guild.id, embed, after.guild)


@bot.event
async def on_message_delete(message):
    session = active_bridges.get(str(message.channel.id))
    if session:
        target_id = session.get("messageMap", {}).pop(str(message.id), None)
        if target_id:
            session["messageMap"].pop(str(target_id), None)
            try:
                target = bot.get_channel(int(session["targetChannelId"]))
                if isinstance(target, discord.TextChannel):
                    target_msg = await target.fetch_message(int(target_id))
                    await target_msg.delete()
            except Exception:
                pass

    if (
        bot_data["liveLoggingEnabled"]
        and message.guild
        and str(message.channel.id) not in active_bridges
    ):
        embed = discord.Embed(
            title=f"🗑️ Message Deleted: #{getattr(message.channel, 'name', 'unknown')}",
            description=(
                f"**Deleted Content:**\n{message.content[:1500] or '[No cached text]'}\n\n"
                f"📍 **Channel:** <#{message.channel.id}>"
            ),
            color=discord.Color.red(),
            timestamp=datetime.now(timezone.utc),
        )
        if message.author:
            embed.set_author(name=f"{message.author} ({message.author.id})")
        await queue_live_log(message.guild.id, embed, message.guild)


@bot.event
async def on_reaction_add(reaction, user):
    if user.bot or not session_active():
        return

    session = active_bridges.get(str(reaction.message.channel.id))
    if session:
        target_id = session.get("messageMap", {}).get(str(reaction.message.id))
        if target_id:
            try:
                target = bot.get_channel(int(session["targetChannelId"]))
                if isinstance(target, discord.TextChannel):
                    msg = await target.fetch_message(int(target_id))
                    await msg.add_reaction(reaction.emoji)
            except Exception:
                pass
        return

    for bridge_id, bridge in list(active_bridges.items()):
        if str(reaction.message.channel.id) == str(bridge.get("targetChannelId")):
            local_id = bridge.get("messageMap", {}).get(str(reaction.message.id))
            if local_id:
                try:
                    local = bot.get_channel(int(bridge_id))
                    if isinstance(local, discord.TextChannel):
                        msg = await local.fetch_message(int(local_id))
                        await msg.add_reaction(reaction.emoji)
                except Exception:
                    pass


@bot.event
async def on_typing(channel, user, when):
    if user.bot or not session_active():
        return

    session = active_bridges.get(str(channel.id))
    if session:
        target = bot.get_channel(int(session["targetChannelId"]))
        if isinstance(target, discord.TextChannel):
            try:
                await target.typing()
            except Exception:
                pass


# ============================================================
# Live log queue
# ============================================================

async def queue_live_log(guild_id, embed, guild):
    if not bot_data["liveLoggingEnabled"]:
        return

    live_log_queues.setdefault(str(guild_id), []).append(embed)

    if str(guild_id) in live_log_tasks:
        return

    async def flush():
        try:
            await asyncio.sleep(1.2)
            queue = live_log_queues.get(str(guild_id), [])
            items = queue[:5]
            del queue[:5]

            if items:
                archive = await get_or_create_server_archive_channel(guild)
                if archive:
                    await archive.send(embeds=items)

            if queue:
                live_log_tasks.pop(str(guild_id), None)
                await queue_live_log(guild_id, queue.pop(0), guild)
            else:
                live_log_tasks.pop(str(guild_id), None)
        except Exception as exc:
            live_log_tasks.pop(str(guild_id), None)
            print(f"Live log flush error: {exc}")

    live_log_tasks[str(guild_id)] = asyncio.create_task(flush())


# ============================================================
# Watchdog
# ============================================================

@tasks.loop(seconds=30)
async def session_watchdog():
    if bot_data.get("sessionExpiresAt") and not session_active():
        bot_data["sessionExpiresAt"] = None
        save_storage()

        for bridge_id, session in list(active_bridges.items()):
            try:
                channel = bot.get_channel(int(bridge_id))
                if channel:
                    await channel.send("🔒 **24-hour session expired. Auto-closing bridge.**")
                    guild = bot.get_guild(int(session.get("operatorGuildId", 0)))
                    await archive_bridge(session, guild)
                    await channel.delete(reason="24-hour session expired")
            except Exception as exc:
                print(f"Watchdog bridge error: {exc}")
            active_bridges.pop(bridge_id, None)

        sync_bridges_to_disk()
        await deploy_all_panels()


# ============================================================
# Slash commands
# ============================================================

@bot.tree.command(name="ping", description="Check bot latency")
async def ping(interaction):
    if not authorized(interaction.user.id):
        await interaction.response.send_message("❌ Unauthorized.", ephemeral=True)
        return
    await interaction.response.send_message(
        f"🏓 Latency: **{round(bot.latency * 1000)}ms**", ephemeral=True
    )


@bot.tree.command(name="dashboard", description="Refresh all command decks")
async def dashboard(interaction):
    if not authorized(interaction.user.id):
        await interaction.response.send_message("❌ Unauthorized.", ephemeral=True)
        return
    await interaction.response.defer(ephemeral=True)
    await deploy_all_panels()
    await interaction.followup.send("✓ Refreshed all command decks.", ephemeral=True)


# ============================================================
# Startup / shutdown
# ============================================================

@bot.event
async def on_ready():
    print(f"✓ Bot logged in as {bot.user} ({bot.user.id})")

    try:
        await bot.tree.sync()
    except Exception as exc:
        print(f"Slash command sync error: {exc}")

    # Register persistent views after restart.
    bot.add_view(SecurityView())
    bot.add_view(DashboardView())
    bot.add_view(LauncherView())

    await deploy_all_panels()

    if not session_watchdog.is_running():
        session_watchdog.start()

    print("✓ Discord bridge bot is ready.")


def shutdown():
    save_storage()
    print("Saving state and shutting down...")


def main():
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: shutdown())
    bot.run(TOKEN)


if __name__ == "__main__":
    main()
