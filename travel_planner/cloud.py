"""Supabase RPC 호출 (표준 라이브러리만 사용)."""

import json
import urllib.error
import urllib.request


class CloudError(RuntimeError):
    pass


class Cloud:
    def __init__(self, url: str, key: str, owner_key: str = ""):
        self.url = url.rstrip("/")
        self.key = key
        self.owner_key = owner_key

    def _headers(self) -> dict:
        headers = {"apikey": self.key, "Content-Type": "application/json"}
        # 예전 형식(JWT) anon 키는 Authorization에도 넣는다. 새 형식(sb_publishable_...)은 넣으면 안 됨
        if not self.key.startswith("sb_"):
            headers["Authorization"] = f"Bearer {self.key}"
        return headers

    def rpc(self, fn: str, **params):
        req = urllib.request.Request(
            f"{self.url}/rest/v1/rpc/{fn}",
            data=json.dumps(params, ensure_ascii=False).encode("utf-8"),
            headers=self._headers(),
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                body = res.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            try:
                detail = json.loads(detail).get("message", detail)
            except json.JSONDecodeError:
                pass
            raise CloudError(f"{fn} 실패 ({e.code}): {detail}") from None
        except urllib.error.URLError as e:
            raise CloudError(f"Supabase에 연결할 수 없습니다: {e.reason}") from None
        return json.loads(body) if body else None

    def owner_rpc(self, fn: str, **params):
        return self.rpc(fn, p_owner_key=self.owner_key, **params)
