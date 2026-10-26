// AI Office(multiAi) 문자 발송 Edge Function — bauhaus-send-sms에서 발송 부분만 가져옴
// 문자서버가 앞에 [브랜드]를 붙이므로 본문에는 넣지 않는다.
// multiai-auth → (Authorization: Bearer service role) → 이 함수 → 문자서버 → multiAi_sms_log 기록
// 내부 전용: service role 키로만 부를 수 있다. 문자서버 주소/키는 함수 Secret으로만 보관.
//
// 배포: supabase functions deploy multiai-send-sms --project-ref woevgjaavqtecdhkxnhl --use-api --no-verify-jwt
// Secret(선택): SMS_ENDPOINT, SMS_API_KEY, MULTIAI_SMS_BRAND
//
// POST { phone, body } → { ok } | { error }
import { createClient } from "npm:@supabase/supabase-js@2"

const SMS_ENDPOINT = Deno.env.get("SMS_ENDPOINT") ?? "https://sms.predict.kr/send-message"
const SMS_API_KEY = Deno.env.get("SMS_API_KEY") // 문자서버에 인증을 붙이면 설정 (Authorization: Bearer)
const BRAND = Deno.env.get("MULTIAI_SMS_BRAND") ?? "AI Office"
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405)
  if (req.headers.get("authorization") !== `Bearer ${SERVICE_KEY}`) return json({ error: "forbidden" }, 403)

  let phone: string
  let body: string
  try {
    const payload = await req.json()
    phone = String(payload.phone ?? "").replace(/\D/g, "")
    body = String(payload.body ?? "")
  } catch {
    return json({ error: "잘못된 요청입니다." }, 400)
  }
  if (!/^01[016789]\d{7,8}$/.test(phone)) return json({ error: "잘못된 번호입니다." }, 400)
  if (!body.trim() || body.length > 2000) return json({ error: "메시지 내용을 확인하세요." }, 400)

  let ok = false
  let response = ""
  try {
    const res = await fetch(SMS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(SMS_API_KEY ? { Authorization: `Bearer ${SMS_API_KEY}` } : {}),
      },
      body: JSON.stringify({ brand: BRAND, phone, sendText: body }),
      signal: AbortSignal.timeout(15_000),
    })
    response = await res.text()
    ok = res.ok
  } catch (e) {
    response = e instanceof Error ? e.message : String(e)
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY, { auth: { persistSession: false } })
  // 인증번호가 기록에 남지 않게 숫자는 가린다
  await db.from("multiAi_sms_log").insert({ phone, body: body.replace(/\d{4,}/g, "******"), ok, response: response.slice(0, 500) })
  return ok ? json({ ok: true }) : json({ error: "문자 발송에 실패했습니다." }, 502)
})
