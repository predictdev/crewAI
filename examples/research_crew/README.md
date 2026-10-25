# Research Crew 예제

리서처 → 라이터 → 리뷰어 3개 에이전트가 순차(`Process.sequential`)로 협업해 주제 리포트를 만드는 예제입니다.

| 에이전트 | 하는 일 |
| --- | --- |
| researcher | `web_search` 도구로 최신 자료를 찾아 핵심 사실·동향·쟁점 조사 |
| writer | 리서치를 바탕으로 마크다운 리포트 초안 작성 |
| reviewer | 초안을 리서치와 대조해 검토하고 최종본 작성 |

## 실행

```bash
cp examples/research_crew/.env.example examples/research_crew/.env   # ANTHROPIC_API_KEY 입력
.venv/bin/python examples/research_crew/main.py "멀티 AI 에이전트 프레임워크"
```

최종 리포트는 실행한 위치 기준 `output/report.md`에 저장됩니다. 모델은 `.env`의 `MODEL`로 바꿀 수 있습니다 (기본값 `anthropic/claude-opus-5-5`).

## 웹 검색

`tools.py`의 `ClaudeWebSearchTool`이 Claude API의 서버측 웹 검색(`web_search_20260209`)을 호출합니다. 별도 검색 API 키 없이 `ANTHROPIC_API_KEY`만으로 동작하며, 검색 1,000회당 $10가 토큰 비용에 더해집니다. Anthropic Console에서 조직의 웹 검색이 꺼져 있으면 실패합니다.
