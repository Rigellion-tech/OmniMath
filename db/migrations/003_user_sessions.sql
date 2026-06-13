create table if not exists user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  title text not null default 'New math session',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_sessions_user_updated_idx
  on user_sessions (user_id, updated_at desc);
