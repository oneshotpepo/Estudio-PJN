# Estudio PJN (Perona) en Vercel

La app de Perona, la misma de claude.ai, pero publicada en Vercel con:

- **Entrada con usuario y contraseña.** Sin sesión no se ve nada: ni la app, ni los datos, ni los archivos.
- **Base propia** (Postgres, Neon desde Vercel) para notas, escritos, tareas, intimaciones, cédulas, análisis, modelos y consultas.
- **Claude por la API del estudio** (redactar, analizar, consultas), con la clave cargada en Vercel y un **tope de gasto por mes**.
- **Datos del día subidos por la PC** del estudio (`scripts/subir_vercel.py`), sin Google Drive en el medio.

## Cómo está armado

| Parte | Qué hace |
|---|---|
| `app/estudio.html` | La app de siempre (copia de la Perona de claude.ai, con lo mínimo cambiado para leer el expediente completo del servidor). |
| `public/runtime.js` | Puente: le da a la app la base, los archivos, Claude y el usuario, igual que claude.ai. |
| `public/login.html`, `public/usuarios.html` | Entrada, alta de usuarios, cambio de contraseña y gasto de Claude del mes. |
| `api/app.js` | Sirve la app solo con sesión. |
| `api/login.js` | Entrar y salir. Freno a quien prueba contraseñas. |
| `api/db.js` | Base de documentos (colecciones). |
| `api/blob.js` | Archivos (datos de la PC, PDFs y modelos subidos). |
| `api/claude.js` | Pedidos a Claude (Opus 5.5) con tope mensual y registro de gasto por usuario. |
| `api/subir.js` | Entrada de la PC: solo escribe, con `SUBIR_TOKEN`. |
| `scripts/subir_vercel.py` | Corre en la PC después de `actualizar_tablero.py` y sube lo del día. |

## Variables de Vercel (Settings → Environment Variables)

| Variable | Qué poner |
|---|---|
| `DATABASE_URL` | La pone sola Vercel al conectar la base Neon (Storage). |
| `ANTHROPIC_API_KEY` | La clave de API de Claude. La cargás vos; no se pasa por ningún chat. |
| `ADMIN_CLAVE` | Contraseña de tu primera entrada (10 caracteres o más). Entrás con usuario `juan`. Después la podés borrar. |
| `SUBIR_TOKEN` | Una clave larga para que la PC pueda subir datos (la misma va en `vercel_subir.txt` en la PC). |
| `TOPE_USD_MES` | Opcional. Tope de gasto de Claude por mes en dólares (si no está, 150). |

## Probar en una computadora

```
npm install
DATABASE_URL=postgres://... ADMIN_CLAVE=... SUBIR_TOKEN=... ANTHROPIC_API_KEY=... node scripts/servidor_local.js
```

Abre en http://localhost:3000.
