# ADR 010: Registro en disco con escritor único e ids ordenables

## Contexto
El hito 2 pide agregar eventos a `events.jsonl` sin reescribir, leer tolerando la última línea cortada, evitar escrituras concurrentes, probar sin disco real ni hora real y que los ids de evento se ordenen en el tiempo, todo portable Windows/Linux.

## Opciones consideradas
1. **Append-only + `.lock` en exclusiva + ids `E-000001…` + puertos `SistemaArchivos`/`Reloj`**: Solo se agrega al final; el bloqueo falla en vez de entrelazar; el id es el índice en el registro (igual al orden temporal con un solo escritor); la E/S y el reloj se inyectan (`sistemaArchivosNode`/`relojSistema` por defecto) y las rutas usan `node:path` con líneas LF.
2. **ULID para los ids**: Ordenable globalmente pero exige dependencia o implementación propia para un beneficio marginal dentro de una ejecución.
3. **Bloqueo cooperativo en memoria**: No protege entre procesos, que es el caso real de dos CLI a la vez.

## Decisión
Escritor que valida antes de agregar y falla si hay cola cortada (pide `restaurar` en vez de soldar bytes); lector puro que descarta la cola cortada e informa y falla con el número de línea en cualquier otro caso; `.lock` por ejecución con limpieza manual documentada; ids `E-` con índice cero-rellenado; puertos inyectables con sistema en memoria en pruebas.

## Consecuencias
- **Positivas**: Sin dependencias nuevas; pruebas sin disco ni hora real; la única reescritura permitida es descartar bytes que nunca fueron un evento (en `restaurar`).
- **Negativas**: `iniciarEjecucion` concurrente podría repetir NNN (el llamante lo serializa); el bloqueo obsoleto exige borrado manual.
