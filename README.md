# Discord Bridge Bot — Python / Railway

## Railway setup

This project is intentionally flat so Railpack can detect Python immediately:

    bot.py
    requirements.txt
    Procfile
    railway.toml

Set these Railway Variables:

- DISCORD_TOKEN
- OWNER_ID
- MASTER_PASSKEY
- WEBHOOK_URL (optional)
- SECURITY_TERMINAL_CHANNEL_ID (optional)
- DASHBOARD_CHANNEL_ID (optional)
- RELAY_HUB_CHANNEL_ID (optional)
- ARCHIVE_CONTAINER_ID (optional)

Do not paste secrets into `bot.py`.

## Discord Developer Portal

Enable the privileged intents required by the bot:

- Message Content Intent
- Server Members Intent
- Presence Intent

The bot also needs the permissions required by the channels/features you use, including sending messages,
reading history, embedding links, attaching files, adding reactions, managing channels, and the moderation
permissions for moderation commands.

## Why the Railway error happened

Railpack was only seeing:

    ./
    └── jimmy

That means the deploy root did not contain recognizable project files such as `requirements.txt` / `bot.py`.
Upload/deploy the contents of this folder as the Railway service root, not a parent folder that only contains `jimmy`.

Also make sure `bot.py` and `requirements.txt` are in the same directory.
