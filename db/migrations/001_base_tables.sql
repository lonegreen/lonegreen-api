CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  service_area TEXT,
  business_hours TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE,
  password TEXT,
  role TEXT DEFAULT 'admin',
  company_id INTEGER
);

CREATE TABLE IF NOT EXISTS clients (
  id SERIAL PRIMARY KEY,
  name TEXT,
  phone TEXT,
  address TEXT,
  zip TEXT,
  notes TEXT,
  company_id INTEGER
);

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  client_id INTEGER,
  service TEXT,
  type TEXT,
  date DATE,
  start_time TEXT,
  end_time TEXT,
  status TEXT DEFAULT 'scheduled',
  worker_id INTEGER,
  price INTEGER DEFAULT 0,
  company_id INTEGER
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  client_id INTEGER,
  service TEXT,
  frequency TEXT,
  next_date DATE,
  price INTEGER,
  worker_id INTEGER,
  status TEXT DEFAULT 'active',
  company_id INTEGER
);

CREATE TABLE IF NOT EXISTS workers (
  id SERIAL PRIMARY KEY,
  name TEXT,
  company_id INTEGER
);

CREATE TABLE IF NOT EXISTS zip_groups (
  id SERIAL PRIMARY KEY,
  name TEXT,
  day INTEGER,
  company_id INTEGER
);

CREATE TABLE IF NOT EXISTS zip_codes (
  id SERIAL PRIMARY KEY,
  zip TEXT,
  group_id INTEGER,
  company_id INTEGER
);

CREATE TABLE IF NOT EXISTS estimates (
  id SERIAL PRIMARY KEY,
  client_id INTEGER,
  service TEXT,
  status TEXT DEFAULT 'draft',
  quoted_price INTEGER DEFAULT 0,
  visit_date DATE,
  notes TEXT,
  company_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
