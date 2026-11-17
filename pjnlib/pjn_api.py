"""Direct PJN authentication and API operations; no browser is required."""

from __future__ import annotations

import ast
import base64
import hashlib
import json
from pathlib import Path
import secrets
import time
import unicodedata
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse

from bs4 import BeautifulSoup
import requests


PORTAL = "https://escritos.pjn.gov.ar"
API = f"{PORTAL}/api"
REALM = "https://sso.pjn.gov.ar/auth/realms/pjn"
CLIENT_ID = "pjn-escritos"
CALLBACK = f"{PORTAL}/auth/callback"
TIMEOUT = (15, 60)


class PJNError(RuntimeError):
    pass


def normalized_account_name(value: str) -> str:
    characters = unicodedata.normalize("NFKD", value)
    unaccented = "".join(char for char in characters if not unicodedata.combining(char))
    return " ".join(unaccented.upper().split())


def credentials_from_script(path: Path) -> tuple[str, str]:
    """Read legacy constants without importing or executing the original bot."""
    values = {}
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in {"PJN_USER", "PJN_PASSWORD"}:
                    values[target.id] = node.value.value
    if not all(isinstance(values.get(key), str) and values[key] for key in ("PJN_USER", "PJN_PASSWORD")):
        raise PJNError("The legacy script must contain PJN_USER and PJN_PASSWORD string constants.")
    return values["PJN_USER"], values["PJN_PASSWORD"]


class PJNClient:
    def __init__(self, username: str, password: str, expected_name: str | None = None):
        self.username = username
        self.password = password
        self.expected_name = expected_name
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36",
            "Origin": PORTAL,
            "Referer": f"{PORTAL}/nuevo",
        })
        self.access_token = None
        self.refresh_token = None
        self.expires_at = 0.0
        self.author_cuil = None
        self.author_name = None

    def close(self) -> None:
        self.session.close()

    def _set_tokens(self, data: dict) -> None:
        if not isinstance(data.get("access_token"), str) or not data["access_token"]:
            raise PJNError("PJN did not return an access token.")
        self.access_token = data["access_token"]
        # Read server-issued profile metadata; PJN itself validates the bearer token.
        try:
            encoded = self.access_token.split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            cuil = str(claims["cuil"])
            if len(cuil) != 11 or not cuil.isdecimal():
                raise ValueError
            self.author_cuil = cuil
            self.author_name = str(claims.get("name") or "").strip()
        except (IndexError, KeyError, ValueError, TypeError):
            raise PJNError("The PJN token does not identify the filing author.") from None
        if self.expected_name:
            if normalized_account_name(self.author_name) != normalized_account_name(self.expected_name):
                self.access_token = None
                raise PJNError("The authenticated PJN account does not match the configured author.")
        self.refresh_token = data.get("refresh_token") or self.refresh_token
        self.expires_at = time.time() + float(data.get("expires_in", 240))

    def login(self) -> None:
        verifier = secrets.token_urlsafe(72)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).decode("ascii").rstrip("=")
        state = secrets.token_urlsafe(32)
        params = {
            "client_id": CLIENT_ID, "redirect_uri": CALLBACK,
            "response_type": "code", "scope": "openid pjn-template",
            "state": state, "nonce": secrets.token_urlsafe(32),
            "code_challenge": challenge, "code_challenge_method": "S256",
        }
        try:
            response = self.session.get(f"{REALM}/protocol/openid-connect/auth", params=params, timeout=TIMEOUT)
            response.raise_for_status()
            if not parse_qs(urlparse(response.url).query).get("code"):
                soup = BeautifulSoup(response.text, "html.parser")
                form = soup.find("form", id="kc-form-login")
                if form is None:
                    raise PJNError("PJN requires an unsupported login step; no credentials were submitted.")
                action = urljoin(response.url, form.get("action", ""))
                if urlparse(action).scheme != "https" or urlparse(action).netloc != "sso.pjn.gov.ar":
                    raise PJNError("Unexpected PJN login destination.")
                fields = {
                    element["name"]: element.get("value", "")
                    for element in form.find_all("input", attrs={"name": True})
                    if element.get("type", "").lower() not in {"submit", "button", "checkbox", "radio"}
                }
                fields.update(username=self.username, password=self.password)
                response = self.session.post(action, data=fields, headers={"Origin": "https://sso.pjn.gov.ar"}, timeout=TIMEOUT)
                response.raise_for_status()
            callback = urlparse(response.url)
            query = parse_qs(callback.query)
            if (callback.scheme, callback.netloc, callback.path) != ("https", "escritos.pjn.gov.ar", "/auth/callback"):
                raise PJNError("Login did not complete. Check credentials or additional authentication requirements.")
            if query.get("state") != [state] or not query.get("code"):
                raise PJNError("Invalid OAuth callback or missing authorization code.")
            response = self.session.post(f"{REALM}/protocol/openid-connect/token", data={
                "grant_type": "authorization_code", "client_id": CLIENT_ID,
                "redirect_uri": CALLBACK, "code": query["code"][0], "code_verifier": verifier,
            }, timeout=TIMEOUT)
            response.raise_for_status()
            self._set_tokens(response.json())
        except requests.RequestException as exc:
            status = exc.response.status_code if exc.response is not None else "unavailable"
            raise PJNError(f"PJN login failed (HTTP {status}).") from None

    def token(self) -> str:
        if self.access_token and time.time() < self.expires_at - 45:
            return self.access_token
        if self.refresh_token:
            try:
                response = self.session.post(f"{REALM}/protocol/openid-connect/token", data={
                    "grant_type": "refresh_token", "client_id": CLIENT_ID,
                    "refresh_token": self.refresh_token,
                }, timeout=TIMEOUT)
                if response.ok:
                    self._set_tokens(response.json())
                    return self.access_token
            except (requests.RequestException, ValueError):
                pass
        self.login()
        return self.access_token

    def request(self, method: str, path: str, **kwargs) -> requests.Response:
        if not path.startswith("/") or path.startswith("//") or "://" in path:
            raise ValueError("Expected a relative PJN API path.")
        token = self.token()
        attempts = 3 if method == "GET" else 1
        refreshed = False
        for attempt in range(attempts):
            try:
                response = self.session.request(method, API + path, headers={"Authorization": f"Bearer {token}"}, timeout=TIMEOUT, allow_redirects=False, **kwargs)
            except requests.RequestException:
                if method == "GET" and attempt < attempts - 1:
                    time.sleep(attempt + 1)
                    continue
                raise PJNError(f"Connection failed during {method} {path}; mutations are never retried automatically.") from None
            if response.status_code == 401 and method == "GET" and not refreshed and attempt < attempts - 1:
                self.expires_at = 0
                token = self.token()
                refreshed = True
                continue
            if method == "GET" and attempt < attempts - 1 and (response.status_code == 429 or response.status_code >= 500):
                try:
                    delay = float(response.headers.get("Retry-After", attempt + 1))
                except (TypeError, ValueError):
                    delay = attempt + 1
                if 0 <= delay <= 60:
                    time.sleep(delay)
                    continue
            if not 200 <= response.status_code < 300:
                raise PJNError(f"PJN returned HTTP {response.status_code} for {method} {path}.")
            return response
        raise PJNError("PJN authentication failed.")

    def get(self, path: str, **params):
        response = self.request("GET", path, params=params)
        try:
            return response.json()
        except ValueError:
            raise PJNError(f"PJN returned an invalid JSON response for GET {path}.") from None

    def upload_pdf(self, path: Path) -> str:
        with path.open("rb") as stream:
            return self.upload_pdf_bytes(path.name, stream.read())

    def upload_pdf_bytes(self, name: str, data: bytes) -> str:
        response = self.request("POST", "/adjuntos", files={"file": (quote(name, safe=""), data, "application/pdf")})
        try:
            key = response.json()["clave"]
        except (ValueError, KeyError, TypeError):
            raise PJNError("Upload returned no attachment key; submission was not attempted.") from None
        if not isinstance(key, str) or not key:
            raise PJNError("Upload returned an invalid attachment key.")
        return key

    def submit(self, payload: dict) -> dict:
        response = self.request("POST", "/escritos/ingresar", json=payload)
        try:
            body = response.json() if response.content else None
        except ValueError:
            body = None
        return {"http_status": response.status_code, "body": body}
