# Plan de Correcciones - Auditoria Hito 8 (AntigravityRunner)

> Rama: feat/antigravity-runner
> Referencias: AGENTS.md, docs/briefs/hito-08-antigravity-runner.md, ADR 021, ADR 022
> Regla critica: Bajo --sandbox la terminal esta restringida; edita solo los archivos indicados.
> Disciplina AGENTS.md: 1 commit atomico por unidad logica con sus tests (<300 lineas).

---

## Unidad 1: Entorno OAuth en CuotaManager y preflight + borde umbral_cuota = 0 (A-03)

### Problema
1. AntigravityRunner.ejecutar() inyecta obtenerVariablesSesionAgy(this.plataforma) en entornoExtra,
   pero CuotaManager.consultarBuckets() y ejecutarChequeos() en preflight.ts invocan agy SIN entornoExtra,
   lo que impide a agy leer la sesion OAuth en ~/.gemini/ cuando EjecutorComandosReal limpia el entorno.
2. En evaluarCuota(), la condicion bucket.remaining_fraction < umbralCuota falla cuando umbralCuota === 0
   y remaining_fraction === 0 (0 < 0 es false).

### Archivos permitidos
- packages/core/src/antigravityRunner.ts
- packages/core/src/cuotaManager.ts
- packages/core/src/index.ts
- packages/cli/src/preflight.ts
- packages/core/test/cuotaManager.test.ts
- packages/cli/test/manejadores.test.ts

### Cambios exactos requeridos
1. En packages/core/src/antigravityRunner.ts (y reexportada en packages/core/src/index.ts):
   Crea y exporta construirEntornoSesionAgy(plataforma = process.platform, envOrigen = process.env): Record<string, string>
   que copie las variables devueltas por obtenerVariablesSesionAgy(plataforma) desde envOrigen si existen.
   Reutilizala dentro de AntigravityRunner.ejecutar().
2. En packages/core/src/cuotaManager.ts:
   - Anade plataforma?: NodeJS.Platform al constructor de CuotaManager (default process.platform) y pasala desde AntigravityRunner.
   - En consultarBuckets(), pasa entornoExtra: construirEntornoSesionAgy(this.plataforma) en las opciones de ejecutarArgs.
   - En evaluarCuota(), cambia la condicion a: if (bucket.remaining_fraction <= 0 || bucket.remaining_fraction < umbralCuota).
3. En packages/cli/src/preflight.ts:
   - Importa construirEntornoSesionAgy de @batuta/core.
   - Al llamar a entorno.ejecutor.ejecutarArgs(binPath, ['models'], ...), incluye entornoExtra: construirEntornoSesionAgy().
4. Tests:
   - En cuotaManager.test.ts: verifica remaining_fraction: 0 con umbralCuota: 0 => suficiente: false, y que consultarBuckets pasa entornoExtra.
   - En manejadores.test.ts: verifica que preflight con antigravity pasa entornoExtra a ejecutarArgs.

---

## Unidad 2: continuacionResumen en contexto y restriccion de terminal en prompt corto (A-02)

### Problema
1. En motorSubtareas.ts, escribirContextoEnWorktree no recibe continuacionResumen cuando tipoRunner === 'antigravity'.
2. construirPromptCortoAgy en motorPrompts.ts no advierte al agente que --sandbox bloquea la terminal (ADR 021 6.3).

### Archivos permitidos
- packages/core/src/motorContexto.ts
- packages/core/src/motorPrompts.ts
- packages/core/src/motorSubtareas.ts
- packages/core/test/antigravityRunner.test.ts

### Cambios exactos requeridos
1. En packages/core/src/motorContexto.ts:
   - Anade continuacionResumen?: string a ContextoArchivosWorktree.
   - Si datos.continuacionResumen tiene contenido, agrega a bloquesFeedback:
     '## Notas de continuacion del turno previo\n' + datos.continuacionResumen.
2. En packages/core/src/motorSubtareas.ts:
   - Pasa continuacionResumen: continuacionResumen ?? undefined al llamar a escribirContextoEnWorktree.
3. En packages/core/src/motorPrompts.ts (construirPromptCortoAgy):
   - Antes de la linea 'Instruccion:', agrega:
     'Restriccion de sandbox: No ejecutes comandos de terminal ni pruebas por tu cuenta (la terminal esta deshabilitada en sandbox; el motor ejecutara los gates).'
   - Asegura que el test de longitud (< 500 chars en caso base y < 4000 en truncado) siga en verde.
4. Tests en packages/core/test/antigravityRunner.test.ts:
   - Verifica que continuacionResumen se escribe en .batuta/contexto/feedback.md.
   - Verifica que construirPromptCortoAgy incluye la frase 'Restriccion de sandbox:'.

---

## Unidad 3: Calculo de costos en AntigravityRunner con preciosModelos (A-01)

### Problema
AntigravityRunner.calcularCosto pasa undefined fijo a calcularCostoEstimado, ignorando precios configurados en alias_modelos.

### Archivos permitidos
- packages/core/src/antigravityRunner.ts
- packages/cli/src/contexto.ts
- packages/core/test/antigravityRunner.test.ts

### Cambios exactos requeridos
1. En packages/core/src/antigravityRunner.ts:
   - Anade preciosModelos?: Record<string, { entrada?: number; salida?: number }> a AntigravityRunnerConfig.
   - En calcularCosto(uso, contexto), busca p = this.preciosModelos?.[contexto.modelo].
   - Si p tiene entrada y salida numericos, pasa { entradaPorMillon: p.entrada, salidaPorMillon: p.salida } a calcularCostoEstimado.
2. En packages/cli/src/contexto.ts (crearRunner):
   - Construye preciosModelos iterando Object.entries(config.alias_modelos) y registrando tanto la clave alias como info.modelo.
   - Pasalo en la configuracion de new AntigravityRunner(...).
3. Tests en packages/core/test/antigravityRunner.test.ts:
   - Verifica que con preciosModelos definido para el modelo, costoEstimado.desconocido es false y montoUsd > 0.

---

## Unidad 4: Validacion Zod en reducer.ts, retomarEn dinamico y case-insensitive en Windows (A-04, A-05)

### Problema
1. En reducer.ts, PausaCuotaPayloadSchema no se ejecuta en el case 'ejecucion_pausada_por_cuota'.
2. En motor.ts, reanudar desde WAITING_QUOTA fuerza retomar_en: 'IMPLEMENT' fijo.
3. En antigravityRunner.ts, esWorktreeValido busca '/.batuta/worktrees/' con sensibilidad a mayusculas en Windows.

### Archivos permitidos
- packages/core/src/reducer.ts
- packages/core/src/motorTipos.ts
- packages/core/src/motorSubtareas.ts
- packages/core/src/motor.ts
- packages/core/src/antigravityRunner.ts
- packages/core/test/reducer.test.ts
- packages/core/test/antigravityRunner.test.ts
- docs/briefs/hito-08-antigravity-runner.md

### Cambios exactos requeridos
1. En packages/core/src/reducer.ts:
   - En case 'ejecucion_pausada_por_cuota', ejecuta PausaCuotaPayloadSchema.parse(evento.payload ?? {}) antes de retornar el estado.
2. En motorTipos.ts, motorSubtareas.ts y motor.ts:
   - Anade retomarEn?: RunStatus a ProgresoMotor['pausaCuota'].
   - En motorSubtareas.ts guarda retomarEn: 'IMPLEMENT' en progreso.pausaCuota.
   - En motor.ts (reanudar), lee const retomarEn = progreso.pausaCuota?.retomarEn ?? 'IMPLEMENT' antes de borrar pausaCuota y pasalo en payload.retomar_en.
3. En packages/core/src/antigravityRunner.ts (esWorktreeValido):
   - Usa norm.toLowerCase() cuando process.platform === 'win32' para buscar el indice de '/.batuta/worktrees/'.
4. En docs/briefs/hito-08-antigravity-runner.md:
   - Marca con [x] las casillas de criterios de aceptacion ya verificadas.
