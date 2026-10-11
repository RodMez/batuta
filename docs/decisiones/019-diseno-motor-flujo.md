# ADR 019: Diseño del motor de flujo con agentes simulados

## Contexto
El hito 6 une registro/estado (hito 2), gates y diff (hito 3), Git/worktrees
(hito 4) y runners (hito 5) en un orquestador que ejecuta de principio a fin
con dependencias inyectables, se pausa en puertas/esperas sin bloquear el
proceso y se reanuda tras interrupciones. La pauta del planificador pide
separar la decisión pura de los efectos y entregar por partes.

## Opciones consideradas
1. **Motor dirigido por eventos con `siguientePaso` pura + `motor.json`**:
   `siguientePaso(estado, progreso, config)` decide sin E/S; el progreso
   (`motor.json`: aprobaciones con hash, índice de subtarea, intentos, firmas,
   uso por rol, worktree y último commit) vive junto a `config.json`,
   `spec.md`, `plan.json` y solicitudes legibles en la carpeta de la
   ejecución. Cada llamada devuelve por qué terminó (pausa/aprobación,
   pausa/entrada, terminada, fallida, abortada). Los intentos solo cuentan al
   completarse un fallo; una excepción (interrupción simulada) no cuenta.
2. **Derivar todo el progreso solo de `events.jsonl`**: Evita un archivo más,
   pero obliga a replegar y reinterpretar historiales de reintentos, usos y
   hashes en cada paso, frágil ante interrupciones a mitad de evaluar o entre
   commit y checkpoint.
3. **Máquina de estados en memoria con espera bloqueante**: Simple, pero el
   proceso no podría terminar y volver a arrancar, contra la sección 14.

## Decisión
Opción 1, en `packages/core/src/motor.ts` con piezas puras separadas:
`seleccionModelo.ts` (rol/complejidad/intento → alias/modelo; el intento 2
sube baja→media→fuerte), `informeFallo.ts` (recorte a 2000 caracteres y
últimas 30 líneas; firma gate+código+primeras líneas para bucles),
`notificador.ts` (interfaz + `NotificadorNulo`) y evento `advertencia`
(no-op en el reductor) para costos desconocidos. Reglas aplicadas: diff antes
que gates; violación de diff resetea antes de reintentar, fallo de gates
conserva el worktree para corrección incremental; mismo error dos veces o
dos fallos → `debugger`; NEEDS_INPUT → `WAITING_INPUT` con respuesta incluida
en el siguiente prompt (máximo configurable); NEEDS_CONTINUATION → nueva
sesión con resumen/notas (máximo configurable); límites de tokens/minutos por
ejecución y dólares por llamada cuando hay precios; preparación con
`timeout_preparacion_seg` y fallo claro; cierre con `summary.md`, marcas
`revision_completada`/`pr_creada` omitidas (sin revisores ni push en hito 6),
H3 y DONE; abortar elimina worktree/rama; reanudar usa `restaurar` (hito 3),
resetea al último commit y repite sin contar. Límites nuevos en
`limites` con defecto (3, 2, 600) y plantilla `prompts/debugger.md`.

## Correcciones antes de fusionar (revisión del planificador)

1. **H2 nunca se solicitaba.** `siguientePaso` agrupaba `PLAN` con los
   estados de subtarea y no comprobaba `H2_plan`, y `emitir-plan` solo emite
   `plan_creado`: con H2 habilitada el motor ejecutaba las subtareas sin
   aprobación del plan. Se separó el caso `PLAN` (pide H2 si está habilitada
   y sin aprobar, también al reanudar justo tras emitir el plan) y la pausa
   H3 se movió de `generarCierre` a `siguientePaso` en `FINALIZE`, para que
   toda decisión de pausa se pruebe sin efectos.
2. **`usd_por_ejecucion` opcional sin defecto.** Tope total en dólares que
   solo se aplica con precios conocidos (si algún costo es desconocido,
   rige la advertencia y el control por tokens). El evento `limite_alcanzado`
   distingue el límite (`tokens_por_ejecucion`, `minutos_por_ejecucion`,
   `usd_por_agente`, `usd_por_ejecucion`).
3. **Hash del commit por subtarea en `summary.md`.** Ya se incluía
   (`commit <hash>` por subtarea); se fijó con una prueba que lo compara con
   `motor.json`.

## Por qué las pruebas no detectaron el fallo de H2

Todas las configuraciones de prueba usaban `H2_plan: false` (la puerta es
"opcional" en el diseño y desactivarla acortaba los flujos) y los tests de
`siguientePaso` no cubrían `PLAN` con H2 habilitada. Lección: cada puerta
(H0–H3) debe tener al menos una prueba activada de pausa, aprobación,
rechazo y reanudación; se añadieron para H2 y se extendió la reanudación con
H0/H1/H3. Queda como límite conocido que un cambio de spec/plan *después* de
superar su puerta solo invalida el flag sin re-solicitarla (el reductor no
permite pedir H1/H2 fuera de SPEC/PLAN).

## Consecuencias
- **Positivas**: Escenarios probados por separado (decisión pura + integración
  con repos temporales y runners guionados que escriben el worktree);
  reanudación idéntica al camino limpio en las 4 fases pedidas; rama principal
  intacta en fallos y abortos; sin interpolación de texto de agentes en
  comandos (Git por vector, gates/preparación solo de config con shell).
- **Negativas**: `revision_completada`/`pr_creada` se emiten como omitidas
  hasta los hitos 7–8; la recreación del worktree tras pérdida total de la
  máquina queda pendiente (se asume repo+rama locales); el escalado por
  complejidad supone niveles baja→media→alta.
