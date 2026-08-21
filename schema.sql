-- Mount It Right — full schema (Phase 1: accounts, claim workflow, chat, receipts)
-- Run this against your D1 database. Safe to re-run (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  password_hash TEXT NOT NULL,   -- format: pbkdf2$<saltHex>$<hashHex>
  role TEXT NOT NULL DEFAULT 'master', -- 'admin' | 'master'
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'online',   -- 'online' | 'phone' | 'manual'

  -- Which service this booking is for. Only 'tv_mounting' exists today —
  -- this column just reserves the room to add 'cleaning', 'handyman', etc.
  -- later without a schema migration.
  service_category TEXT NOT NULL DEFAULT 'tv_mounting',

  -- 'new' -> 'claimed' -> 'en_route' -> 'completed'  (or 'cancelled' at any point)
  status TEXT NOT NULL DEFAULT 'new',

  address TEXT, lat REAL, lng REAL, in_service_area INTEGER,

  dismount TEXT, size TEXT, bracket TEXT, wall TEXT, wires TEXT,
  addons TEXT,            -- JSON array
  total_price INTEGER,    -- quoted price from the booking flow

  booking_date TEXT, booking_time TEXT,
  name TEXT, phone TEXT, notes TEXT,

  claimed_by INTEGER,     -- users.id of the master who accepted the job
  claimed_at TEXT,

  departed_at TEXT,
  eta_text TEXT,          -- e.g. '9:00-9:30 AM'

  completed_at TEXT,
  payment_method TEXT,    -- 'cash' | 'card' | 'other'
  actual_total INTEGER,   -- final price if it changed on site (falls back to total_price)
  master_earning INTEGER, -- computed payout for the master on this job

  receipt_token TEXT,     -- random token used in the public receipt link

  -- Full structured list of every TV on this booking, e.g.
  -- [{"size":"size_51_65","dismount":"dismount_yes","bracket":"bracket_fixed","wall":"wall_standard","wires":"wires_exposed"}, ...]
  -- The columns above (dismount/size/bracket/wall/wires) always mirror the
  -- highest-priced TV in this list, for anything that only reads one TV.
  tvs_json TEXT,

  -- Straight-line distance (miles) from the master's location at the moment
  -- they hit "Departed" to the job address. Rough by design (internal stats
  -- only, not for tax filing) — computed once in depart.js, never updated.
  distance_miles REAL,

  -- Whether the client opted in to receive SMS updates. Booking always
  -- succeeds regardless of this value — consent must never gate the
  -- transaction (Twilio toll-free verification requirement).
  sms_consent INTEGER DEFAULT 0,

  FOREIGN KEY(claimed_by) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_claimed_by ON bookings(claimed_by);
CREATE INDEX IF NOT EXISTS idx_bookings_receipt_token ON bookings(receipt_token);

-- In-app chat, one thread per booking (admin <-> master)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(booking_id) REFERENCES bookings(id),
  FOREIGN KEY(sender_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_booking ON messages(booking_id);

-- Extra phone numbers / emails that get pinged on every new booking,
-- on top of whatever's set in the Pages environment variables.
CREATE TABLE IF NOT EXISTS notify_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,     -- 'sms' | 'email'
  value TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- Pending invitations — any admin can invite a new admin or master.
-- The invited person clicks a link and sets their own password.
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'master', -- 'admin' | 'master'
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(created_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
