# AI Office image. Build from the repository root (the app runs crews on this
# repo's crewAI source):  docker build -f apps/ai_office/Dockerfile .
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    UV_NO_CACHE=1 \
    HOST=0.0.0.0 \
    PORT=8080 \
    OFFICE_STORAGE_DIR=/data

COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies first so code edits don't reinstall them.
COPY lib/crewai-core lib/crewai-core
COPY lib/cli lib/cli
COPY lib/crewai lib/crewai
COPY apps/ai_office/requirements.txt apps/ai_office/requirements.txt
RUN uv pip install --system ./lib/crewai-core ./lib/cli "./lib/crewai[anthropic]" \
    -r apps/ai_office/requirements.txt python-dotenv

COPY examples/research_crew/tools.py examples/research_crew/tools.py
COPY apps/ai_office apps/ai_office

EXPOSE 8080
CMD ["python", "apps/ai_office/server.py"]
