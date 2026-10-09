# Batuta: sistema orquestador de agentes de IA

> Diseño v0.10 · Plan cerrado, piloto verificado y plan de codificación · 9 de octubre de 2026
> Estado: solo planificación. Todavía no hay código ni lenguaje elegido.
> Las versiones v0.2 a v0.10 incorporan la comparación con ForgeFlow Harness y las decisiones de ejecución, despliegue y avisos (ver el registro de cambios al final).

## 1. Visión

**Batuta** es un programa que dirige agentes de IA como un director dirige una orquesta. Recibe una idea con su diseño técnico, la convierte en una especificación aprobada por una persona y entrega una rama de Git verificada, lista para revisión.

El flujo lo controla código determinista. La IA solo hace el trabajo cognitivo dentro de pasos acotados.

### Principios

1. **El código manda, la IA ejecuta.** El orden de los pasos, los reintentos, los límites y las decisiones de avance viven en el programa.
2. **Nada avanza sin verificación objetiva.** Se confía en comandos (linter, tests), no en que el modelo diga "listo".
3. **Todo es reanudable.** El estado es un registro de eventos, no una conversación en memoria.
4. **Aislamiento por defecto.** Ningún agente toca la rama principal.
5. **Corrección única.** Un error se corrige en el prompt, la plantilla o el gate, nunca parchando la salida a mano.
6. **Humano en las decisiones clave.** Aprueba la especificación y el merge final.
7. **Agentes pequeños.** Cada uno tiene una sola responsabilidad.

### Fuera de alcance (v1)

- Desplegar a producción de forma autónoma.
- Trabajar sobre varios repositorios a la vez.
- Reemplazar la revisión humana final.
- Interfaz web (se usa CLI).

## 2. Arquitectura general

```
brief.md ──▶ CLI de Batuta
                │
         ┌──────▼───────┐
         │ Motor de     │◀── batuta.yaml + AGENTS.md
         │ flujo        │    (máquina de estados)
         └─┬─────┬────┬─┘
           │     │    └──▶ Registro de eventos (append-only) + checkpoints
           │     └───────▶ Gestor de aislamiento (git worktree / Docker)
           ▼
   Ejecutor de agentes ──▶ Enrutador de modelos ──▶ CLI headless (Claude Code, OpenCode)
           │
           ▼
   Quality gates (formato, lint, build, tests, criterios, política de diff)
           │
           ▼
   Aprobación humana final (Pull Request)
```

| Módulo | Responsabilidad |
|---|---|
| Motor de flujo | Máquina de estados: decide el siguiente paso, los reintentos y cuándo parar |
| Registro de eventos | Guarda cada acción como evento inmutable; permite reanudar y auditar |
| Gestor de aislamiento | Crea y destruye worktrees (y más adelante contenedores) |
| Ejecutor de agentes | Invoca a cada agente mediante la CLI headless de la herramienta elegida (capa `AgentRunner`), valida que su salida cumpla el contrato JSON y aplica los límites |
| Enrutador de modelos | Asigna un modelo a cada rol según la configuración |
| Quality gates | Ejecuta las verificaciones deterministas y produce un informe estructurado |
| Gestor de aprobaciones | Pausa el flujo en los puntos humanos y lo reanuda al aprobar |
| Reportero | Genera el resumen final y las métricas de la ejecución |

## 3. Los cinco pilares de diseño

### 3.1 Estado basado en eventos

**Decisión:** cada acción, comando y resultado se guarda como un evento inmutable en un archivo de solo agregar (`events.jsonl`). El estado actual se reconstruye leyendo ese registro.

**Cómo funciona:**
- Cada evento tiene `id`, `run_id`, `ts`, `tipo`, `paso`, `agente`, `payload` y `parent_id`.
- `state.json` guarda el estado actual para consultarlo rápido (id de la ejecución, estado general, presupuesto acumulado, modelo activo). Siempre se puede reconstruir desde `events.jsonl`, que es la fuente de verdad.
- Cada paso de agente escribe además un log legible en `logs/` (por ejemplo `step_01_architect.log`) para depurar sin recorrer todo el registro.
- Tras completar cada subtarea se escribe un **checkpoint** (estado serializado + hash del commit).
- **Condensación de contexto:** cuando el contexto de un agente supera un umbral, un paso de resumen comprime los eventos antiguos en un solo evento `resumen` y conserva en bruto los últimos K eventos.
- Reanudar es releer el registro hasta el último checkpoint válido y continuar en una sesión limpia del agente, entregándole un resumen cronológico de lo ya hecho.

**Listo cuando:** se puede matar el proceso a mitad de una subtarea y `batuta resume` continúa sin repetir trabajo ya verificado.

### 3.2 Aislamiento por tarea

**Decisión:** ningún agente edita la rama principal ni el directorio de trabajo normal.

**Cómo funciona:**
- Cada ejecución crea `git worktree add <dir>/<run_id> -b batuta/<run_id>`.
- Cada subtarea verificada se guarda como un commit en esa rama, que sirve de punto de retorno.
- Si una subtarea falla definitivamente, se hace `git reset --hard` al último commit bueno.
- Si la ejecución se aborta o descarrila, se elimina el worktree y la rama sin dejar rastro.
- **Fase 3:** las verificaciones y los comandos de los agentes corren dentro de contenedores Docker. Un worktree aísla archivos, pero no procesos: un agente aún podría ejecutar comandos arbitrarios. Por eso en el MVP se aplican además listas de comandos permitidos y rutas prohibidas.

**Listo cuando:** una ejecución fallida no deja cambios en la rama principal ni archivos huérfanos.

### 3.3 Desarrollo guiado por especificaciones (SDD)

**Decisión:** el agente no toca código hasta que existe una especificación aprobada.

**Cómo funciona:**
- **Entrada:** `brief.md` (la idea y el diseño técnico inicial, escrito por la persona).
- **Fase de especificación:** el agente `architect` genera `spec.md` con objetivo, lista exacta de archivos a modificar, criterios de aceptación verificables, el comando que comprueba cada criterio y los casos de borde que las pruebas deben cubrir.
- **Gate humano H1:** la persona aprueba o corrige la especificación.
- **Fase de plan:** a partir de la especificación aprobada se genera `plan.json` con subtareas, archivos, criterios asociados y la complejidad de cada subtarea (baja, media o alta).
- **Archivo de reglas del repositorio** (`AGENTS.md` o `CLAUDE.md`): comandos de build, lint y tests, estilo de código y directorios prohibidos. Se inyecta como contexto en cada llamada.
- **Specs en el repositorio:** cada spec aprobada se guarda en `docs/specs/SPEC-001-nombre.md` dentro del mismo PR, como registro. Si una tarea cambia el comportamiento descrito en una spec anterior, el `architect` lista las specs afectadas (el `scout` las encuentra a partir de los archivos tocados) y las actualiza. Es configurable (`specs_en_repo`); si es `false`, se guardan en `.batuta/`. Una única fuente de verdad siempre sincronizada queda para la Fase 3.

**Listo cuando:** ningún paso de implementación arranca sin `spec.md` aprobado, y cada criterio de aceptación tiene un comando o está marcado como "revisión manual".

### 3.4 Enrutamiento multi-modelo

**Decisión:** cada rol usa el modelo que mejor equilibra costo y capacidad. Se configura por rol, no en el código.

| Patrón | Rol | Tipo de modelo |
|---|---|---|
| Scout-then-Edit (explorar) | `scout` | Rápido y económico: rastrea el repo y recopila contexto |
| Scout-then-Edit (editar) | `software-engineer`, `architect` | Alto razonamiento: cambios complejos y diseño |
| Generate-then-Review | `code-reviewer`, `security-reviewer` | Modelo **distinto** al del implementador, para detectar errores que este no vería |

**Notas de diseño:**
- Los roles apuntan a alias de modelo (por ejemplo `fuerte`, `rapido`, `revisor`), no a nombres concretos. Cambiar de proveedor es cambiar una línea de configuración.
- Si los modelos se enrutan mediante un proxy local (como Jan), Batuta lo trata como una dependencia: al arrancar hace un **preflight** que valida las variables de entorno (`ANTHROPIC_BASE_URL`, token) y que el modelo responde, porque el proxy puede resetear el token al cambiar de modelo.
- Cada llamada registra modelo, tokens y costo estimado en el registro de eventos.
- En el MVP todos los roles se invocan por CLI headless. El modelo de cada rol se selecciona con la opción de modelo de la herramienta (o con el alias que exponga el proxy).

**Listo cuando:** cambiar el modelo de un rol no requiere tocar código y el informe final muestra el costo por rol.

### Modelos por rol y reglas de enrutamiento

**Propuesta inicial de nivel por rol:**

| Rol | Nivel | Por qué |
|---|---|---|
| `scout` y resúmenes | Rápido y barato | Exploran y condensan, no deciden |
| `architect` | Fuerte | La spec condiciona todo lo que sigue |
| `software-engineer` | Según la complejidad de la subtarea (rápido, medio o fuerte) | Es donde más tokens se gastan |
| `debugger` | Fuerte | Solo entra cuando lo barato ya falló |
| Revisores | Distinto al del implementador, idealmente de otro proveedor | Un modelo distinto detecta errores que el primero no ve |

**Reglas:**

1. **Un modelo por llamada.** El modelo se fija al lanzar la llamada y no cambia mientras el agente trabaja. La rotación ocurre entre llamadas: cada paso, subtarea, reintento y revisión es una llamada con su propio modelo. Las llamadas son pequeñas (una subtarea por llamada). Si una subtarea tiene fases con necesidades distintas, por ejemplo explorar y luego editar, se parte en dos llamadas.
2. **Complejidad por subtarea.** El `architect` la marca en `plan.json` y Batuta elige el modelo del implementador con ella.
3. **Escalado en reintentos.** El primer intento usa el modelo que corresponde a la complejidad; el segundo sube de nivel; tras el segundo fallo entra el `debugger` (modelo fuerte).
4. **Respaldo con criterio.** Solo ante sobrecarga del modelo (por ejemplo `--fallback-model` en Claude Code), nunca bajando de nivel a un revisor de seguridad. Batuta registra qué modelo respondió realmente.
5. **Contexto por modelo.** El umbral de condensación depende de la ventana de contexto de cada modelo.
6. **Nombres completos.** Para que las ejecuciones sean reproducibles se usan nombres completos de modelo, porque los alias apuntan al modelo más reciente. Si se usa un proxy, el alias equivale al modelo asignado a ese slot.
7. **Mecanismos internos de la herramienta fuera del MVP.** Cosas como `opusplan` o subagentes con modelo propio restan visibilidad de qué modelo hizo qué y complican el conteo de costos. Se evalúan en la Fase 2 como optimización.

### 3.5 Bucles de verificación deterministas (quality gates)

**Decisión:** el programa nunca acepta un "listo" del modelo. Tras cada implementación ejecuta un pipeline fijo.

**Orden de los gates:**
1. Formateador y linter.
2. Build o chequeo de tipos.
3. Tests unitarios.
4. Tests de integración (si aplica).
5. Criterios de aceptación de la especificación (un comando por criterio).
6. **Política de diff:** solo se tocaron archivos permitidos, ninguno prohibido, el tamaño del diff está dentro del límite y no se agregaron secretos.

**Política de reintentos:**
- Máximo 3 intentos por subtarea.
- El segundo intento del implementador sube el modelo de nivel (ver 3.4).
- El informe de error se recorta a las líneas relevantes y se devuelve al implementador.
- Tras el segundo fallo se escala al agente `debugger`, que debe replantear la estrategia y proponer un enfoque distinto al de los intentos anteriores.
- Si el mismo error aparece dos veces seguidas, se escala de inmediato (detección de bucles).
- Tras el tercer fallo la subtarea se marca como fallida, se vuelve al último checkpoint y se avisa a la persona.

**Reglas adicionales:**
- Cada comando de verificación tiene un tiempo máximo (por defecto 120 segundos).
- El motor **reejecuta** los comandos de verificación por su cuenta. Lo que el agente reporte sobre sus propios resultados es informativo y nunca cuenta como prueba.

**Al terminar todas las subtareas:** revisión por los agentes revisores, generación de la Pull Request y **gate humano H3**.

**Listo cuando:** ninguna subtarea se marca completada sin que todos los gates pasen, y los fallos quedan registrados con su salida.

## 4. Ciclo de vida de una ejecución

```
INTAKE → [H0: aprobar presupuesto y límites] → SPEC → [H1: aprobar spec] → PLAN → [H2: aprobar plan, opcional]
   → por cada subtarea: IMPLEMENT → VERIFY ─┬─ falla → RETRY / DEBUG (máx. 3)
                                            └─ pasa  → CHECKPOINT
   → REVIEW → FINALIZE (PR) → [H3: aprobar merge] → DONE
```

Estados terminales: `DONE`, `FAILED` (límite de intentos o presupuesto), `ABORTED` (cancelada por la persona).

**Comandos de la CLI:**
- `batuta run brief.md`: inicia una ejecución; muestra los límites de presupuesto y pide confirmación (H0).
- `batuta status [run_id]`: muestra el estado y el último evento.
- `batuta approve <run_id> <gate>`: aprueba un gate humano.
- `batuta resume <run_id>`: reanuda desde el último checkpoint.
- `batuta abort <run_id>`: cancela y limpia el worktree.
- `batuta init`: prepara un repositorio nuevo (commit inicial, `AGENTS.md` y carpeta de specs).

### Manejo de ambigüedad

- **Antes de codificar:** el `architect` incluye en la spec hasta 5 preguntas abiertas, cada una con un supuesto por defecto. Se resuelven en H1; si no se responde, rigen los supuestos, que quedan marcados en la spec.
- **Durante la implementación:** el agente no pregunta. Registra el supuesto en su salida y continúa.
- **Excepción:** si la duda afecta la seguridad, los datos o una acción irreversible, no se supone. El agente devuelve `NEEDS_INPUT` con su `blocking_question`, la ejecución pasa a `WAITING_INPUT` y Batuta avisa. Se reanuda con la respuesta.
- Hay un máximo configurable de preguntas bloqueantes por ejecución (por defecto 3) para evitar idas y vueltas.

### Proyecto nuevo (desde cero)

Batuta también puede iniciar un proyecto vacío, con estas adaptaciones, porque al principio no existen los comandos de verificación ni las reglas:

1. `batuta init` crea el repositorio con un commit inicial, necesario para que los worktrees tengan una rama de la que partir.
2. La primera ejecución es **`SPEC-000: fundación del proyecto`**: define el stack, la estructura, los scripts (lint, typecheck, test, build), el `AGENTS.md` y el CI. Sus criterios de aceptación son que el esqueleto compila y los scripts corren.
3. La aprobación humana en H1 es más exigente en esa primera spec, porque fija la arquitectura. La elección del stack no se delega al agente.
4. Para `SPEC-000` el máximo de preguntas abiertas sube (por ejemplo a 10), porque hay mucha más ambigüedad.
5. Desde ahí el flujo es el normal: `SPEC-001`, `SPEC-002`, una por funcionalidad.

## 5. Agentes y contratos

Los agentes actuales se conservan como pasos. La función del antiguo orquestador `tech-lead` pasa al motor de flujo de Batuta (código).

| Agente | Rol en Batuta | Entrada | Salida (JSON) |
|---|---|---|---|
| `scout` (nuevo) | Explora el repo y reúne contexto | brief + estructura del repo | archivos relevantes y resumen |
| `architect` | Genera `spec.md` y `plan.json` | brief + contexto | spec, subtareas, criterios |
| `software-engineer` | Implementa una subtarea | subtarea + spec + reglas | archivos modificados y notas |
| `debugger` | Corrige tras fallos repetidos | subtarea + informe de error | causa y cambios propuestos |
| `database-reviewer` | Revisa cambios de BD (solo si los hay) | diff + esquema | veredicto + hallazgos |
| `security-reviewer` | Revisa seguridad del diff | diff | veredicto + hallazgos |
| `code-reviewer` | Revisa calidad y cumplimiento de la spec | diff + spec | veredicto + hallazgos |

**Regla de contrato:** toda salida se valida contra un esquema JSON. Si no es válida, se reintenta una vez con el error de validación; si vuelve a fallar, cuenta como intento fallido.

**Entrada común a todo agente (`AgentInput`):**

```json
{
  "task_id": "TASK-102",
  "agent_role": "software-engineer",
  "spec_path": ".batuta/runs/RUN-001/spec.md",
  "allowed_files": ["src/services/user.py"],
  "budget_limit_usd": 1.5,
  "max_steps": 15
}
```

**Salida obligatoria (`AgentOutput`)**, entregada al cerrar mediante una herramienta de cierre (`finish`):

```json
{
  "status": "SUCCESS",
  "summary": "Descripción breve de lo hecho",
  "files_modified": ["src/services/user.py", "tests/test_user.py"],
  "reported_checks": [{"command": "npm test", "exit_code": 0}],
  "continuation_notes": "",
  "blocking_question": ""
}
```

- `status` puede ser `SUCCESS`, `FAILED`, `NEEDS_CONTINUATION` o `NEEDS_INPUT`. `NEEDS_INPUT` indica que el agente quedó bloqueado por una duda crítica (ver manejo de ambigüedad). `NEEDS_CONTINUATION` se usa cuando el agente agota sus pasos o su contexto antes de terminar: el motor lanza una sesión nueva con un resumen y `continuation_notes`.
- `reported_checks` es informativo. El motor reejecuta los comandos y no acepta el autoinforme como prueba.
- Si el agente supera `budget_limit_usd` o `max_steps`, el motor lo detiene y cuenta el intento como fallido.
- Si los modelos son de terceros y el costo no viene en la respuesta, el costo en dólares se estima con los tokens y una tabla de precios en la configuración.

**Veredicto de revisores:** `aprobado`, `cambios_requeridos` o `bloqueante`, con lista de hallazgos por severidad. El programa decide con reglas explícitas (por ejemplo, cualquier `bloqueante` detiene el flujo).

### Capa de ejecución (`AgentRunner`)

En el MVP **todos los agentes se invocan por CLI headless**. Una capa común oculta las diferencias entre herramientas:

| Adaptador | Cuándo | Notas |
|---|---|---|
| `ClaudeCodeRunner` | MVP (primero) | Admite tope de gasto, límite de turnos, salida con esquema JSON y permisos por comando |
| `OpenCodeRunner` | Fase 2 | Reutiliza los agentes actuales; no se asumen límites nativos de turnos ni de costo |
| `ApiRunner` | Futuro, opcional | Solo para pasos sin herramientas (architect, revisores, resúmenes) |

**Responsabilidades de la capa:**
1. Construir el comando con el modelo, los permisos y los límites del rol.
2. Entregar el `AgentInput` y capturar la salida.
3. Validar la salida contra el esquema. Si la herramienta no soporta esquemas, Batuta valida por su cuenta y reintenta una vez.
4. Imponer un **timeout** y matar el proceso si lo excede, aunque la herramienta no tenga ese límite.
5. Contar tokens y estimar el costo con la tabla de precios propia de la configuración.
6. Registrar todo en `events.jsonl`.

**Permisos según el tipo de rol:**
- *Solo lectura* (`scout`, `architect`, revisores, resúmenes): pueden leer y buscar archivos, sin editar ni ejecutar comandos. El contenido de `spec.md` y `plan.json` lo devuelve el `architect` en su salida y es Batuta quien escribe los archivos.
- *Con escritura* (`software-engineer`, `debugger`): pueden editar los archivos permitidos y ejecutar solo los comandos de la lista permitida de la configuración.

Se recomienda un arranque mínimo de la herramienta (en Claude Code, la opción `--bare`) para no cargar contexto innecesario. Las reglas del repositorio y la spec se inyectan de forma explícita.

## 6. Datos y estructura de archivos

```
.batuta/
  runs/<run_id>/
    brief.md
    spec.md
    plan.json
    state.json          # estado actual (derivable de events.jsonl)
    events.jsonl        # registro de eventos
    logs/               # un log legible por paso de agente
    checkpoints/        # estado + hash de commit
    reports/            # informes de gates y revisiones
    summary.md          # resumen final
  lecciones.md          # registro de la corrección única
batuta.yaml             # configuración
AGENTS.md               # reglas del repositorio
```

### Plantilla de especificación (`spec.md`)

```
# SPEC-001: <nombre de la funcionalidad o corrección>
# Objetivo (el porqué y el comportamiento esperado)
# Contexto y restricciones
# Requisitos (lista de verificación)
  - [ ] R-1: ...
# Archivos permitidos para modificar (lista exacta)
# Archivos prohibidos
# Criterios de aceptación
  - CA-1: <descripción> | verificación: <comando>
# Comandos de verificación (build, lint, tests)
# Pruebas requeridas
  - Casos de borde y escenarios que deben cubrirse
  - Qué dependencias pueden simularse y cuáles no
# Preguntas abiertas y supuestos
  - P-1: <pregunta> | supuesto por defecto: <...>
# Specs afectadas (si cambia el comportamiento de specs anteriores)
# Fuera de alcance
```

## 7. Configuración (`batuta.yaml`)

```yaml
proyecto: ruta/al/repo
preparacion:                 # comandos que dejan listo un worktree nuevo (por ejemplo, instalar dependencias)
  - <completar>
entorno_gates:               # variables de entorno de prueba para los gates; nunca secretos reales
  CLAVE: valor
ejecutor: claude-code          # en el MVP todos los roles usan CLI headless
alias_modelos:                # cada alias apunta a un nombre de modelo completo; precios en USD por millón de tokens
  rapido:  { modelo: <completar>, entrada: <completar>, salida: <completar>, ventana: <completar> }
  medio:   { modelo: <completar>, entrada: <completar>, salida: <completar>, ventana: <completar> }
  fuerte:  { modelo: <completar>, entrada: <completar>, salida: <completar>, ventana: <completar> }
  revisor: { modelo: <completar>, entrada: <completar>, salida: <completar>, ventana: <completar> }
modelos:
  scout: rapido
  resumenes: rapido
  architect: fuerte
  software-engineer:         # según la complejidad de la subtarea (ajustable)
    baja: rapido
    media: medio
    alta: fuerte
  debugger: fuerte
  revisores: revisor         # idealmente de otro proveedor
escalar_modelo_en_reintento: true
limites:
  intentos_por_subtarea: 3
  tokens_por_ejecucion: 2000000
  minutos_por_ejecucion: 120
  lineas_de_diff_max: 800
  usd_por_agente: 2.0
  pasos_por_agente: 15
  timeout_comando_seg: 120
aprobaciones:
  H0_inicio: true
  H1_spec: true
  H2_plan: true
  H3_merge: true
gates:
  - formato
  - lint
  - build
  - tests
  - criterios
  - politica_diff
politica_comandos:
  bajo: permitir             # lectura, tests, lint
  medio: registrar           # instalar dependencias, editar configuración
  alto: pedir_confirmacion   # borrar, git push, privilegios elevados
rutas_prohibidas: [".env", "infra/", ".github/workflows/"]
specs_en_repo: true
notificaciones:
  canal: telegram            # token y chat por variables de entorno
  eventos: [aprobacion_requerida, espera_de_respuesta, fallo, ejecucion_terminada, costo_cerca_del_limite]
```

## 8. Guardarraíles y seguridad

- **Límites duros** de intentos, tokens, tiempo y tamaño del diff. Al superarlos la ejecución se detiene y avisa.
- **Permisos mínimos** para los agentes: lista de comandos permitidos y rutas prohibidas.
- **Clasificación de riesgo de comandos:** cada comando se clasifica como bajo, medio o alto. Los de riesgo alto (borrar, `git push`, privilegios elevados) pausan la ejecución hasta que la persona confirme. Con una CLI headless esto depende de la configuración de permisos de la herramienta; si Batuta controla el bucle de herramientas mediante la API, puede interceptar cada comando directamente.
- **Secretos:** nunca se pasan al contexto de los agentes; la política de diff rechaza cambios que los agreguen.
- **Aprobaciones humanas** en H0 (presupuesto), H1 (especificación) y H3 (merge) de forma obligatoria al inicio. Se relajan solo con evidencia de que los gates son confiables.
- **Preflight** antes de cada ejecución: repositorio limpio, herramientas instaladas, modelos respondiendo y versión de Node compatible con el campo `engines` del proyecto.
- **Registro completo:** cada comando ejecutado queda en `events.jsonl`.

## 9. Observabilidad y métricas

- `summary.md` por ejecución: qué se hizo, intentos por subtarea, gates fallidos, costo por rol y duración.
- Métricas a seguir: porcentaje de ejecuciones que llegan a `DONE` sin intervención fuera de los gates, intentos promedio por subtarea, costo por ejecución, tiempo total y porcentaje de reanudaciones exitosas.

## 10. Regla de corrección única

Cada vez que una ejecución falla o un agente comete un error recurrente:
1. Se identifica la causa (prompt ambiguo, plantilla incompleta, gate faltante, contexto insuficiente).
2. Se corrige **esa pieza** y no la salida.
3. Se anota en `lecciones.md` con la fecha, el síntoma y el cambio aplicado.

## 11. Pruebas del propio Batuta

- Pruebas unitarias del motor de flujo, con agentes simulados (respuestas JSON fijas).
- Pruebas de reanudación: matar el proceso en cada estado y verificar que `resume` continúa bien.
- Pruebas de aislamiento: comprobar que la rama principal queda intacta tras fallos y abortos.
- Un repositorio de práctica con tareas pequeñas conocidas para validar de extremo a extremo.

## 12. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Costos descontrolados | Límites de tokens y tiempo, informe de costo por rol |
| Bucles de reintento | Máximo de intentos y detección de errores repetidos |
| Salidas que no son JSON válido | Validación con esquema y un reintento con el error |
| Saturación de contexto | Condensación de eventos y contexto mínimo por agente |
| Los tests pasan pero el código está mal | Criterios de aceptación verificables y revisores independientes |
| Un agente ejecuta algo peligroso | Worktree, lista de comandos permitidos y, más adelante, Docker |
| Cambios en las CLI headless | Capa de abstracción sobre el ejecutor de agentes |
| Una herramienta no ofrece límites de turnos o costo | Batuta aplica timeout, mata el proceso y cuenta tokens por su cuenta |
| Exceso de confianza en la automatización | Gates humanos H1 y H3 obligatorios al inicio |

## 13. Hoja de ruta

| Fase | Contenido | Criterio de listo |
|---|---|---|
| **0. Preparación** | Plantilla de spec, `AGENTS.md`, esquemas JSON, proyecto piloto preparado (CuotaMoto, sección 18) | Documentos revisados |
| **1. MVP** | Bucle lineal, worktree, registro de eventos y `state.json`, gates de lint y tests, un implementador mediante un adaptador headless, límites por agente (USD, pasos y timeout), H0, H1 y H3 (plan de codificación en la sección 19) | Completa una tarea real pequeña y se reanuda tras matar el proceso |
| **2. Calidad** | Revisores independientes, enrutamiento por rol y complejidad, escalado de modelo en reintentos, escalamiento al debugger, condensación de contexto, segundo adaptador (OpenCode), avisos por Telegram, comando `batuta run --issue`, evaluar `opusplan` y subagentes con modelo propio como optimización | Los revisores detectan errores que los tests no |
| **3. Robustez** | Docker para verificaciones (antes de migrar al VPS), subtareas en paralelo, PR automática y GitHub Actions, adaptador de API directa para pasos sin herramientas (opcional), detección automática de issues | Ejecución sin supervisión de varias horas sin incidentes |
| **4. Operación** | Agente de monitoreo que abre issues, métricas históricas, mejora continua desde `lecciones.md` | Ciclo de errores en producción reasignados al flujo |

## 14. Despliegue: local y VPS

Batuta corre primero en local y pasará a un VPS pronto. Para no rehacer cosas al migrar:

- **Aprobaciones asíncronas:** H0, H1 y H3 pausan el flujo y se reanudan con `batuta approve`, sin necesidad de una sesión abierta.
- **Sin rutas ni credenciales fijas:** las rutas van en la configuración y las claves en variables de entorno.
- **Proveedor de modelos:** si en local se usa un proxy para enrutar modelos de terceros, en el VPS hay que montar uno equivalente o apuntar directo al proveedor. La configuración de `modelos` y `precios` no debe depender del proxy.
- **Aislamiento reforzado:** usuario sin privilegios, sin secretos de producción y Docker para las verificaciones antes de migrar.
- **Proceso persistente:** servicio (systemd o tmux) que se reanuda con `batuta resume` tras un reinicio.
- **Registros en archivos:** nada depende de una terminal interactiva.
- **Windows y Linux:** el desarrollo local es en Windows y el VPS será Linux, así que Batuta no puede depender de comandos de shell específicos. Usa las APIs de Node para archivos y rutas, lanza los comandos sin shell cuando se pueda y, al vencer un timeout, termina el árbol completo de procesos (en Windows con `taskkill /T`, en Linux con grupos de procesos).

## 15. Notificaciones

Los avisos se envían por **Telegram**, mediante una interfaz `Notifier` con un adaptador `TelegramNotifier`.

- **Eventos:** aprobación requerida (H0, H1, H3), espera de respuesta (`WAITING_INPUT`), fallo, ejecución terminada (con enlace al PR o a la rama) y costo cerca del límite.
- **Contenido:** un resumen corto. Nunca código, diffs ni secretos.
- **Seguridad:** el token y el chat se leen de variables de entorno, y solo se escribe al chat configurado.
- Los avisos son informativos: las aprobaciones se hacen con la CLI. Aprobar desde Telegram queda como mejora futura.

## 16. Implementación: lenguaje y estructura

El lenguaje es **TypeScript**. Estructura propuesta:

```
batuta/
  packages/
    core/   # motor de flujo, estado, gates, AgentRunner, TaskSource, Notifier
    cli/    # comandos delgados sobre el núcleo
    ui/     # futuro: interfaz web que lee el estado
```

- El núcleo no depende de la terminal. La CLI es una capa delgada, y una UI futura se agrega como otro paquete.
- Los esquemas se definen con Zod, que también genera el JSON Schema que piden las herramientas.
- Como el estado vive en archivos (`events.jsonl`, `state.json`), una UI puede leerlo sin acoplarse al motor.
- El runtime y las librerías de la CLI se definen al empezar el código.

## 17. Origen de la tarea y autenticación

### Origen de la tarea

Toda tarea entra como un `brief.md` dentro de la carpeta de la ejecución, sin importar su origen. La fuente es una interfaz (`TaskSource`), así que cambiarla no afecta al resto del flujo.

| Fase | Origen |
|---|---|
| 1 (MVP) | Archivo: `batuta run brief.md` |
| 2 | Issue puntual: `batuta run --issue 12` (trae el issue bajo demanda, sin vigilar el repositorio) |
| 3 | Detección automática de issues con una etiqueta (por ejemplo `batuta`), junto con el VPS |

**Regla de confianza:** solo se aceptan issues escritos por el propietario o con la etiqueta puesta por él, porque cualquier texto externo que llegue al agente es una vía de inyección de instrucciones.

### Autenticación y credenciales

- **Herramientas de IA:** claves de API por variables de entorno, guardadas en un archivo con permisos restringidos y con un límite de gasto en el proveedor. En el VPS se prefieren las claves de API sobre una sesión de suscripción, que es incómoda sin navegador; si se quisiera usar una suscripción, hay que revisar antes los términos del plan.
- **GitHub:** un token con alcance mínimo, limitado a los repositorios del proyecto (contenido y PR, y issues cuando se use esa fuente). **Solo Batuta lo usa** para hacer el push y abrir el PR.
- **Entorno de los agentes:** los agentes reciben únicamente la clave del modelo. Batuta limpia el resto del entorno antes de lanzarlos, así que nunca ven el token de GitHub, el de Telegram ni secretos de producción.
- **Telegram:** token del bot y chat autorizado por variables de entorno.

## 18. Proyecto piloto: CuotaMoto

CuotaMoto es un repositorio personal y público (Next.js, Drizzle y SQLite). Es un buen piloto porque es acotado y ya tiene tests, CI, migraciones y README propios.

### Estado de preparación

En la rama `chore/batuta-pilot` se agregaron los scripts `typecheck` y `verify`, la sección de reglas para agentes en `AGENTS.md`, la plantilla `docs/specs/SPEC-000-plantilla.md` y dos briefs en `docs/batuta/briefs/`. La rama se subió al remoto y se revisó de forma independiente: no toca rutas protegidas ni agrega dependencias, y lint, tipos, tests (24 archivos, 199 pruebas), cobertura (56,5 %) y build pasan. Además contiene el resultado de `brief-02` hecho a mano con el pipeline actual (commit `8322f5b`), que sirve de control.

**Línea base (equipo local con Windows y Node 24):**

| Paso | Resultado | Tiempo |
|---|---|---|
| `npm ci --ignore-scripts` | ✓ | 107 s |
| `npm run lint` | ✓ | 14,7 s |
| `npm run typecheck` | ✓ | 9,5 s |
| `npm test` | ✓ 21 archivos, 182 pruebas | 42 s |
| `npm run build` | ✓ | 87 s |
| `npm run verify` (los cuatro anteriores) | ✓ | 153 s |

La cobertura de líneas es del 52,6 % frente a un umbral del 48 %. Se mide aparte con `npm run test:coverage` y no forma parte de `verify`.

### Configuración del piloto

```yaml
proyecto: ruta/al/repo/cuotamoto
preparacion:
  - npm ci --ignore-scripts
entorno_gates:   # valores de prueba que ya usa el CI del proyecto; nunca secretos reales
  DATABASE_URL: "file:./data/test.db"
  ADMIN_PASSWORD: "test-password-12345"
  AUTH_SECRET: "ci-secret-minimo-32-caracteres-xxxxxx"
gates:
  - { nombre: lint,      comando: "npm run lint",          timeout_seg: 60 }
  - { nombre: tipos,     comando: "npm run typecheck",     timeout_seg: 60 }
  - { nombre: tests,     comando: "npm test",              timeout_seg: 120 }
  - { nombre: cobertura, comando: "npm run test:coverage", timeout_seg: 120 }
  - { nombre: build,     comando: "npm run build",         timeout_seg: 240 }
rutas_prohibidas:   # cambiarlas requiere aprobación humana
  - ".env*"
  - "Dockerfile"
  - "docker-compose.yml"
  - "docker-entrypoint.sh"
  - "README_COOLIFY.md"
  - "scripts/backup.mjs"
  - "scripts/migrate.mjs"
  - "drizzle/"
  - ".github/workflows/"
  - "package-lock.json"
  - "data/"
```

### Hallazgos que afectan al diseño

1. **Versión de Node.** El equipo local usa Node 24 y el proyecto pide la 22. Con esa diferencia `npm ci` intentó compilar `better-sqlite3` y falló por falta de herramientas de compilación. El preflight de Batuta compara la versión de Node con `engines` y avisa. Se recomienda usar la 22 en local, igual que el CI y el despliegue.
2. **`--ignore-scripts`.** Con esa opción la instalación funciona porque el paquete trae binarios precompilados, y además evita ejecutar los scripts de instalación de las dependencias. Es una decisión por proyecto, dentro de `preparacion`, y no un valor por defecto de Batuta, porque otros proyectos sí necesitan esos scripts.
3. **Carpeta `data/`.** No existe en un worktree nuevo porque Git la ignora, pero el proyecto la crea solo al correr las pruebas, así que no hace falta un paso extra. Cada worktree tiene su propia base de pruebas y no hay choques entre ejecuciones.
4. **`node_modules` en los worktrees.** Instalar toma unos 107 s y ~350 MB por worktree. Con un worktree por ejecución (MVP) se paga una vez por ejecución, y como `package-lock.json` es ruta prohibida el resultado sirve durante toda la ejecución. No se comparte por enlace simbólico: crearía estado mutable compartido entre ejecuciones y puede fallar con herramientas que resuelven rutas reales. Para subtareas en paralelo (Fase 3) se evaluará guardar una copia de `node_modules` identificada por el hash de `package-lock.json`.

### Ajustes pendientes en la rama

1. **`verify` con cobertura.** `verify` corre `test`, pero el CI corre `test:coverage`, que exige el 55 %. Un `verify` en verde no garantiza un CI en verde, así que `verify` debe usar `test:coverage`.
2. **Roles exigidos por las rutas.** Las pruebas nuevas simulan que `requireRole` rechaza, pero no comprueban con qué roles se llama: `"admin"` en vehículos y `"admin", "cobrador"` en clientes. Falta afirmarlo con `toHaveBeenCalledWith`.
3. **`AGENTS.md`.** Falta documentar `test:coverage` y su umbral, las variables de entorno que necesitan los gates (`DATABASE_URL`, `ADMIN_PASSWORD`, `AUTH_SECRET`) y cómo correr un solo archivo de pruebas.

### Tareas piloto

1. `typecheck` y `verify`: hechas a mano en la preparación.
2. `brief-02-tests-rutas`: pruebas para las rutas `api/vehicles`, `api/clients` y `api/health`, hoy sin cobertura, y subir el umbral de cobertura al 55 %. Ya se hizo a mano con el pipeline actual (commit `8322f5b`: 17 pruebas nuevas y cobertura del 56,5 %), así que sirve de **control**. Batuta lo repetirá desde el commit `42d205b` (la preparación sin las pruebas nuevas) y se compararán tiempo, costo y calidad. Falta anotar el tiempo y los tokens de la sesión manual. Será **la primera ejecución real de Batuta sobre el piloto**.
3. Más adelante: cambios en la lógica de pagos, con revisión humana estricta en H3.

**Criterio de éxito del piloto:** Batuta completa `brief-02` de extremo a extremo (spec aprobada, pruebas escritas, todos los gates en verde y PR creado), se reanuda tras matar el proceso a mitad, la rama principal queda intacta y el resultado es al menos equivalente al control manual.

## 19. Plan de codificación de la Fase 1

### Método

Batuta se construye con el mismo método que aplicará: cada hito tiene un brief con criterios de aceptación y comandos de verificación, y no se pasa al siguiente hasta que sus gates están en verde.

**Reparto de roles.** Claude planifica el proyecto: mantiene este diseño, la hoja de ruta, los hitos y sus criterios de aceptación. El agente de codificación decide el cómo: estructura del código, patrones, librerías y detalles técnicos. Escribe el código, las pruebas y la documentación técnica, y registra sus decisiones.

**Límites del agente.** Las decisiones ya tomadas por el usuario (sección 20) son restricciones y no se cambian sin consultarlo. Los criterios de aceptación de cada hito se cumplen siempre. Si el agente cree que el diseño tiene un error o que hay una opción mejor, lo propone en su informe. Puede seguir su propuesta mientras no contradiga una decisión tomada ni un criterio de aceptación, y deja constancia en el registro de decisiones. Claude actualiza el diseño con esas propuestas cuando el usuario se las traslada.

**Orquestación manual hasta que Batuta exista.** El usuario hace de orquestador, con este ciclo por hito:

1. Claude define el hito: objetivo, restricciones y criterios de aceptación, en un brief corto.
2. El usuario lanza al agente de codificación sobre el brief, en una rama `hito/NN-nombre`.
3. El agente diseña el detalle (puede escribir su propia spec corta), implementa, ejecuta los gates, registra sus decisiones y entrega un informe.
4. El usuario revisa con el informe y los gates. Si lo pide, Claude hace una revisión independiente de la rama.
5. El usuario fusiona la rama y se pasa al siguiente hito.

Los briefs son las órdenes de trabajo del agente y, a la vez, la primera prueba del formato que Batuta consumirá. Cuando Batuta funcione de extremo a extremo (hito 8), podrá tomar el relevo en los hitos siguientes y en la Fase 2.

### Convenciones técnicas

**Decididas por el usuario (restricciones):** TypeScript, núcleo y CLI delgada, funcionamiento en Windows y Linux, invocación de agentes por CLI headless y el resto de las decisiones de la sección 20.

**Recomendaciones iniciales.** El agente puede cambiarlas si lo justifica en el registro de decisiones:

- Módulos ES, Node 22 o superior y `npm workspaces`.
- Vitest para las pruebas y ESLint para el lint.
- Dependencias mínimas: `zod`, `yaml`, `commander`, `execa` y una utilidad para terminar árboles de procesos.
- Los efectos (procesos, Git, archivos, reloj) detrás de interfaces para poder simularlos, y la lógica de estado como funciones puras.
- Rutas con `node:path`, comandos sin shell y finales de línea normalizados.
- Subprocesos con entorno limpio y sin registrar variables de entorno ni secretos.
- Identificadores de ejecución con el formato `RUN-AAAA-MM-DD-NNN`.

**Registro de decisiones.** Cada decisión técnica relevante del agente se anota en `docs/decisiones/NNN-titulo.md`, con contexto, opciones, decisión y consecuencias en pocas líneas.

### Estructura del repositorio (propuesta inicial)

```
batuta/
  packages/
    core/
      src/   # schemas, config, events, state, exec, git, gates, runners, approvals, engine, report
    cli/
      src/
  docs/                        # diseño, specs y briefs de cada hito
  .github/workflows/ci.yml     # lint, tipos, tests y build en Linux y Windows
  AGENTS.md
```

### Hitos

Los hitos fijan el objetivo y el criterio de terminación. El agente puede proponer dividirlos o reordenarlos si lo justifica en el registro de decisiones.

| # | Hito | Contenido | Listo cuando |
|---|---|---|---|
| 0 | Andamiaje | Monorepo, TypeScript, Vitest, ESLint, CI en Linux y Windows, `AGENTS.md` | El CI pasa en ambos sistemas con una prueba de humo |
| 1 | Esquemas y configuración | Zod para `AgentInput`, `AgentOutput`, eventos, estado, plan y `batuta.yaml`; cargador de configuración | Los ejemplos válidos pasan y los inválidos fallan con errores claros |
| 2 | Registro de eventos y estado | `events.jsonl` de solo agregar, lector tolerante a una última línea cortada, reductor puro, `state.json` derivado y checkpoints | Reconstruir el estado desde los eventos da lo mismo que el checkpoint, y se recupera de un registro cortado |
| 3 | Comandos y gates | Ejecución sin shell con timeout, terminación del árbol de procesos, límite de salida y entorno limpio; ejecutor de gates con informe JSON; política de diff | Pruebas con comandos de prueba (`node -e`) en ambos sistemas: timeout, salida grande y código de salida |
| 4 | Git y worktrees | Crear y eliminar worktrees, commit por subtarea, retorno al último checkpoint y estadísticas de diff | Con repositorios temporales, la rama principal queda intacta tras un fallo y tras un aborto |
| 5 | Capa de agentes | Interfaz `AgentRunner`, `FakeRunner` guionado y `ClaudeCodeRunner` que arma el comando (modelo, turnos, presupuesto, permisos, esquema), valida la salida y cuenta tokens | Pruebas de construcción de comandos y de lectura de salidas grabadas, más una llamada real manual |
| 6 | Motor de flujo con agentes simulados | Máquina de estados completa con spec y plan escritos a mano, bucle de subtareas, reintentos y escalado, H0, H1 y H3 por archivo, límites, `NEEDS_INPUT` y reanudación | Escenarios de éxito, reintento, escalado, fallo, aborto y "matar y reanudar" en cada tipo de evento |
| 7 | CLI | `run`, `status`, `approve`, `resume` y `abort` | Un flujo completo con `FakeRunner` desde la terminal |
| 8 | Primera ejecución real | El `architect` genera la spec y el plan (solo lectura) y un implementador real con Claude Code trabaja sobre un repositorio de práctica | Una tarea trivial de extremo a extremo con gates reales |
| 9 | Piloto CuotaMoto | Repetir `brief-02` desde `42d205b` y comparar con el control manual | Se cumple el criterio de éxito de la sección 18 |

### Estrategia de pruebas

- Pruebas unitarias de la lógica pura: reductor, política de diff y construcción de comandos.
- Flujos completos con agentes simulados, incluido "matar y reanudar".
- Pruebas de integración con repositorios temporales de Git y comandos reales de prueba.
- CI en Linux y Windows desde el hito 0.
- Pruebas de contrato: las salidas reales de las herramientas se graban como ejemplos y se vuelven a leer en cada ejecución, para detectar cambios en las CLI headless.

### Riesgos de la codificación

| Riesgo | Mitigación |
|---|---|
| Las CLI headless cambian | Capa de agentes, pruebas de contrato y versión de la herramienta comprobada en el preflight |
| Terminar árboles de procesos en Windows | Se prueba pronto, en el hito 3 |
| El alcance crece | No se empieza un hito sin los gates del anterior en verde; lo que no esté en la tabla pasa a la Fase 2 |
| Las pruebas con modelos reales cuestan | Solo en los hitos 8 y 9, con límites de presupuesto bajos |

### Fuera de la Fase 1

Revisores independientes, enrutamiento por complejidad, avisos por Telegram, `batuta run --issue`, `batuta init`, Docker y VPS.

## 20. Decisiones

### Decididas

1. **Invocación de agentes:** todo por CLI headless en el MVP (sección 5).
2. **Dónde corre:** local al inicio y VPS pronto (sección 14).
3. **Ambigüedad:** preguntar una vez antes de codificar, suponer con registro después y bloquear solo en decisiones críticas (sección 4).
4. **Especificaciones vivas:** versión moderada en el repositorio (sección 3.3).
5. **Lenguaje:** TypeScript con núcleo y CLI delgada (sección 16).
6. **Avisos:** Telegram (sección 15).
7. **Origen de la tarea:** archivo `brief.md` en el MVP, issues en fases posteriores (sección 17).
8. **Autenticación:** claves de API por entorno, token de GitHub solo para Batuta y entorno mínimo para los agentes (sección 17).
9. **Modelos:** un modelo por llamada, nivel por rol, complejidad por subtarea y escalado en reintentos (sección 3.4).
10. **Proyecto piloto:** CuotaMoto, con tareas acotadas y verificables (sección 18).
11. **Compatibilidad:** Batuta debe funcionar en Windows (local) y en Linux (VPS) (sección 14).
12. **Proyecto nuevo:** `batuta init` y `SPEC-000` de fundación (sección 4).
13. **Modo de trabajo de la Fase 1:** Claude planifica el proyecto (diseño, hoja de ruta, hitos y criterios de aceptación); el agente de codificación decide el cómo, escribe el código y registra sus decisiones; la revisión la hace el usuario con los gates, y Claude bajo petición (sección 19).

### Abiertas

1. **Estrategia de `node_modules` con subtareas en paralelo** (Fase 3), descrita en la sección 18.
2. **Visibilidad del repositorio `batuta`** (público o privado): determina si Claude puede clonarlo para revisar cada hito o si la revisión se hace con informes y diffs pegados.

## 21. Registro de cambios

**v0.10**
- Corrige la v0.9: el agente de codificación decide el cómo y registra sus decisiones; Claude solo planifica el proyecto y revisa bajo petición. Las decisiones del usuario son las únicas restricciones.
- Las convenciones técnicas pasan a ser recomendaciones iniciales y los hitos pueden proponerse para dividirse o reordenarse.

**v0.9** (reemplazada por la v0.10)
- Decisión: Claude planifica, escribe los briefs y revisa; el agente de codificación escribe todo el código. Se documenta el ciclo de orquestación manual por hito.
- Pendiente: visibilidad del repositorio `batuta`.

**v0.8**
- Piloto: rama revisada y verificada, control manual de `brief-02` (commit `8322f5b`), base `42d205b` para la ejecución de Batuta y tres ajustes pendientes en la rama.
- Nueva sección 19: plan de codificación de la Fase 1 (convenciones, estructura, diez hitos, pruebas y riesgos).
- Fecha del encabezado corregida.

**v0.7**
- Proyecto piloto CuotaMoto: preparación verificada, línea base, configuración y criterio de éxito (sección 18).
- Configuración: `preparacion` y `entorno_gates`; preflight que compara la versión de Node con `engines`.
- Compatibilidad entre Windows (local) y Linux (VPS).
- Modo proyecto nuevo: `batuta init` y `SPEC-000`.
- Corregida la fecha del encabezado.

**v0.6**
- Decisión: un modelo por llamada, con rotación entre llamadas y no dentro de una.
- Nueva subsección de modelos por rol y reglas de enrutamiento: complejidad por subtarea, escalado en reintentos, respaldo con criterio, contexto por modelo y nombres completos.
- La configuración pasa a `alias_modelos` (modelo, precios y ventana de contexto por alias).
- Plan cerrado; solo falta elegir el proyecto piloto para empezar.

**v0.5**
- Decisiones: origen de la tarea por archivo en el MVP (issues en las fases 2 y 3) y modelo de autenticación.
- Nueva sección de origen de tarea y credenciales, con la regla de confianza para issues.
- Solo queda abierto el proyecto piloto.

**v0.4**
- Decisiones: local primero y VPS pronto, manejo de ambigüedad, TypeScript, especificaciones vivas moderadas y avisos por Telegram.
- Nuevas secciones de despliegue, notificaciones e implementación.
- Nuevos estados `NEEDS_INPUT` y `WAITING_INPUT`.
- Plantilla de spec con preguntas abiertas y specs afectadas.
- Siguen abiertas: proyecto piloto, origen de la tarea y autenticación.

**v0.3**
- Decisión: todos los agentes se invocan por CLI headless en el MVP, con una capa `AgentRunner` y adaptadores (Claude Code primero, OpenCode después, API directa como opción futura).
- Roles de solo lectura con permisos restringidos y roles de escritura con comandos permitidos.
- Tabla de precios propia para estimar el costo real y timeout aplicado por Batuta.

**v0.2** (aportes de la comparación con ForgeFlow Harness)
- Contratos `AgentInput` y `AgentOutput` con estado `NEEDS_CONTINUATION`, presupuesto y límite de pasos por agente.
- `state.json` y logs por paso, además del registro de eventos.
- Puerta H0 para aprobar el presupuesto al iniciar.
- Clasificación de riesgo de comandos y tiempo máximo por comando.
- Replanteo obligatorio de la estrategia antes del último intento.
- Plantilla de especificación ampliada con requisitos, pruebas requeridas y casos de borde.
- Se mantiene la reejecución de los gates por el motor: el autoinforme del agente no cuenta como prueba.

**v0.1:** primer borrador.
