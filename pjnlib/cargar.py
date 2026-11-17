"""Presenta en el PJN un escrito que alguien confirmo en la app (version para Vercel del Cargador PJN).

Es la misma logica que corria en la PC del estudio (cargador_pjn.py + subir_escritos.py), sin archivos ni Drive:
recibe el PDF y el pedido, verifica el expediente y el destino, sube el PDF y lo envia. No guarda nada: el
registro de intentos (para no presentar dos veces lo mismo) lo lleva /api/carga en la base de la app.
"""
from __future__ import annotations

import io
import re
import unicodedata

from pypdf import PdfReader
from pypdf.errors import PyPdfError

from .pjn_api import PJNClient, PJNError

CASE_PATTERN = re.compile(
    r"\b(?P<prefix>[A-Z]{2,6})\s+"
    r"(?P<number>\d{1,8})\s*[/\-–—]\s*"
    r"(?P<year>(?:19|20)\d{2})\b(?!\s*[/\-–—]\s*\d)"
)


def find_references(text: str) -> set[tuple]:
    return {(m["prefix"], int(m["number"]), int(m["year"])) for m in CASE_PATTERN.finditer((text or "").upper()) if int(m["number"]) > 0}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").upper()
    return " ".join("".join(c if c.isalnum() else " " for c in s if not unicodedata.combining(c)).split())


def nivel_destinatario(texto_pdf: str) -> str | None:
    """'appeal' si el escrito se dirige a la Camara, 'trial' si al Juez (mira las primeras lineas)."""
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


def resolve_destination(client: PJNClient, reference: dict, office_id: int | None = None, case_id: int | None = None) -> dict:
    chambers = client.get("/camaras")
    matches = [item for item in chambers if item.get("codigo") == reference["prefix"]]
    if len(matches) != 1:
        raise PJNError("The document jurisdiction does not match one available PJN jurisdiction.")
    cases = client.get("/expedientes", camara=matches[0]["id"], numero=reference["number"], anio=reference["year"])
    candidates = [item for item in cases if (
        item.get("camara") == reference["prefix"]
        and item.get("numero") == reference["number"]
        and item.get("anio") == reference["year"]
        and (case_id is None or item.get("id") == case_id)
    )]
    if len(candidates) != 1:
        ids = [item.get("id") for item in candidates]
        raise PJNError(f"Expected one matching case; found {len(candidates)} (IDs: {ids}). Review the case selection.")
    case = candidates[0]
    if case.get("numeroSubexpediente") not in (0, None):
        raise PJNError("Incident filings require explicit incident identification and are not supported yet.")
    recipients = client.get(f"/destinatarios/{case['id']}")
    selected = [item for item in recipients if office_id is None or item.get("id") == office_id]
    if len(selected) != 1:
        ids = [item.get("id") for item in selected]
        raise PJNError(f"Expected one destination; found {len(selected)} (IDs: {ids}). Use --office-id after review.")
    recipient = selected[0]
    if recipient.get("usaVoces") is not False:
        raise PJNError("This destination requires additional classification; automatic filing is not supported there yet.")
    types = client.get("/tipos-escrito", idExpediente=case["id"], idOficina=recipient["id"])
    options = [item for item in types.get("tipos", []) if item.get("descripcion", "").strip().upper() == "ESCRITO"]
    if len(options) != 1 or not options[0].get("codigoEscrito"):
        raise PJNError("PJN does not offer the requested ESCRITO type for this destination.")
    pending = client.get(f"/escritos/expediente/{case['id']}/en-bandeja")
    if not isinstance(pending, dict) or not isinstance(pending.get("items"), list):
        raise PJNError("PJN returned an unrecognized pending-filings response.")
    pending_count = max(len(pending["items"]), pending.get("total", 0) or 0, pending.get("numberOfItems", 0) or 0)
    return {
        "case_id": case["id"], "case_reference": case["numeracion"],
        "case_title": case["caratula"], "office_id": recipient["id"],
        "office": recipient["descripcion"], "type_code": options[0]["codigoEscrito"],
        "pending_count": pending_count,
    }


def destino(client: PJNClient, ref: dict, texto_pdf: str) -> dict:
    try:
        return resolve_destination(client, ref)
    except PJNError as exc:
        if "destination" not in str(exc):
            raise
    # hay mas de un destino posible: se elige por el encabezamiento ("Señor Juez" / "Excma. Camara")
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
    "not currently enabled to submit": "La cuenta del PJN no está habilitada para enviar escritos al tribunal.",
    "PJN login failed": "No pude entrar al PJN (puede estar caído, o no aceptar la conexión desde este servidor).",
    "Login did not complete": "El PJN no aceptó el usuario o la clave cargados en Vercel (PJN_USER y PJN_PASSWORD).",
    "unsupported login step": "El PJN pidió un paso extra para entrar (captcha o verificación) que la app no puede hacer.",
    "does not match the configured author": "La cuenta del PJN que entró no es la esperada (PJN_NOMBRE).",
}


def en_castellano(msg: str) -> str:
    for clave, texto in TRADUCCIONES.items():
        if clave in msg:
            return texto
    return msg


def cliente(env: dict) -> PJNClient:
    usuario, clave = (env.get("PJN_USER") or "").strip(), env.get("PJN_PASSWORD") or ""
    if not usuario or not clave:
        raise PJNError("Faltan cargar en Vercel el usuario y la clave del PJN (PJN_USER y PJN_PASSWORD).")
    return PJNClient(usuario, clave, expected_name=(env.get("PJN_NOMBRE") or "").strip() or None)


def verify_permissions(client: PJNClient) -> None:
    user = client.get("/usuario/info")
    if user.get("tieneFirma") is not True or user.get("puedeEnviarATribunal") is not True:
        raise PJNError("This account is not currently enabled to submit filings to the court.")


def probar(env: dict) -> dict:
    """Solo entra al PJN y mira que la cuenta pueda presentar. No presenta nada."""
    client = None
    try:
        client = cliente(env)
        verify_permissions(client)
        return {"ok": True, "cuenta": client.author_name, "mensaje": f"Conexión con el PJN correcta. Cuenta: {client.author_name}."}
    except PJNError as exc:
        return {"ok": False, "mensaje": en_castellano(str(exc))}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "mensaje": f"Error inesperado: {type(exc).__name__}: {exc}"}
    finally:
        if client:
            client.close()


def cargar(env: dict, pedido: dict, pdf: bytes) -> dict:
    """Devuelve {estado: cargado|error|revisar, etapa: previo|subida|envio|hecho, mensaje, ...}.

    etapa dice hasta donde llego: 'previo' = no se mando nada al PJN (se puede reintentar);
    'subida' = fallo al subir el PDF (no se presento); 'envio' = se mando y no se sabe si entro (revisar en el PJN).
    """
    etapa = "previo"
    client = None
    try:
        refs = find_references(pedido.get("numero", ""))
        if len(refs) != 1:
            raise PJNError("El pedido no tiene un número de expediente válido.")
        prefix, number, year = next(iter(refs))
        ref = {"prefix": prefix, "number": number, "year": year, "display": f"{prefix} {number:06d}/{year}"}
        descripcion = re.sub(r"\s+", " ", pedido.get("descripcion", "") or "").strip()[:180]
        if not descripcion:
            raise PJNError("El escrito no tiene título (es la descripción que va al PJN).")
        try:
            reader = PdfReader(io.BytesIO(pdf))
            if reader.is_encrypted or len(reader.pages) == 0:
                raise PJNError("The PDF must be readable, unencrypted and contain at least one page.")
            texto = "\n".join(page.extract_text() or "" for page in reader.pages)
        except PyPdfError:
            raise PJNError("The PDF could not be read; submission was not attempted.") from None
        if find_references(texto) != {(prefix, number, year)}:  # el PDF tiene que mencionar ese expediente y ningun otro
            raise PJNError("The PDF case references do not match the Word document.")
        client = cliente(env)
        verify_permissions(client)
        dest = destino(client, ref, texto)
        # el nombre del archivo es el que ve el juzgado
        nombre = re.sub(r'[\\/:*?"<>|]', "-", f"{ref['display'].replace('/', '-')} - {descripcion}")[:120] + ".pdf"
        etapa = "subida"
        clave = client.upload_pdf_bytes(nombre, pdf)
        payload = {
            "adjuntosDTO": [{"key": clave, "orden": 0, "descripcion": descripcion, "voces": []}],
            "cuilAutor": client.author_cuil, "envioATribunal": True, "envioAutorizador": False,
            "idExpediente": dest["case_id"], "idOficinaDestino": dest["office_id"], "tipo": dest["type_code"],
        }
        etapa = "envio"
        resp = client.submit(payload)
        body = resp.get("body")
        ids = [x["id"] for x in (body if isinstance(body, list) else [body]) if isinstance(x, dict) and isinstance(x.get("id"), int)]
        return {"estado": "cargado", "etapa": "hecho", "pjn_ids": ids, "destino": dest["office"], "caratula": dest["case_title"],
                "expediente": dest["case_reference"], "pendientes_en_bandeja": dest.get("pending_count", 0), "cuenta": client.author_name,
                "mensaje": f"Cargado en {dest['office']}" + (f" (ID {', '.join(map(str, ids))})" if ids else "")}
    except BaseException as exc:  # noqa: BLE001
        if etapa == "envio":
            return {"estado": "revisar", "etapa": etapa,
                    "mensaje": "Se envió pero el PJN no confirmó la respuesta. Fijate en el PJN si quedó cargado antes de volver a intentar."}
        msg = en_castellano(str(exc)) if isinstance(exc, PJNError) else f"Error inesperado: {type(exc).__name__}: {exc}"
        if etapa == "subida":
            msg = "No se pudo subir el PDF al PJN; no se presentó nada. " + msg
        return {"estado": "error", "etapa": etapa, "mensaje": msg}
    finally:
        if client:
            client.close()
