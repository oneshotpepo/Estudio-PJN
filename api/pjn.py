"""Funcion interna: presenta un escrito en el PJN (o prueba la conexion). Solo la llama /api/carga, con la clave SUBIR_TOKEN.

POST JSON {op: 'probar'}  ->  {ok, mensaje, cuenta}
POST JSON {op: 'cargar', pedido: {numero, descripcion}, pdf_b64}  ->  {estado, etapa, mensaje, pjn_ids, destino}
Usa PJN_USER y PJN_PASSWORD (y opcional PJN_NOMBRE) cargados en Vercel. No guarda ni registra las credenciales.
"""
from http.server import BaseHTTPRequestHandler
import base64
import hmac
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pjnlib.cargar import cargar, probar  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def _json(self, status, obj):
        datos = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def do_GET(self):
        self._json(405, {"error": "Método no permitido"})

    def do_POST(self):
        token = os.environ.get("SUBIR_TOKEN") or ""
        dado = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
        if len(token) < 24 or not hmac.compare_digest(dado.encode(), token.encode()):
            return self._json(401, {"error": "No autorizado"})
        try:
            b = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except Exception:
            return self._json(400, {"error": "JSON inválido"})
        if b.get("op") == "probar":
            return self._json(200, probar(os.environ))
        if b.get("op") == "cargar":
            try:
                pdf = base64.b64decode(b.get("pdf_b64") or "", validate=True)
            except Exception:
                return self._json(400, {"error": "PDF inválido"})
            if not pdf.startswith(b"%PDF"):
                return self._json(400, {"error": "PDF inválido"})
            return self._json(200, cargar(os.environ, b.get("pedido") or {}, pdf))
        return self._json(400, {"error": "Operación desconocida"})

    def log_message(self, *args):  # sin registrar pedidos
        return
