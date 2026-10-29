"""Tools a team member can be given besides web search: reading websites, Naver search
and trends, and saving files next to the report.

Each tool returns a Korean message instead of raising, so the agent can read what went
wrong and try something else.
"""

from __future__ import annotations

from datetime import date, timedelta
import ipaddress
import os
from pathlib import Path
import re
import socket
import threading
import time
from typing import Any, Literal
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

from bs4 import BeautifulSoup
from crewai.tools import BaseTool
import httpx
from pydantic import BaseModel, Field


USER_AGENT = "Mozilla/5.0 (compatible; AIOfficeBot/1.0)"
PAGE_CHARS = 15000  # text kept from one page
CRAWL_CHARS = 30000  # text kept from a whole crawl
MAX_CRAWL_PAGES = 20
CRAWL_DELAY = 0.5  # seconds between pages of one site


class ToolError(Exception):
    """A problem worth telling the agent about."""


# ---------- reading websites ----------


def _check_public(url: str) -> None:
    """Only public http(s) hosts: the office machine's own network is off limits."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ToolError(f"http(s) 주소만 열 수 있습니다: {url}")
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443)
    except socket.gaierror:
        raise ToolError(f"주소를 찾을 수 없습니다: {parts.hostname}") from None
    for info in infos:
        if not ipaddress.ip_address(info[4][0]).is_global:
            raise ToolError(f"내부 네트워크 주소는 열 수 없습니다: {parts.hostname}")


def _client() -> httpx.Client:
    # The hook runs for every redirect hop too.
    return httpx.Client(
        headers={"User-Agent": USER_AGENT, "Accept-Language": "ko,en;q=0.8"},
        follow_redirects=True,
        timeout=20,
        event_hooks={"request": [lambda request: _check_public(str(request.url))]},
    )


class _Robots:
    """robots.txt per site, fetched once."""

    def __init__(self, client: httpx.Client) -> None:
        self.client = client
        self.sites: dict[str, RobotFileParser] = {}

    def allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        site = f"{parts.scheme}://{parts.netloc}"
        if site not in self.sites:
            parser = RobotFileParser()
            try:
                response = self.client.get(f"{site}/robots.txt")
                parser.parse(
                    response.text.splitlines() if response.status_code == 200 else []
                )
            except Exception:
                parser.parse([])
            self.sites[site] = parser
        return self.sites[site].can_fetch(USER_AGENT, url)


def _render(url: str) -> str:
    """HTML after JavaScript ran, from a headless browser."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise ToolError("이 서버에는 브라우저(Playwright)가 없어 render 없이만 열 수 있습니다.") from None

    result: dict[str, Any] = {}

    def run() -> None:
        # Its own thread: sync Playwright refuses to start inside a running event loop.
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                page = browser.new_page(user_agent=USER_AGENT)

                def guard(route: Any) -> None:
                    try:
                        _check_public(route.request.url)
                    except ToolError:
                        route.abort()
                        return
                    route.continue_()

                page.route(re.compile(r"^https?://"), guard)
                page.goto(url, wait_until="networkidle", timeout=30000)
                result["html"] = page.content()
                browser.close()
        except Exception as e:
            result["error"] = e

    thread = threading.Thread(target=run)
    thread.start()
    thread.join()
    if "error" in result:
        raise ToolError(f"브라우저로 열지 못했습니다: {result['error']}")
    return result["html"]


def _parse(url: str, html: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else ""
    meta = soup.find("meta", attrs={"name": "description"})
    description = meta.get("content", "") if meta else ""
    links: dict[str, str] = {}
    for a in soup.find_all("a", href=True):
        href = urljoin(url, a["href"]).split("#")[0]
        if href.startswith(("http://", "https://")):
            links.setdefault(href, a.get_text(" ", strip=True)[:60])
    for tag in soup(["script", "style", "noscript", "svg", "iframe"]):
        tag.decompose()
    text = re.sub(r"\n\s*\n+", "\n\n", soup.get_text("\n", strip=True))
    return {"title": title, "description": description, "text": text, "links": links}


def _fetch(
    client: httpx.Client, robots: _Robots, url: str, render: bool
) -> dict[str, Any]:
    _check_public(url)
    if not robots.allowed(url):
        raise ToolError(f"사이트의 robots.txt가 이 페이지 수집을 막고 있습니다: {url}")
    if render:
        return _parse(url, _render(url))
    response = client.get(url)
    if response.status_code >= 400:
        raise ToolError(
            f"페이지를 열지 못했습니다 (HTTP {response.status_code}): {url}"
        )
    kind = response.headers.get("content-type", "")
    if "html" not in kind and "text" not in kind:
        raise ToolError(f"웹페이지가 아닌 파일입니다 ({kind or '형식 모름'}): {url}")
    return _parse(str(response.url), response.text)


class FetchPageInput(BaseModel):
    url: str = Field(..., description="열어볼 페이지 주소 (https://...)")
    render: bool = Field(
        False,
        description="true면 브라우저로 열어 자바스크립트가 그린 내용까지 읽는다. 본문이 비어 보일 때만 쓴다.",
    )


class FetchPageTool(BaseTool):
    name: str = "fetch_page"
    description: str = (
        "웹페이지 하나를 열어 제목, 설명, 본문 텍스트, 페이지 안의 링크 목록을 돌려준다. "
        "경쟁사 사이트, 상품 페이지, 블로그 글처럼 주소를 아는 페이지를 직접 읽을 때 쓴다."
    )
    args_schema: type[BaseModel] = FetchPageInput

    def _run(self, url: str, render: bool = False) -> str:
        try:
            with _client() as client:
                page = _fetch(client, _Robots(client), url, render)
        except ToolError as e:
            return str(e)
        except httpx.HTTPError as e:
            return f"페이지를 열지 못했습니다: {e}"
        text = page["text"]
        cut = (
            f"\n(본문이 길어 앞 {PAGE_CHARS}자만 표시)"
            if len(text) > PAGE_CHARS
            else ""
        )
        links = "\n".join(
            f"- {label or '(텍스트 없음)'}: {href}"
            for href, label in list(page["links"].items())[:60]
        )
        return (
            f"제목: {page['title']}\n설명: {page['description']}\n\n본문:\n{text[:PAGE_CHARS]}{cut}"
            f"\n\n링크 ({len(page['links'])}개 중 최대 60개):\n{links}"
        )


class CrawlSiteInput(BaseModel):
    url: str = Field(..., description="시작 페이지 주소")
    max_pages: int = Field(
        8,
        ge=1,
        le=MAX_CRAWL_PAGES,
        description=f"읽을 최대 페이지 수 (1~{MAX_CRAWL_PAGES})",
    )
    path_prefix: str = Field(
        "",
        description="이 경로로 시작하는 페이지만 따라간다 (예: /blog/). 비우면 같은 사이트 전체.",
    )


class CrawlSiteTool(BaseTool):
    name: str = "crawl_site"
    description: str = (
        "한 사이트 안에서 링크를 따라가며 여러 페이지를 읽고, 페이지마다 제목과 본문 요약(앞부분)을 돌려준다. "
        "사이트 전체 구성, 상품·가격 목록, 게시글 목록을 훑을 때 쓴다. robots.txt를 지킨다."
    )
    args_schema: type[BaseModel] = CrawlSiteInput

    def _run(self, url: str, max_pages: int = 8, path_prefix: str = "") -> str:
        host = urlsplit(url).netloc
        queue, seen, pages, skipped = [url], {url}, [], []
        per_page = max(CRAWL_CHARS // max_pages, 800)
        with _client() as client:
            robots = _Robots(client)
            while queue and len(pages) < max_pages:
                current = queue.pop(0)
                try:
                    page = _fetch(client, robots, current, render=False)
                except (ToolError, httpx.HTTPError) as e:
                    skipped.append(f"- {current}: {e}")
                    continue
                pages.append(
                    f"## {page['title'] or current}\n{current}\n{page['text'][:per_page]}"
                )
                for href in page["links"]:
                    parts = urlsplit(href)
                    if (
                        parts.netloc == host
                        and parts.path.startswith(path_prefix or "/")
                        and href not in seen
                    ):
                        seen.add(href)
                        queue.append(href)
                time.sleep(CRAWL_DELAY)
        if not pages:
            return "읽은 페이지가 없습니다.\n" + "\n".join(skipped)
        tail = "\n\n읽지 못한 페이지:\n" + "\n".join(skipped[:10]) if skipped else ""
        return (
            f"{len(pages)}개 페이지를 읽었습니다 (발견한 링크 {len(seen)}개).\n\n"
            + "\n\n".join(pages)
            + tail
        )


# ---------- Naver search and trends ----------


def naver_search_configured() -> bool:
    return bool(os.getenv("NAVER_CLIENT_ID") and os.getenv("NAVER_CLIENT_SECRET"))


def _naver_open_api(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
    if not naver_search_configured():
        raise ToolError(
            "네이버 검색 API 키(NAVER_CLIENT_ID, NAVER_CLIENT_SECRET)가 설정되지 않았습니다."
        )
    headers = {
        "X-Naver-Client-Id": os.environ["NAVER_CLIENT_ID"],
        "X-Naver-Client-Secret": os.environ["NAVER_CLIENT_SECRET"],
    }
    response = httpx.request(
        method,
        f"https://openapi.naver.com{path}",
        headers=headers,
        timeout=20,
        **kwargs,
    )
    if response.status_code >= 400:
        raise ToolError(
            f"네이버 API 오류 (HTTP {response.status_code}): {response.text[:300]}"
        )
    return response.json()


def _plain(text: str) -> str:
    return BeautifulSoup(text or "", "html.parser").get_text()


SEARCH_KINDS = {
    "blog": "블로그",
    "news": "뉴스",
    "cafearticle": "카페",
    "shop": "쇼핑",
    "webkr": "웹문서",
    "kin": "지식iN",
}


class NaverSearchInput(BaseModel):
    query: str = Field(..., description="검색어")
    kind: Literal["blog", "news", "cafearticle", "shop", "webkr", "kin"] = Field(
        "blog",
        description="blog(블로그), news(뉴스), cafearticle(카페), shop(쇼핑), webkr(웹문서), kin(지식iN)",
    )
    sort: Literal["sim", "date"] = Field(
        "sim", description="sim(정확도순) 또는 date(최신순)"
    )
    count: int = Field(20, ge=1, le=100, description="가져올 결과 수 (최대 100)")


class NaverSearchTool(BaseTool):
    name: str = "naver_search"
    description: str = (
        "네이버에서 블로그·뉴스·카페·쇼핑·웹문서·지식iN을 검색해 제목, 요약, 링크, 날짜(쇼핑은 가격·판매처)와 "
        "전체 검색 결과 수를 돌려준다. 국내 소비자 반응, 경쟁 상품, 가격대, 키워드 경쟁 정도를 볼 때 쓴다."
    )
    args_schema: type[BaseModel] = NaverSearchInput

    def _run(
        self, query: str, kind: str = "blog", sort: str = "sim", count: int = 20
    ) -> str:
        try:
            data = _naver_open_api(
                "GET",
                f"/v1/search/{kind}.json",
                params={"query": query, "display": count, "sort": sort},
            )
        except (ToolError, httpx.HTTPError) as e:
            return str(e)
        lines = [
            f"네이버 {SEARCH_KINDS[kind]} 검색 '{query}': 전체 {data.get('total', 0):,}건 중 {len(data.get('items', []))}건"
        ]
        for i, item in enumerate(data.get("items", []), 1):
            extra = [
                item.get(k)
                for k in ("postdate", "pubDate", "bloggername", "cafename", "mallName")
                if item.get(k)
            ]
            if kind == "shop":
                extra.append(f"최저가 {item.get('lprice')}원")
            lines.append(
                f"{i}. {_plain(item.get('title', ''))} ({' · '.join(extra)})\n"
                f"   {_plain(item.get('description', ''))[:200]}\n   {item.get('link', '')}"
            )
        return "\n".join(lines)


class NaverTrendInput(BaseModel):
    keywords: list[str] = Field(
        ..., min_length=1, max_length=5, description="비교할 검색어 (최대 5개)"
    )
    months: int = Field(12, ge=1, le=36, description="최근 몇 개월을 볼지")
    unit: Literal["date", "week", "month"] = Field(
        "month", description="date(일), week(주), month(월)"
    )


class NaverTrendTool(BaseTool):
    name: str = "naver_trend"
    description: str = (
        "네이버 데이터랩으로 검색어들의 기간별 검색량 추이를 비교한다. 값은 기간 중 가장 많이 검색된 때를 100으로 "
        "둔 상대값이다. 시즌성, 관심 증감, 키워드 간 비교에 쓴다."
    )
    args_schema: type[BaseModel] = NaverTrendInput

    def _run(self, keywords: list[str], months: int = 12, unit: str = "month") -> str:
        end = date.today() - timedelta(days=1)
        start = end - timedelta(days=30 * months)
        body = {
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "timeUnit": unit,
            "keywordGroups": [{"groupName": k, "keywords": [k]} for k in keywords],
        }
        try:
            data = _naver_open_api("POST", "/v1/datalab/search", json=body)
        except (ToolError, httpx.HTTPError) as e:
            return str(e)
        lines = [f"네이버 검색량 추이 {start} ~ {end} (단위: {unit}, 최고점=100)"]
        for group in data.get("results", []):
            points = ", ".join(
                f"{p['period']}: {p['ratio']:.0f}" for p in group.get("data", [])
            )
            lines.append(f"- {group['title']}: {points or '데이터 없음'}")
        return "\n".join(lines)


# ---------- files ----------

FILE_NAME = re.compile(r"^[\w가-힣 .()\-]{1,80}\.(md|csv|txt|json|html)$")
MAX_FILE_BYTES = 2 * 1024 * 1024


class SaveFileInput(BaseModel):
    filename: str = Field(
        ...,
        description="파일 이름 (예: 키워드_목록.csv). 확장자는 md, csv, txt, json, html 중 하나",
    )
    content: str = Field(..., description="파일 내용 전체")


class SaveFileTool(BaseTool):
    name: str = "save_file"
    description: str = (
        "결과물을 파일로 저장한다. 대표가 Report 화면에서 내려받을 수 있다. 표는 CSV(첫 줄 머리글), "
        "문서는 md로 저장한다. 같은 이름으로 다시 저장하면 덮어쓴다."
    )
    args_schema: type[BaseModel] = SaveFileInput
    folder: Path

    def _run(self, filename: str, content: str) -> str:
        filename = filename.strip()
        if not FILE_NAME.fullmatch(filename) or filename.startswith("."):
            return "파일 이름은 글자·숫자·공백·._-() 로만, 확장자는 md/csv/txt/json/html로 지어주세요."
        data = content.encode("utf-8")
        if len(data) > MAX_FILE_BYTES:
            return "파일이 2MB를 넘어 저장하지 않았습니다. 나눠서 저장하세요."
        self.folder.mkdir(parents=True, exist_ok=True)
        # A BOM lets Excel read Korean CSV correctly.
        (self.folder / filename).write_bytes(
            ("﻿".encode() if filename.endswith(".csv") else b"") + data
        )
        return f"'{filename}' 저장 완료 ({len(data):,} bytes). 대표는 Report 화면에서 내려받을 수 있다."
