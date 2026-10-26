// AI Office(multiAi) 회원가입·SMS 로그인·세션·회원 승인. multiAi_* 테이블은 이 함수(service role)만 읽고 쓴다.
// 가입은 누구나 신청할 수 있지만, 관리자가 승인(status='approved')한 사람만 인증번호를 받고 로그인할 수 있다.
// 인증번호 문자는 multiai-send-sms 함수로 보낸다.
//
// 배포: supabase functions deploy multiai-auth --project-ref woevgjaavqtecdhkxnhl --use-api --no-verify-jwt
//
// POST { action, ... }
//   signup       { phone, name, note? }      → { status }
//   request_code { phone }                   → { ok }
//   verify_code  { phone, code }             → { token, expires_at, user }
//   session      { token }                   → { user }
//   logout       { token }                   → { ok }
//   users        { token }  (관리자)          → { users }
//   set_user     { token, id, status?, is_admin? } (관리자) → { user }
import { createClient } from "npm:@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const CODE_TTL_MS = 5 * 60 * 1000
const CODE_MAX_ATTEMPTS = 5
const RESEND_AFTER_MS = 60 * 1000 // 같은 번호로 1분에 한 번
const CODES_PER_HOUR = 5
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const USER_COLUMNS = "id, phone, name, note, status, is_admin, created_at, approved_at, last_login_at"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const fail = (status: number, error: string) => json({ error }, status)

const normalizePhone = (p: unknown) => String(p ?? "").replace(/\D/g, "")
const isValidPhone = (p: string) => /^01[016789]\d{7,8}$/.test(p)

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")
}
const codeHash = (phone: string, code: string) => sha256(`multiAi:${phone}:${code}`)

async function sendSms(phone: string, body: string) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/multiai-send-sms`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ phone, body }),
  })
  return res.ok
}

const publicUser = (u: Record<string, unknown>) => ({ id: u.id, phone: u.phone, name: u.name, is_admin: u.is_admin })

async function signup(body: Record<string, unknown>) {
  const phone = normalizePhone(body.phone)
  const name = String(body.name ?? "").trim().slice(0, 30)
  const note = String(body.note ?? "").trim().slice(0, 200) || null
  if (!name) return fail(400, "이름을 입력해 주세요.")
  if (!isValidPhone(phone)) return fail(400, "휴대폰 번호를 정확히 입력해 주세요. (예: 01012345678)")

  const { data: existing } = await db.from("multiAi_users").select("status").eq("phone", phone).maybeSingle()
  if (existing) {
    const message = existing.status === "approved" ? "이미 가입된 번호입니다. 로그인해 주세요."
      : existing.status === "pending" ? "이미 가입 신청한 번호입니다. 관리자 승인을 기다려 주세요."
      : "가입이 거절된 번호입니다. 관리자에게 문의해 주세요."
    return fail(409, message)
  }
  const { error } = await db.from("multiAi_users").insert({ phone, name, note })
  if (error) throw error
  return json({ status: "pending" })
}

async function requestCode(body: Record<string, unknown>) {
  const phone = normalizePhone(body.phone)
  if (!isValidPhone(phone)) return fail(400, "휴대폰 번호를 정확히 입력해 주세요.")

  const { data: user } = await db.from("multiAi_users").select("status").eq("phone", phone).maybeSingle()
  if (!user) return fail(404, "가입되지 않은 번호입니다. 먼저 회원가입을 신청해 주세요.")
  if (user.status === "pending") return fail(403, "가입 승인 대기 중입니다. 관리자가 승인하면 로그인할 수 있습니다.")
  if (user.status !== "approved") return fail(403, "로그인할 수 없는 계정입니다. 관리자에게 문의해 주세요.")

  const { data: recent } = await db.from("multiAi_sms_codes").select("created_at").eq("phone", phone)
    .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString()).order("created_at", { ascending: false })
  if (recent && recent.length >= CODES_PER_HOUR) return fail(429, "인증번호를 너무 자주 요청했습니다. 잠시 뒤 다시 시도해 주세요.")
  if (recent?.[0] && Date.now() - Date.parse(recent[0].created_at) < RESEND_AFTER_MS) {
    return fail(429, "인증번호는 1분에 한 번만 받을 수 있습니다.")
  }

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0")
  const { error } = await db.from("multiAi_sms_codes").insert({
    phone, code_hash: await codeHash(phone, code), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  })
  if (error) throw error
  if (!(await sendSms(phone, `로그인 인증번호는 ${code} 입니다. 5분 안에 입력해 주세요.`))) {
    return fail(502, "인증번호 문자를 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.")
  }
  return json({ ok: true })
}

async function verifyCode(body: Record<string, unknown>) {
  const phone = normalizePhone(body.phone)
  const code = String(body.code ?? "").replace(/\D/g, "")
  if (!isValidPhone(phone) || code.length !== 6) return fail(400, "인증번호 6자리를 입력해 주세요.")

  const { data: row } = await db.from("multiAi_sms_codes").select("id, code_hash, attempts, expires_at")
    .eq("phone", phone).is("used_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (!row || Date.parse(row.expires_at) < Date.now() || row.attempts >= CODE_MAX_ATTEMPTS) {
    return fail(400, "인증번호가 만료되었습니다. 다시 받아 주세요.")
  }
  if (row.code_hash !== (await codeHash(phone, code))) {
    await db.from("multiAi_sms_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id)
    const left = CODE_MAX_ATTEMPTS - row.attempts - 1
    return fail(401, left > 0 ? `인증번호가 틀렸습니다. (${left}번 더 시도할 수 있습니다)` : "인증번호를 여러 번 틀렸습니다. 다시 받아 주세요.")
  }
  await db.from("multiAi_sms_codes").update({ used_at: new Date().toISOString() }).eq("id", row.id)

  const { data: user } = await db.from("multiAi_users").select(USER_COLUMNS).eq("phone", phone).maybeSingle()
  if (!user || user.status !== "approved") return fail(403, "로그인할 수 없는 계정입니다.")

  const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("")
  const expires_at = new Date(Date.now() + SESSION_TTL_MS).toISOString()
  const { error } = await db.from("multiAi_sessions").insert({ token_hash: await sha256(token), user_id: user.id, expires_at })
  if (error) throw error
  await db.from("multiAi_users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id)
  // 가끔 지난 인증번호·세션을 정리한다
  if (Math.random() < 0.1) {
    const now = new Date().toISOString()
    await db.from("multiAi_sms_codes").delete().lt("expires_at", new Date(Date.now() - 86_400_000).toISOString())
    await db.from("multiAi_sessions").delete().lt("expires_at", now)
  }
  return json({ token, expires_at, user: publicUser(user) })
}

/** 토큰의 사용자. 만료됐거나 승인 상태가 아니면 null */
async function sessionUser(token: unknown) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null
  const { data } = await db.from("multiAi_sessions").select(`expires_at, user:multiAi_users(${USER_COLUMNS})`)
    .eq("token_hash", await sha256(token)).maybeSingle()
  const user = data?.user as Record<string, unknown> | null | undefined
  if (!data || !user || Date.parse(data.expires_at) < Date.now() || user.status !== "approved") return null
  return user
}

async function session(body: Record<string, unknown>) {
  const user = await sessionUser(body.token)
  return user ? json({ user: publicUser(user) }) : fail(401, "로그인이 필요합니다.")
}

async function logout(body: Record<string, unknown>) {
  if (typeof body.token === "string") await db.from("multiAi_sessions").delete().eq("token_hash", await sha256(body.token))
  return json({ ok: true })
}

async function users(body: Record<string, unknown>) {
  const admin = await sessionUser(body.token)
  if (!admin?.is_admin) return fail(403, "관리자만 볼 수 있습니다.")
  const { data, error } = await db.from("multiAi_users").select(USER_COLUMNS).order("created_at", { ascending: false })
  if (error) throw error
  return json({ users: data })
}

async function setUser(body: Record<string, unknown>) {
  const admin = await sessionUser(body.token)
  if (!admin?.is_admin) return fail(403, "관리자만 바꿀 수 있습니다.")
  const id = String(body.id ?? "")
  if (id === admin.id) return fail(400, "자기 계정은 바꿀 수 없습니다.")

  const { data: before } = await db.from("multiAi_users").select(USER_COLUMNS).eq("id", id).maybeSingle()
  if (!before) return fail(404, "없는 회원입니다.")
  const patch: Record<string, unknown> = {}
  if (body.status !== undefined) {
    if (!["pending", "approved", "rejected"].includes(String(body.status))) return fail(400, "잘못된 상태입니다.")
    patch.status = body.status
    if (body.status === "approved" && before.status !== "approved") patch.approved_at = new Date().toISOString()
  }
  if (body.is_admin !== undefined) patch.is_admin = body.is_admin === true
  const { data: user, error } = await db.from("multiAi_users").update(patch).eq("id", id).select(USER_COLUMNS).single()
  if (error) throw error

  if (user.status !== "approved") await db.from("multiAi_sessions").delete().eq("user_id", id) // 바로 로그아웃
  if (user.status === "approved" && before.status !== "approved") {
    await sendSms(user.phone, `${user.name}님, 가입이 승인되었습니다. 휴대폰 번호로 로그인해 주세요.`)
  }
  return json({ user })
}

const ACTIONS: Record<string, (body: Record<string, unknown>) => Promise<Response>> = {
  signup, request_code: requestCode, verify_code: verifyCode, session, logout, users, set_user: setUser,
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "method not allowed")
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return fail(400, "잘못된 요청입니다.")
  }
  const handler = ACTIONS[String(body.action)]
  if (!handler) return fail(400, "알 수 없는 요청입니다.")
  try {
    return await handler(body)
  } catch (e) {
    console.error(e)
    return fail(500, "서버 오류가 발생했습니다.")
  }
})
