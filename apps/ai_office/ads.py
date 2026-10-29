"""Ad platforms: Naver Search Ads, Meta (Facebook/Instagram) and Google Ads.

Agents read freely (reports, keyword tools, current settings) but never change anything
themselves: a change becomes an approval request (``store.Action``) and runs only after
an admin approves it in the office. Keys come from the environment (apps/ai_office/.env).
"""

from __future__ import annotations

import base64
from collections.abc import Callable
import hashlib
import hmac
import json
import os
import re
import time
from typing import Any, Literal

from crewai.tools import BaseTool
import httpx
from pydantic import BaseModel, Field


RESULT_CHARS = 20000
Platform = Literal["naver", "meta", "google"]
LABELS = {"naver": "네이버 검색광고", "meta": "메타 광고", "google": "구글 Ads"}
ENV = {
    "naver": ("NAVER_ADS_API_KEY", "NAVER_ADS_SECRET_KEY", "NAVER_ADS_CUSTOMER_ID"),
    "meta": ("META_ACCESS_TOKEN", "META_AD_ACCOUNT_ID"),
    "google": (
        "GOOGLE_ADS_DEVELOPER_TOKEN",
        "GOOGLE_ADS_CLIENT_ID",
        "GOOGLE_ADS_CLIENT_SECRET",
        "GOOGLE_ADS_REFRESH_TOKEN",
        "GOOGLE_ADS_CUSTOMER_ID",
    ),
}
# Google Ads calls that only read, though they are POSTs.
GOOGLE_READS = re.compile(
    r":(search|searchStream|generateKeywordIdeas|generateKeywordHistoricalMetrics)$"
)


class AdsError(Exception):
    pass


def configured(platform: str) -> bool:
    return all(os.getenv(name) for name in ENV[platform])


def _check_path(path: str) -> str:
    if not path.startswith("/") or "://" in path or ".." in path or "?" in path:
        raise AdsError(
            "path는 /로 시작하는 API 경로여야 하고, 쿼리는 params로 넘겨야 합니다."
        )
    return path


# ---------- one request per platform ----------


def _naver(
    method: str, path: str, params: dict[str, Any] | None, body: Any
) -> httpx.Response:
    key, secret, customer = (os.environ[n] for n in ENV["naver"])
    stamp = str(int(time.time() * 1000))
    signature = hmac.new(
        secret.encode(), f"{stamp}.{method}.{path}".encode(), hashlib.sha256
    ).digest()
    headers = {
        "X-Timestamp": stamp,
        "X-API-KEY": key,
        "X-Customer": customer,
        "X-Signature": base64.b64encode(signature).decode(),
    }
    return httpx.request(
        method,
        f"https://api.searchad.naver.com{path}",
        params=params,
        json=body,
        headers=headers,
        timeout=30,
    )


def _meta(
    method: str, path: str, params: dict[str, Any] | None, body: Any
) -> httpx.Response:
    version = os.getenv("META_API_VERSION", "v26.0")
    headers = {"Authorization": f"Bearer {os.environ['META_ACCESS_TOKEN']}"}
    return httpx.request(
        method,
        f"https://graph.facebook.com/{version}{path}",
        params=params,
        json=body,
        headers=headers,
        timeout=30,
    )


_google_token: dict[str, Any] = {}


def _google_access_token() -> str:
    if _google_token.get("expires", 0) > time.time() + 60:
        return _google_token["value"]
    response = httpx.post(
        "https://oauth2.googleapis.com/token",
        data={
            "grant_type": "refresh_token",
            "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
            "refresh_token": os.environ["GOOGLE_ADS_REFRESH_TOKEN"],
        },
        timeout=30,
    )
    if response.status_code >= 400:
        raise AdsError(
            f"구글 로그인 토큰을 갱신하지 못했습니다 (HTTP {response.status_code})."
        )
    data = response.json()
    _google_token.update(
        value=data["access_token"], expires=time.time() + data.get("expires_in", 3600)
    )
    return _google_token["value"]


def _google(
    method: str, path: str, params: dict[str, Any] | None, body: Any
) -> httpx.Response:
    version = os.getenv("GOOGLE_ADS_API_VERSION", "v26")
    headers = {
        "Authorization": f"Bearer {_google_access_token()}",
        "developer-token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
    }
    if os.getenv(
        "GOOGLE_ADS_LOGIN_CUSTOMER_ID"
    ):  # when the account sits under a manager account
        headers["login-customer-id"] = os.environ["GOOGLE_ADS_LOGIN_CUSTOMER_ID"]
    return httpx.request(
        method,
        f"https://googleads.googleapis.com/{version}{path}",
        params=params,
        json=body,
        headers=headers,
        timeout=60,
    )


SENDERS: dict[str, Callable[..., httpx.Response]] = {
    "naver": _naver,
    "meta": _meta,
    "google": _google,
}


def request(
    platform: str,
    method: str,
    path: str,
    params: dict[str, Any] | None = None,
    body: Any = None,
) -> Any:
    """Calls the platform and returns the decoded response; raises AdsError on failure."""
    if not configured(platform):
        raise AdsError(
            f"{LABELS[platform]} API 키가 설정되지 않았습니다 ({', '.join(ENV[platform])})."
        )
    try:
        response = SENDERS[platform](
            method.upper(), _check_path(path), params or None, body
        )
    except httpx.HTTPError as e:
        raise AdsError(f"{LABELS[platform]}에 연결하지 못했습니다: {e}") from None
    try:
        data = response.json()
    except ValueError:
        data = response.text
    if response.status_code >= 400:
        raise AdsError(
            f"{LABELS[platform]} 오류 (HTTP {response.status_code}): {json.dumps(data, ensure_ascii=False)[:1500]}"
        )
    return data


def _dump(data: Any) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=1)
    return (
        text
        if len(text) <= RESULT_CHARS
        else text[:RESULT_CHARS] + f"\n(응답이 길어 앞 {RESULT_CHARS}자만 표시)"
    )


# ---------- what agents see ----------

GUIDES = {
    "naver": (
        "네이버 검색광고 API (https://api.searchad.naver.com). 고객 ID(customerId): {account}. 자주 쓰는 경로: "
        "GET /keywordstool (params: hintKeywords=쉼표로 최대 5개, showDetail=1 → 월간 검색수·클릭수·경쟁정도), "
        "GET /ncc/campaigns, GET /ncc/adgroups (params: nccCampaignId), GET /ncc/keywords (params: nccAdgroupId), "
        "GET /ncc/ads (params: nccAdgroupId), GET /ncc/channels (비즈채널=광고할 사이트), "
        'GET /stats (params: ids, fields=\'["impCnt","clkCnt","salesAmt","ctr","cpc"]\', '
        'timeRange=\'{"since":"2026-10-01","until":"2026-10-28"}\').'
    ),
    "meta": (
        "메타 Marketing API (Graph API). 광고 계정: act_{account}. 자주 쓰는 경로: "
        "GET /act_{account}/campaigns (params: fields=name,status,objective,daily_budget), "
        "GET /act_{account}/adsets, GET /act_{account}/ads, "
        "GET /act_{account}/insights (params: level=campaign, date_preset=last_7d, "
        "fields=campaign_name,spend,impressions,clicks,ctr,cpc,actions), "
        "GET /act_{account}/targetingsearch (params: q=관심사). 금액은 계정 통화의 최소 단위다(원화면 원)."
    ),
    "google": (
        "구글 Ads API. 고객 ID: {account}. 읽기: POST /customers/{account}/googleAds:search "
        '(body: {"query": "SELECT campaign.name, metrics.clicks, metrics.cost_micros FROM campaign '
        'WHERE segments.date DURING LAST_7_DAYS"}), POST /customers/{account}:generateKeywordIdeas '
        '(body: {"language": "languageConstants/1012", "geoTargetConstants": ["geoTargetConstants/2410"], '
        '"keywordSeed": {"keywords": ["..."]}}). 금액은 micros(1원 = 1,000,000).'
    ),
}
CHANGE_GUIDES = {
    "naver": (
        "예: POST /ncc/campaigns (body: campaignTp=WEB_SITE, name, customerId, dailyBudget, useDailyBudget=true, "
        "userLock=true), POST /ncc/adgroups, POST /ncc/keywords (params: nccAdgroupId, body: 키워드 목록), "
        "POST /ncc/ads, PUT /ncc/keywords/{id} (params: fields=bidAmt), PUT /ncc/campaigns/{id} (params: fields=userLock)."
    ),
    "meta": (
        "예: POST /act_{account}/campaigns (body: name, objective, status=PAUSED, special_ad_categories=[]), "
        "POST /act_{account}/adsets, POST /act_{account}/adcreatives, POST /act_{account}/ads, "
        "POST /{id} (body: status 또는 daily_budget 변경)."
    ),
    "google": (
        "예: POST /customers/{account}/googleAds:mutate (body: mutateOperations, 새 캠페인은 status=PAUSED)."
    ),
}


def _account(platform: str) -> str:
    raw = os.getenv(
        {
            "naver": "NAVER_ADS_CUSTOMER_ID",
            "meta": "META_AD_ACCOUNT_ID",
            "google": "GOOGLE_ADS_CUSTOMER_ID",
        }[platform],
        "",
    )
    return raw.removeprefix("act_").replace("-", "") or "(미설정)"


# Free-form objects can't go through strict tool schemas (they'd have to stay empty),
# so params and bodies travel as JSON text.
PARAMS_HELP = '쿼리 파라미터, JSON 객체 문자열 (예: {"hintKeywords": "미술학원", "showDetail": "1"}). 없으면 빈 문자열'


def _json(text: str, kind: type | tuple[type, ...]) -> Any:
    if not text.strip():
        return None
    try:
        value = json.loads(text)
    except ValueError as e:
        raise AdsError(f"JSON 형식이 아닙니다: {e}") from None
    if not isinstance(value, kind):
        raise AdsError("params는 JSON 객체, body는 JSON 객체나 배열이어야 합니다.")
    return value


class ReadInput(BaseModel):
    path: str = Field(
        ..., description="API 경로 (예: /ncc/campaigns). 쿼리 문자열은 params로"
    )
    params: str = Field("", description=PARAMS_HELP)
    body: str = Field(
        "", description="구글 Ads 조회(search 등)에만 쓰는 요청 본문, JSON 문자열"
    )


class AdsReadTool(BaseTool):
    """Looks things up on an ad platform; never changes anything."""

    args_schema: type[BaseModel] = ReadInput
    platform: Platform

    def _run(self, path: str, params: str = "", body: str = "") -> str:
        method = "GET"
        if self.platform == "google" and GOOGLE_READS.search(path):
            method = "POST"
        elif body.strip():
            return "조회 도구는 GET만 보냅니다(구글 Ads search/키워드 아이디어 제외). 변경은 승인 요청 도구를 쓰세요."
        try:
            return _dump(
                request(
                    self.platform, method, path, _json(params, dict), _json(body, dict)
                )
            )
        except AdsError as e:
            return str(e)


class ChangeInput(BaseModel):
    method: Literal["POST", "PUT", "DELETE"] = Field(..., description="HTTP 메서드")
    path: str = Field(..., description="API 경로. 쿼리 문자열은 params로")
    params: str = Field("", description=PARAMS_HELP)
    body: str = Field(
        "",
        description="요청 본문, JSON 문자열 (객체, 또는 키워드 목록처럼 객체의 배열). 없으면 빈 문자열",
    )
    summary: str = Field(
        ...,
        min_length=5,
        max_length=500,
        description="무엇을 왜 바꾸는지 대표가 읽을 한두 문장",
    )
    daily_cost_krw: int = Field(
        ...,
        ge=0,
        description="이 변경으로 늘어나는 하루 최대 비용(원). 비용이 없으면 0",
    )


class AdsChangeTool(BaseTool):
    """Files an approval request; the change runs only after an admin approves it."""

    args_schema: type[BaseModel] = ChangeInput
    platform: Platform
    propose: Callable[[dict[str, Any]], str]

    def _run(
        self,
        method: str,
        path: str,
        summary: str,
        daily_cost_krw: int,
        params: str = "",
        body: str = "",
    ) -> str:
        try:
            _check_path(path)
            query, payload = _json(params, dict), _json(body, (dict, list))
        except AdsError as e:
            return str(e)
        if self.platform == "google" and GOOGLE_READS.search(path):
            return "조회는 승인 없이 조회 도구로 하세요."
        action_id = self.propose(
            {
                "platform": self.platform,
                "method": method,
                "path": path,
                "params": query or {},
                "body": payload,
                "summary": summary,
                "daily_cost_krw": daily_cost_krw,
            }
        )
        return (
            f"승인 요청 #{action_id}을 올렸다. 대표가 '승인' 화면에서 승인해야 실제로 반영된다. "
            "반영된 것으로 가정하지 말고, 결과물에 승인이 필요한 항목으로 적어라."
        )


def tools_for(
    platform: Platform, propose: Callable[[dict[str, Any]], str]
) -> list[BaseTool]:
    account = _account(platform)
    guide = GUIDES[platform].replace("{account}", account)
    change = CHANGE_GUIDES[platform].replace("{account}", account)
    return [
        AdsReadTool(
            name=f"{platform}_ads_read",
            description=f"{LABELS[platform]} 조회 전용 (변경 없음). {guide}",
            platform=platform,
        ),
        AdsChangeTool(
            name=f"{platform}_ads_request_change",
            description=(
                f"{LABELS[platform]}에 광고 등록·수정·켜기/끄기·입찰가·예산 변경을 요청한다. 바로 실행되지 않고 "
                "대표 승인 대기열에 올라가며, 승인되면 이 요청 그대로 실행된다. 새로 만드는 캠페인·광고는 항상 "
                f"일시중지(OFF) 상태로 만들고 켜는 것은 따로 요청하라. 한 번에 하나의 API 호출. {change}"
            ),
            platform=platform,
            propose=propose,
        ),
    ]
