# AI Office (MVP)

crewAI 크루가 일하는 모습을 픽셀아트 사무실에서 실시간으로 보는 웹 앱입니다. 지금은 `examples/research_crew`의 리서처 → 라이터 → 리뷰어 크루를 실행합니다.

- **Office**: 팀별 방, 캐릭터 상태(생각 중·검색 중·완료), 말풍선, 작업 인계 애니메이션, 매니저의 작업 배정
- **Activity**: 검색어, 도구 결과, 태스크 결과를 시간순으로 기록
- **Tasks / Report**: 태스크 진행 상태와 최종 리포트(마크다운, `.md` 저장)

## 실행

```bash
python3 -m uv pip install --python .venv/bin/python -r apps/ai_office/requirements.txt
.venv/bin/python apps/ai_office/server.py
```

http://localhost:8765 에 접속합니다. API 키는 `examples/research_crew/.env`의 `ANTHROPIC_API_KEY`를 사용합니다.

## 실행과 재생

- **▶ 실행**: 크루를 실제로 돌립니다. 실행마다 API 비용이 들고, 이벤트와 리포트가 `apps/ai_office/runs/<시각>/`에 저장됩니다 (git 제외).
- **⟲ 재생**: 저장된 실행이나 `samples/`의 녹화를 비용 없이 다시 재생합니다. 긴 대기 시간은 최대 2.5초로 줄여서 보여줍니다. 화면을 수정할 때는 재생으로 확인하세요.

## 구조

| 파일 | 역할 |
| --- | --- |
| `bridge.py` | crewAI 이벤트 버스를 구독해 사무실 이벤트(JSON)로 변환 |
| `server.py` | FastAPI 서버. 크루 실행, 녹화 저장·재생, WebSocket 중계 |
| `static/sprites.js` | 픽셀아트 사무실·캐릭터 그리기 (외부 이미지 없음) |
| `static/office.js` | 이벤트 → 화면 상태, 말풍선, Activity·Tasks·Report |
