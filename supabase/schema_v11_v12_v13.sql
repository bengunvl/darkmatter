-- DarkMatter schema migrations v11 + v12 + v13
-- Run this entire file in the Supabase SQL editor
-- Safe to run multiple times (IF NOT EXISTS throughout)

-- First: add agent_id to commits if it does not exist
-- The original schema used from_agent/to_agent; agent_id is the canonical column
-- used by all dashboard queries and server code from v4 onward.
alter table commits
  add column if not exists agent_id text references agents(agent_id);

-- Backfill agent_id from to_agent where null
update commits set agent_id = to_agent
  where agent_id is null and to_agent is not null;

create index if not exists commits_agent_id_idx
  on commits(agent_id, timestamp desc);

-- v11: commit_content (full text/HTML for conversation reconstruction)
create table if not exists commit_content (
  id               text primary key,
  format           text not null default 'text',
  text_content     text,
  html_content     text,
  prompt_text      text,
  prompt_html      text,
  token_count      integer,
  char_count       integer,
  has_images       boolean default false,
  has_code         boolean default false,
  has_tables       boolean default false,
  storage_provider text default 'inline',
  created_at       timestamptz default now()
);

-- v11: commit_attachments (images, code blocks, files)
create table if not exists commit_attachments (
  id               text primary key,
  commit_id        text references commits(id) on delete cascade,
  type             text not null,
  storage_provider text default 'inline',
  storage_bucket   text,
  storage_key      text,
  public_url       text,
  mime_type        text,
  size_bytes       integer,
  filename         text,
  language         text,
  inline_content   text,
  position         integer,
  metadata         jsonb default '{}',
  created_at       timestamptz default now()
);

create index if not exists commit_attachments_commit_idx
  on commit_attachments(commit_id);

-- v11: conversation_threads
create table if not exists conversation_threads (
  id           text primary key,
  platform     text not null,
  platform_url text,
  title        text,
  user_id      uuid references auth.users(id) on delete cascade,
  root_ctx_id  text,
  tip_ctx_id   text,
  turn_count   integer default 0,
  models_used  text[],
  total_tokens integer default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists conv_threads_user_idx
  on conversation_threads(user_id, updated_at desc);

create index if not exists conv_threads_platform_idx
  on conversation_threads(platform);

-- v12: agent_policies
create table if not exists agent_policies (
  id          text primary key,
  agent_id    text not null references agents(agent_id) on delete cascade,
  name        text not null,
  description text,
  condition   text not null,
  action      text not null default 'flag',
  message     text,
  enabled     boolean default true,
  created_at  timestamptz default now()
);

create index if not exists agent_policies_agent_idx
  on agent_policies(agent_id);

-- v13: Add platform/conv_id columns to commits for faster dashboard filtering
alter table commits
  add column if not exists platform   text,
  add column if not exists conv_id    text,
  add column if not exists actor_role text;

create index if not exists commits_platform_idx
  on commits(agent_id, platform);

create index if not exists commits_conv_idx
  on commits(conv_id);

-- Enable RLS
alter table commit_content       enable row level security;
alter table commit_attachments   enable row level security;
alter table conversation_threads enable row level security;
alter table agent_policies       enable row level security;

-- Drop policies before recreating to avoid duplicate errors
drop policy if exists "Users see own content"     on commit_content;
drop policy if exists "Users see own attachments" on commit_attachments;
drop policy if exists "Users see own threads"     on conversation_threads;
drop policy if exists "Users manage own policies" on agent_policies;

-- RLS: use agent_id column (now exists on commits)
create policy "Users see own content" on commit_content
  for all using (
    id in (
      select c.id from commits c
      join agents a on c.agent_id = a.agent_id
      where a.user_id = auth.uid()
    )
  );

create policy "Users see own attachments" on commit_attachments
  for all using (
    commit_id in (
      select c.id from commits c
      join agents a on c.agent_id = a.agent_id
      where a.user_id = auth.uid()
    )
  );

create policy "Users see own threads" on conversation_threads
  for all using (user_id = auth.uid());

create policy "Users manage own policies" on agent_policies
  for all using (
    agent_id in (
      select agent_id from agents
      where user_id = auth.uid()
    )
  );
