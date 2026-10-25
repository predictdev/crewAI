import os

import anthropic
from crewai.tools import BaseTool
from pydantic import BaseModel, Field

MAX_CONTINUATIONS = 3


class WebSearchInput(BaseModel):
    query: str = Field(..., description="검색할 질문이나 키워드")


class ClaudeWebSearchTool(BaseTool):
    """Searches the web with Claude's server-side web search, reusing ANTHROPIC_API_KEY."""

    name: str = "web_search"
    description: str = (
        "웹에서 최신 정보를 검색한다. 질문을 넣으면 검색 결과를 요약한 답과 출처 URL 목록을 돌려준다."
    )
    args_schema: type[BaseModel] = WebSearchInput

    def _run(self, query: str) -> str:
        client = anthropic.Anthropic()
        model = os.getenv("MODEL", "anthropic/claude-opus-5-5").removeprefix("anthropic/")
        messages = [
            {
                "role": "user",
                "content": (
                    f"웹 검색으로 다음을 조사하고 핵심 사실을 날짜와 함께 정리해줘: {query}\n"
                    "검색 결과로 확인한 사실만 적어라. 검색으로 확인하지 못한 항목은 "
                    "'미확인'이라고만 표시하고, 기억이나 추측으로 채우지 마라."
                ),
            }
        ]
        tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 5}]

        response = client.messages.create(
            model=model, max_tokens=16000, messages=messages, tools=tools
        )
        # The server-side search loop can pause; re-send the turn so it resumes.
        for _ in range(MAX_CONTINUATIONS):
            if response.stop_reason != "pause_turn":
                break
            response = client.messages.create(
                model=model,
                max_tokens=16000,
                messages=[*messages, {"role": "assistant", "content": response.content}],
                tools=tools,
            )

        texts: list[str] = []
        sources: dict[str, str] = {}
        for block in response.content:
            if block.type == "text":
                texts.append(block.text)
            # Dynamic filtering drops inline citations, so take URLs from the raw results.
            # An error result carries an object instead of a list.
            elif block.type == "web_search_tool_result" and isinstance(block.content, list):
                for item in block.content:
                    sources.setdefault(item.url, item.title or item.url)

        result = "".join(texts).strip() or "검색 결과가 없습니다."
        if sources:
            result += "\n\n검색된 출처:\n" + "\n".join(
                f"- {title}: {url}" for url, title in sources.items()
            )
        return result
