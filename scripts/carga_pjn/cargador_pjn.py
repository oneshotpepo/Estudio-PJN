"""Carga al PJN los escritos que confirmás en la app Estudio PJN.

La app deja en la carpeta de Drive "Tablero PJN/Carga PJN" el PDF del escrito y un
pedido (<id>.pedido.json). Este programa, corriendo en la PC del estudio, los toma,
verifica el expediente y el destino en el PJN, sube el PDF con tu usuario y deja el
resultado (<id>.resultado.json) para que la app lo muestre.

Uso:
    py cargador_pjn.py                 # queda mirando la carpeta cada 20 segundos
    py cargador_pjn.py --una-vez       # procesa lo pendiente y termina
    pythonw cargador_pjn.py --fondo    # sin ventana (lo arranca Windows al prender la PC); escribe output/cargador.log

Usa las credenciales de pjn_credentials.json en tu carpeta de usuario (o en esta carpeta), o las pide al arrancar.
Cada PDF se carga una sola vez: el registro output/submissions.sqlite3 bloquea repeticiones.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import time
import traceback
import unicodedata

from pypdf import PdfReader

from pjn_api import PJNError
from pjn_documents import find_references
from subir_escritos import (
    ROOT, SubmissionLedger, build_payload, check_pdf, file_hash, make_client,
    resolve_destination, save_json, verify_permissions,
)

ESPERA = 20

try:  # 17/11: pedidos de la app nueva (estudiopjn.vercel.app), que no usa Drive
    import puente_app
except Exception:
    puente_app = None
PUERTO_UNICO = 47831  # traba para que no corran dos cargadores a la vez


def carpeta_default() -> Path:
    for base in (r"G:\Mi unidad", r"G:\My Drive"):
        if os.path.isdir(base):
            return Path(base) / "Tablero PJN" / "Carga PJN"
    return ROOT / "Carga PJN"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").upper()
    return " ".join("".join(c if c.isalnum() else " " for c in s if not unicodedata.combining(c)).split())


def nivel_destinatario(texto_pdf: str) -> str | None:
    """'appeal' si el escrito se dirige a la Cámara, 'trial' si al Juez (mira las primeras líneas)."""
    inicio = norm(" ".join(texto_pdf.splitlines()[:6]))
    if "CAMARA" in inicio and "JUEZ" not in inicio:
        return "appeal"
    if "JUEZ" in inicio:
        return "trial"
    return None


def nivel_oficina(descripcion: str) -> str | None:
    d = norm(descripcion)
    if d.startswith("CAMARA"):
        return "appeal"
    if d.startswith("JUZGADO"):
        return "trial"
    return None


def destino(client, ref: dict, texto_pdf: str) -> dict:
    try:
        return resolve_destination(client, ref)
    except PJNError as exc:
        if "destination" not in str(exc):
            raise
    # hay más de un destino posible: se elige por el encabezamiento ("Señor Juez" / "Excma. Cámara")
    camaras = [c["id"] for c in client.get("/camaras") if c.get("codigo") == ref["prefix"]]
    casos = client.get("/expedientes", camara=camaras[0], numero=ref["number"], anio=ref["year"])
    casos = [c for c in casos if c.get("numero") == ref["number"] and c.get("anio") == ref["year"] and c.get("numeroSubexpediente") in (0, None)]
    if len(casos) != 1:
        raise PJNError("No encontré un único expediente principal con ese número.")
    nivel = nivel_destinatario(texto_pdf)
    oficinas = [o for o in client.get(f"/destinatarios/{casos[0]['id']}") if nivel and nivel_oficina(o.get("descripcion", "")) == nivel]
    if len(oficinas) > 1:
        actual = [o for o in oficinas if norm(o.get("descripcion", "")) == norm(casos[0].get("oficina", "")) or str(o.get("caracterEnum", "")).startswith("ACTUAL")]
        if len(actual) == 1:
            oficinas = actual
    if len(oficinas) != 1:
        raise PJNError("El expediente tiene varios destinos posibles y el encabezamiento del escrito no alcanza para elegir uno. Cargalo a mano.")
    return resolve_destination(client, ref, office_id=oficinas[0]["id"], case_id=casos[0]["id"])


TRADUCCIONES = {
    "The PDF case references do not match": "El PDF tiene que mencionar el expediente (por ejemplo CNT 36242/2023) y ningún otro número de expediente.",
    "The PDF must be readable": "El PDF está vacío o protegido.",
    "The PDF could not be read": "No pude leer el PDF; no se envió nada.",
    "does not match one available PJN jurisdiction": "No encontré esa cámara/fuero en el PJN.",
    "Expected one matching case": "No encontré un único expediente con ese número en el PJN.",
    "Incident filings require": "Es un incidente: por ahora los incidentes se cargan a mano.",
    "requires additional classification": "Ese destino pide clasificar el escrito (voces): cargalo a mano.",
    "does not offer the requested ESCRITO type": "El PJN no ofrece el tipo ESCRITO para ese destino.",
    "not currently enabled to submit": "Tu cuenta del PJN no está habilitada para enviar escritos al tribunal.",
    "already has a submission attempt": "Este mismo PDF ya se intentó cargar antes. No lo vuelvo a enviar: revisá el PJN.",
}


def en_castellano(msg: str) -> str:
    for clave, texto in TRADUCCIONES.items():
        if clave in msg:
            return texto
    return msg


def resultado(carpeta: Path, pid: str, **datos) -> None:
    datos["fecha"] = datetime.now().isoformat(timespec="seconds")
    save_json(carpeta / f"{pid}.resultado.json", datos)
    print(f"  -> {datos.get('estado')}: {datos.get('mensaje', '')}", flush=True)


def procesar(client, ledger: SubmissionLedger, carpeta: Path, pedido_path: Path) -> None:
    pid = pedido_path.name[: -len(".pedido.json")]
    pedido = json.loads(pedido_path.read_text(encoding="utf-8"))
    pdf = carpeta / pedido["pdf"]
    if not pdf.is_file() or (pedido.get("pdf_sha256") and file_hash(pdf) != pedido["pdf_sha256"]):
        print(f"  {pid}: esperando que Drive termine de bajar el PDF…", flush=True)
        return
    print(f"Pedido {pid}: {pedido.get('numero')} | {pedido.get('descripcion')}", flush=True)
    try:
        refs = find_references(pedido.get("numero", ""))
        if len(refs) != 1:
            raise PJNError("El pedido no tiene un número de expediente válido.")
        r = next(iter(refs))
        ref = {"prefix": r.prefix, "number": r.number, "year": r.year, "display": f"{r.prefix} {r.number:06d}/{r.year}"}
        descripcion = re.sub(r"\s+", " ", pedido.get("descripcion", "")).strip()[:180]
        if not descripcion:
            raise PJNError("El escrito no tiene título (es la descripción que va al PJN).")
        check_pdf(pdf, ref)  # el PDF tiene que mencionar ese expediente y ningún otro
        texto = "\n".join(p.extract_text() or "" for p in PdfReader(pdf).pages)
        dest = destino(client, ref, texto)
        h = file_hash(pdf)
        entry = {"source": str(pdf), "source_sha256": h, "pdf": str(pdf), "pdf_sha256": h, "reference": ref, "description": descripcion, **dest}
        job = ledger.reserve(client.author_cuil, entry)  # si ya se intentó cargar este mismo PDF, corta acá
        record = {"job_key": job, "entry": entry}
        estado = "upload_failed"
        try:
            # el nombre del archivo es el que ve el juzgado
            nombre = re.sub(r'[\\/:*?"<>|]', "-", f"{ref['display'].replace('/', '-')} - {descripcion}")[:120] + ".pdf"
            envio = ROOT / "output" / "envios" / nombre
            envio.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(pdf, envio)
            clave = client.upload_pdf(envio)
            record["attachment_key"] = clave
            ledger.update(job, "uploaded", record)
            payload = build_payload(client.author_cuil, entry, clave)
            record["payload"] = payload
            ledger.update(job, "sending", record)
            estado = "unknown"
            resp = client.submit(payload)
            record["response"] = resp
            body = resp.get("body")
            ids = [x["id"] for x in (body if isinstance(body, list) else [body]) if isinstance(x, dict) and isinstance(x.get("id"), int)]
            record["filing_ids"] = ids
            ledger.update(job, "accepted", record)
            estado = "accepted"
            save_json(ROOT / "output" / "receipts" / f"{job}.json", record)
        except BaseException:
            ledger.update(job, estado, record)
            if estado == "unknown":
                resultado(carpeta, pid, estado="revisar", mensaje="Se envió pero el PJN no confirmó la respuesta. Fijate en el PJN si quedó cargado antes de volver a intentar.")
                return
            raise
        resultado(carpeta, pid, estado="cargado", pjn_ids=ids, destino=dest["office"], caratula=dest["case_title"], expediente=dest["case_reference"],
                  pendientes_en_bandeja=dest.get("pending_count", 0), mensaje=f"Cargado en {dest['office']}" + (f" (ID {', '.join(map(str, ids))})" if ids else ""))
    except PJNError as exc:
        resultado(carpeta, pid, estado="error", mensaje=en_castellano(str(exc)))
    except Exception as exc:
        traceback.print_exc()
        resultado(carpeta, pid, estado="error", mensaje=f"Error inesperado: {exc}")


def pendientes(carpeta: Path) -> list[Path]:
    return sorted(p for p in carpeta.glob("*.pedido.json") if not (carpeta / p.name.replace(".pedido.json", ".resultado.json")).exists())


def correr(args) -> int:
    carpeta = args.carpeta
    carpeta.mkdir(parents=True, exist_ok=True)
    print(f"Mirando {carpeta}", flush=True)
    client = make_client(args)
    verify_permissions(client)
    print(f"Cuenta PJN verificada: {client.author_name}. Dejá esta ventana abierta.", flush=True)
    if puente_app:
        print("También miro los pedidos de la app nueva (estudiopjn.vercel.app).", flush=True)
    ledger = SubmissionLedger(ROOT / "output" / "submissions.sqlite3")
    try:
        while True:
            if puente_app:
                puente_app.sincronizar(carpeta)  # baja los pedidos de la app nueva a esta misma carpeta
            for p in pendientes(carpeta):
                try:
                    procesar(client, ledger, carpeta, p)
                except Exception:
                    traceback.print_exc()
            if puente_app:
                puente_app.sincronizar(carpeta)  # y le avisa a la app como termino cada uno
            if args.una_vez:
                return 0
            time.sleep(ESPERA)
    except KeyboardInterrupt:
        return 0
    finally:
        ledger.close()
        client.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--carpeta", type=Path, default=carpeta_default())
    ap.add_argument("--una-vez", action="store_true")
    ap.add_argument("--fondo", action="store_true", help="sin ventana: reintenta solo y escribe output/cargador.log")
    ap.add_argument("--credentials-file", type=Path)
    args = ap.parse_args()
    args.credentials_from = None
    if args.credentials_file is None and (Path.home() / "pjn_credentials.json").is_file():
        args.credentials_file = Path.home() / "pjn_credentials.json"
    traba = socket.socket()
    try:
        traba.bind(("127.0.0.1", PUERTO_UNICO))
    except OSError:
        print("El Cargador PJN ya está corriendo en esta PC.", flush=True)
        return 0
    if not args.fondo:
        return correr(args)
    log = ROOT / "output" / "cargador.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.is_file() and log.stat().st_size > 2_000_000:
        log.replace(log.with_suffix(".log.1"))
    sys.stdout = sys.stderr = open(log, "a", encoding="utf-8", buffering=1)
    if args.credentials_file is None:
        print(f"{datetime.now():%d/%m %H:%M} Falta {Path.home() / 'pjn_credentials.json'}: corré crear_credenciales.bat.", flush=True)
        return 1
    espera = 60
    while True:  # sin internet al prender la PC, el PJN caído, etc.: reintenta solo
        try:
            print(f"{datetime.now():%d/%m %H:%M} Arranca el cargador", flush=True)
            correr(args)
            espera = 60
        except Exception as exc:
            traceback.print_exc()
            # si la clave está mal no insiste seguido, para no bloquear la cuenta
            espera = 1800 if "login" in str(exc).lower() or "credential" in str(exc).lower() else min(espera * 2, 900)
            print(f"{datetime.now():%d/%m %H:%M} Error: {exc}. Reintento en {espera // 60} min.", flush=True)
        time.sleep(espera)


if __name__ == "__main__":
    sys.exit(main())
