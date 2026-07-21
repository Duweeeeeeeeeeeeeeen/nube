-- Nube cloud database baseline.
-- Intended for Supabase/Postgres when multi-device sync is enabled.

create table if not exists nube_profiles (
  user_id text primary key,
  email text not null,
  name text not null,
  avatar_url text,
  currency text not null default 'EUR',
  city text,
  location_label text,
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists nube_captures (
  id bigint not null,
  user_id text not null references nube_profiles(user_id) on delete cascade,
  title text not null,
  body text not null default '',
  type text not null,
  source text not null,
  priority text,
  due_at timestamptz,
  completed boolean not null default false,
  starred boolean not null default false,
  metadata jsonb not null default '[]'::jsonb,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists idx_nube_captures_user_created on nube_captures(user_id, created_at desc);
create index if not exists idx_nube_captures_user_due on nube_captures(user_id, due_at);
create index if not exists idx_nube_captures_type on nube_captures(user_id, type);
create index if not exists idx_nube_captures_payload_gin on nube_captures using gin(payload);

create table if not exists nube_files (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references nube_profiles(user_id) on delete cascade,
  capture_id bigint,
  provider text not null default 'cloudflare-r2',
  bucket text,
  object_key text not null,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_nube_files_user_capture on nube_files(user_id, capture_id);

create table if not exists nube_import_batches (
  id text primary key,
  user_id text not null references nube_profiles(user_id) on delete cascade,
  provider text not null,
  title text not null,
  detail text,
  capture_ids jsonb not null default '[]'::jsonb,
  count integer not null default 0,
  skipped integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists nube_activity (
  id uuid primary key default gen_random_uuid(),
  user_id text references nube_profiles(user_id) on delete cascade,
  level text not null default 'info',
  source text not null default 'system',
  title text not null,
  detail text,
  capture_id bigint,
  created_at timestamptz not null default now()
);

create index if not exists idx_nube_activity_user_created on nube_activity(user_id, created_at desc);
