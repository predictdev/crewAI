# AI Office (MVP)

여러 사업(프로젝트)에 업무를 지시하고, 각 사업의 AI 팀이 일하는 모습을 픽셀아트 사무실에서 실시간으로 보는 웹 앱입니다. 사업마다 팀장 한 명과 팀원들이 있습니다. 팀장은 지시를 받으면 일을 나눠 알맞은 팀원에게 맡기고 결과를 검토합니다(crewAI hierarchical 프로세스).

- **사무실**: 팀별 방, 캐릭터 상태(생각 중·검색 중·완료), 말풍선, 팀장의 지시와 팀원의 보고 애니메이션
- **활동**: 팀장이 맡긴 일, 검색어, 도구 결과를 시간순으로 기록
- **업무**: 이 사업에 내린 지시의 대기열과 기록. 진행 중인 지시는 팀장이 누구에게 무엇을 맡겼는지 함께 보여줍니다
- **결과**: 결과물(마크다운, `.md` 저장)과 팀원이 저장한 파일
- **승인**: 팀원이 요청한 광고 변경. 관리자가 승인해야 실행
- **팀 편집**: 사업의 팀장과 팀원을 배치하고 설정을 고칩니다

## 실행

```bash
python3 -m uv pip install --python .venv/bin/python -r apps/ai_office/requirements.txt
.venv/bin/python apps/ai_office/server.py
```

창을 닫아도 꺼지지 않게 띄우려면 `apps/ai_office/serve.sh start`를 씁니다. 백그라운드에서 돌고, 서버가 죽으면 3초 뒤 다시 켭니다. 끌 때는 `serve.sh stop`, 상태는 `serve.sh status`, 로그는 `apps/ai_office/server.log`입니다. 재부팅 후에는 다시 `start` 해야 합니다. 서버가 도는 동안에는 맥이 잠들지 않습니다.

### 사무실 컴퓨터에서 원격 접속 받기

사무실의 항상 켜 둔 맥 한 대에서 돌리고, 밖에서는 `https://도메인`으로 접속합니다. 앱은 이 맥 안(127.0.0.1)에서만 열리고, 앞에 둔 Caddy가 HTTPS 인증서를 자동으로 받아 연결해 줍니다. 로그인 문자 코드와 쿠키가 암호화되지 않은 채 오가지 않도록 앱 포트(8765)는 직접 열지 않습니다.

1. Caddy 설치: `brew install caddy`
2. 도메인 DNS에 A 레코드 추가: `office.<도메인>` → 사무실 공인 IP. 공인 IP가 바뀌는 회선이면 공유기의 DDNS를 쓰고 CNAME으로 연결합니다.
3. 공유기 포트포워드: 외부 80, 443 → 이 맥의 내부 IP 80, 443 (TCP). 내부 IP는 공유기에서 고정 할당합니다.
4. `apps/ai_office/.env`에 `OFFICE_DOMAIN=office.<도메인>` 추가
5. `apps/ai_office/serve.sh stop && apps/ai_office/serve.sh start`

처음 시작할 때 Caddy가 인증서를 받으므로 80·443 포워드가 먼저 되어 있어야 합니다. 사무실 안에서도 같은 주소로 접속합니다. 안에서만 안 열리면 공유기의 헤어핀 NAT(NAT 루프백) 설정을 켭니다.

http://localhost:8765 에 접속합니다. API 키는 `examples/research_crew/.env`의 `ANTHROPIC_API_KEY`를 사용합니다.

## 로그인과 회원

로그인한 사람만 사무실에 들어갈 수 있습니다.

- **회원가입**: 로그인 화면의 회원가입 탭에서 이름·휴대폰 번호·메모로 신청합니다. 신청만으로는 로그인할 수 없습니다.
- **승인**: 관리자가 상단 **👥 회원**에서 승인하면 신청자에게 문자로 알립니다. 승인 대기 수가 버튼에 표시됩니다. **이용 중지**하면 바로 로그아웃됩니다.
- **로그인**: 휴대폰 번호를 넣고 **인증번호 받기** → 문자로 받은 6자리를 입력합니다. 인증번호는 5분 동안 유효하고 5번 틀리면 다시 받아야 합니다(1분에 한 번, 1시간에 5번까지). 로그인은 30일 유지됩니다.
- **첫 관리자**: 처음 가입한 사람은 Supabase에서 직접 승인합니다.
  `update "multiAi_users" set status = 'approved', is_admin = true where phone = '01012345678';`

회원 정보는 Supabase(`predict-service`)의 `multiAi_*` 테이블에 있고, Edge Function만 읽고 씁니다(RLS, anon 권한 없음). 서버는 저장소 루트 `.env`의 `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`로 `multiai-auth` 함수를 부릅니다.

| Supabase | 내용 |
| --- | --- |
| `multiAi_users` | 회원: 번호, 이름, 메모, 상태(pending/approved/rejected), 관리자 여부 |
| `multiAi_sms_codes` | 인증번호(해시), 만료, 시도 횟수 |
| `multiAi_sessions` | 로그인 세션(토큰 해시), 만료 |
| `multiAi_sms_log` | 문자 발송 기록(번호 속 숫자는 가림) |
| `multiai-auth` 함수 | 가입·인증번호·로그인·세션 확인·회원 승인 |
| `multiai-send-sms` 함수 | 문자 발송(`bauhaus-send-sms`에서 복사). service role 키로만 호출 |

스키마는 `supabase/migrations/`, 함수 코드는 `supabase/functions/`에 있습니다. 배포:

```bash
cd apps/ai_office
supabase functions deploy multiai-auth --project-ref woevgjaavqtecdhkxnhl --use-api --no-verify-jwt
supabase functions deploy multiai-send-sms --project-ref woevgjaavqtecdhkxnhl --use-api --no-verify-jwt
```

## 사업과 업무 지시

- **사업**: 왼쪽 목록에 모든 사업이 사업 목표, 최근 지시, 완료·대기 수와 함께 나옵니다. 사업을 고르면 화면 전체가 그 사업으로 바뀝니다: 팀과 사무실, 업무 목록, 결과(그 사업의 최근 결과물), 입력칸. 마지막으로 고른 사업은 다시 들어왔을 때 그대로 열립니다.
- **사업 만들기·고치기**: **＋ 새 사업**으로 이름과 사업 목표를 넣어 만듭니다(지금 팀 복사 또는 기본 팀). 고른 사업의 **✎ 이름·목표**에서 이름·목표를 고치거나 사업을 삭제합니다.
- **사업 목표**: 팀장은 모든 지시를 그 사업의 목표에 맞춰 해석합니다. 구체적으로 적을수록 지시가 짧아도 됩니다.
- **업무 지시**: 입력칸에 하고 싶은 일을 그대로 쓰고 **지시**(Enter)를 누릅니다. 예: "학원 원장 대상 서비스 소개 제안서 초안 써줘", "경쟁 서비스 5곳 가격 비교표 만들어줘".
- **대기열**: 지시는 모든 사업을 통틀어 하나씩 차례대로 처리됩니다. 여러 개를 넣어 두면 앞의 일이 끝나는 대로 이어서 시작합니다. 대기 중인 지시는 업무 탭에서 취소할 수 있습니다.
- **결과**: 끝난 지시는 업무 탭에서 **결과 보기**, **재생**(비용 없이 다시 보기), **다시 지시**를 할 수 있습니다.
- **이어서 실행**: 중지되거나 실패한 지시(서버 재시작 포함)는 업무 탭에서 이어서 실행할 수 있습니다. 그때 팀원들이 끝낸 일의 결과를 팀장에게 함께 넘겨, 끝난 일은 다시 맡기지 않고 남은 일만 진행합니다. 브라우저를 닫거나 브라우저가 멈춰도 지시는 서버에서 계속 진행되며, 다시 접속하면 진행 화면이 그대로 이어집니다.
- **진행 표시줄**: 입력칸 아래에 지금 무엇이 진행 중인지(LIVE·REPLAY, 다른 사업이 일하는 중이면 **보러 가기**)와 **■ 중지** 버튼이 한 줄로 나옵니다.
- **재생**: 지시마다 업무 카드의 **재생**으로 봅니다(속도는 탭 위에서 선택). 샘플과 사업 기능 이전의 기록은 탭 맨 아래 **샘플·이전 기록 재생**에 있습니다.
- **■ 중지**: 진행 중인 지시를 멈춥니다. 별도 프로세스라 바로 종료되고, 대기열의 다음 지시가 이어서 시작됩니다.
- 실행마다 API 비용이 듭니다. 녹화와 결과물은 `runs/<시각>-<지시 id>/`에 저장됩니다(git 제외).

## 팀 편집

**팀 편집**을 누르면 사무실이 편집 모드로 바뀌고 오른쪽에 설정 패널이 열립니다. 편집은 지금 고른 사업의 팀에만 적용됩니다.

- **배치**: 캐릭터를 끌어 놓습니다. 다른 팀원 책상이나 다른 방 바닥에 놓으면 그 팀으로 옮겨 갑니다. 팀장석으로 끌면 그 사람(이름·외형)이 팀장이 되고, 역할 설정은 자리에 남습니다.
- **그룹(팀)**: ⇧Shift 또는 ⌘/Ctrl을 누른 채 팀원을 클릭해 여러 명을 고르고, 패널에서 이름을 넣어 **그룹으로 묶기**를 누르면 한 방에 모입니다. 방 바닥을 클릭하면 그 팀 전체가 선택됩니다.
- **추가·삭제**: 빈 방(+)을 누르면 팀원이 추가됩니다(최대 20명). 선택한 팀원은 **🗑 팀원 삭제** 버튼이나 Delete 키로 지웁니다.
- **설정**: 이름, 직함, 팀 이름, 모델(Opus/Sonnet/Haiku), 도구(아래), 외형 색, role·goal·backstory, 담당 분야·하는 일·결과물 형식
- **담당 분야·하는 일**은 팀장이 일을 맡길 사람을 고르는 기준입니다. 구체적으로 쓸수록 알맞게 나눠 맡깁니다.
- **역할(role)은 사람마다 달라야 합니다.** 팀장이 역할로 사람을 구분해 일을 맡기기 때문입니다.
- 글에는 `{topic}`(업무 지시 내용), `{current_year}`만 쓸 수 있습니다. 다른 `{...}`는 저장할 때 거부됩니다.

## 팀원 도구

팀 편집에서 팀원마다 쓸 수 있는 도구를 고릅니다. 키가 필요한 도구는 `apps/ai_office/.env`에 키를 넣고 서버를 다시 켜야 동작합니다(키가 없으면 편집 화면에 "키 없음"으로 표시되고, 쓰려고 하면 키가 없다는 답만 받습니다).

| 도구 | 하는 일 | 필요한 키 |
| --- | --- | --- |
| 웹 검색 | Claude 웹 검색으로 최신 자료 조사 | 없음 (`ANTHROPIC_API_KEY`) |
| 사이트 읽기·크롤링 | 페이지 본문·링크 읽기, 한 사이트 안에서 여러 페이지 따라가기(최대 20쪽), 자바스크립트로 그리는 페이지는 브라우저로 열기. robots.txt를 지키고 사내망 주소는 열지 않음 | 없음 |
| 네이버 검색·트렌드 | 블로그·뉴스·카페·쇼핑·웹문서·지식iN 검색, 데이터랩 검색량 추이 | `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` ([네이버 개발자센터](https://developers.naver.com/apps)에서 애플리케이션 등록, 검색·데이터랩 API 선택) |
| 파일 저장 | 표(CSV)·문서(md 등)를 저장. 결과 탭의 저장된 파일에서 내려받기 | 없음 |
| 네이버 검색광고 | 키워드 도구(월간 검색수·경쟁도), 캠페인·광고그룹·키워드·성과 조회, 변경 요청 | `NAVER_ADS_API_KEY`, `NAVER_ADS_SECRET_KEY`, `NAVER_ADS_CUSTOMER_ID` (검색광고 관리시스템 → 도구 → API 사용 관리) |
| 메타 광고 | 캠페인·광고세트·광고·성과 조회, 변경 요청 | `META_ACCESS_TOKEN`(비즈니스 관리자 시스템 사용자 토큰, `ads_management` 권한), `META_AD_ACCOUNT_ID` |
| 구글 Ads | GAQL 성과 조회, 키워드 아이디어, 변경 요청 | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`(숫자만), 관리자 계정 밑이면 `GOOGLE_ADS_LOGIN_CUSTOMER_ID` |

API 버전은 `META_API_VERSION`(기본 `v26.0`), `GOOGLE_ADS_API_VERSION`(기본 `v26`)으로 바꿀 수 있습니다.

### 광고 변경은 승인 후 실행

광고 도구로 팀원이 할 수 있는 것은 **조회**와 **변경 요청**뿐입니다. 캠페인 만들기, 켜기·끄기, 입찰가·예산 변경 같은 요청은 **승인** 탭에 쌓이고, 관리자가 **승인하고 실행**을 눌러야 요청 그대로 광고 플랫폼에 보내집니다. 카드에는 요청한 팀원, 이유, 하루 최대 비용 증가(요청자 추정), 실제로 보낼 API 요청이 보이고, 실행 뒤에는 플랫폼 응답이나 오류가 남습니다. 새로 만드는 캠페인·광고는 꺼진 상태로 만들도록 지시되어 있어, 켜는 것도 따로 승인합니다.

## 배포 (Fly.io)

서버 한 대에 볼륨 하나를 붙여 돌립니다. 지시 대기열이 서버 메모리에 있어서 **머신은 반드시 1대**여야 합니다. 지시가 오래 걸리고 웹소켓을 계속 쓰므로 머신이 잠들지 않게 설정돼 있습니다(`fly.toml`).

| 파일 | 내용 |
| --- | --- |
| `Dockerfile` | 저장소 루트에서 빌드. 이 저장소의 crewAI 소스와 앱을 담음 |
| `fly.toml` | 앱 이름, 지역(nrt 도쿄), 볼륨 `/data`, 메모리 2GB, 헬스 체크 |
| `deploy.sh` | 저장소 루트에서 `fly deploy` 실행 |
| `/.dockerignore` | 빌드에 필요한 폴더만 올림(docs·.git 제외) |

처음 한 번:

```bash
brew install flyctl
fly auth login
# fly.toml의 app 이름을 원하는 이름으로 바꾼 뒤
fly apps create ai-office-predict
fly volumes create office_data --app ai-office-predict --region nrt --size 1
fly secrets set --app ai-office-predict ANTHROPIC_API_KEY=... SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=...
./apps/ai_office/deploy.sh
```

이후 업데이트는 `./apps/ai_office/deploy.sh`만 실행합니다. 대기 중인 지시는 볼륨에 남아 재시작 뒤 이어서 처리되지만, 배포 순간 실행 중이던 지시는 실패로 표시됩니다.

- 주소: `https://<앱 이름>.fly.dev` (도메인 연결: `fly certs add office.example.com`)
- 로그: `fly logs`, 접속: `fly ssh console`
- 지금 쓰던 사업·기록을 옮기려면:
  ```bash
  tar czf office-data.tgz -C apps/ai_office data runs
  fly ssh sftp shell   # put office-data.tgz /data/office-data.tgz
  fly ssh console -C "tar xzf /data/office-data.tgz -C /data"
  fly machine restart
  ```

배포 환경에서는 `OFFICE_STORAGE_DIR=/data` 아래에 `data/`, `runs/`가 생깁니다. 로컬에서는 이 폴더(`apps/ai_office/`) 아래에 생깁니다.

## 데이터

| 위치 | 내용 |
| --- | --- |
| `data/projects/<id>.json` | 사업 이름과 팀 (git 제외) |
| `data/orders.json` | 모든 업무 지시와 상태 (git 제외) |
| `data/actions.json` | 광고 변경 요청과 승인·실행 결과 (git 제외) |
| `runs/<시각>-<지시 id>/` | 지시 내용(`order.json`), 녹화(`events.jsonl`), 결과물(`report.md`), 팀원이 저장한 파일(`files/`) |
| `team.default.json` | 새 사업의 기본 팀 |

예전 버전의 `team.json`이 있으면 처음 실행할 때 "기본 사업"으로 옮겨집니다. 이때 역할 이름의 `{topic}`은 빠지고, 겹치는 역할에는 번호가 붙습니다.

## 구조

| 파일 | 역할 |
| --- | --- |
| `auth.py` | 로그인 확인 미들웨어, 가입·로그인·회원 승인 API (`multiai-auth` 함수 호출) |
| `bridge.py` | crewAI 이벤트 버스를 구독해 사무실 이벤트(JSON)로 변환 |
| `server.py` | FastAPI 서버. 사업·팀·업무 지시 API, 대기열 실행·중지, 녹화 재생, WebSocket 중계 |
| `store.py` | 사업, 업무 지시, 광고 변경 요청 저장 (`data/`) |
| `agent_tools.py` | 사이트 읽기·크롤링, 네이버 검색·트렌드, 파일 저장 도구 |
| `ads.py` | 네이버·메타·구글 광고 API 호출, 조회 도구와 변경 요청(승인 대기) 도구 |
| `worker.py` | 지시 하나를 별도 프로세스에서 실행. 팀장이 일을 나눠 팀원에게 맡기는 크루를 만들고, 이벤트를 stdout(JSON 줄)으로 전달 |
| `team.py` | 팀 설정 스키마·검증 |
| `static/sprites.js` | 픽셀아트 사무실·캐릭터 그리기 (외부 이미지 없음) |
| `static/login.html`, `login.js` | 로그인·회원가입 화면 |
| `static/account.js` | 상단 사용자·로그아웃, 회원 승인 창 |
| `static/office.js` | 이벤트 → 화면 상태, 말풍선, 업무·결과·승인 탭, 사업 전환, 팀 편집 |
