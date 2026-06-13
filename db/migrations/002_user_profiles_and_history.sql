create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null unique,
  email text,
  display_name text,
  image_url text,
  tier text not null default 'free' check (tier in ('free', 'pro')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists app_users_clerk_user_id_idx
  on app_users (clerk_user_id);

create table if not exists user_explanations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  source text not null check (source in ('text', 'image')),
  title text,
  original_problem text,
  expression text,
  final_answer text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists user_explanations_user_created_idx
  on user_explanations (user_id, created_at desc);
