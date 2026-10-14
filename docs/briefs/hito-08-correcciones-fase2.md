# Plan de Correcciones Fase 2 - Auditoria General (Hitos 00 a 08)

> Rama: feat/antigravity-runner
> Regla critica: Bajo --sandbox la terminal esta restringida; edita solo los archivos permitidos.
> Disciplina AGENTS.md: 1 commit atomico por unidad logica con sus tests (<300 lineas).

---

## Unidad 1: Unificar ruta de worktrees entre git.ts y motorSubtareas.ts + timeout de runner (G-01, G-02)

### Problema
1. (G-01) Cuando config.directorio_worktrees es undefined, ModuloGitReal.crearWorktree() en git.ts crea el worktree
   en resolve(dirname(repoAbs), basename(repoAbs) + '-worktrees', runId), pero motorSubtareas.ts calcula
   raizWorktrees como join(dirBatuta, 'worktrees') (.batuta/worktrees). Al no coincidir, esWorktreeValido()
   rechaza el worktree real por defecto con error de seguridad.
2. (G-02) En motorSubtareas.ts, contexto.limites.timeoutMs siempre recibe config.limites.timeout_comando_seg * 1000 (120s),
   pisando config.runner.timeout_seg (300s por defecto en AntigravityRunner).

### Archivos permitidos
- packages/core/src/git.ts
- packages/core/src/index.ts
- packages/core/src/motorSubtareas.ts
- packages/core/test/motorCuota.test.ts

### Cambios exactos requeridos
1. En packages/core/src/git.ts (y reexportada en packages/core/src/index.ts):
   Extrae y exporta una funcion pura:
   export function resolverDirectorioWorktrees(directorioRepo: string, directorioWorktrees?: string): string
   que calcule el directorio padre de worktrees exactamente como lo hace crearWorktree:
   - Si directorioWorktrees esta definido: isAbsolute(directorioWorktrees) ? resolve(directorioWorktrees) : resolve(repoAbs, directorioWorktrees)
   - Si no esta definido: resolve(dirname(repoAbs), basename(repoAbs) + '-worktrees')
   Usa resolverDirectorioWorktrees(repoAbs, opciones?.directorioWorktrees) dentro de crearWorktree.
2. En packages/core/src/motorSubtareas.ts:
   - Calcula raizWorktrees usando resolverDirectorioWorktrees(dirname(dirBatuta), config.directorio_worktrees).
     (Nota: si progreso.worktree.ruta ya existe y en tests unitarios con mocks no sigue esa estructura, verifica:
     resolverDirectorioWorktrees(dirname(dirBatuta), config.directorio_worktrees)).
   - Para timeoutMs en contexto.limites: cuando tipoRunner === 'antigravity' y config.runner?.timeout_seg este definido,
     usa config.runner.timeout_seg * 1000; en caso contrario usa config.limites.timeout_comando_seg * 1000.
3. En packages/core/test/motorCuota.test.ts:
   - Anade o ajusta un test donde el motor use un AntigravityRunner real (con ejecutor mock y validarRutaWorktree: true)
     y config sin directorio_worktrees explicito, verificando que esWorktreeValido acepta el worktree creado por ModuloGitReal.

---

## Unidad 2: Transicion WAITING_QUOTA en reducer.ts y limpieza de pausaCuota en motor.ts (G-04, G-05, G-06)

### Problema
1. (G-04) En motor.reanudar(), se llama primero a store.restaurar(runId), que emite un evento ejecucion_reanudada
   sin payload.retomar_en. En reducer.ts, case 'ejecucion_reanudada' transiciona WAITING_QUOTA -> IMPLEMENT
   incluso cuando no viene retomar_en. Como consecuencia, en motor.reanudar() la condicion posterior
   if (estado.estado === 'WAITING_QUOTA') nunca se cumple y progreso.pausaCuota jamas se limpia en motor.json.
2. (G-05) En motorSubtareas.ts, cuando resultado.motivoFallo === 'cuota_agotada', se agregan decision.modelo y rol
   a sub.modelosUsados y sub.rolesUsados antes de pausar, registrando una llamada que ni siquiera se ejecuto.
3. (G-06) En reducer.ts, case 'ejecucion_pausada_por_cuota' usa PausaCuotaPayloadSchema.parse directo en vez de
   leerPayload(PausaCuotaPayloadSchema, evento), y falta exportar PausaCuotaPayloadSchema en index.ts.

### Archivos permitidos
- packages/core/src/reducer.ts
- packages/core/src/motor.ts
- packages/core/src/motorSubtareas.ts
- packages/core/src/index.ts
- packages/core/test/motorCuota.test.ts
- packages/core/test/reducer.test.ts

### Cambios exactos requeridos
1. En packages/core/src/reducer.ts:
   - En case 'ejecucion_pausada_por_cuota': usa leerPayload(PausaCuotaPayloadSchema, evento).
   - En case 'ejecucion_reanudada': cuando estado.estado === 'WAITING_QUOTA', solo cambia el estado si
     payload.retomar_en esta definido y es un RunStatus no terminal; si payload.retomar_en es undefined
     (evento de restaurar() de infraestructura), conserva estado: 'WAITING_QUOTA' para que motor.reanudar()
     limpie progreso.pausaCuota y emita el evento con retomar_en.
2. En packages/core/src/index.ts:
   - Reexporta PausaCuotaPayloadSchema y el tipo PausaCuotaPayload desde ./reducer.js.
3. En packages/core/src/motorSubtareas.ts:
   - Mueve el bloque if (!resultado.exito && resultado.motivoFallo === 'cuota_agotada') ANTES de registrarUso,
     sub.modelosUsados.push y sub.rolesUsados.push (o solo registra uso si resultado.uso tiene tokens > 0,
     pero sin ensuciar sub.modelosUsados ni emitir advertencia de costos cuando fue pausa proactiva de 0 tokens).
4. En packages/core/test/motorCuota.test.ts y packages/core/test/reducer.test.ts:
   - Verifica en motorCuota.test.ts que tras motor.reanudar() el campo progreso.pausaCuota en motor.json queda undefined.
   - Verifica en reducer.test.ts que un payload invalido en ejecucion_pausada_por_cuota lanza el error formateado con el id del evento.

---

## Unidad 3: Codigo de salida 12 en stdout de CLI y visibilidad de pausa en status (G-03)

### Problema
En packages/cli/src/index.ts, la funcion actuar() envia a console.log los codigos 0, 10 y 11, pero envia el codigo 12
(CODIGO_PAUSA_CUOTA) a console.error.

### Archivos permitidos
- packages/cli/src/index.ts
- packages/cli/src/comandos/status.ts
- packages/cli/test/cli.test.ts

### Cambios exactos requeridos
1. En packages/cli/src/index.ts:
   - En actuar(), cambia la condicion a:
     if (res.codigo === 0 || res.codigo === 10 || res.codigo === 11 || res.codigo === 12)
2. En packages/cli/src/comandos/status.ts:
   - Si el estado es WAITING_QUOTA y progreso?.pausaCuota existe, incluye en la salida de texto humano una linea:
     Cuota en espera: reinicio estimado ${progreso.pausaCuota.resetTime ?? 'desconocido'}
3. En packages/cli/test/cli.test.ts:
   - Añade o verifica que el codigo 12 no se trate como error fatal en consola.
