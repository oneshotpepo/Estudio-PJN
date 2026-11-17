# -*- coding: utf-8 -*-
"""Sube los datos del dia de Perona a la app nueva en Vercel (17/11/2026).

Lee la carpeta "Tablero PJN" de Google Drive (la que arma actualizar_tablero.py cada madrugada):
estado.json, los archivos de datos que lista, la biblioteca de escritos y el analisis de Claude.
Los comprime, los sube a la app y actualiza la "copia" que la app lee al abrir.
Solo sube lo que cambio (cada archivo se identifica por su contenido).

No crea tareas ni ventanas: se llama desde actualizar_tablero.bat, despues de paquete_nube.py.
Necesita, al lado de este archivo, "vercel_subir.txt" con dos lineas:
    https://<tu-app>.vercel.app
    <SUBIR_TOKEN, el mismo que cargaste en Vercel>

Tambien sube cada expediente completo (carpeta expedientes/, para que Claude lea el expediente entero),
solo los que cambiaron; la primera vez son miles y puede tardar: corta a los 60 minutos y sigue al otro dia.

Uso:  python subir_vercel.py                     (carpeta de Perona en G:)
      python subir_vercel.py --minutos 240       (la primera vez, para subir todo de una)
      python subir_vercel.py --carpeta "D:\\otra\\Tablero PJN"
"""
import gzip, hashlib, json, os, sys, time, urllib.request, urllib.error

AQUI = os.path.dirname(os.path.abspath(__file__))
PARTE = 3 * 1024 * 1024  # bytes comprimidos por archivo (Vercel no acepta mas de 4,5 MB)


def leer(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def config():
    p = os.path.join(AQUI, "vercel_subir.txt")
    if not os.path.exists(p):
        sys.exit(f"[vercel] falta {p} (primera linea: direccion de la app; segunda: SUBIR_TOKEN)")
    lineas = [l.strip() for l in open(p, encoding="utf-8-sig") if l.strip()]
    if len(lineas) < 2:
        sys.exit("[vercel] vercel_subir.txt tiene que tener 2 lineas: direccion y token")
    return lineas[0].rstrip("/"), lineas[1]


def pedir(url, token, cuerpo, tipo="application/json", extra=None, intentos=4):
    h = {"Authorization": "Bearer " + token, "Content-Type": tipo, "User-Agent": "estudio-pjn-pc"}
    h.update(extra or {})
    for i in range(intentos):
        try:
            req = urllib.request.Request(url, data=cuerpo, headers=h, method="POST")
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:300]
            if e.code in (400, 401, 403, 413):
                sys.exit(f"[vercel] error {e.code}: {msg}")
            print(f"[vercel] error {e.code}, reintento: {msg}")
        except Exception as e:  # red
            print(f"[vercel] sin conexion ({e!r}), reintento")
        time.sleep(5 * (i + 1))
    sys.exit("[vercel] no pude subir despues de varios intentos")


def partes_json(filas, base):
    """Parte una lista en archivos JSON comprimidos de hasta PARTE bytes. Devuelve [(id, nombre, bytes)]."""
    out, actual, n = [], [], 0
    def cerrar():
        crudo = gzip.compress(json.dumps(actual, ensure_ascii=False).encode("utf-8"), 6, mtime=0)
        if len(crudo) > PARTE and len(actual) > 1:
            mitad = len(actual) // 2
            return partes_json(actual[:mitad], base) + partes_json(actual[mitad:], base)
        i = hashlib.sha1(crudo).hexdigest()[:32]
        return [(i, f"{base}_{i[:6]}.json", crudo)]
    for f in filas:
        actual.append(f)
        n += len(json.dumps(f, ensure_ascii=False))
        if n > PARTE * 5:  # el JSON comprime ~6 a 1: se corta antes y se ajusta en cerrar()
            out += cerrar(); actual, n = [], 0
    if actual or not out:
        out += cerrar()
    return out


def un_json(obj, base):
    crudo = gzip.compress(json.dumps(obj, ensure_ascii=False).encode("utf-8"), 6, mtime=0)
    i = hashlib.sha1(crudo).hexdigest()[:32]
    return (i, f"{base}_{i[:6]}.json", crudo)


def analisis(carpeta):
    idx = os.path.join(carpeta, "analisis_app.json")
    if os.path.exists(idx):
        x = leer(idx); out = {}
        for n in x.get("partes", []):
            p = os.path.join(carpeta, n)
            if os.path.exists(p):
                out.update(leer(p))
        return out, x.get("generado", "")
    p = os.path.join(carpeta, "analisis_auto.json")
    if os.path.exists(p):
        x = leer(p)
        return x.get("analisis", {}), x.get("generado", "")
    return None, ""


def subir_completos(carpeta, url, token, minutos):
    """Cada expediente completo (expedientes/e<id>.json y sus partes) como un archivo e<id>. Solo los que cambiaron.
    Lo ya subido se anota en vercel_subidos.json (al lado de este programa), asi si se corta sigue donde quedo."""
    d = os.path.join(carpeta, "expedientes")
    if not os.path.isdir(d):
        print("[vercel] no hay carpeta expedientes (expedientes completos): sigo")
        return
    est_p = os.path.join(AQUI, "vercel_subidos.json")
    try:
        hechos = leer(est_p)
    except Exception:
        hechos = {}
    nombres = sorted(n for n in os.listdir(d) if n.startswith("e") and n.endswith(".json") and "_p" not in n)
    t0, n, mb, grandes = time.time(), 0, 0.0, 0
    for k, fn in enumerate(nombres):
        if time.time() - t0 > minutos * 60:
            print(f"[vercel] corte por tiempo: faltan {len(nombres) - k} expedientes completos (siguen manana)")
            break
        p = os.path.join(d, fn)
        partes = [os.path.join(d, x) for x in (leer(p).get("partes") or [])] if os.path.getsize(p) else []
        firma_local = "|".join(f"{os.path.getsize(x)}:{int(os.path.getmtime(x))}" for x in [p] + [x for x in partes if os.path.exists(x)])
        eid = fn[:-5]
        if hechos.get(eid, {}).get("f") == firma_local:
            continue
        x = leer(p)
        for q in partes:
            if os.path.exists(q):
                x["movimientos"] = (x.get("movimientos") or []) + (leer(q).get("movimientos") or [])
        x.pop("partes", None)
        crudo = gzip.compress(json.dumps(x, ensure_ascii=False).encode("utf-8"), 6, mtime=0)
        if len(crudo) > 4 * 1024 * 1024 - 1000:
            grandes += 1
            print(f"[vercel] {fn}: muy grande ({len(crudo) / 1e6:.1f} MB comprimido), no lo subo")
            continue
        h = hashlib.sha1(crudo).hexdigest()
        if hechos.get(eid, {}).get("h") != h:
            pedir(f"{url}/api/subir?op=archivo&id={eid}&nombre={eid}.json&clase=exp", token, crudo,
                  tipo="application/json; charset=utf-8", extra={"x-gzip": "1"})
            n += 1; mb += len(crudo) / 1e6
        hechos[eid] = {"f": firma_local, "h": h}
        if n and n % 50 == 0:
            json.dump(hechos, open(est_p, "w", encoding="utf-8"))
    json.dump(hechos, open(est_p, "w", encoding="utf-8"))
    print(f"[vercel] expedientes completos: {n} subidos ({mb:.1f} MB){f', {grandes} demasiado grandes' if grandes else ''}")


def main():
    carpeta = None
    if "--carpeta" in sys.argv:
        carpeta = sys.argv[sys.argv.index("--carpeta") + 1]
    else:
        for r in (r"G:\Mi unidad", r"G:\My Drive"):
            if os.path.isdir(os.path.join(r, "Tablero PJN")):
                carpeta = os.path.join(r, "Tablero PJN"); break
    if not carpeta or not os.path.exists(os.path.join(carpeta, "estado.json")):
        sys.exit("[vercel] no encontre la carpeta Tablero PJN con estado.json")
    url, token = config()
    t0 = time.time()
    estado = leer(os.path.join(carpeta, "estado.json"))

    subir = []          # (id, nombre, bytes)
    archivos = {}       # dataset -> [urls]
    for ds, lst in (estado.get("archivos") or {}).items():
        filas = []
        for fn in lst:
            p = os.path.join(carpeta, fn)
            if os.path.exists(p):
                filas.extend(leer(p))
        ps = partes_json(filas, ds)
        subir += ps
        archivos[ds] = ["/_blob/" + i for i, _, _ in ps]
    bib = []
    for fn in estado.get("biblioteca") or []:
        p = os.path.join(carpeta, fn)
        if os.path.exists(p):
            bib.extend(leer(p))
    bib_p = partes_json(bib, "biblioteca") if bib else []
    subir += bib_p
    an, an_fecha = analisis(carpeta)
    an_p = un_json(an, "analisis") if an else None
    if an_p:
        subir.append(an_p)

    ids = [i for i, _, _ in subir]
    tiene = set(pedir(url + "/api/subir?op=tiene", token, json.dumps({"ids": ids}).encode())["tiene"])
    nuevos = [x for x in subir if x[0] not in tiene]
    total = 0
    for i, nombre, crudo in nuevos:
        pedir(f"{url}/api/subir?op=archivo&id={i}&nombre={urllib.request.quote(nombre)}", token, crudo,
              tipo="application/json; charset=utf-8", extra={"x-gzip": "1"})
        total += len(crudo)
    snap = {
        "estado": estado,
        "archivos": archivos,
        "biblioteca": ["/_blob/" + i for i, _, _ in bib_p],
        "datos_ids": ids,
        "copia_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "copia_por": "pc",
    }
    if an_p:
        snap["analisis"] = "/_blob/" + an_p[0]
        snap["analisis_id"] = an_p[0]
        snap["analisis_fecha"] = an_fecha
    pedir(url + "/api/subir?op=docs", token, json.dumps({"col": "config", "docs": [{"id": "snapshot", "data": snap}]}, ensure_ascii=False).encode("utf-8"))
    r = pedir(url + "/api/subir?op=limpiar", token, json.dumps({"mantener": ids}).encode())
    minutos = float(sys.argv[sys.argv.index("--minutos") + 1]) if "--minutos" in sys.argv else 60
    subir_completos(carpeta, url, token, minutos)
    print(f"[vercel] listo: {len(subir)} archivos ({len(nuevos)} nuevos, {total / 1e6:.1f} MB subidos), "
          f"{r.get('borrados', 0)} viejos borrados, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
