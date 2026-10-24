-- rwp-chat database schema.
--
-- Installed by the Plugins screen (POST /api/plugins/install-schema) when the plugin is
-- activated, never by supabase/schema.sql: a site that never enables the chatbot does not get
-- these five tables. This file is the only copy of that schema — the Plugins screen inlines it —
-- so a site that prefers the SQL Editor pastes this same file in. Safe to re-run.
--
-- Who can see what
-- ----------------
-- A visitor is usually anonymous, so there is no auth.uid() to write a policy against. Every
-- anonymous read and write therefore goes through a SECURITY DEFINER function that takes the
-- session's own secret token (chat_sessions.session_token, 48 hex characters from
-- gen_random_bytes). RLS refuses anon direct access to all five tables outright — including
-- select, because a readable chat_sessions row is a list of every lead's email and phone number.
-- The token is handed to the browser once, when the session is created, and kept in
-- localStorage; losing it just starts a new conversation.
--
-- Staff read and write through ordinary RLS: moderate_comments for the inbox (Editor, Shop
-- Manager, Administrator) and manage_options for the settings and the credentials.
--
-- Credentials
-- -----------
-- public.options is world-readable (the public site reads site_title before anyone signs in), so
-- a Telegram bot token or a WhatsApp API key must never go in it. They live in chat_secrets,
-- which anon and authenticated can never select; the server reads it with SUPABASE_SECRET_KEY.
-- Everything harmless (bot name, welcome message, which channel is on, the public wa.me number)
-- stays in chat_* option rows so the public widget can read it without an extra round trip.
--
-- Shop, and anything else with products
-- -------------------------------------
-- This plugin never references a shop object. A product card and an order lookup are resolved by
-- name at run time, the way core resolves engagement targets:
--
--   public.rwp_chat_card_<type>(p_id text) returns jsonb
--   public.rwp_chat_order_status(p_order_key text, p_email text) returns jsonb
--
-- rwp-shop creates both (plugins/rwp-shop/schema.sql) and drops them in its uninstall.sql. On a
-- site without the shop the dispatchers below simply return null, and the widget hides the
-- product card and the order tracker.

-- 1. Tables -----------------------------------------------------------------------------------

-- The visitor's key to their own conversation: 64 hex characters, 244 bits of randomness.
--
-- Built from two gen_random_uuid() calls rather than from encode(gen_random_bytes(24), 'hex'),
-- which would be the obvious way to write it. gen_random_bytes belongs to pgcrypto, and Supabase
-- installs pgcrypto into the `extensions` schema, not `public` — so it is unresolvable from a
-- function pinned to `set search_path = public`, which every function here is, and the insert
-- fails with "function gen_random_bytes(integer) does not exist". gen_random_uuid() has been a
-- core pg_catalog function since PostgreSQL 13 and is found whatever the search path is.
create or replace function public.rwp_chat_new_token()
returns text language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  -- The visitor's own capability to reach this conversation again. Never selectable by anon.
  session_token text not null unique default public.rwp_chat_new_token(),
  user_id uuid references auth.users(id) on delete set null,
  visitor_name text,
  visitor_email text,
  visitor_phone text,
  status text not null default 'active',
  current_page_url text not null default '',
  -- What the visitor was looking at. No foreign key on purpose: 'page' ids are bigint and the
  -- shop's product ids are uuid, exactly as core's engagement tables do it.
  context_type text,
  context_id text,
  locale text not null default 'en',
  -- Which member of staff picked the conversation up, for the inbox.
  assigned_to uuid references public.profiles(id) on delete set null,
  message_count integer not null default 0,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- An install made before rwp_chat_new_token() existed has the old
-- `encode(gen_random_bytes(24), 'hex')` default. That one does still work — a column default is
-- resolved when the table is created, with the session's search path, which on Supabase includes
-- `extensions` — but it is the odd one out now, so a re-run converges it.
alter table public.chat_sessions alter column session_token set default public.rwp_chat_new_token();

-- Older installs of this plugin had product_id uuid; context_type/context_id replaced it so that
-- a page, a post or a plugin's own object can be the subject too. Migrated here, not dropped, so
-- a re-run on a site that already has data keeps it.
alter table public.chat_sessions add column if not exists context_type text;
alter table public.chat_sessions add column if not exists context_id text;
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'chat_sessions' and column_name = 'product_id'
  ) then
    execute $m$
      update public.chat_sessions
         set context_type = coalesce(context_type, 'product'), context_id = coalesce(context_id, product_id::text)
       where product_id is not null
    $m$;
    execute 'alter table public.chat_sessions drop column product_id';
  end if;
end $$;

alter table public.chat_sessions drop constraint if exists chat_sessions_status_check;
alter table public.chat_sessions add constraint chat_sessions_status_check
  check (status in ('active', 'agent_requested', 'closed'));

alter table public.chat_sessions drop constraint if exists chat_sessions_context_check;
alter table public.chat_sessions add constraint chat_sessions_context_check
  check (
    (context_type is null and context_id is null)
    or (context_type ~ '^[a-z][a-z0-9_]{1,30}$' and char_length(context_id) between 1 and 64)
  );

-- Lead fields are what the pre-chat form collects. Bounded so a script cannot store an essay.
alter table public.chat_sessions drop constraint if exists chat_sessions_visitor_check;
alter table public.chat_sessions add constraint chat_sessions_visitor_check
  check (
    char_length(coalesce(visitor_name, '')) <= 120
    and char_length(coalesce(visitor_email, '')) <= 200
    and char_length(coalesce(visitor_phone, '')) <= 40
    and char_length(current_page_url) <= 500
    and char_length(locale) between 2 and 12
  );

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  sender_type text not null,
  sender_id uuid references auth.users(id) on delete set null,
  message text not null default '',
  -- [{ "url", "name", "mime_type", "bytes", "width", "height", "media_id" }]
  attachments jsonb not null default '[]'::jsonb,
  -- { "kind": "product_card", "card": { … } } and similar. Rendered by ChatMessage.tsx.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.chat_messages drop constraint if exists chat_messages_sender_type_check;
alter table public.chat_messages add constraint chat_messages_sender_type_check
  check (sender_type in ('user', 'agent', 'bot', 'system'));

alter table public.chat_messages drop constraint if exists chat_messages_size_check;
alter table public.chat_messages add constraint chat_messages_size_check
  check (
    char_length(message) <= 8000
    and jsonb_typeof(attachments) = 'array'
    and jsonb_typeof(metadata) = 'object'
    and pg_column_size(attachments) <= 16384
    and pg_column_size(metadata) <= 16384
  );

-- A message with neither text nor a file is noise in the transcript.
alter table public.chat_messages drop constraint if exists chat_messages_not_empty_check;
alter table public.chat_messages add constraint chat_messages_not_empty_check
  check (btrim(message) <> '' or jsonb_array_length(attachments) > 0);

create table if not exists public.live_agent_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  channel text not null,
  status text not null default 'pending',
  -- Whether the notification actually left the server, and why it did not. Never a credential.
  delivery text not null default 'pending',
  delivery_error text,
  handled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.live_agent_requests drop constraint if exists live_agent_requests_channel_check;
alter table public.live_agent_requests add constraint live_agent_requests_channel_check
  check (channel in ('internal', 'telegram', 'whatsapp_redirect', 'whatsapp_api'));

alter table public.live_agent_requests drop constraint if exists live_agent_requests_status_check;
alter table public.live_agent_requests add constraint live_agent_requests_status_check
  check (status in ('pending', 'accepted', 'resolved'));

alter table public.live_agent_requests drop constraint if exists live_agent_requests_delivery_check;
alter table public.live_agent_requests add constraint live_agent_requests_delivery_check
  check (delivery in ('pending', 'sent', 'failed', 'not_applicable') and char_length(coalesce(delivery_error, '')) <= 500);

create table if not exists public.chat_canned_responses (
  id uuid primary key default gen_random_uuid(),
  shortcut text not null,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.chat_canned_responses drop constraint if exists chat_canned_responses_shortcut_check;
alter table public.chat_canned_responses add constraint chat_canned_responses_shortcut_check
  check (shortcut = btrim(shortcut) and char_length(shortcut) between 1 and 60 and char_length(content) between 1 and 4000);

create unique index if not exists chat_canned_responses_shortcut_idx on public.chat_canned_responses (lower(shortcut));

-- Credentials for the live-agent channels. One row, id = true, so there is nothing to choose
-- between. Never readable by anon or authenticated: only the server (secret key) and the SQL
-- Editor can select it, and manage_options writes it through rwp_chat_save_secrets().
create table if not exists public.chat_secrets (
  id boolean primary key default true check (id),
  telegram_bot_token text not null default '',
  telegram_chat_id text not null default '',
  whatsapp_api_url text not null default '',
  whatsapp_api_token text not null default '',
  whatsapp_api_instance text not null default '',
  whatsapp_admin_number text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

insert into public.chat_secrets (id) values (true) on conflict (id) do nothing;

-- The knowledge base. These two tables are created here, in the tables section, rather than in
-- section 8 with the triggers that maintain them: section 7 turns RLS on them and attaches four
-- policies, and a policy cannot be dropped or created for a table that does not exist yet, which
-- would stop the whole file on a fresh install. Section 8 explains the design and does the work.
create table if not exists public.chat_knowledge_base (
  id bigint generated by default as identity primary key,
  -- Where this entry came from. 'page:12' for a scraped CMS page, 'manual:<uuid>' for something an
  -- administrator typed, 'file:<uuid>' for an uploaded document. Stable across syncs.
  source_type varchar(20) not null check (source_type in ('scraped', 'manual', 'file')),
  source_key text not null,
  title text not null default '',
  -- The public page this entry belongs to, or null for a manual entry / uploaded file.
  url text,
  content text not null default '',
  excerpt text not null default '',
  -- Only 'published' is quoted to the model. 'draft' is being written; 'archived' is no longer on
  -- the site (or no longer wanted) and is kept as a record until an administrator deletes it.
  status varchar(20) not null default 'published' check (status in ('published', 'draft', 'archived')),
  -- Page id, checksum, refinement history, original filename: anything the scraper learned that a
  -- human might need later. Never quoted to the model.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- What makes a sync idempotent: PostgREST's on_conflict=source_type,source_key resolves to this.
create unique index if not exists chat_knowledge_base_source_idx
  on public.chat_knowledge_base (source_type, source_key);
create index if not exists chat_knowledge_base_list_idx
  on public.chat_knowledge_base (status, source_type, updated_at desc);
create index if not exists chat_knowledge_base_updated_idx
  on public.chat_knowledge_base (updated_at desc);

create table if not exists public.chat_knowledge_chunks (
  id bigint generated by default as identity primary key,
  entry_id bigint not null references public.chat_knowledge_base(id) on delete cascade,
  -- 1, 2, 3… within one entry, so a passage can be traced back to its row in the admin screen.
  part integer not null,
  content text not null,
  -- to_tsvector(regconfig, text) is immutable, so this may be stored and indexed.
  search tsvector generated always as (to_tsvector('simple', coalesce(content, ''))) stored,
  constraint chat_knowledge_chunks_part_unique unique (entry_id, part)
);

create index if not exists chat_knowledge_chunks_search_idx
  on public.chat_knowledge_chunks using gin (search);

-- 2. Indexes ----------------------------------------------------------------------------------

create index if not exists chat_sessions_status_idx on public.chat_sessions (status, last_message_at desc nulls last);
create index if not exists chat_sessions_user_idx on public.chat_sessions (user_id) where user_id is not null;
create index if not exists chat_sessions_context_idx on public.chat_sessions (context_type, context_id);
-- The CRM filters by lead email and phone.
create index if not exists chat_sessions_email_idx on public.chat_sessions (lower(visitor_email)) where visitor_email is not null;
create index if not exists chat_sessions_phone_idx on public.chat_sessions (visitor_phone) where visitor_phone is not null;
create index if not exists chat_messages_session_idx on public.chat_messages (session_id, created_at);
create index if not exists live_agent_requests_session_idx on public.live_agent_requests (session_id, created_at desc);
create index if not exists live_agent_requests_status_idx on public.live_agent_requests (status, created_at desc);

-- 3. Session bookkeeping ------------------------------------------------------------------------

-- message_count and last_message_at are shown in the inbox, so the database maintains them: a
-- browser clock that is wrong would sort the queue wrongly, and a client that forgets to update
-- them would hide a waiting visitor.
create or replace function public.chat_messages_touch_session()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.chat_sessions
     set message_count = message_count + 1,
         last_message_at = new.created_at,
         updated_at = now()
   where id = new.session_id;
  return null;
end;
$$;

drop trigger if exists chat_messages_touch_session on public.chat_messages;
create trigger chat_messages_touch_session
  after insert on public.chat_messages
  for each row execute function public.chat_messages_touch_session();

create or replace function public.chat_sessions_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
    -- The token is the visitor's only key to this conversation; a caller must not choose it.
    new.session_token := public.rwp_chat_new_token();
    new.message_count := 0;
  else
    new.created_at := old.created_at;
    new.session_token := old.session_token;
  end if;
  new.visitor_email := nullif(lower(btrim(coalesce(new.visitor_email, ''))), '');
  new.visitor_name := nullif(btrim(coalesce(new.visitor_name, '')), '');
  new.visitor_phone := nullif(btrim(coalesce(new.visitor_phone, '')), '');
  return new;
end;
$$;

drop trigger if exists chat_sessions_touch on public.chat_sessions;
create trigger chat_sessions_touch
  before insert or update on public.chat_sessions
  for each row execute function public.chat_sessions_touch();

create or replace function public.live_agent_requests_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.created_at := old.created_at; end if;
  return new;
end;
$$;

drop trigger if exists live_agent_requests_touch on public.live_agent_requests;
create trigger live_agent_requests_touch
  before insert or update on public.live_agent_requests
  for each row execute function public.live_agent_requests_touch();

drop trigger if exists chat_canned_responses_touch on public.chat_canned_responses;
create trigger chat_canned_responses_touch
  before insert or update on public.chat_canned_responses
  for each row execute function public.live_agent_requests_touch();

-- 4. Context dispatchers -------------------------------------------------------------------------

-- A card for whatever the visitor is looking at, or that the bot wants to show in the stream.
-- Core's rwp_engagement_target already answers for 'page' and (with the shop) 'product', so this
-- falls back to it and only prefers rwp_chat_card_<type> when a plugin ships a richer card (the
-- shop adds price, stock and an add-to-cart link).
create or replace function public.rwp_chat_card(p_type text, p_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if p_type is null or p_type !~ '^[a-z][a-z0-9_]{1,30}$'
     or p_id is null or char_length(p_id) not between 1 and 64 then
    return null;
  end if;
  if to_regprocedure(format('public.rwp_chat_card_%s(text)', p_type)) is not null then
    execute format('select public.%I($1)', 'rwp_chat_card_' || p_type) into v_result using p_id;
    if v_result is not null then
      return v_result || jsonb_build_object('type', p_type, 'id', p_id);
    end if;
  end if;
  if to_regprocedure('public.rwp_engagement_target(text, text)') is not null then
    select public.rwp_engagement_target(p_type, p_id) into v_result;
    if v_result is not null then
      return v_result || jsonb_build_object('type', p_type, 'id', p_id);
    end if;
  end if;
  return null;
end;
$$;

-- Order tracking. The lookup is by order key plus the email on the order, so knowing a key alone
-- is not enough: order keys appear in confirmation emails and browser history. rwp-shop provides
-- the implementation; without it this returns null and the widget hides the tracker.
create or replace function public.rwp_chat_track_order(p_order_key text, p_email text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_result jsonb;
begin
  if coalesce(btrim(p_order_key), '') = '' or coalesce(btrim(p_email), '') = ''
     or char_length(p_order_key) > 120 or char_length(p_email) > 200 then
    return null;
  end if;
  if to_regprocedure('public.rwp_chat_order_status(text, text)') is null then
    return null;
  end if;
  execute 'select public.rwp_chat_order_status($1, $2)'
    into v_result using btrim(p_order_key), lower(btrim(p_email));
  return v_result;
end;
$$;

-- 5. The visitor API -----------------------------------------------------------------------------
-- Anonymous visitors reach their own conversation only through these. Each one re-checks the
-- token, so a guessed session id is useless.

create or replace function public.rwp_chat_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select o.option_value not in ('false', '0', '') from public.options o where o.option_name = 'chat_enabled'),
    true
  );
$$;

-- The session behind a token, or an exception. Internal: revoked from everyone below.
create or replace function public.rwp_chat_session(p_session uuid, p_token text)
returns public.chat_sessions language plpgsql stable security definer set search_path = public as $$
declare
  v_row public.chat_sessions;
begin
  select * into v_row from public.chat_sessions s where s.id = p_session;
  -- Compared in full rather than short-circuiting on the id, so a wrong token and an unknown
  -- session are one message: neither tells a prober which of the two it was.
  if v_row.id is null or p_token is null or v_row.session_token <> p_token then
    raise exception using errcode = '42501',
      message = 'This chat session could not be found, or the link to it has expired. Start a new conversation.';
  end if;
  return v_row;
end;
$$;

/**
 * Starts a conversation and returns { session_id, token, status, greeting_context }.
 *
 * p_payload: { name, email, phone, page_url, context_type, context_id, locale }
 * The lead fields come from the pre-chat form and are optional; which of them are required is a
 * matter for the form, not the database, because a site may turn the form off entirely.
 */
create or replace function public.rwp_chat_start(p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_row public.chat_sessions;
  v_type text := nullif(btrim(coalesce(p_payload->>'context_type', '')), '');
  v_id text := nullif(btrim(coalesce(p_payload->>'context_id', '')), '');
begin
  if not public.rwp_chat_enabled() then
    raise exception using errcode = '42501', message = 'Live chat is switched off for this site.';
  end if;
  -- An unknown context is dropped rather than refused: the page the visitor is on must never
  -- stop them from asking a question.
  if v_type is null or v_type !~ '^[a-z][a-z0-9_]{1,30}$' or v_id is null or char_length(v_id) > 64 then
    v_type := null;
    v_id := null;
  end if;

  insert into public.chat_sessions (
    user_id, visitor_name, visitor_email, visitor_phone, current_page_url, context_type, context_id, locale
  ) values (
    auth.uid(),
    left(coalesce(p_payload->>'name', ''), 120),
    left(coalesce(p_payload->>'email', ''), 200),
    left(coalesce(p_payload->>'phone', ''), 40),
    left(coalesce(p_payload->>'page_url', ''), 500),
    v_type,
    v_id,
    coalesce(nullif(left(coalesce(p_payload->>'locale', ''), 12), ''), 'en')
  )
  returning * into v_row;

  return jsonb_build_object(
    'session_id', v_row.id,
    'token', v_row.session_token,
    'status', v_row.status,
    'card', public.rwp_chat_card(v_type, v_id)
  );
end;
$$;

/** Adds the visitor's own message. Returns the stored row. */
create or replace function public.rwp_chat_post(p_session uuid, p_token text, p_message text, p_attachments jsonb default '[]'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_session public.chat_sessions;
  v_row public.chat_messages;
  v_recent integer;
begin
  v_session := public.rwp_chat_session(p_session, p_token);
  if v_session.status = 'closed' then
    raise exception using errcode = '42501',
      message = 'This conversation has been closed. Start a new one to carry on.';
  end if;

  -- One visitor cannot flood the transcript (or the AI quota behind it).
  select count(*) into v_recent
    from public.chat_messages m
   where m.session_id = p_session and m.sender_type = 'user' and m.created_at > now() - interval '1 minute';
  if v_recent >= 20 then
    raise exception using errcode = '53400',
      message = 'You are sending messages faster than the chat accepts them. Wait a few seconds and try again.';
  end if;

  insert into public.chat_messages (session_id, sender_type, sender_id, message, attachments)
  values (
    p_session, 'user', auth.uid(), left(coalesce(p_message, ''), 8000),
    case when jsonb_typeof(p_attachments) = 'array' then p_attachments else '[]'::jsonb end
  )
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

/** The transcript, oldest first. p_after fetches only what is newer, for polling. */
create or replace function public.rwp_chat_history(p_session uuid, p_token text, p_after timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_session public.chat_sessions;
begin
  v_session := public.rwp_chat_session(p_session, p_token);
  return jsonb_build_object(
    'status', v_session.status,
    'messages', coalesce((
      select jsonb_agg(to_jsonb(m) - 'sender_id' order by m.created_at)
        from public.chat_messages m
       where m.session_id = p_session
         and (p_after is null or m.created_at > p_after)
    ), '[]'::jsonb)
  );
end;
$$;

/** Saves lead details captured after the conversation started ("leave your email"). */
create or replace function public.rwp_chat_identify(p_session uuid, p_token text, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_session public.chat_sessions;
begin
  v_session := public.rwp_chat_session(p_session, p_token);
  update public.chat_sessions s
     set visitor_name = coalesce(nullif(left(coalesce(p_payload->>'name', ''), 120), ''), s.visitor_name),
         visitor_email = coalesce(nullif(left(coalesce(p_payload->>'email', ''), 200), ''), s.visitor_email),
         visitor_phone = coalesce(nullif(left(coalesce(p_payload->>'phone', ''), 40), ''), s.visitor_phone)
   where s.id = p_session;
  return jsonb_build_object('ok', true);
end;
$$;

/**
 * Asks for a human. Marks the session and records the request; the notification itself is sent by
 * the server (plugins/rwp-chat/serverAgents.mjs), which owns the credentials.
 */
create or replace function public.rwp_chat_request_agent(p_session uuid, p_token text, p_channel text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_session public.chat_sessions;
  v_row public.live_agent_requests;
  v_channel text := coalesce(p_channel, 'internal');
begin
  v_session := public.rwp_chat_session(p_session, p_token);
  if v_channel not in ('internal', 'telegram', 'whatsapp_redirect', 'whatsapp_api') then
    v_channel := 'internal';
  end if;

  -- One open request per session: pressing the button twice must not page the team twice.
  select * into v_row
    from public.live_agent_requests r
   where r.session_id = p_session and r.status = 'pending'
   order by r.created_at desc limit 1;

  if v_row.id is null then
    insert into public.live_agent_requests (session_id, channel)
    values (p_session, v_channel)
    returning * into v_row;
  end if;

  update public.chat_sessions s set status = 'agent_requested' where s.id = p_session and s.status <> 'closed';

  insert into public.chat_messages (session_id, sender_type, message, metadata)
  values (p_session, 'system', 'The visitor asked to speak to a person.', jsonb_build_object('kind', 'agent_requested', 'channel', v_channel));

  return jsonb_build_object('request_id', v_row.id, 'channel', v_row.channel, 'status', v_row.status);
end;
$$;

/** Closes the conversation from the visitor's side. */
create or replace function public.rwp_chat_close(p_session uuid, p_token text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.rwp_chat_session(p_session, p_token);
  update public.chat_sessions s set status = 'closed' where s.id = p_session;
  return jsonb_build_object('ok', true);
end;
$$;

-- 6. The staff API -------------------------------------------------------------------------------

/** Writes the settings that must not be public. Values left null keep what is stored. */
create or replace function public.rwp_chat_save_secrets(p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.user_has_cap('manage_options') then
    raise exception using errcode = '42501',
      message = 'Saving the chat credentials needs the “Manage settings” capability (Administrator), and your role does not have it.';
  end if;
  update public.chat_secrets s set
    telegram_bot_token = left(coalesce(p_payload->>'telegram_bot_token', s.telegram_bot_token), 200),
    telegram_chat_id = left(coalesce(p_payload->>'telegram_chat_id', s.telegram_chat_id), 100),
    whatsapp_api_url = left(coalesce(p_payload->>'whatsapp_api_url', s.whatsapp_api_url), 500),
    whatsapp_api_token = left(coalesce(p_payload->>'whatsapp_api_token', s.whatsapp_api_token), 400),
    whatsapp_api_instance = left(coalesce(p_payload->>'whatsapp_api_instance', s.whatsapp_api_instance), 100),
    whatsapp_admin_number = left(coalesce(p_payload->>'whatsapp_admin_number', s.whatsapp_admin_number), 40),
    updated_at = now(),
    updated_by = auth.uid()
  where s.id;
  return public.rwp_chat_secrets_status();
end;
$$;

/**
 * Whether each credential is set — never its value, the same rule the setup checklist follows.
 * The WhatsApp number is returned in full: it is a public "message us" link on the widget.
 */
create or replace function public.rwp_chat_secrets_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_row public.chat_secrets;
begin
  if not public.user_has_cap('manage_options') then
    raise exception using errcode = '42501',
      message = 'Viewing the chat credentials status needs the “Manage settings” capability (Administrator).';
  end if;
  select * into v_row from public.chat_secrets limit 1;
  return jsonb_build_object(
    'telegram_bot_token', coalesce(v_row.telegram_bot_token, '') <> '',
    'telegram_chat_id', coalesce(v_row.telegram_chat_id, '') <> '',
    'whatsapp_api_url', coalesce(v_row.whatsapp_api_url, '') <> '',
    'whatsapp_api_token', coalesce(v_row.whatsapp_api_token, '') <> '',
    'whatsapp_api_instance', coalesce(v_row.whatsapp_api_instance, ''),
    'whatsapp_admin_number', coalesce(v_row.whatsapp_admin_number, ''),
    'updated_at', v_row.updated_at
  );
end;
$$;

-- 7. Row level security ----------------------------------------------------------------------------

alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.live_agent_requests enable row level security;
alter table public.chat_canned_responses enable row level security;
alter table public.chat_secrets enable row level security;

-- chat_sessions: staff, plus a signed-in visitor reading back their own conversations. Anonymous
-- visitors get nothing here and use the token functions above.
drop policy if exists "Chat staff read sessions" on public.chat_sessions;
create policy "Chat staff read sessions"
  on public.chat_sessions for select to authenticated
  using (public.user_has_cap('moderate_comments') or user_id = auth.uid());

drop policy if exists "Chat staff update sessions" on public.chat_sessions;
create policy "Chat staff update sessions"
  on public.chat_sessions for update to authenticated
  using (public.user_has_cap('moderate_comments'))
  with check (public.user_has_cap('moderate_comments'));

drop policy if exists "Chat managers delete sessions" on public.chat_sessions;
create policy "Chat managers delete sessions"
  on public.chat_sessions for delete to authenticated
  using (public.user_has_cap('manage_options'));

drop policy if exists "Chat staff read messages" on public.chat_messages;
create policy "Chat staff read messages"
  on public.chat_messages for select to authenticated
  using (
    public.user_has_cap('moderate_comments')
    or exists (select 1 from public.chat_sessions s where s.id = session_id and s.user_id = auth.uid())
  );

-- An agent replies as themselves. sender_type is pinned to 'agent' so a member of staff cannot
-- post a line that looks like it came from the visitor.
drop policy if exists "Chat staff reply" on public.chat_messages;
create policy "Chat staff reply"
  on public.chat_messages for insert to authenticated
  with check (public.user_has_cap('moderate_comments') and sender_type = 'agent' and sender_id = auth.uid());

drop policy if exists "Chat managers delete messages" on public.chat_messages;
create policy "Chat managers delete messages"
  on public.chat_messages for delete to authenticated
  using (public.user_has_cap('manage_options'));

drop policy if exists "Chat staff read agent requests" on public.live_agent_requests;
create policy "Chat staff read agent requests"
  on public.live_agent_requests for select to authenticated
  using (public.user_has_cap('moderate_comments'));

drop policy if exists "Chat staff update agent requests" on public.live_agent_requests;
create policy "Chat staff update agent requests"
  on public.live_agent_requests for update to authenticated
  using (public.user_has_cap('moderate_comments'))
  with check (public.user_has_cap('moderate_comments'));

-- Canned responses are typed by agents into the inbox, so every agent reads them and
-- manage_options curates the list.
drop policy if exists "Chat staff read canned responses" on public.chat_canned_responses;
create policy "Chat staff read canned responses"
  on public.chat_canned_responses for select to authenticated
  using (public.user_has_cap('moderate_comments'));

drop policy if exists "Chat managers write canned responses" on public.chat_canned_responses;
create policy "Chat managers write canned responses"
  on public.chat_canned_responses for all to authenticated
  using (public.user_has_cap('manage_options'))
  with check (public.user_has_cap('manage_options'));

-- The knowledge base is an administrator's working document, not public content: a draft entry can
-- hold an unpublished price, and an archived one is kept only as a record. manage_options reads and
-- writes it; the assistant and every visitor read published passages through
-- rwp_chat_knowledge_search, which bypasses these policies deliberately and returns nothing else.
drop policy if exists "Chat managers read the knowledge base" on public.chat_knowledge_base;
create policy "Chat managers read the knowledge base"
  on public.chat_knowledge_base for select to authenticated
  using (public.user_has_cap('manage_options'));

drop policy if exists "Chat managers add knowledge" on public.chat_knowledge_base;
create policy "Chat managers add knowledge"
  on public.chat_knowledge_base for insert to authenticated
  with check (public.user_has_cap('manage_options'));

drop policy if exists "Chat managers edit knowledge" on public.chat_knowledge_base;
create policy "Chat managers edit knowledge"
  on public.chat_knowledge_base for update to authenticated
  using (public.user_has_cap('manage_options'))
  with check (public.user_has_cap('manage_options'));

drop policy if exists "Chat managers delete knowledge" on public.chat_knowledge_base;
create policy "Chat managers delete knowledge"
  on public.chat_knowledge_base for delete to authenticated
  using (public.user_has_cap('manage_options'));

-- chat_knowledge_chunks deliberately has no policy: RLS is on and nothing is granted, so only the
-- SECURITY DEFINER functions that maintain and search it can see a passage.
alter table public.chat_knowledge_chunks enable row level security;

-- chat_secrets has no policy at all on purpose: with RLS on and nothing granted, neither anon nor
-- authenticated can read a token even by accident. The server uses the secret key, which bypasses
-- RLS, and the admin screen goes through rwp_chat_save_secrets / rwp_chat_secrets_status.
drop policy if exists "Chat managers read secrets" on public.chat_secrets;
drop policy if exists "Chat managers write secrets" on public.chat_secrets;

-- 8. Knowledge base ---------------------------------------------------------------------------

-- The chatbot answers from two corpora, curated differently.
--
--   scraped   published CMS pages and posts, pulled by the admin screen's Sync button. source_key
--             is the page id ("page:12"), so a second sync updates the row the first one created
--             instead of duplicating the site. A page that has been unpublished since is archived,
--             never deleted: text an administrator may have refined stays until they say so.
--   manual    text an administrator wrote: a policy, a delivery table, the answer to a question
--             the site never put on a page. There is no URL, so the assistant is told to answer
--             without citing one.
--   file      the text of an uploaded document (.docx, .txt, .md, .csv, .html, .json), extracted in
--             the administrator's browser — nothing is uploaded, and a PDF is refused rather than
--             turned into fragments — then reviewed and corrected in the admin screen.
--
-- chat_knowledge_chunks is derived and never edited by hand: a trigger re-splits a row's content
-- into overlapping passages whenever the text changes. Retrieval matches passages rather than
-- whole documents, because the answer to a question is one paragraph of a long article — matching
-- the article and quoting its first 700 characters answers a question nobody asked.
--
-- Neither table is readable by anon. The assistant asks rwp_chat_knowledge_search, which runs as
-- the owner and returns only published passages, so the row count and every draft stay private.
--
-- Both tables are created in section 1, above the policies that guard them; from here on this file
-- only maintains what is in them.

-- Normalises a row and maintains updated_at, the same division of labour chat_sessions_touch uses:
-- a browser clock that is wrong cannot reorder the list, and a caller cannot choose created_at.
create or replace function public.chat_knowledge_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.source_key := btrim(coalesce(new.source_key, ''));
  if new.source_key = '' then
    raise exception 'A knowledge base entry needs a source_key (page:<id>, manual:<uuid> or file:<uuid>).';
  end if;
  new.title := left(btrim(coalesce(new.title, '')), 300);
  new.url := nullif(btrim(coalesce(new.url, '')), '');
  -- 200,000 characters is far more than any page or document this feature is for; the ceiling
  -- exists so one paste cannot turn every retrieval query into a scan of a novel.
  new.content := left(coalesce(new.content, ''), 200000);
  new.excerpt := left(
    coalesce(nullif(btrim(new.excerpt), ''), left(regexp_replace(new.content, '\s+', ' ', 'g'), 400)),
    600
  );
  return new;
end;
$$;

drop trigger if exists chat_knowledge_base_touch on public.chat_knowledge_base;
create trigger chat_knowledge_base_touch
  before insert or update on public.chat_knowledge_base
  for each row execute function public.chat_knowledge_touch();

-- Re-splits one entry into passages. Called by the trigger below, so every write path — the Sync
-- button, the admin screen, a future importer that talks to PostgREST directly — is chunked the
-- same way. 1,500 characters is roughly a page of prose: long enough to hold the answer to a
-- question, short enough that its own words describe what it is about. Windows start 1,200
-- characters apart, so 300 characters overlap and a sentence on a boundary is quoted whole by the
-- passage on either side.
create or replace function public.chat_knowledge_rechunk(p_entry_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_content text;
  v_length integer;
  v_position integer := 1;
  v_piece text;
  v_part integer := 0;
  c_window constant integer := 1500;
  c_step constant integer := 1200;
begin
  delete from public.chat_knowledge_chunks where entry_id = p_entry_id;
  select content into v_content from public.chat_knowledge_base where id = p_entry_id;
  v_content := btrim(coalesce(v_content, ''));
  if v_content = '' then
    return;
  end if;
  v_length := char_length(v_content);
  while v_position <= v_length loop
    v_piece := substr(v_content, v_position, c_window);
    if v_position + c_window <= v_length then
      -- Trim the half word the window ended on. A window with nothing but one enormous token
      -- (base64, a minified asset) is left alone rather than emptied.
      v_piece := regexp_replace(v_piece, '\s+\S*$', '');
      if char_length(v_piece) < 60 then
        v_piece := substr(v_content, v_position, c_window);
      end if;
    end if;
    if btrim(v_piece) <> '' then
      v_part := v_part + 1;
      insert into public.chat_knowledge_chunks (entry_id, part, content)
      values (p_entry_id, v_part, btrim(v_piece));
    end if;
    v_position := v_position + c_step;
  end loop;
end;
$$;

create or replace function public.chat_knowledge_after_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Only the text matters: renaming a page or archiving it must not pay to re-split 50,000
  -- characters, and a status change is read from the base row at query time anyway.
  if tg_op = 'INSERT' then
    perform public.chat_knowledge_rechunk(new.id);
  elsif new.content is distinct from old.content then
    perform public.chat_knowledge_rechunk(new.id);
  end if;
  return null;
end;
$$;

drop trigger if exists chat_knowledge_base_after_change on public.chat_knowledge_base;
create trigger chat_knowledge_base_after_change
  after insert or update on public.chat_knowledge_base
  for each row execute function public.chat_knowledge_after_change();

-- What the assistant quotes for one word of a question.
--
-- SECURITY DEFINER rather than a policy that makes published rows readable by anon: the search
-- term and the limit are the only things a caller chooses, and the function can only ever return
-- published passages. Drafts and archived pages stay secrets even from someone who knows the
-- table's name.
--
-- Ranking is ts_rank over the 'simple' configuration, so no stemming is assumed and a site in any
-- language is searched the same way. A prefix match ('cost' matching 'costs') and a plain
-- substring fallback keep it useful for the words full-text search misses, such as an order code
-- or a product name written without spaces.
create or replace function public.rwp_chat_knowledge_search(p_query text, p_limit integer default 6)
returns table (
  entry_id bigint,
  part integer,
  title text,
  url text,
  source_type text,
  content text,
  rank real
) language sql stable security definer set search_path = public as $$
  with asked as (
    select nullif(btrim(coalesce(p_query, '')), '') as term
  ),
  hits as (
    select
      c.entry_id,
      c.part,
      b.title,
      b.url,
      b.source_type,
      left(c.content, 2000) as content,
      ts_rank(c.search, websearch_to_tsquery('simple', q.term)) as rank,
      row_number() over (
        partition by c.entry_id
        order by ts_rank(c.search, websearch_to_tsquery('simple', q.term)) desc
      ) as place
    from public.chat_knowledge_chunks c
    join public.chat_knowledge_base b on b.id = c.entry_id
    cross join asked q
    where b.status = 'published'
      and q.term is not null
      and (
        c.search @@ websearch_to_tsquery('simple', q.term)
        or c.search @@ to_tsquery(
          'simple',
          nullif(regexp_replace(q.term, '[^[:alnum:]]+', '', 'g'), '') || ':*'
        )
        or c.content ilike '%' || q.term || '%'
      )
  )
  select entry_id, part, title, url, source_type, content, rank
    from hits
   where place = 1
   order by rank desc nulls last, title
   limit least(greatest(coalesce(p_limit, 6), 1), 12);
$$;

-- The counts the admin screen shows. One round trip, and behind manage_options, because the table
-- itself is not readable by any browser.
create or replace function public.rwp_chat_knowledge_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.user_has_cap('manage_options') then
    raise exception 'Only administrators can read the knowledge base statistics.'
      using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'total', count(*),
      'published', count(*) filter (where status = 'published'),
      'draft', count(*) filter (where status = 'draft'),
      'archived', count(*) filter (where status = 'archived'),
      'scraped', count(*) filter (where source_type = 'scraped'),
      'manual', count(*) filter (where source_type = 'manual'),
      'file', count(*) filter (where source_type = 'file'),
      'characters', coalesce(sum(char_length(content)), 0),
      'chunks', (select count(*) from public.chat_knowledge_chunks),
      'updated_at', max(updated_at)
    ) from public.chat_knowledge_base
  );
end;
$$;

-- 9. Grants ------------------------------------------------------------------------------------------

revoke all on table public.chat_secrets from anon, authenticated;

revoke all on table public.chat_sessions from anon;
revoke all on table public.chat_messages from anon;
revoke all on table public.live_agent_requests from anon;
revoke all on table public.chat_canned_responses from anon;

-- Passages are never read directly by a browser: the search function runs as the owner. Revoking
-- authenticated as well as anon means a signed-in administrator cannot list every chunk of every
-- draft, and the only way in is a query term.
revoke all on table public.chat_knowledge_base from anon;
revoke all on table public.chat_knowledge_chunks from anon, authenticated;

grant select on table public.chat_sessions to authenticated;
grant update, delete on table public.chat_sessions to authenticated;
grant select, insert, delete on table public.chat_messages to authenticated;
grant select, update on table public.live_agent_requests to authenticated;
grant select, insert, update, delete on table public.chat_canned_responses to authenticated;
grant select, insert, update, delete on table public.chat_knowledge_base to authenticated;

-- New public functions are executable by anon by default (Supabase default privileges), so the
-- internal helpers are revoked explicitly and only the visitor API is granted back.
-- Only ever called by the owner: the column default and the trigger both run inside
-- rwp_chat_start, which is SECURITY DEFINER, and nothing else may insert into chat_sessions.
revoke execute on function public.rwp_chat_new_token() from public, anon, authenticated;
revoke execute on function public.rwp_chat_session(uuid, text) from public, anon, authenticated;
revoke execute on function public.rwp_chat_enabled() from public;
revoke execute on function public.rwp_chat_card(text, text) from public;
revoke execute on function public.rwp_chat_track_order(text, text) from public;
revoke execute on function public.rwp_chat_start(jsonb) from public;
revoke execute on function public.rwp_chat_post(uuid, text, text, jsonb) from public;
revoke execute on function public.rwp_chat_history(uuid, text, timestamptz) from public;
revoke execute on function public.rwp_chat_identify(uuid, text, jsonb) from public;
revoke execute on function public.rwp_chat_request_agent(uuid, text, text) from public;
revoke execute on function public.rwp_chat_close(uuid, text) from public;
revoke execute on function public.rwp_chat_save_secrets(jsonb) from public, anon;
revoke execute on function public.rwp_chat_secrets_status() from public, anon;
revoke execute on function public.chat_messages_touch_session() from public, anon, authenticated;
revoke execute on function public.chat_sessions_touch() from public, anon, authenticated;
revoke execute on function public.live_agent_requests_touch() from public, anon, authenticated;
-- The chunker and its triggers run as the owner only. If authenticated could call the rechunker it
-- would be a way to rewrite passages without the policies on the base table seeing the write.
revoke execute on function public.chat_knowledge_touch() from public, anon, authenticated;
revoke execute on function public.chat_knowledge_rechunk(bigint) from public, anon, authenticated;
revoke execute on function public.chat_knowledge_after_change() from public, anon, authenticated;
revoke execute on function public.rwp_chat_knowledge_search(text, integer) from public;
revoke execute on function public.rwp_chat_knowledge_stats() from public, anon;

grant execute on function public.rwp_chat_enabled() to anon, authenticated;
grant execute on function public.rwp_chat_card(text, text) to anon, authenticated;
grant execute on function public.rwp_chat_track_order(text, text) to anon, authenticated;
grant execute on function public.rwp_chat_start(jsonb) to anon, authenticated;
grant execute on function public.rwp_chat_post(uuid, text, text, jsonb) to anon, authenticated;
grant execute on function public.rwp_chat_history(uuid, text, timestamptz) to anon, authenticated;
grant execute on function public.rwp_chat_identify(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.rwp_chat_request_agent(uuid, text, text) to anon, authenticated;
grant execute on function public.rwp_chat_close(uuid, text) to anon, authenticated;
grant execute on function public.rwp_chat_save_secrets(jsonb) to authenticated;
grant execute on function public.rwp_chat_secrets_status() to authenticated;
grant execute on function public.rwp_chat_knowledge_search(text, integer) to anon, authenticated;
grant execute on function public.rwp_chat_knowledge_stats() to authenticated;

-- 10. Default settings ---------------------------------------------------------------------------------
-- Public, non-secret settings only. Seeded so the widget has something sensible before anyone
-- opens the settings screen; an existing row is never overwritten.

insert into public.options (option_name, option_value) values
  ('chat_enabled', 'true'),
  ('chat_bot_name', 'Assistant'),
  ('chat_bot_avatar', ''),
  ('chat_welcome_message', 'Hi! Ask me anything about this site — I usually reply in a few seconds.'),
  ('chat_launcher_label', 'Chat with us'),
  ('chat_position', 'bottom-right'),
  ('chat_theme', 'dark'),
  ('chat_ai_enabled', 'true'),
  ('chat_prechat_enabled', 'true'),
  ('chat_prechat_fields', 'name,email'),
  ('chat_prechat_required', 'email'),
  ('chat_attachments_enabled', 'true'),
  ('chat_proactive_enabled', 'false'),
  ('chat_proactive_delay', '25'),
  ('chat_proactive_exit_intent', 'true'),
  ('chat_proactive_message', 'Need a hand finding anything?'),
  ('chat_agent_channel', 'internal'),
  ('chat_agent_button_label', 'Talk to a person'),
  ('chat_whatsapp_number', ''),
  ('chat_product_card_enabled', 'true'),
  ('chat_order_tracking_enabled', 'true'),
  ('chat_cart_prompt_enabled', 'false'),
  ('chat_cart_prompt_message', 'Still deciding? Ask me about sizes, delivery or returns.'),
  ('chat_cart_prompt_delay', '40'),
  ('chat_knowledge_enabled', 'true'),
  ('chat_knowledge_auto_sync', 'false'),
  ('chat_knowledge_sync_hours', '24'),
  ('chat_knowledge_last_sync', '')
on conflict (option_name) do nothing;

-- Empty folders exist as rows, so "Chatbot Media" is in the Media Library sidebar from the start
-- rather than appearing only after the first attachment. Skipped on a site that has not run the
-- 20260928 folder-manager migration.
do $$ begin
  if to_regclass('public.media_folders') is not null then
    insert into public.media_folders (path) values ('chat_media') on conflict (path) do nothing;
  end if;
end $$;

-- Without this PostgREST keeps serving the old column list and every new column reads as missing.
notify pgrst, 'reload schema';
