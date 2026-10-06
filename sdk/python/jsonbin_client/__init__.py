"""
Official Python SDK for JSONBin (Cloudflare Workers + R2).
"""

from typing import Any, Dict, List, Optional, Union
import json
import urllib.request
import urllib.error
import urllib.parse


class JsonBinError(Exception):
    def __init__(self, message: str, status_code: int, data: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.data = data


class AuthenticationError(JsonBinError):
    def __init__(self, message: str = "Unauthorized", data: Any = None):
        super().__init__(message, 401, data)


class PermissionDeniedError(JsonBinError):
    def __init__(self, message: str = "Permission Denied", data: Any = None):
        super().__init__(message, 403, data)


class NotFoundError(JsonBinError):
    def __init__(self, message: str = "Resource Not Found", data: Any = None):
        super().__init__(message, 404, data)


class ConflictError(JsonBinError):
    def __init__(self, message: str = "Conflict", data: Any = None):
        super().__init__(message, 409, data)


class EtagConflictError(ConflictError):
    def __init__(self, message: str = "ETag Conflict", data: Any = None):
        super().__init__(message, data)
        self.status_code = 412


class ValidationError(JsonBinError):
    def __init__(self, message: str = "Validation Error", data: Any = None):
        super().__init__(message, 422, data)


class LockedError(JsonBinError):
    def __init__(self, message: str = "Resource Locked", data: Any = None):
        super().__init__(message, 423, data)


class PreconditionRequiredError(JsonBinError):
    def __init__(self, message: str = "Precondition (If-Match) Required", data: Any = None):
        super().__init__(message, 428, data)


class RateLimitError(JsonBinError):
    def __init__(self, message: str = "Rate Limit Exceeded", retry_after: int = 60, data: Any = None):
        super().__init__(message, 429, data)
        self.retry_after = retry_after


class ServerError(JsonBinError):
    def __init__(self, message: str = "Server Error", status_code: int = 500, data: Any = None):
        super().__init__(message, status_code, data)


def _map_http_error(status: int, body: Any, headers: Any) -> JsonBinError:
    msg = ""
    if isinstance(body, dict):
        msg = body.get("error") or body.get("message") or f"HTTP {status}"
    else:
        msg = str(body) if body else f"HTTP {status}"

    if status == 401:
        return AuthenticationError(msg, body)
    elif status == 403:
        return PermissionDeniedError(msg, body)
    elif status == 404:
        return NotFoundError(msg, body)
    elif status == 409:
        return ConflictError(msg, body)
    elif status == 412:
        return EtagConflictError(msg, body)
    elif status == 422:
        return ValidationError(msg, body)
    elif status == 423:
        return LockedError(msg, body)
    elif status == 428:
        return PreconditionRequiredError(msg, body)
    elif status == 429:
        retry_after = 60
        if headers:
            try:
                retry_after = int(headers.get("Retry-After", 60))
            except Exception:
                pass
        return RateLimitError(msg, retry_after, body)
    elif status >= 500:
        return ServerError(msg, status, body)
    return JsonBinError(msg, status, body)


class BinsResource:
    def __init__(self, client: "JsonBin"):
        self._client = client

    def list(self, tag: Optional[str] = None, favorite: Optional[bool] = None, pinned: Optional[bool] = None) -> Dict[str, Any]:
        params = {}
        if tag:
            params["tag"] = tag
        if favorite is not None:
            params["favorite"] = str(favorite).lower()
        if pinned is not None:
            params["pinned"] = str(pinned).lower()
        qs = f"?{urllib.parse.urlencode(params)}" if params else ""
        res, _ = self._client._request(f"/bins{qs}", method="GET")
        return res

    def get(self, id_or_slug: str, if_none_match: Optional[str] = None) -> Dict[str, Any]:
        is_uuid = len(id_or_slug) == 36 and id_or_slug.count("-") == 4
        path = f"/bins/{id_or_slug}" if is_uuid else f"/b/{id_or_slug}"
        headers = {}
        if if_none_match:
            headers["If-None-Match"] = if_none_match
        res, status = self._client._request(path, method="GET", headers=headers)
        if status == 304:
            return {"modified": False}
        return res

    def get_published(self, id_or_slug: str) -> Dict[str, Any]:
        is_uuid = len(id_or_slug) == 36 and id_or_slug.count("-") == 4
        path = f"/bins/{id_or_slug}/published" if is_uuid else f"/b/{id_or_slug}/published"
        res, _ = self._client._request(path, method="GET")
        return res

    def create(self, name: str, value: Any, **kwargs) -> Dict[str, Any]:
        payload = {"name": name, "value": value}
        payload.update(kwargs)
        res, _ = self._client._request("/bins", method="POST", data=payload)
        return res

    def update(self, id: str, value: Any, etag: str, message: Optional[str] = None) -> Dict[str, Any]:
        headers = {"If-Match": etag}
        if message:
            headers["X-JSONBin-Message"] = urllib.parse.quote(message)
        res, _ = self._client._request(f"/bins/{id}", method="PUT", data={"value": value}, headers=headers)
        return res

    def merge_patch(self, id: str, patch: Dict[str, Any], etag: str) -> Dict[str, Any]:
        headers = {"If-Match": etag, "Content-Type": "application/merge-patch+json"}
        res, _ = self._client._request(f"/bins/{id}", method="PATCH", data=patch, headers=headers)
        return res

    def json_patch(self, id: str, patch: List[Dict[str, Any]], etag: str) -> Dict[str, Any]:
        headers = {"If-Match": etag, "Content-Type": "application/json-patch+json"}
        res, _ = self._client._request(f"/bins/{id}", method="PATCH", data=patch, headers=headers)
        return res

    def publish(self, id: str, etag: str, version: Optional[int] = None) -> Dict[str, Any]:
        headers = {"If-Match": etag}
        payload = {}
        if version is not None:
            payload["version"] = version
        res, _ = self._client._request(f"/bins/{id}/publish", method="POST", data=payload, headers=headers)
        return res

    def rollback(self, id: str, etag: str, version: int) -> Dict[str, Any]:
        headers = {"If-Match": etag}
        res, _ = self._client._request(f"/bins/{id}/rollback", method="POST", data={"version": version}, headers=headers)
        return res

    def delete(self, id: str, etag: Optional[str] = None) -> Dict[str, Any]:
        headers = {"If-Match": etag} if etag else {}
        res, _ = self._client._request(f"/bins/{id}", method="DELETE", headers=headers)
        return res


class JsonBin:
    def __init__(self, base_url: str, token: Optional[str] = None, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.bins = BinsResource(self)

    def _request(
        self,
        path: str,
        method: str = "GET",
        data: Any = None,
        headers: Optional[Dict[str, str]] = None,
    ):
        url = f"{self.base_url}/api/v1{path if path.startswith('/') else '/' + path}"
        req_headers = {"User-Agent": "jsonbin-python-sdk/3.2.0"}
        if self.token:
            req_headers["Authorization"] = f"Bearer {self.token}"
        if headers:
            req_headers.update(headers)

        body_bytes = None
        if data is not None:
            if "Content-Type" not in req_headers:
                req_headers["Content-Type"] = "application/json"
            body_bytes = json.dumps(data).encode("utf-8")

        req = urllib.request.Request(url, data=body_bytes, headers=req_headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                status = resp.status
                etag = resp.headers.get("ETag", "")
                resp_body = resp.read().decode("utf-8")
                try:
                    parsed = json.loads(resp_body) if resp_body else {}
                except Exception:
                    parsed = resp_body
                if isinstance(parsed, dict) and etag and "etag" not in parsed:
                    parsed["etag"] = etag
                return parsed, status
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8")
            try:
                parsed_err = json.loads(err_body)
            except Exception:
                parsed_err = err_body
            if e.code == 304:
                return None, 304
            raise _map_http_error(e.code, parsed_err, e.headers)
        except Exception as e:
            raise JsonBinError(str(e), 0)
