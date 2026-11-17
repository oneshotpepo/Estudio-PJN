@echo off
rem Sube ahora los datos de Perona a la app nueva (estudiopjn.vercel.app). Ventana comun: se puede cerrar y volver a correr, sigue donde quedo.
cd /d "%~dp0"
python -u subir_vercel.py --minutos 240
echo.
echo Listo. Podes cerrar esta ventana.
pause
