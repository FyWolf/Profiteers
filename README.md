# Profiteers PMC Website

Unit management website for Profiteers PMC, an Arma 3 gaming community. Built with Node.js and Express, it provides a central hub for operations scheduling, roster management, ORBAT planning, leave of absence tracking, modpack distribution, and Discord integration.

## Features

- **Operations** — Create, publish, and manage operations with rich text descriptions, banner images, attendance tracking, and a news feed. Published operations automatically post to a Discord forum channel with role pings and live attendance updates.
- **ORBAT** — Fixed templates with drag-to-reorder slots, and dynamic per-operation ORBATs where players can self-assign to slots.
- **Roster** — Synced from Discord roles via the bot. Displays members grouped by rank with profile links.
- **Leave of Absence** — Members submit LOA requests with date ranges and an optional superior to notify. Discord DM notifications are sent on submission, edit, and deletion.
- **Modpacks** — Upload Arma 3 Launcher HTML presets. Mod metadata (name, size, icon) is fetched from the Steam Workshop API in the background.
- **Gallery** — Folder-based image gallery with admin upload controls.
- **Medals and Trainings** — Admins award medals manually; trainings are synced automatically from Discord roles on login.
- **Discord OAuth2 login** — Access is restricted to members of a configured guild who hold at least one required role.

## Requirements

- Node.js 18 or later
- MySQL 8 or MariaDB 10.6 or later
- A Discord application with a bot token and OAuth2 credentials
- A Steam Web API key (for modpack indexing)

## Installation

```bash
git clone https://github.com/your-org/profiteers-pmc-website.git
cd profiteers-pmc-website
npm install
```

Copy the environment file and fill in your values:

```bash
cp .env.example .env
```

Import the database schema:

```bash
mysql -u your_user -p your_database < schema.sql
```

## Environment Variables

```env
# Application
NODE_ENV=development
PORT=3000
SESSION_SECRET=change_this_to_a_long_random_string

# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_NAME=your_db_name

# Discord OAuth2 (from Discord Developer Portal -> OAuth2)
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
DISCORD_CALLBACK_URL=http://localhost:3000/auth/discord/callback

# Discord Bot
DISCORD_BOT_TOKEN=your_discord_bot_token

# Discord Channel IDs
DISCORD_OPERATIONS_FORUM_ID=your_forum_channel_id
DISCORD_LOA_CHANNEL_ID=your_loa_channel_id

# Discord Role IDs for operation pings (optional, falls back to hardcoded defaults)
DISCORD_MAIN_OPS_ROLE_ID=your_main_ops_role_id
DISCORD_SIDE_OPS_ROLE_ID=your_side_ops_role_id

# Operation reminders via Discord (optional)
DISCORD_ENABLE_REMINDERS=false

# Steam Web API key (for modpack mod metadata fetching)
STEAM_API_KEY=your_steam_api_key

# Public URL of the site (used in Discord embeds)
WEBSITE_URL=http://localhost:3000

# File upload size limit in bytes (default: 10MB)
MAX_FILE_SIZE=10485760
```

### Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. Under **Bot**, enable the **Server Members Intent**.
3. Under **OAuth2**, add your callback URL and generate an invite link with the `bot` and `applications.commands` scopes and the **Read Messages**, **Send Messages**, and **Manage Threads** permissions.
4. Invite the bot to your server.

Login access is controlled by guild membership and role. Edit `config/passport.js` to set `requiredGuildId` and `requiredRoles` to match your server.

## Running

Development (with auto-restart on file changes):

```bash
npm run dev
```

Production:

```bash
npm start
```

The server starts on the port defined in `PORT` (default `3000`). Visit `http://localhost:3000` in your browser.

## Project Structure

```
.
├── config/          # Database pool and Passport OAuth2 strategy
├── discord/         # Bot client, operation posts, LOA notifications, reminders
├── middleware/       # Session auth, Zeus (game master) permission check
├── routes/          # Express route handlers for each feature area
├── services/        # Background modpack indexer (Steam API)
├── views/           # EJS templates
│   ├── admin/       # Admin-only management pages
│   ├── loa/         # Leave of absence pages
│   ├── modpacks/    # Modpack list, view, upload
│   ├── operations/  # Operations list, form, view
│   ├── orbat/       # ORBAT templates and dynamic views
│   └── partials/    # Shared header, footer, card components
├── public/          # Static assets (CSS, JS, images)
├── server.js        # Application entry point
└── package.json
```
