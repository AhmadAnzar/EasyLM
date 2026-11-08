"""A small in-memory sliding-window rate limiter.

It lives in one process, which is what the free Render tier runs. Each call to check() records a hit
for a key (for example "query:ip:1.2.3.4") and raises HTTP 429 with a Retry-After header once that key
has used up its allowance for the window.
"""
import threading
import time
from collections import deque

from fastapi import HTTPException


class RateLimiter:
    def __init__(self):
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()
        self._last_prune = time.time()

    def check(self, key: str, limit: int, window_seconds: float, what: str = "requests", message: str | None = None):
        now = time.time()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] > window_seconds:
                hits.popleft()
            if len(hits) >= limit:
                retry_after = max(1, int(window_seconds - (now - hits[0])) + 1)
                raise HTTPException(
                    status_code=429,
                    detail=message or f"Too many {what}. Please wait {retry_after} seconds and try again.",
                    headers={"Retry-After": str(retry_after)},
                )
            hits.append(now)
            self._prune(now)

    def _prune(self, now: float):
        # forget keys that have been quiet for a while so the table cannot grow without bound
        if now - self._last_prune < 60:
            return
        self._last_prune = now
        for key in [k for k, hits in self._hits.items() if not hits or now - hits[-1] > 7200]:
            del self._hits[key]
