const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const createSyncRoutes = require('./sync');
const ConflictResolver = require('./conflictResolver');
const DeviceRegistry = require('./deviceRegistry');

// ---------------------------------------------------------------------------
// Configuration (env-driven so the same image works in Docker and locally)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'dlc-manager.db');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// JWT secret: env var in prod; otherwise persist a random one to DATA_DIR
// so restarts don't invalidate every issued token.
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (fs.existsSync(SECRET_FILE)) {
    JWT_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } else {
    JWT_SECRET = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SECRET_FILE, JWT_SECRET, { mode: 0o600 });
    console.warn('[warn] JWT_SECRET not set — generated one at', SECRET_FILE);
  }
}

// ---------------------------------------------------------------------------
// Database setup - Using sqlite3 (async compatible)
// ---------------------------------------------------------------------------
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('✅ Database connected');
  }
});

// Enable foreign keys
db.run('PRAGMA foreign_keys = ON');
db.run('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    ean TEXT UNIQUE,
    name TEXT NOT NULL,
    barcode TEXT,
    category TEXT DEFAULT 'Autre',
    image_uri TEXT,
    image_version INTEGER DEFAULT 0,
    initial_expiry_date TEXT,
    aisle_id INTEGER,
    version INTEGER DEFAULT 0,
    device_id TEXT DEFAULT 'server',
    is_deleted INTEGER DEFAULT 0,
    updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checks (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    ean TEXT,
    check_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ok', 'rupture')),
    next_expiry_date TEXT,
    previous_expiry_date TEXT,
    version INTEGER DEFAULT 0,
    device_id TEXT DEFAULT 'server',
    is_deleted INTEGER DEFAULT 0,
    updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS aisles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    order_index INTEGER DEFAULT 0,
    version INTEGER DEFAULT 0,
    device_id TEXT DEFAULT 'server',
    is_deleted INTEGER DEFAULT 0,
    updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS device_registry (
    device_id TEXT PRIMARY KEY,
    device_name TEXT,
    app_version TEXT,
    last_sync TEXT,
    last_sync_version INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    last_seen TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('CREATE', 'UPDATE', 'DELETE')),
    entity_id TEXT NOT NULL,
    data_before TEXT,
    data_after TEXT,
    timestamp TEXT NOT NULL,
    version INTEGER,
    synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    entity_type TEXT,
    device_a_id TEXT,
    device_a_version INTEGER,
    device_a_data TEXT,
    device_b_id TEXT,
    device_b_version INTEGER,
    device_b_data TEXT,
    resolution_strategy TEXT DEFAULT 'lww',
    chosen_version TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    synced_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_checks_date ON checks(check_date);
  CREATE INDEX IF NOT EXISTS idx_checks_product ON checks(product_id);
  CREATE INDEX IF NOT EXISTS idx_products_aisle ON products(aisle_id);
  CREATE INDEX IF NOT EXISTS idx_aisles_order ON aisles(order_index);
  CREATE INDEX IF NOT EXISTS idx_sync_history_device ON sync_history(device_id);
  CREATE INDEX IF NOT EXISTS idx_sync_history_time ON sync_history(created_at);
  CREATE INDEX IF NOT EXISTS idx_conflicts_resolved ON conflicts(resolved_at);
`);

// Seed default user if not exists
const existingUser = db.prepare('SELECT id FROM users WHERE login = ?').get('Honfleur');
if (!existingUser) {
  db.prepare('INSERT INTO users (login, password) VALUES (?, ?)').run('Honfleur', 'Honfleur');
  console.log('Default user "Honfleur" created.');
}

// ---------------------------------------------------------------------------
// Multer setup for photo uploads
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, _file, cb) => {
    const ext = '.jpg';
    cb(null, `${req.params.ean}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

// ---------------------------------------------------------------------------
// Sync Modules
// ---------------------------------------------------------------------------
const conflictResolver = new ConflictResolver(db);
const deviceRegistry = new DeviceRegistry(db);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
const syncRouter = express.Router();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Register sync routes
createSyncRoutes(syncRouter, db, conflictResolver, deviceRegistry);
app.use(syncRouter);

// Serve the Expo web bundle if it was copied in at build time
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------------------------------------------------------------------
// AUTH routes
// ---------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    return res.status(400).json({ error: 'Login and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE login = ? AND password = ?').get(login, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ userId: user.id, login: user.login }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

// ---------------------------------------------------------------------------
// PRODUCTS routes
// ---------------------------------------------------------------------------
app.get('/api/products', authenticate, (_req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  res.json(products);
});

app.post('/api/products', authenticate, (req, res) => {
  const { ean, name, initial_expiry_date } = req.body;
  if (!ean || !name) {
    return res.status(400).json({ error: 'ean and name are required' });
  }

  const existing = db.prepare('SELECT ean FROM products WHERE ean = ?').get(ean);
  if (existing) {
    db.prepare('UPDATE products SET name = ?, initial_expiry_date = ? WHERE ean = ?')
      .run(name, initial_expiry_date || null, ean);
  } else {
    db.prepare('INSERT INTO products (ean, name, initial_expiry_date, created_at) VALUES (?, ?, ?, datetime(\'now\'))')
      .run(ean, name, initial_expiry_date || null);
  }

  const product = db.prepare('SELECT * FROM products WHERE ean = ?').get(ean);
  res.json(product);
});

app.delete('/api/products/:ean', authenticate, (req, res) => {
  const { ean } = req.params;
  const existing = db.prepare('SELECT ean FROM products WHERE ean = ?').get(ean);
  if (!existing) {
    return res.status(404).json({ error: 'Product not found' });
  }

  db.prepare('DELETE FROM products WHERE ean = ?').run(ean);

  // Also remove photo if exists
  const photoPath = path.join(UPLOADS_DIR, `${ean}.jpg`);
  if (fs.existsSync(photoPath)) {
    fs.unlinkSync(photoPath);
  }

  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// CHECKS routes
// ---------------------------------------------------------------------------
app.get('/api/checks', authenticate, (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: 'date query parameter is required (YYYY-MM-DD)' });
  }

  const checks = db.prepare(`
    SELECT c.*, p.name AS product_name
    FROM checks c
    LEFT JOIN products p ON c.ean = p.ean
    WHERE c.check_date = ?
    ORDER BY c.created_at DESC
  `).all(date);

  res.json(checks);
});

app.get('/api/checks/product/:ean', authenticate, (req, res) => {
  const { ean } = req.params;
  const checks = db.prepare(`
    SELECT * FROM checks
    WHERE ean = ?
    ORDER BY check_date DESC, created_at DESC
  `).all(ean);

  res.json(checks);
});

app.post('/api/checks', authenticate, (req, res) => {
  const { ean, check_date, status, next_expiry_date } = req.body;
  if (!ean || !check_date || !status) {
    return res.status(400).json({ error: 'ean, check_date, and status are required' });
  }
  if (!['ok', 'rupture'].includes(status)) {
    return res.status(400).json({ error: 'status must be "ok" or "rupture"' });
  }

  // Verify product exists
  const product = db.prepare('SELECT ean FROM products WHERE ean = ?').get(ean);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const result = db.prepare(`
    INSERT INTO checks (ean, check_date, status, next_expiry_date, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(ean, check_date, status, next_expiry_date || null);

  const check = db.prepare('SELECT * FROM checks WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(check);
});

// ---------------------------------------------------------------------------
// PHOTOS routes
// ---------------------------------------------------------------------------
app.post('/api/photos/upload/:ean', authenticate, upload.single('photo'), (req, res) => {
  const { ean } = req.params;
  if (!req.file) {
    return res.status(400).json({ error: 'No photo file provided' });
  }

  // Verify product exists
  const product = db.prepare('SELECT ean FROM products WHERE ean = ?').get(ean);
  if (!product) {
    // Clean up uploaded file
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Product not found' });
  }

  // Increment image_version
  db.prepare('UPDATE products SET image_version = image_version + 1 WHERE ean = ?').run(ean);

  const updated = db.prepare('SELECT image_version FROM products WHERE ean = ?').get(ean);
  res.json({ success: true, image_version: updated.image_version });
});

app.get('/api/photos/:ean', authenticate, (req, res) => {
  const { ean } = req.params;
  const photoPath = path.join(UPLOADS_DIR, `${ean}.jpg`);

  if (!fs.existsSync(photoPath)) {
    return res.status(404).json({ error: 'Photo not found' });
  }

  // Get image_version for cache headers
  const product = db.prepare('SELECT image_version FROM products WHERE ean = ?').get(ean);
  const version = product ? product.image_version : 0;

  res.set({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'public, max-age=86400',
    'ETag': `"${ean}-v${version}"`,
  });

  res.sendFile(photoPath);
});

app.get('/api/photos/:ean/version', authenticate, (req, res) => {
  const { ean } = req.params;
  const product = db.prepare('SELECT image_version FROM products WHERE ean = ?').get(ean);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  res.json({ ean, image_version: product.image_version });
});

// ---------------------------------------------------------------------------
// SYNC routes
// ---------------------------------------------------------------------------
app.get('/api/sync/full', authenticate, (_req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  const checks = db.prepare('SELECT * FROM checks ORDER BY check_date DESC, created_at DESC').all();
  res.json({
    products,
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/sync/changes', authenticate, (req, res) => {
  const { since } = req.query;
  if (!since) {
    return res.status(400).json({ error: 'since query parameter is required (ISO timestamp)' });
  }

  const products = db.prepare('SELECT * FROM products WHERE created_at > ? ORDER BY name').all(since);
  const checks = db.prepare('SELECT * FROM checks WHERE created_at > ? ORDER BY check_date DESC, created_at DESC').all(since);

  res.json({
    products,
    checks,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`DLC Manager server running on http://0.0.0.0:${PORT}`);
});
