#!/usr/bin/env python
"""Run the research crew: python examples/research_crew/main.py "topic"."""

import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
load_dotenv(HERE / ".env")

from crew import ResearchCrew  # noqa: E402


def run() -> None:
    topic = sys.argv[1] if len(sys.argv) > 1 else "멀티 AI 에이전트 프레임워크"
    inputs = {"topic": topic, "current_year": str(datetime.now().year)}
    result = ResearchCrew().crew().kickoff(inputs=inputs)
    print("\n=== 최종 결과 ===\n")
    print(result.raw)
    print(f"\n토큰 사용량: {result.token_usage}")


if __name__ == "__main__":
    run()
