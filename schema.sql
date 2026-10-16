-- VolunteerHub schema. Paste the whole file into Supabase > SQL Editor > Run.
create table if not exists public.volunteers(
  id text primary key,
  name text not null check (length(trim(name))>0),
  phone text not null unique,
  address text not null default '',
  dept text not null default '',
  status text not null default 'active' check (status in ('active','inactive')),
  verification text not null default 'Pending' check (verification in ('Verified','Pending','Rejected')),
  screenshot_path text,
  drive_url text,
  created_at timestamptz not null default now());
create table if not exists public.class_schedules(
  id bigint generated always as identity primary key,
  volunteer_id text not null references public.volunteers(id) on delete cascade,
  day text not null check (day in ('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')),
  course text not null,
  start_time time not null,
  end_time time not null,
  check (end_time>start_time));
create index if not exists class_schedules_vol on public.class_schedules(volunteer_id);
create table if not exists public.events(
  id text primary key,
  name text not null,
  date date not null,
  start_time time not null,
  end_time time not null,
  location text not null,
  required int not null check (required>0),
  check (end_time>start_time));
create table if not exists public.event_assignments(
  event_id text not null references public.events(id) on delete cascade,
  volunteer_id text not null references public.volunteers(id) on delete cascade,
  primary key (event_id,volunteer_id)); -- blocks duplicate assignments

-- Admin allow-list. Only people listed here can read or write anything.
create table if not exists public.admins(user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.admins enable row level security; -- no policies: the browser can never read or edit this table

create or replace function public.is_admin() returns boolean
language sql security definer stable set search_path=public as
$$ select exists(select 1 from public.admins where user_id=(select auth.uid())) $$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

alter table public.volunteers enable row level security;
alter table public.class_schedules enable row level security;
alter table public.events enable row level security;
alter table public.event_assignments enable row level security;
do $$ declare t text; begin
  foreach t in array array['volunteers','class_schedules','events','event_assignments'] loop
    execute format('drop policy if exists "admin full access" on public.%I',t);
    execute format('create policy "admin full access" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())',t);
  end loop; end $$;

-- Private bucket for routine screenshots
insert into storage.buckets(id,name,public) values('screenshots','screenshots',false) on conflict (id) do nothing;
drop policy if exists "admin screenshots" on storage.objects;
create policy "admin screenshots" on storage.objects for all to authenticated
  using (bucket_id='screenshots' and public.is_admin()) with check (bucket_id='screenshots' and public.is_admin());
