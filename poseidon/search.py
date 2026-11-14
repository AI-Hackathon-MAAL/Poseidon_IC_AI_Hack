"""Live web search with citations. Linkup is the default; Tavily is an alternative.

Every result keeps its sources, so nothing the agent says about the web is uncited.
"""
from __future__ import annotations

import requests

LINKUP_URL = "https://api.linkup.so/v1/search"
TAVILY_URL = "https://api.tavily.com/search"


class SearchError(RuntimeError):
    pass


class SearchClient:
    def __init__(self, key, provider="linkup", session=None, timeout=60):
        if not key:
            raise ValueError("Missing web search key (Databricks secret hackathon/linkup_key)")
        if provider not in ("linkup", "tavily"):
            raise ValueError("provider must be 'linkup' or 'tavily'")
        self.key, self.provider, self.timeout = key, provider, timeout
        self.session = session or requests.Session()
        self.calls = 0

    def search(self, query, from_date=None, to_date=None, max_results=6, depth="standard"):
        """Returns {answer, sources:[{title,url,snippet}], query, provider, from_date, to_date}."""
        self.calls += 1
        try:
            if self.provider == "linkup":
                answer, sources = self._linkup(query, from_date, to_date, max_results, depth)
            else:
                answer, sources = self._tavily(query, max_results)
        except requests.RequestException as e:
            raise SearchError(f"{self.provider} search failed: {e}") from e
        seen, clean = set(), []
        for s in sources:
            url = (s.get("url") or "").strip()
            if url and url not in seen:
                seen.add(url)
                clean.append({"title": (s.get("title") or url)[:200], "url": url,
                              "snippet": (s.get("snippet") or "")[:500]})
        return {"answer": answer, "sources": clean[:max_results], "query": query,
                "provider": self.provider, "from_date": from_date, "to_date": to_date}

    def _linkup(self, query, from_date, to_date, max_results, depth):
        body = {"q": query, "depth": depth, "outputType": "sourcedAnswer"}
        optional = {"maxResults": max_results, "fromDate": from_date, "toDate": to_date}
        headers = {"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        r = self.session.post(LINKUP_URL, headers=headers, timeout=self.timeout,
                              json={**body, **{k: v for k, v in optional.items() if v}})
        if r.status_code == 400:  # an optional filter was rejected: retry with the bare query
            r = self.session.post(LINKUP_URL, headers=headers, json=body, timeout=self.timeout)
        if r.status_code >= 400:
            raise SearchError(f"Linkup HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        raw = d.get("sources") or d.get("results") or []
        return d.get("answer"), [{"title": s.get("name") or s.get("title"), "url": s.get("url"),
                                  "snippet": s.get("snippet") or s.get("content")} for s in raw if isinstance(s, dict)]

    def _tavily(self, query, max_results):
        r = self.session.post(TAVILY_URL, timeout=self.timeout,
                              headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"},
                              json={"query": query, "max_results": max_results, "include_answer": True})
        if r.status_code >= 400:
            raise SearchError(f"Tavily HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        return d.get("answer"), [{"title": s.get("title"), "url": s.get("url"), "snippet": s.get("content")}
                                 for s in d.get("results") or []]
