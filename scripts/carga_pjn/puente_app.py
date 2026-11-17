"""Puente entre el Cargador PJN y la app nueva del estudio (estudiopjn.vercel.app).

La app nueva no usa Google Drive: cuando alguien confirma "Cargar al PJN", el PDF y el pedido quedan guardados
en la app. Este modulo, que el Cargador llama en cada vuelta, baja esos pedidos a la misma carpeta "Carga PJN"
(asi el Cargador los presenta igual que siempre) y despues le avisa a la app como termino cada uno.

No presenta nada por si mismo ni toca las credenciales del PJN. Usa la direccion y la clave de
vercel_subir.txt (el mismo archivo que usa subir_vercel.py, en la carpeta de al lado). Si ese archivo no
esta, no hace nada.
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

AQUI = Path(__file__).resolve().parent
CADA = 30            # segundos entre consultas a la app, de dia
CADA_NOCHE = 600     # de 22 a 7 consulta cada 10 minutos
_ultima = 0.0
_avisado_falta = False


def _config():
    for p in (AQUI / "vercel_subir.txt", AQUI.parent / "vercel_subir.txt"):
        if p.is_file():
            lineas = [l.strip() for l in p.read_text(encoding="utf-8-sig").splitlines() if l.strip()]
            if len(lineas) >= 2:
                return lineas[0].rstrip("/"), lineas[1]
    return None


def _pedir(url, token, op, cuerpo, crudo=False):
    req = urllib.request.Request(f"{url}/api/subir?op={op}", data=json.dumps(cuerpo).encode("utf-8"), method="POST",
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json",
                                          "User-Agent": "cargador-pjn"})
    with urllib.request.urlopen(req, timeout=60) as r:
        datos = r.read()
    return datos if crudo else json.loads(datos.decode("utf-8") or "{}")


def _bajar(url, token, carpeta: Path) -> int:
    n = 0
    for c in _pedir(url, token, "cargas", {}).get("cargas", []):
        pid = str(c.get("id") or "")
        if not pid or any(ch in pid for ch in '\\/:*?"<>|') or pid.startswith("."):
            continue
        pedido_p = carpeta / f"{pid}.pedido.json"
        if not pedido_p.exists():
            pdf = _pedir(url, token, "carga_pdf", {"id": pid}, crudo=True)
            if not pdf.startswith(b"%PDF"):
                _pedir(url, token, "carga_res", {"id": pid, "estado": "error", "mensaje": "El PDF llego mal a la PC. Volve a cargarlo."})
                continue
            if c.get("pdf_sha256") and hashlib.sha256(pdf).hexdigest() != c["pdf_sha256"]:
                _pedir(url, token, "carga_res", {"id": pid, "estado": "error", "mensaje": "El PDF llego distinto a la PC. Volve a cargarlo."})
                continue
            (carpeta / f"{pid}.pdf").write_bytes(pdf)
            pedido = {"pdf": f"{pid}.pdf", "pdf_sha256": c.get("pdf_sha256"), "numero": c.get("numero"), "caratula": c.get("caratula"),
                      "descripcion": c.get("descripcion"), "escrito_id": c.get("escrito_id"), "expediente_id": c.get("expediente_id"),
                      "at": c.get("at"), "origen": "app", "de": c.get("de")}
            # el pedido se escribe ultimo y de una: el Cargador recien lo ve cuando el PDF ya esta completo
            tmp = carpeta / f"{pid}.pedido.tmp"
            tmp.write_text(json.dumps(pedido, ensure_ascii=False, indent=1), encoding="utf-8")
            tmp.replace(pedido_p)
            print(f"{datetime.now():%d/%m %H:%M} Pedido de la app nueva: {c.get('numero')} | {c.get('descripcion')}", flush=True)
            n += 1
        _pedir(url, token, "carga_res", {"id": pid, "estado": "tomado"})
    return n


def _avisar(url, token, carpeta: Path) -> int:
    """Manda a la app los resultados de los pedidos que vinieron de ella (una sola vez cada uno)."""
    n = 0
    for res_p in carpeta.glob("*.resultado.json"):
        pid = res_p.name[: -len(".resultado.json")]
        marca = carpeta / f"{pid}.avisado"
        pedido_p = carpeta / f"{pid}.pedido.json"
        if marca.exists() or not pedido_p.exists():
            continue
        try:
            if json.loads(pedido_p.read_text(encoding="utf-8")).get("origen") != "app":
                continue
            r = json.loads(res_p.read_text(encoding="utf-8"))
        except Exception:
            continue
        estado = r.get("estado") if r.get("estado") in ("cargado", "error", "revisar") else "error"
        try:
            _pedir(url, token, "carga_res", {"id": pid, "estado": estado, "mensaje": r.get("mensaje", ""), "pjn_ids": r.get("pjn_ids", []),
                                             "destino": r.get("destino", ""), "fecha": r.get("fecha", "")})
        except urllib.error.HTTPError as exc:
            if exc.code != 404:  # 404: ese pedido ya no existe en la app; no se insiste
                raise
        marca.write_text(datetime.now().isoformat(timespec="seconds"), encoding="utf-8")
        n += 1
    return n


def sincronizar(carpeta: Path, forzar: bool = False) -> int:
    """Llamar seguido: baja pedidos nuevos y avisa resultados. Nunca levanta errores (sin internet, sigue despues)."""
    global _ultima, _avisado_falta
    cfg = _config()
    if not cfg:
        if not _avisado_falta:
            print("App nueva: no esta vercel_subir.txt, sigo solo con los pedidos de Drive.", flush=True)
            _avisado_falta = True
        return 0
    url, token = cfg
    n = 0
    try:
        n += _avisar(url, token, carpeta)  # los resultados salen enseguida
        cada = CADA if 7 <= datetime.now().hour < 22 else CADA_NOCHE
        if forzar or time.time() - _ultima >= cada:
            _ultima = time.time()
            n += _bajar(url, token, carpeta)
    except Exception as exc:
        print(f"{datetime.now():%d/%m %H:%M} App nueva: no pude conectarme ({exc}). Reintento solo.", flush=True)
    return n
