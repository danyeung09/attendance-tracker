const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, ShadingType,
  AlignmentType,
} = require('docx');
const fs = require('fs');

const BLUE    = '2E74B5';
const DKGREY  = '595959';
const BLACK   = '000000';
const WHITE   = 'FFFFFF';
const CODE_BG = 'F5F5F5';
const TIP_BG  = 'EAF3FB';
const WARN_BG = 'FFF8E1';

// ── helpers ──────────────────────────────────────────────────────────────────

const spacer = () => new Paragraph({ spacing: { after: 160 }, children: [] });

const para = (text, opts = {}) => new Paragraph({
  spacing: { after: 120 },
  children: [new TextRun({ text, size: 20, color: BLACK, ...opts })],
});

const bullet = (text, level = 0) => new Paragraph({
  bullet: { level },
  spacing: { after: 80 },
  children: [new TextRun({ text, size: 20, color: BLACK })],
});

const step = (num, text) => new Paragraph({
  spacing: { after: 120 },
  children: [
    new TextRun({ text: `${num}. `, bold: true, size: 20, color: BLUE }),
    new TextRun({ text, size: 20, color: BLACK }),
  ],
});

const labelLine = (label, value) => new Paragraph({
  spacing: { after: 100 },
  children: [
    new TextRun({ text: label, bold: true, size: 20 }),
    new TextRun({ text: value, size: 20 }),
  ],
});

const codeBlock = lines => [
  ...lines.map(line => new Paragraph({
    spacing: { before: 0, after: 0 },
    shading: { type: ShadingType.SOLID, fill: CODE_BG },
    children: [new TextRun({ text: line || ' ', font: 'Courier New', size: 18, color: '1F3864' })],
  })),
  spacer(),
];

const callout = (fill, labelText, labelColor, bodyText) => new Paragraph({
  spacing: { before: 120, after: 160 },
  indent: { left: 360 },
  shading: { type: ShadingType.SOLID, fill },
  children: [
    new TextRun({ text: labelText + ' ', bold: true, size: 20, color: labelColor }),
    new TextRun({ text: bodyText, size: 20, color: DKGREY }),
  ],
});

const note = text => callout(TIP_BG,  'Tip:',  BLUE,    text);
const warn = text => callout(WARN_BG, 'Note:', 'B45309', text);

// ── table helpers ─────────────────────────────────────────────────────────────

const hCell = text => new TableCell({
  shading: { type: ShadingType.SOLID, fill: BLUE },
  children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: WHITE, size: 20 })] })],
});

const dCell = (text, mono = false) => new TableCell({
  children: [new Paragraph({ children: [new TextRun({ text, size: 20, font: mono ? 'Courier New' : undefined })] })],
});

const twoColTable = (headers, rows) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [
    new TableRow({ children: headers.map(h => hCell(h)) }),
    ...rows.map(cells => new TableRow({ children: cells.map(([t, mono]) => dCell(t, mono)) })),
  ],
});

// Centred cell, for the yes/no columns of the permission matrix.
const tickCell = text => new TableCell({
  children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text, size: 20, bold: text === 'Yes', color: text === 'Yes' ? '15803D' : DKGREY })],
  })],
});

// First column is a left-aligned label; the rest are centred Yes/— cells.
const matrixTable = (headers, rows) => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [
    new TableRow({ children: headers.map(h => hCell(h)) }),
    ...rows.map(([label, ...ticks]) => new TableRow({
      children: [dCell(label), ...ticks.map(t => tickCell(t))],
    })),
  ],
});

// ── h1 / h2 ───────────────────────────────────────────────────────────────────

const h1 = text => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 320, after: 160 },
  children: [new TextRun({ text, color: BLUE, bold: true, size: 28 })],
});

const h2 = text => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 200, after: 120 },
  children: [new TextRun({ text, color: DKGREY, bold: true, size: 22 })],
});

const h3 = text => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 160, after: 100 },
  children: [new TextRun({ text, color: DKGREY, bold: true, size: 20 })],
});

// ═══════════════════════════════════════════════════════════════════════════════
// Document content
// ═══════════════════════════════════════════════════════════════════════════════

const children = [

  // ── Title ──────────────────────────────────────────────────────────────────
  new Paragraph({
    heading: HeadingLevel.TITLE,
    spacing: { after: 200 },
    shading: { type: ShadingType.SOLID, fill: BLUE },
    children: [new TextRun({ text: 'Attendance Tracker — Setup Guide', color: WHITE, size: 36, bold: true })],
  }),
  para('A web application for tracking attendance across meetings and groups. Data is stored in a local data.json file for local development — no database server required. In production the app connects to a MySQL database via the DATABASE_URL environment variable.'),
  spacer(),

  // ── 1. Prerequisites ───────────────────────────────────────────────────────
  h1('1. Prerequisites'),
  twoColTable(
    ['Tool', 'Check', 'Install'],
    [
      [['Node.js (v18+)', false], ['node --version', true], ['nodejs.org', false]],
      [['npm', false],           ['npm --version', true],  ['Comes with Node.js', false]],
      [['Git', false],           ['git --version', true],  ['git-scm.com', false]],
    ]
  ),
  spacer(),
  para('For local testing, no additional accounts are needed.'),
  para('For production deployment, you will also need:'),
  bullet('A hosting account that supports Node.js 18+'),
  bullet('A MySQL 8.0+ database (provided by your host or a separate service)'),
  spacer(),

  // ── 2. Local Development ───────────────────────────────────────────────────
  h1('2. Local Development'),

  h2('Step 1 — Install dependencies'),
  ...codeBlock(['npm install']),

  h2('Step 2 — (Optional) Create an environment file'),
  ...codeBlock([
    '# Windows',
    'copy .env.example .env',
    '',
    '# Mac / Linux',
    'cp .env.example .env',
  ]),
  para('Defaults (leave DATABASE_URL unset — the app uses data.json locally):'),
  ...codeBlock(['DB_PATH=./data.json', 'PORT=3000']),
  para('If you leave the authentication values unset for local development, the app falls back to built-in development credentials and prints a warning at startup:'),
  ...codeBlock([
    '⚠  DEVELOPMENT AUTH DEFAULTS IN USE — ADMIN_PASSWORD, SESSION_SECRET not set.',
    '   admin password: "admin1234"  (break-glass admin sign-in)',
    '   Sessions reset on restart. Never deploy without setting these.',
  ]),
  warn('These defaults are hardcoded in the source, so they are public. They work only for local development — if DATABASE_URL or NODE_ENV=production is set, the app refuses to start until you supply real values.'),
  note('Because SESSION_SECRET is regenerated on every restart when unset, you will be signed out each time you restart the server locally. Accounts themselves are not affected.'),

  h2('Step 3 — Start the server'),
  ...codeBlock(['node server.js']),
  para('You should see:'),
  ...codeBlock(['Attendance Tracker running on port 3000']),
  warn('Without a .env file the app listens on port 3100, not 3000.'),

  h2('Step 4 — Open the app'),
  para('Go to http://localhost:3000 in your browser. On a brand-new database the app is seeded with sample meetings, groups and people. Press Ctrl + C to stop.'),
  para('There are no user accounts on a fresh install, so your first sign-in uses the break-glass admin password — see section 6, Accounts and Roles.'),
  spacer(),

  // ── 3. Production Deployment ───────────────────────────────────────────────
  h1('3. Production Deployment'),

  h2('What Your Host Must Support'),
  twoColTable(
    ['Requirement', 'Details'],
    [
      [['Node.js 18+',                       false], ['The app\'s runtime', false]],
      [['npm',                                false], ['To install dependencies', false]],
      [['MySQL database',                     false], ['To store data persistently', false]],
      [['Custom environment variables',       false], ['To pass DATABASE_URL and PORT', false]],
      [['Custom start command',               false], ['node server.js', true]],
    ]
  ),
  spacer(),
  note('The app creates the database table automatically on first boot — no manual SQL setup needed.'),

  // Step 1: Get a MySQL database
  h2('Step 1 — Get a MySQL Database'),
  para('Your MySQL database can come from one of these sources:'),

  h3('Option 1 — Your hosting company (simplest)'),
  para('Many hosts (Hostinger, Bluehost, SiteGround, etc.) include a MySQL database in their plans. Create one from your control panel and note the host, port, database name, username, and password.'),

  h3('Option 2 — PlanetScale (free, always-on)'),
  step(1, 'Go to planetscale.com and sign up.'),
  step(2, 'Click Create a new database → name it attendance-tracker.'),
  step(3, 'Click Connect → select Node.js → copy the connection string:'),
  ...codeBlock(['mysql://username:password@host.aws.connect.psdb.cloud/attendance-tracker?ssl={"rejectUnauthorized":true}']),

  h3('Option 3 — Railway (free tier)'),
  step(1, 'Go to railway.app and sign up.'),
  step(2, 'Click New Project → Provision MySQL.'),
  step(3, 'Go to the MySQL service → Variables → copy MYSQL_URL.'),
  spacer(),

  para('Build your DATABASE_URL in this format:'),
  ...codeBlock(['mysql://DB_USER:DB_PASSWORD@DB_HOST:3306/DB_NAME']),
  para('If your provider requires SSL, append:'),
  ...codeBlock(['?ssl={"rejectUnauthorized":true}']),

  // Step 2: Prepare files
  h2('Step 2 — Prepare Your Files'),
  para('On your local machine, install production dependencies:'),
  ...codeBlock(['npm install --omit=dev']),
  para('Create a .env file with your production values (keep this file on the server only — never commit it to Git):'),
  ...codeBlock([
    'DATABASE_URL=mysql://user:password@host:3306/dbname',
    'PORT=3000',
    'NODE_ENV=production',
    'ADMIN_PASSWORD=a-strong-password',
    'SESSION_SECRET=<paste the generated hex string>',
  ]),

  // Option A: VPS
  h2('Option A — VPS / Cloud Server'),
  para('Examples: DigitalOcean, Linode, AWS EC2, Vultr, Hetzner'),

  h3('1. Connect to your server'),
  ...codeBlock(['ssh root@YOUR_SERVER_IP']),

  h3('2. Install Node.js'),
  ...codeBlock([
    'curl -fsSL https://deb.nodesource.com/setup_20.x | bash -',
    'apt-get install -y nodejs',
  ]),

  h3('3. Upload your project files'),
  para('Using SCP from your local machine:'),
  ...codeBlock(['scp -r ./attendance-tracker root@YOUR_SERVER_IP:/var/www/attendance-tracker']),
  para('Or using Git (on the server):'),
  ...codeBlock(['git clone https://github.com/YOUR_USERNAME/attendance-tracker.git /var/www/attendance-tracker']),

  h3('4. Install dependencies on the server'),
  ...codeBlock([
    'cd /var/www/attendance-tracker',
    'npm install --omit=dev',
  ]),

  h3('5. Create .env on the server'),
  ...codeBlock([
    'nano /var/www/attendance-tracker/.env',
    '',
    '# Add:',
    'DATABASE_URL=mysql://user:password@host:3306/dbname',
    'PORT=3000',
    'NODE_ENV=production',
    'ADMIN_PASSWORD=a-strong-password',
    'SESSION_SECRET=<paste the generated hex string>',
  ]),

  h3('6. Run with PM2 (keeps the app alive)'),
  ...codeBlock([
    'npm install -g pm2',
    'pm2 start server.js --name attendance-tracker',
    'pm2 save',
    'pm2 startup',
  ]),

  h3('7. (Optional) Nginx reverse proxy for port 80/443'),
  ...codeBlock([
    'apt-get install -y nginx',
  ]),
  para('Create /etc/nginx/sites-available/attendance-tracker:'),
  ...codeBlock([
    'server {',
    '    listen 80;',
    '    server_name yourdomain.com;',
    '',
    '    location / {',
    '        proxy_pass         http://localhost:3000;',
    '        proxy_http_version 1.1;',
    '        proxy_set_header   Upgrade $http_upgrade;',
    '        proxy_set_header   Connection \'upgrade\';',
    '        proxy_set_header   Host $host;',
    '        proxy_cache_bypass $http_upgrade;',
    '    }',
    '}',
  ]),
  ...codeBlock([
    'ln -s /etc/nginx/sites-available/attendance-tracker /etc/nginx/sites-enabled/',
    'nginx -t && systemctl reload nginx',
  ]),

  // Option B: cPanel
  h2('Option B — cPanel / Plesk Shared Hosting'),
  para('Examples: Hostinger, Bluehost, SiteGround, Namecheap'),

  h3('1. Enable Node.js in your control panel'),
  bullet('Log in to cPanel or Plesk'),
  bullet('Find Node.js or Setup Node.js App'),
  bullet('Click Create Application and fill in:'),
  bullet('Node.js version: 18 or higher', 1),
  bullet('Application mode: Production', 1),
  bullet('Application root: the folder where you will upload files', 1),
  bullet('Application startup file: server.js', 1),
  spacer(),

  h3('2. Upload your files'),
  para('Use the File Manager in cPanel or an FTP client (FileZilla) to upload all project files except node_modules/ and data.json to the application root folder.'),

  h3('3. Install dependencies'),
  para('In the Node.js app panel, click Run NPM Install. Or open the terminal and run:'),
  ...codeBlock(['npm install --omit=dev']),

  h3('4. Set environment variables'),
  para('In the Node.js app panel, find Environment Variables and add:'),
  twoColTable(
    ['Key', 'Value'],
    [
      [['DATABASE_URL',   true],  ['your MySQL connection string', false]],
      [['ADMIN_PASSWORD', true],  ['break-glass admin sign-in', false]],
      [['SESSION_SECRET', true],  ['random hex string (see section 4)', false]],
      [['NODE_ENV',       true],  ['production', false]],
    ]
  ),
  spacer(),
  warn("Leave PORT unset — cPanel/Plesk assigns it automatically via the PORT environment variable, which the app already reads."),

  h3('5. Start the application'),
  para('Click Start App in the Node.js panel. Your app will be accessible at the domain or subdomain you configured.'),
  spacer(),

  // Option C: PaaS
  h2('Option C — PaaS Platform'),
  para('Examples: Railway, Fly.io, Heroku, Cyclic'),

  h3('1. Push your code to GitHub'),
  ...codeBlock([
    'git init',
    'git add .',
    'git commit -m "Initial commit"',
    'git branch -M main',
    'git remote add origin https://github.com/YOUR_USERNAME/attendance-tracker.git',
    'git push -u origin main',
  ]),

  h3('2. Create a new app and set environment variables'),
  para('Connect your GitHub repository from the platform dashboard. Then add:'),
  twoColTable(
    ['Key', 'Value'],
    [
      [['DATABASE_URL', true], ['your MySQL connection string', false]],
      [['NODE_ENV',     true], ['production', false]],
    ]
  ),
  spacer(),

  h3('3. Set build and start commands'),
  twoColTable(
    ['Command', 'Value'],
    [
      [['Build command', false],  ['npm install', true]],
      [['Start command', false],  ['node server.js', true]],
    ]
  ),
  spacer(),

  h3('4. Deploy'),
  para('Trigger a deploy from the dashboard. Most platforms also redeploy automatically on every push to main.'),
  spacer(),

  // ── 4. Environment Variables Reference ─────────────────────────────────────
  h1('4. Environment Variables Reference'),
  twoColTable(
    ['Variable', 'Required in production', 'Description'],
    [
      [['DATABASE_URL',   true], ['Yes', false], ['MySQL connection string, e.g. mysql://user:pass@host:3306/db', false]],
      [['ADMIN_PASSWORD', true], ['Yes', false], ['Break-glass admin sign-in, used with no account. Your recovery path if every admin account is lost.', false]],
      [['SESSION_SECRET', true], ['Yes', false], ['Random string used to sign session cookies. Changing it signs everyone out.', false]],
      [['PORT',           true], ['No',  false], ['Port to listen on. Defaults to 3100. Most hosts set this automatically.', false]],
      [['DB_PATH',        true], ['No',  false], ['Path to the local JSON file. Used only when DATABASE_URL is not set.', false]],
      [['NODE_ENV',       true], ['Yes (unless DATABASE_URL is set)', false], ['Set to production. This is what enforces the checks above — it is not just a logging switch.', false]],
    ]
  ),
  spacer(),
  para('Generate a session secret with:'),
  ...codeBlock(['node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"']),
  warn('The app will not start in production unless ADMIN_PASSWORD and SESSION_SECRET are both set. Without them you would have no way in, and every session would reset on each restart.'),
  note('APP_PASSWORD was used by earlier versions and is no longer read. You can safely remove it from your host configuration.'),
  spacer(),

  // ── 5. Using the App ────────────────────────────────────────────────────────
  h1('5. Using the App'),

  h2('Taking Attendance'),
  step(1, 'Click a meeting on the home screen.'),
  step(2, 'Click a group.'),
  step(3, 'Select the date (defaults to today).'),
  step(4, 'Tap each person to toggle Present / Absent. Use All Present or All Absent to mark everyone at once.'),
  step(5, 'Click Save Attendance.'),
  spacer(),
  note('If someone else recorded the same group and date while you were working, you will see "Someone else saved this session first" with both totals and two choices: Use their version, or Replace with mine. Nothing is overwritten until you pick — the two of you cannot silently wipe out each other\'s work.'),

  h2('Viewing History'),
  para('Click the clock icon in the navigation bar. Filter by meeting. Each record shows the date, percentage, and colour-coded attendance (green = present, red = absent).'),
  para('People who have since been removed from the roster still appear on the records they were part of, shown in italics, so historical percentages stay accurate.'),
  spacer(),

  // ── 6. Accounts and Roles ───────────────────────────────────────────────────
  h1('6. Accounts and Roles'),
  para('Everyone has their own account with their own username and password. There is no shared password to sign in with. Roles are assigned by admins, so you can have as many super users as you need, each with their own credentials.'),

  h2('How someone joins'),
  para('Anyone who can reach the app may create an account — no invitation code is needed. A new account starts as Pending, which grants nothing at all: they can sign in, but they see only a "Waiting for approval" screen. No roster, no phone numbers, no history. An admin then gives the account a role.'),
  note('This is what makes open registration safe. Because a stranger who registers can see nothing, you can share the address freely and approve the people you recognise.'),

  h2('The four roles'),
  para('Each role includes everything the one before it can do. All four are enforced on the server, so hiding a button is never what protects an action.'),
  matrixTable(
    ['Can they…', 'Pending', 'Viewer', 'Super user', 'Admin'],
    [
      ['Sign in',                            'Yes', 'Yes', 'Yes', 'Yes'],
      ['View the roster and history',        '—',   'Yes', 'Yes', 'Yes'],
      ['Record attendance',                  '—',   'Yes', 'Yes', 'Yes'],
      ['Create / rename / delete groups',    '—',   '—',   'Yes', 'Yes'],
      ['Add and remove group members',       '—',   '—',   'Yes', 'Yes'],
      ['Create and edit people',             '—',   '—',   'Yes', 'Yes'],
      ['Import people from CSV',             '—',   '—',   'Yes', 'Yes'],
      ['Remove a person from the roster',    '—',   '—',   '—',   'Yes'],
      ['Create and delete meetings',         '—',   '—',   '—',   'Yes'],
      ['Manage accounts and assign roles',   '—',   '—',   '—',   'Yes'],
    ]
  ),
  spacer(),
  para('Removing a person archives them rather than deleting them: past attendance keeps their name and its totals stay correct. Because that changes what your history reads, it is restricted to admins. Meetings are the top-level structure, so they are admin-only too.'),
  note('Role changes take effect immediately. The role is read from the account on every request rather than stored in the sign-in cookie, so promoting or demoting someone applies to their very next action — they do not need to sign out and back in.'),

  h2('Setting up a fresh install'),
  step(1, 'Start the app and open it in a browser. On the sign-in screen choose "Sign in with the admin password instead" and enter your ADMIN_PASSWORD. This is the break-glass route and needs no account.'),
  step(2, 'Go to the ⚙ Manage screen, open the Users tab, and click New User to create an admin account for yourself.'),
  step(3, 'Sign out, then sign in with your new account. Stop using break-glass for day-to-day work.'),
  step(4, 'Send your leaders the address of the app. They choose "Don\'t have an account? Create one" and register themselves.'),
  step(5, 'In Users you will see a banner counting who is waiting. Set each person to Viewer, Super user or Admin using the dropdown on their row.'),
  spacer(),

  h2('Managing accounts (admins)'),
  para('The Users tab lists every account. For each one you can:'),
  bullet('Change the role using the dropdown — Pending, Viewer, Super user or Admin'),
  bullet('Reset password — sets a new password and signs that person out on every device'),
  bullet('Deactivate — blocks sign-in and ends their current sessions, but keeps the account'),
  bullet('Delete (bin icon) — removes the account permanently. Attendance they recorded is not affected.'),
  spacer(),
  warn('You cannot demote, deactivate or delete the last remaining active admin. Promote someone else first. This is deliberate, so you cannot lock every administrator out of the app.'),

  h2('Changing your own password'),
  para('Click the key icon in the navigation bar. You must enter your current password to set a new one. Other devices signed in as you are signed out; the device you used stays signed in.'),
  spacer(),

  h2('If you are locked out'),
  para('The break-glass admin password (ADMIN_PASSWORD) always works and cannot be deleted or deactivated, because it lives in your host\'s environment settings rather than in the database. Use it to sign in and repair the accounts.'),
  note('Changing ADMIN_PASSWORD immediately invalidates any existing break-glass session. Normal account sessions are unaffected.'),
  spacer(),

  // ── 7. Management Panel ─────────────────────────────────────────────────────
  h1('7. Managing Groups, People and Meetings'),
  para('Click the ⚙ icon in the navigation bar. The screen adapts to your role: admins see Meetings and Users tabs and a bin icon on each person; super users see neither. A viewer who opens it is told they need an admin to grant them access.'),

  h2('Managing Groups — super user or admin'),
  bullet('Add — click New Group, enter a name, select a meeting, tick the members'),
  bullet('Edit — click the pencil icon'),
  bullet('Delete — click the bin icon'),
  para('A person can belong to one group per meeting. Someone can be on the Sunday worship team and in a Friday small group, but not in two Friday groups. People already taken for the meeting you selected appear greyed out, labelled with the group that holds them.'),
  spacer(),

  h2('Managing People — super user or admin'),
  bullet('Add — click New Person, fill in first name, last name and phone'),
  bullet('Edit — click the pencil icon'),
  bullet('Import — click Import CSV to add many people at once'),
  spacer(),

  h2('Removing People — admin only'),
  para('Click the bin icon. The person is removed from every group and disappears from the roster and the pickers, but past attendance keeps their name and its percentages stay correct — they appear in italics in History. This is why the action is limited to admins: it changes what your records read.'),
  spacer(),

  h2('Managing Meetings — admin only'),
  bullet('Add — click New Meeting, enter a name and day of the week'),
  bullet('Delete — click the bin icon. All groups and attendance records for that meeting are also deleted.'),
  spacer(),

  // ── 8. Troubleshooting ──────────────────────────────────────────────────────
  h1('8. Troubleshooting'),

  labelLine('"Waiting for approval" after registering: ', 'This is expected. A new account has no access until an admin assigns it a role in the Users tab. Ask an admin to approve you.'),
  spacer(),
  labelLine('"No management access" when opening the ⚙ screen: ', 'Your account is a Viewer. Ask an admin to make you a Super user if you need to manage groups and people. There is no password to enter — roles come from your account.'),
  spacer(),
  labelLine('Signed out every time the server restarts (local only): ', 'SESSION_SECRET is not set, so it is regenerated on each start. Set it in .env to keep sessions across restarts.'),
  spacer(),
  labelLine('Nobody can sign in as an admin: ', 'Use "Sign in with the admin password instead" on the sign-in screen with your ADMIN_PASSWORD, then repair the accounts in the Users tab.'),
  spacer(),
  labelLine('"Someone else saved this session first": ', 'Two people recorded the same group and date at once. Nothing has been overwritten — choose "Use their version" or "Replace with mine".'),
  spacer(),
  labelLine('App shows a red error banner: ', 'The frontend cannot reach the server. Check the terminal/logs for errors. Confirm the server started successfully and the correct URL is being used.'),
  spacer(),
  labelLine('Refusing to start: missing required environment variable(s): ', 'ADMIN_PASSWORD or SESSION_SECRET is not set while NODE_ENV=production or DATABASE_URL is present. Set them in your host\'s environment settings.'),
  spacer(),
  labelLine('Data is lost after restarting (local only): ', 'Check that data.json exists in the project folder. If deleted, the server recreates it with seed data on next start.'),
  spacer(),
  labelLine('DATABASE_URL connection error: ', 'Verify the connection string is correct. Check whether your host requires SSL and add ?ssl={"rejectUnauthorized":true} if so. Confirm the MySQL database is running and the user has full permissions.'),
  spacer(),
  labelLine('Port already in use (local): ', 'Set PORT=3001 in .env and open http://localhost:3001.'),
  spacer(),
  labelLine('App crashes on startup: ', 'Run node server.js directly and read the error message. Common causes: missing DATABASE_URL, wrong MySQL credentials, or MySQL server unreachable from the host.'),
];

// ─── Build & write ────────────────────────────────────────────────────────────
const doc = new Document({
  styles: {
    default: { document: { run: { font: 'Calibri', size: 20 } } },
  },
  sections: [{ properties: {}, children }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('SETUP.docx', buf);
  console.log('SETUP.docx created successfully');
});
