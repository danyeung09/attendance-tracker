# Attendance Tracker — Setup Guide

A web application for tracking attendance across meetings and groups. Data is stored in a local `data.json` file for local development — no database server required. In production the app connects to a MySQL database via the `DATABASE_URL` environment variable.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development](#local-development)
3. [Production Deployment](#production-deployment)
   - [What Your Host Must Support](#what-your-host-must-support)
   - [Step 1: Get a MySQL Database](#step-1-get-a-mysql-database)
   - [Step 2: Prepare Your Files](#step-2-prepare-your-files)
   - [Option A: VPS / Cloud Server](#option-a-vps--cloud-server)
   - [Option B: cPanel / Plesk Shared Hosting](#option-b-cpanel--plesk-shared-hosting)
   - [Option C: PaaS Platform](#option-c-paas-platform)
4. [Environment Variables Reference](#environment-variables-reference)
5. [Using the App](#using-the-app)
6. [Management Panel](#management-panel)
7. [Authentication](#authentication)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before you start, make sure the following are installed on your machine:

| Tool | Check | Install |
|------|-------|---------|
| Node.js (v18+) | `node --version` | [nodejs.org](https://nodejs.org) |
| npm | `npm --version` | Comes with Node.js |
| Git | `git --version` | [git-scm.com](https://git-scm.com) |

For **local testing**, no additional accounts are needed.

For **production deployment**, you will also need:
- A hosting account that supports **Node.js 18+**
- A **MySQL 8.0+** database (provided by your host or a separate service)

---

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. (Optional) Create an environment file

```bash
# Windows
copy .env.example .env

# Mac / Linux
cp .env.example .env
```

Defaults (leave `DATABASE_URL` unset for local dev — the app uses `data.json`):

```
DB_PATH=./data.json
PORT=3000
```

If you leave the passwords unset for local development, the app falls back to
built-in development credentials and prints a warning at startup:

```
⚠  DEVELOPMENT AUTH DEFAULTS IN USE — ADMIN_PASSWORD, SESSION_SECRET not set.
   admin password: "admin1234"  (break-glass admin sign-in)
```

These defaults work **only** for local development. If `DATABASE_URL` or
`NODE_ENV=production` is set, the app refuses to start until you provide real
values — see [Authentication](#authentication).

> **Note:** without a `.env` file the app listens on port **3100**, not 3000.

### 3. Start the server

```bash
node server.js
```

You should see:

```
Attendance Tracker running on port 3000
```

### 4. Open the app

Go to [http://localhost:3000](http://localhost:3000). The database is seeded with sample data on first run. Press `Ctrl + C` to stop.

---

## Production Deployment

### What Your Host Must Support

Before signing up with any hosting provider, confirm it supports:

| Requirement | Details |
|-------------|---------|
| **Node.js 18+** | The app's runtime |
| **npm** | To install dependencies |
| **Persistent filesystem** or **MySQL** | To store data between restarts |
| **Custom environment variables** | To pass `DATABASE_URL` and `PORT` |
| **Custom start command** | `node server.js` |

> The app stores all data in a single MySQL table (`app_store`). It creates this table automatically on first boot — no manual database setup is needed.

---

### Step 1: Get a MySQL Database

Your MySQL database can come from:

**Option 1 — Your hosting company** (simplest): Many hosts (Hostinger, Bluehost, SiteGround, etc.) include a MySQL database in their plans. Create one from your control panel and copy the connection details.

**Option 2 — PlanetScale** (free, always-on):
1. Go to [planetscale.com](https://planetscale.com) and sign up
2. Click **Create a new database** → name it `attendance-tracker`
3. Click **Connect** → select **Node.js** → copy the connection string:
   ```
   mysql://username:password@host.aws.connect.psdb.cloud/attendance-tracker?ssl={"rejectUnauthorized":true}
   ```

**Option 3 — Railway** (free tier):
1. Go to [railway.app](https://railway.app) and sign up
2. Click **New Project** → **Provision MySQL**
3. Go to the MySQL service → **Variables** → copy `MYSQL_URL`

Once you have the connection string, build your `DATABASE_URL`:

```
mysql://DB_USER:DB_PASSWORD@DB_HOST:3306/DB_NAME
```

If SSL is required by your provider, append `?ssl={"rejectUnauthorized":true}`.

---

### Step 2: Prepare Your Files

On your local machine, install production dependencies and make sure no dev files are included:

```bash
npm install --omit=dev
```

Then create a `.env` file with your production values (this file stays on the server only — never commit it):

```
DATABASE_URL=mysql://user:password@host:3306/dbname
PORT=3000
NODE_ENV=production
```

---

### Option A: VPS / Cloud Server

*(DigitalOcean, Linode, AWS EC2, Vultr, Hetzner, etc.)*

#### 1. Connect to your server

```bash
ssh root@YOUR_SERVER_IP
```

#### 2. Install Node.js (if not already installed)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

#### 3. Upload your project files

From your local machine, copy the project to the server (exclude `node_modules` and `data.json`):

```bash
scp -r ./attendance-tracker root@YOUR_SERVER_IP:/var/www/attendance-tracker
```

Or use Git:

```bash
# On the server
git clone https://github.com/YOUR_USERNAME/attendance-tracker.git /var/www/attendance-tracker
```

#### 4. Install dependencies on the server

```bash
cd /var/www/attendance-tracker
npm install --omit=dev
```

#### 5. Set environment variables

Create a `.env` file on the server:

```bash
nano /var/www/attendance-tracker/.env
```

Add:

```
DATABASE_URL=mysql://user:password@host:3306/dbname
PORT=3000
NODE_ENV=production
```

#### 6. Run with PM2 (keeps the app alive after you log out)

```bash
npm install -g pm2
pm2 start server.js --name attendance-tracker
pm2 save
pm2 startup
```

The app is now running. Check it:

```bash
curl http://localhost:3000/api/data
```

#### 7. (Optional) Set up Nginx as a reverse proxy

If you want to serve the app on port 80/443:

```bash
apt-get install -y nginx
```

Create `/etc/nginx/sites-available/attendance-tracker`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/attendance-tracker /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

---

### Option B: cPanel / Plesk Shared Hosting

*(Hostinger, Bluehost, SiteGround, Namecheap, etc.)*

#### 1. Enable Node.js in your control panel

- Log in to cPanel or Plesk
- Find **Node.js** or **Setup Node.js App** section
- Click **Create Application**:
  - **Node.js version:** 18 or higher
  - **Application mode:** Production
  - **Application root:** the folder where you will upload files (e.g. `attendance-tracker`)
  - **Application startup file:** `server.js`

#### 2. Upload your files

Use the **File Manager** in cPanel or an FTP client (FileZilla) to upload all project files **except** `node_modules/` and `data.json` to the application root folder.

#### 3. Install dependencies

In the Node.js app panel, click **Run NPM Install** (or open the terminal and run `npm install --omit=dev` in your app folder).

#### 4. Set environment variables

In the Node.js app panel, find the **Environment Variables** section and add:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | your MySQL connection string |
| `ADMIN_PASSWORD` | break-glass admin sign-in |
| `SESSION_SECRET` | random hex string (see [Authentication](#authentication)) |
| `PORT` | assigned automatically by the host — leave this unset |
| `NODE_ENV` | `production` |

#### 5. Start the application

Click **Start App** in the Node.js panel. Your app will be accessible at the domain or subdomain you configured.

> **Note:** cPanel/Plesk hosts assign the port automatically via the `PORT` environment variable. The app already reads `process.env.PORT`, so no code changes are needed.

---

### Option C: PaaS Platform

*(Railway, Fly.io, Heroku, Render, Cyclic, etc.)*

These platforms deploy directly from GitHub or a Git push.

#### 1. Push your code to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/attendance-tracker.git
git push -u origin main
```

#### 2. Create a new app on your platform

Connect your GitHub repository. The platform detects Node.js automatically.

Set the following environment variables in the platform's dashboard:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | your MySQL connection string |
| `ADMIN_PASSWORD` | break-glass admin sign-in |
| `SESSION_SECRET` | random hex string (see [Authentication](#authentication)) |
| `NODE_ENV` | `production` |

The **start command** is:

```
node server.js
```

The **build command** is:

```
npm install
```

#### 3. Deploy

Trigger a deploy from the dashboard, or push a commit to `main` — most platforms redeploy automatically on every push.

---

## Environment Variables Reference

| Variable | Required in production | Description |
|----------|----------------------|-------------|
| `DATABASE_URL` | Yes | MySQL connection string, e.g. `mysql://user:pass@host:3306/db` |
| `ADMIN_PASSWORD` | **Yes** | **Break-glass** admin sign-in, used with no account. Your recovery path. |
| `SESSION_SECRET` | **Yes** | Random string used to sign session cookies. Changing it signs everyone out. |
| `PORT` | No | Port to listen on. Defaults to `3100`. Most hosts set this automatically. |
| `DB_PATH` | No | Path to the local JSON file. Only used when `DATABASE_URL` is not set. Defaults to `./data.json`. |
| `NODE_ENV` | **Yes** (unless `DATABASE_URL` is set) | Set to `production`. This is what forces the password checks below — it is not just a logging switch. |

The app **will not start** in production unless `ADMIN_PASSWORD` and
`SESSION_SECRET` are set. Without them you would have no way in, and sessions
would reset on every restart.

`APP_PASSWORD` is no longer used and can be removed — registration is open, and
new accounts see nothing until an admin approves them.

### Accounts and Roles

Everyone has their own account with their own password. There is no shared
password to sign in with. **Anyone may register**, but a new account starts as
**Pending** and can see nothing at all — not the roster, not a phone number —
until an admin gives it a role.

Each role includes everything below it. All three are enforced on the server, so
hiding a button is never what protects an action.

| | Pending | Viewer | Super user | Admin |
|---|:---:|:---:|:---:|:---:|
| Sign in | ✅ | ✅ | ✅ | ✅ |
| View the roster and history | | ✅ | ✅ | ✅ |
| Record attendance | | ✅ | ✅ | ✅ |
| Create / rename / delete groups | | | ✅ | ✅ |
| Add and remove group members | | | ✅ | ✅ |
| Create and edit people | | | ✅ | ✅ |
| Import people from CSV | | | ✅ | ✅ |
| Remove a person from the roster | | | | ✅ |
| Create and delete meetings | | | | ✅ |
| Manage accounts and assign roles | | | | ✅ |

Admins additionally manage accounts (**Admin → Users**): assign roles, reset
passwords, deactivate and delete.

Removing a person archives them rather than deleting them, so past attendance
keeps their name and its totals stay correct — that changes what history shows,
which is why it stays with admins. Meetings are the top-level structure, so they
stay with admins too.

**Role changes take effect immediately.** The role is read from the account on
every request rather than baked into the sign-in cookie, so promoting or
demoting someone applies to their very next action. Deactivating an account, or
resetting its password, signs that person out everywhere at once.

### Getting started on a fresh install

1. Start the app and sign in with **"Sign in with the admin password instead"**, using `ADMIN_PASSWORD`. This is the break-glass route and needs no account.
2. Go to **Admin → Users** and create an admin account for yourself.
3. Sign out, then sign in with your new account. Stop using break-glass day to day.
4. Send your leaders the app's URL. They pick *"Don't have an account? Create one"* and register themselves — no code needed.
5. **Admin → Users** shows a banner counting who is waiting. Set each to **Viewer**, **Super user** or **Admin**.

Everyone who registers starts as **Pending** and sees only a "waiting for
approval" screen. Nobody can grant themselves a role, and an unapproved account
cannot read the roster or any phone number.

If you ever lose every admin account, break-glass still works — that is what it
is for. It lives in your host's environment settings rather than the database, so
it survives data loss.

---

## Using the App

### Taking Attendance

1. Click a **meeting** on the home screen
2. Click a **group**
3. Select the **date** (defaults to today)
4. Tap each person to toggle **Present / Absent**
5. Click **Save Attendance**

### Viewing History

Click the **clock icon** in the navigation bar. Filter by meeting. Each record shows the date, percentage, and colour-coded attendance (green = present, red = absent).

### Refreshing Data

Click the **refresh icon** to pull the latest data from the server — useful when multiple people are recording attendance simultaneously.

---

## Management Panel

### Getting in

1. Click the **settings icon (⚙)** in the top navigation bar
2. Enter the **admin** or **super user** password
3. Click **Sign In** — the icon turns yellow while elevated access is active

The panel adapts to whichever password you used: admins see a **Meetings** tab
and a bin icon on each person, super users see neither. Click **Exit** to drop
back to normal access without signing out.

### Managing Groups — super user or admin

- **Add** — click **New Group**, enter a name, select a meeting, tick at least 2 members
- **Edit** — click the pencil icon
- **Delete** — click the bin icon

A person can belong to one group **per meeting** — someone can be on the Sunday
worship team and in a Friday small group, but not in two Friday groups. People
already taken for the meeting you picked are greyed out with the group that holds
them.

### Managing People — super user or admin

- **Add** — click **New Person**, fill in first name, last name, phone
- **Edit** — click the pencil icon
- **Import** — click **Import CSV** to add many at once

### Removing People — admin only

Click the bin icon. The person is removed from every group and hidden from the
roster and the pickers, but **past attendance keeps their name** and its totals
stay correct — they show in italics in History. This is why the action is
admin-only: it changes what your history reads.

### Managing Meetings — admin only

- **Add** — click **New Meeting**, enter a name and day of the week
- **Delete** — click the bin icon. All groups and attendance records for that meeting are also deleted.

---

## Authentication

Everyone signs in with **their own username and password**. Roles live on the
account and are assigned by admins, so there are as many super users as you need
— each with their own credentials.

Only one password lives in the environment, and it is not a per-person login:

| Variable | What it is |
|----------|------------|
| `ADMIN_PASSWORD` | **Break-glass** admin sign-in, used with no account at all. Your way back in if every admin account is lost. |

See [Accounts and Roles](#accounts-and-roles) for the permission matrix, and
[Getting started on a fresh install](#getting-started-on-a-fresh-install) for the
first-run steps.

Passwords are stored as **scrypt hashes with a per-user salt** — a stolen copy of
your data does not hand over anyone's password. The app never returns a salt or
hash to a browser, not even to an admin.

### Setting the passwords

Set them as environment variables on your host — never in the source files:

```
ADMIN_PASSWORD=a-strong-password
SESSION_SECRET=<random hex string>
```

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Changing a password

Update the environment variable on your host and restart the app. Existing
sessions stay valid until they expire (30 days) — to force everyone to sign in
again with the new password, change `SESSION_SECRET` at the same time.

### How sessions work

Signing in sets a `HttpOnly`, `SameSite=Lax` cookie holding an HMAC-signed
token. It carries only the role and an expiry, is signed with `SESSION_SECRET`,
and is marked `Secure` automatically when the app is served over HTTPS. Nothing
is stored server-side, so sessions survive restarts as long as
`SESSION_SECRET` stays the same.

Sign-in is rate-limited to 10 failed attempts per IP per 15 minutes.

> **Serve the app over HTTPS.** Passwords and the session cookie are sent in
> plain text over HTTP. See the nginx configuration in
> [Option A](#option-a-vps--dedicated-server-ubuntu--nginx).

---

## Troubleshooting

**App shows a red error banner**
The frontend cannot reach the server. Check the terminal/logs for errors. Confirm the server started successfully and the correct URL is being used.

**Data is lost after restarting (local only)**
Check that `data.json` exists in the project folder. If deleted, the server recreates it with seed data on next start.

**DATABASE_URL connection error**
- Verify the connection string is correct and complete
- Check whether your host requires SSL — add `?ssl={"rejectUnauthorized":true}` if so
- Confirm your MySQL database is running and the user has full permissions on the database

**Port already in use (local)**
Set `PORT=3001` in `.env`, then open [http://localhost:3001](http://localhost:3001).

**App crashes on startup**
Run `node server.js` directly and read the error message. Common causes: missing `DATABASE_URL`, wrong MySQL credentials, or MySQL server unreachable from your host.
