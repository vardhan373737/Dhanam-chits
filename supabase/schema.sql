-- Run this script in Supabase SQL Editor.

create extension if not exists pgcrypto;

create type public.user_role as enum ('user', 'admin');
create type public.borrow_status as enum ('Pending', 'Approved', 'Rejected');
create type public.chit_status as enum ('Pending', 'Approved');
create type public.payment_status as enum ('Pending', 'Approved', 'Rejected');

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  fullname text not null,
  email text not null unique,
  mobile text not null unique,
  password_hash text not null,
  role public.user_role not null default 'user',
  reset_password_token text,
  reset_password_expires timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text not null,
  chits_plan text,
  amount numeric(12,2) not null default 0,
  utr_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mobile text not null,
  email text,
  chits_plan text,
  amount numeric(12,2) not null default 0,
  utr_number text,
  type text,
  status public.payment_status not null default 'Pending',
  reminder_note text,
  reminder_borrow_date date,
  reminder_repayment_date date,
  reminder_amount numeric(12,2),
  reminder_interest numeric(8,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.payments
  add column if not exists reminder_note text;

alter table if exists public.payments
  add column if not exists reminder_borrow_date date;

alter table if exists public.payments
  add column if not exists reminder_repayment_date date;

alter table if exists public.payments
  add column if not exists reminder_amount numeric(12,2);

alter table if exists public.payments
  add column if not exists reminder_interest numeric(8,2);

create index if not exists idx_payments_mobile on public.payments (mobile);
create unique index if not exists idx_payments_utr_unique on public.payments (utr_number) where utr_number is not null;

create table if not exists public.payment_reminders (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references public.payments (id) on delete cascade,
  payment_mobile text not null,
  payment_name text,
  reminder_note text not null default '',
  reminder_borrow_date date,
  reminder_repayment_date date,
  reminder_amount numeric(12,2),
  reminder_interest numeric(8,2),
  reminder_status text not null default 'manual',
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_payment_reminders_payment_id on public.payment_reminders (payment_id);
create index if not exists idx_payment_reminders_mobile_created_at on public.payment_reminders (payment_mobile, created_at desc);

create table if not exists public.bank_details (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_number text not null,
  ifsc_code text not null,
  upi_id text,
  bank_name text not null,
  mobile text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.borrows (
  id uuid primary key default gen_random_uuid(),
  fullname text not null,
  email text,
  mobile text not null,
  amount numeric(12,2) not null,
  aadhaar_document_path text,
  pan_document_path text,
  rc_document_path text,
  status public.borrow_status not null default 'Pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.borrows add column if not exists aadhaar_document_path text;
alter table public.borrows add column if not exists pan_document_path text;
alter table public.borrows add column if not exists rc_document_path text;

create index if not exists idx_borrows_mobile on public.borrows (mobile);

create table if not exists public.chit_ids (
  id uuid primary key default gen_random_uuid(),
  chit_id text not null,
  email text,
  name text,
  mobile text not null,
  month text,
  total_balance numeric(12,2),
  total_paid numeric(12,2) not null default 0,
  status public.chit_status not null default 'Pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_chit_ids_chit_id on public.chit_ids (chit_id);
create index if not exists idx_chit_ids_mobile on public.chit_ids (mobile);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  mobile text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  message text not null,
  rating integer not null check (rating between 1 and 5),
  created_at timestamptz not null default now()
);

create table if not exists public.auction_chat_messages (
  id uuid primary key default gen_random_uuid(),
  mobile text not null,
  sender_role public.user_role not null,
  sender_name text,
  message text not null,
  topic text not null default 'Chit Auction Lift',
  created_at timestamptz not null default now()
);

create index if not exists idx_auction_chat_mobile_created_at on public.auction_chat_messages (mobile, created_at);

drop trigger if exists trg_users_updated_at on public.users;
create trigger trg_users_updated_at
before update on public.users
for each row
execute function public.set_updated_at();

drop trigger if exists trg_submissions_updated_at on public.submissions;
create trigger trg_submissions_updated_at
before update on public.submissions
for each row
execute function public.set_updated_at();

drop trigger if exists trg_payments_updated_at on public.payments;
create trigger trg_payments_updated_at
before update on public.payments
for each row
execute function public.set_updated_at();

drop trigger if exists trg_bank_details_updated_at on public.bank_details;
create trigger trg_bank_details_updated_at
before update on public.bank_details
for each row
execute function public.set_updated_at();

drop trigger if exists trg_borrows_updated_at on public.borrows;
create trigger trg_borrows_updated_at
before update on public.borrows
for each row
execute function public.set_updated_at();

drop trigger if exists trg_chit_ids_updated_at on public.chit_ids;
create trigger trg_chit_ids_updated_at
before update on public.chit_ids
for each row
execute function public.set_updated_at();

-- Optional: enable RLS if you plan direct browser access with Supabase anon key.
alter table public.users enable row level security;
alter table public.submissions enable row level security;
alter table public.payments enable row level security;
alter table public.payment_reminders enable row level security;
alter table public.bank_details enable row level security;
alter table public.borrows enable row level security;
alter table public.chit_ids enable row level security;
alter table public.contacts enable row level security;
alter table public.feedback enable row level security;
alter table public.auction_chat_messages enable row level security;

-- Server-side APIs using service-role key bypass RLS. Keep policy explicit anyway.
drop policy if exists "service-role-users" on public.users;
create policy "service-role-users"
on public.users
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service-role-submissions" on public.submissions;
create policy "service-role-submissions"
on public.submissions
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service-role-payments" on public.payments;
create policy "service-role-payments"
on public.payments
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service-role-payment-reminders" on public.payment_reminders;
create policy "service-role-payment-reminders"
on public.payment_reminders
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service-role-bank-details" on public.bank_details;
create policy "service-role-bank-details"
on public.bank_details
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service-role-borrows" on public.borrows;
create policy "service-role-borrows"
on public.borrows
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service-role-chit-ids" on public.chit_ids;
create policy "service-role-chit-ids"
on public.chit_ids
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service-role-contacts" on public.contacts;
create policy "service-role-contacts"
on public.contacts
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service-role-feedback" on public.feedback;
create policy "service-role-feedback"
on public.feedback
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

drop policy if exists "service-role-auction-chat" on public.auction_chat_messages;
create policy "service-role-auction-chat"
on public.auction_chat_messages
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
