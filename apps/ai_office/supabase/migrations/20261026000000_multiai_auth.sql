-- AI Office (multiAi) 회원·SMS 로그인. 이 테이블들은 Edge Function(service role)만 읽고 쓴다.
-- 브라우저/anon 키로는 접근할 수 없다 (RLS 켜고 정책 없음 + 권한 회수).

create table if not exists "multiAi_users" (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique check (phone ~ '^01[016789][0-9]{7,8}$'),
  name text not null check (char_length(name) between 1 and 30),
  note text check (char_length(note) <= 200),               -- 가입 신청 메모 (소속·사유)
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  is_admin boolean not null default false,                  -- 회원 승인 권한
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  last_login_at timestamptz
);

-- 인증번호: 해시만 저장. 5분 유효, 5번 틀리면 폐기
create table if not exists "multiAi_sms_codes" (
  id bigint generated always as identity primary key,
  phone text not null,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists "multiAi_sms_codes_phone_idx" on "multiAi_sms_codes" (phone, created_at desc);

-- 로그인 세션: 토큰 해시만 저장
create table if not exists "multiAi_sessions" (
  token_hash text primary key,
  user_id uuid not null references "multiAi_users" (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists "multiAi_sessions_user_idx" on "multiAi_sessions" (user_id);

-- 문자 발송 기록 (multiai-send-sms)
create table if not exists "multiAi_sms_log" (
  id bigint generated always as identity primary key,
  phone text not null,
  body text not null,
  ok boolean not null,
  response text,
  created_at timestamptz not null default now()
);

alter table "multiAi_users" enable row level security;
alter table "multiAi_sms_codes" enable row level security;
alter table "multiAi_sessions" enable row level security;
alter table "multiAi_sms_log" enable row level security;
revoke all on "multiAi_users", "multiAi_sms_codes", "multiAi_sessions", "multiAi_sms_log" from anon, authenticated;
