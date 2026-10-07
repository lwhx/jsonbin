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


# Sentinel distinguishing "caller passed None as the JSON body" from "caller
# passed no body at all"; a root-null merge patch must be transmitted.
_UNSET = object()


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
            return res
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

    def merge_patch(self, id: str, patch: Optional[Dict[str, Any]], etag: str) -> Dict[str, Any]:
        """patch=None is a legal RFC 7396 operation: replace the document with null."""
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

    def list_versions(self, id: str) -> Dict[str, Any]:
        res, _ = self._client._request(f"/bins/{id}/versions", method="GET")
        return res

    def get_version(self, id: str, version: int) -> Dict[str, Any]:
        res, _ = self._client._request(f"/bins/{id}/versions/{version}", method="GET")
        return res


class CollectionsResource:
    def __init__(self, client: "JsonBin"):
        self._client = client

    def list(self) -> Dict[str, Any]:
        res, _ = self._client._request("/collections", method="GET")
        return res

    def get(self, id: str) -> Dict[str, Any]:
        res, _ = self._client._request(f"/collections/{id}", method="GET")
        return res

    def create(self, name: str, description: Optional[str] = None) -> Dict[str, Any]:
        data = {"name": name}
        if description:
            data["description"] = description
        res, _ = self._client._request("/collections", method="POST", data=data)
        return res

    def update(self, id: str, etag: str, name: Optional[str] = None, description: Optional[str] = None) -> Dict[str, Any]:
        data = {}
        if name is not None:
            data["name"] = name
        if description is not None:
            data["description"] = description
        res, _ = self._client._request(f"/collections/{id}", method="PATCH", data=data, headers={"If-Match": etag})
        return res

    def delete(self, id: str, etag: str) -> Dict[str, Any]:
        res, _ = self._client._request(f"/collections/{id}", method="DELETE", headers={"If-Match": etag})
        return res


class SchemasResource:
    def __init__(self, client: "JsonBin"):
        self._client = client

    def list(self) -> Dict[str, Any]:
        res, _ = self._client._request("/schemas", method="GET")
        return res

    def get(self, id: str) -> Dict[str, Any]:
        res, _ = self._client._request(f"/schemas/{id}", method="GET")
        return res

    def create(self, name: str, schema: Dict[str, Any], description: Optional[str] = None) -> Dict[str, Any]:
        data = {"name": name, "schema": schema}
        if description:
            data["description"] = description
        res, _ = self._client._request("/schemas", method="POST", data=data)
        return res

    def update(self, id: str, etag: str, name: Optional[str] = None, schema: Optional[Dict[str, Any]] = None, description: Optional[str] = None) -> Dict[str, Any]:
        data = {}
        if name is not None:
            data["name"] = name
        if schema is not None:
            data["schema"] = schema
        if description is not None:
            data["description"] = description
        res, _ = self._client._request(f"/schemas/{id}", method="PUT", data=data, headers={"If-Match": etag})
        return res

    def delete(self, id: str, etag: str) -> Dict[str, Any]:
        res, _ = self._client._request(f"/schemas/{id}", method="DELETE", headers={"If-Match": etag})
        return res

    def validate(self, id: str, value: Any) -> Dict[str, Any]:
        res, _ = self._client._request(f"/schemas/{id}/validate", method="POST", data={"value": value})
        return res


class TrashResource:
    def __init__(self, client: "JsonBin"):
        self._client = client

    def list(self) -> Dict[str, Any]:
        res, _ = self._client._request("/trash/bins", method="GET")
        return res

    def restore(self, id: str, etag: str) -> Dict[str, Any]:
        res, _ = self._client._request(f"/trash/bins/{id}/restore", method="POST", headers={"If-Match": etag})
        return res

    def purge(self, id: str, etag: str) -> Dict[str, Any]:
        res, _ = self._client._request(f"/trash/bins/{id}", method="DELETE", headers={"If-Match": etag})
        return res

    def purge_many(self, items: List[Dict[str, str]]) -> Dict[str, Any]:
        """Permanently purge explicit client-approved snapshots only.

        There is deliberately no "empty everything" form: every item must carry
        the ETag of the trash entry the caller confirmed.
        """
        res, _ = self._client._request("/trash/bins/purge", method="POST", data={"items": items})
        return res


class SearchResource:
    def __init__(self, client: "JsonBin"):
        self._client = client

    def metadata(self, query: str, search_type: str = "all", limit: int = 20, cursor: Optional[str] = None) -> Dict[str, Any]:
        params = {"q": query, "type": search_type, "limit": str(limit)}
        if cursor:
            params["cursor"] = cursor
        qs = urllib.parse.urlencode(params)
        res, _ = self._client._request(f"/search?{qs}", method="GET")
        return res

    def content(self, query: str, mode: Optional[str] = None) -> Dict[str, Any]:
        params = {"q": query}
        if mode:
            params["mode"] = mode
        qs = urllib.parse.urlencode(params)
        res, _ = self._client._request(f"/search/content?{qs}", method="GET")
        return res


class JsonBin:
    def __init__(self, base_url: str, token: Optional[str] = None, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.bins = BinsResource(self)
        self.collections = CollectionsResource(self)
        self.schemas = SchemasResource(self)
        # API key management is intentionally not exposed: those endpoints are
        # Session-only and this client is Bearer-only.
        self.trash = TrashResource(self)
        self.search = SearchResource(self)

    def _request(
        self,
        path: str,
        method: str = "GET",
        data: Any = _UNSET,
        headers: Optional[Dict[str, str]] = None,
    ):
        url = f"{self.base_url}/api/v1{path if path.startswith('/') else '/' + path}"
        req_headers = {"User-Agent": "jsonbin-python-sdk/3.2.0"}
        if self.token:
            req_headers["Authorization"] = f"Bearer {self.token}"
        if headers:
            req_headers.update(headers)

        body_bytes = None
        # Distinguish "no body" from an explicit JSON null body: a root-null
        # merge patch must be transmitted, not silently dropped.
        if data is not _UNSET:
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
                # Keep the callers' cache key: the 304 response still carries
                # the current ETag.
                return {"modified": False, "etag": e.headers.get("ETag", "")}, 304
            raise _map_http_error(e.code, parsed_err, e.headers)
        except Exception as e:
            raise JsonBinError(str(e), 0)
