create table if not exists usage_limits (
  usage_date date not null,
  identity_key text not null,
  identity_provider text not null default 'anonymous' check (identity_provider in ('anonymous', 'clerk', 'signed_header')),
  clerk_user_id text,
  identity_tier text not null check (identity_tier in ('anonymous', 'free', 'pro')),
  usage_kind text not null check (usage_kind in ('explanation', 'image')),
  usage_count integer not null default 0 check (usage_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (usage_date, identity_key, usage_kind)
);

create index if not exists usage_limits_identity_idx
  on usage_limits (identity_key, usage_date);
