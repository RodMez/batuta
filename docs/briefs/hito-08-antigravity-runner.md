# Brief — Hito 8: `AntigravityRunner` (runner sobre Google Antigravity CLI)

> Rama: `feat/antigravity-runner` · Base: `main` · ADR asociado: `021` (`docs/decisiones/021-antigravity-runner.md`)
> Lee antes: `AGENTS.md`, `04_LECCIONES_Y_GUARDARRAILES.md`, ADR 002, 009, 010, 011, 012, 013.

---

## 1. Objetivo

Implementar en `@batuta/core` un runner que ejecute cada paso de agente invocando el binario oficial `agy` en modo headless, usando la suscripción Google AI Pro del usuario (sin API keys de pago), y conectarlo al `FlowEngine` sin modificar la lógica determinista del motor.

El runner es un **adaptador**: no decide flujo, no confía en el autoinforme del modelo (ADR 011) y no reintenta por su cuenta; eso sigue siendo responsabilidad del motor.

## 2. Contexto verificado (pruebas de humo, octubre 2026)

| Hecho | Detalle |
|---|---|
| Binario | `agy.exe` nativo en `~\AppData\Local\agy\bin\`; se lanza con `shell: false` |
| Modo headless | `agy -p "<prompt>" --output-format json` |
| Modelos (`agy models`) | `gemini-3.8-flash-high/medium/low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium` |
| Salida estructurada | `--json-schema <ruta-archivo.json>` puebla `structured_output`; el esquema se pasa **por archivo**, no inline (escapes de comillas en Windows) |
| Contrato real | El esquema `AgentOutputJsonSchema` (derivado de Zod) fue poblado completo y validado por `parseAgentOutput` sin errores |
| `status` de nivel superior | Es el resultado de la CLI, **no** del agente. Se ignora |
| Permisos | `--sandbox` permite crear/modificar archivos en el workspace sin `--dangerously-skip-permissions`. Restringe la terminal (`node -v` falla con `connecting to sandbox server: EOF`) pero **no confina el disco**: se verificó lectura y escritura fuera del `cwd` con `../` |
| Entorno | Además de `PATH`, `PATHEXT`, `SystemRoot`, `ComSpec`, `TEMP`, `TMP`, requiere `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` (sesión OAuth en `~/.gemini/`) |
| Cuota | `agy -p /usage --output-format json` devuelve buckets con `id`, `remaining_fraction` (0.0–1.0) y `reset_time` (ISO 8601). Ejemplo visto: `id: "3p-weekly"`, `remaining_fraction: 0.0014` |
| Coste base | ~13k–25k tokens de entrada por invocación |

## 3. Alcance

### Incluido
1. `AntigravityRunner` implementando la interfaz `AgentRunner` **tal como existe hoy en el código** (el doc de diseño menciona `ejecutarPaso`/`runTask`; manda el código, no el doc).
2. Construcción de argumentos como `string[]`, sin interpolación en shell (`04_LECCIONES §1`).
3. Escritura del JSON Schema a un archivo temporal por llamada, y limpieza posterior.
4. Parseo: leer solo `structured_output` y validar con `parseAgentOutput` (Zod). Si falta o no valida → error tipado, no éxito.
5. Entorno del subproceso: lista blanca del motor + variables de sesión según plataforma (`process.platform === 'win32'` → `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`; en el resto → `HOME`), **solo para el runner** (los gates conservan su entorno limpio + `entorno_gates`).
6. `cwd` obligatorio dentro de `.batuta/worktrees/<RUN_ID>`; el runner rechaza cualquier otro `cwd`.
6b. Prompts cortos (<~500 caracteres): solo la instrucción puntual y las rutas a consultar. `spec.md`, `plan.json` y el feedback de gates se escriben en `.batuta/contexto/` dentro del worktree, añadido a `.git/info/exclude` del worktree y excluido explícitamente en `evaluarDiff`.
7. Flag `--sandbox` siempre presente. **Nunca** `--dangerously-skip-permissions`.
8. Timeout propio (`timeoutMs`, por defecto 5 min) con terminación del árbol de procesos según ADR 013 (`taskkill /T /F` en Windows; grupo de procesos en POSIX).
9. Módulo de cuota: función que consulta `/usage` en JSON y devuelve buckets tipados con Zod.
10. Pausa por cuota: nuevo evento `ejecucion_pausada_por_cuota` (con `reset_time`) y estado `WAITING_QUOTA`; la reanudación sigue siendo `batuta resume`.
11. Extensión de `batuta.yaml` (Zod) para mapear roles/complejidad a nombres de modelo de `agy` y configurar el runner.
12. Tests (ver §7) y ADR 021 registrado en `docs/decisiones/`.

### Fuera de alcance
- Reanudación automática con timer (solo se deja el `reset_time` registrado).
- Cambios en gates, política de diff o worktrees, salvo que una prueba revele un bug.
- Soporte de otros runners.
- Cualquier plugin o wrapper de terceros que extraiga tokens OAuth (prohibido por ToS de Google; solo el binario oficial).

## 4. Configuración (`batuta.yaml`)

```yaml
runner:
  tipo: "antigravity"
  bin_path: "agy"                # resoluble por PATH o ruta absoluta
  timeout_seg: 300
  umbral_cuota: 0.05             # pausar si remaining_fraction del bucket relevante < umbral
  sandbox: true                  # no configurable a false en este hito

modelos:
  scout: "gemini-3.8-flash-low"
  architect: "claude-sonnet-4-6"
  implementer:
    baja_complejidad: "gemini-3.8-flash-medium"
    media_complejidad: "claude-sonnet-4-6"
    alta_complejidad: "claude-opus-4-6-thinking"
  debugger: "claude-opus-4-6-thinking"
  reviewer: "gpt-oss-120b-medium"
```

Los nombres son configuración, **no** constantes en el runner. El comando `batuta doctor` debe poder contrastarlos con `agy models`.

## 5. Gestión de cuota

- **Proactiva:** antes de cada llamada, consultar `/usage` en JSON. Si el bucket del modelo a usar tiene `remaining_fraction < umbral_cuota`, no lanzar la llamada: emitir `ejecucion_pausada_por_cuota` con el `reset_time` del bucket y pasar a `WAITING_QUOTA`. El caso real de 0,14 % restante demuestra que redondear o comparar contra cero es insuficiente.
- **Reactiva:** ante cualquier salida no-cero de `agy`, consultar `/usage` de inmediato; si algún bucket relevante cae bajo el umbral, es pausa y no error de tarea. Si `/usage` también falla, es **error real**, no pausa. No se depende del formato del mensaje de error.
- Buckets conocidos: `gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h`. El esquema Zod usa `id: z.string()` (un `id` nuevo no debe romper el parseo). Cada modelo se mapea a su par: Gemini → (`gemini-5h`, `gemini-weekly`); Claude/GPT → (`3p-5h`, `3p-weekly`). Guardar la respuesta real de `/usage` como fixture.
- Si algún bucket del par está bajo el umbral, se pausa hasta el `reset_time` **más tardío** entre los que están bajo el umbral.
- La consulta de `/usage` consume una invocación de `agy`; cachear el resultado por un intervalo corto dentro de un mismo paso.

## 6. Seguridad (obligatorio)

**Hallazgo clave:** `--sandbox` restringe la terminal pero **no confina el sistema de archivos**; el agente pudo leer y escribir fuera del `cwd` con `../`. La protección es por capas y tiene límites que el ADR 021 declara.

1. `shell: false` y argumentos como arreglo, siempre.
2. `cwd` = worktree del run, verificado con ruta normalizada a `/`. Es necesario pero **no suficiente**: no impide acceder a rutas fuera del worktree.
3. `--sandbox` siempre; nunca `--dangerously-skip-permissions`. No tratarlo como control de disco. El bloqueo de terminal observado puede ser un fallo del servidor del sandbox y no una política estable, así que ninguna defensa se apoya en él. Consecuencia: el agente no puede ejecutar comandos; los prompts no deben pedirle correr tests, y el runner debe distinguir el error `connecting to sandbox server: EOF` de otros fallos.
4. Tras cada paso, el motor ejecuta `evaluarDiff` y `rutas_prohibidas` (solo ven el worktree) y verifica que `main` y el árbol raíz no cambiaron (hash de `main` y `git status` del árbol raíz). **Límite conocido:** no detectan escrituras en archivos ignorados por Git (p. ej. `.env`) ni fuera del repositorio.
5. `.batuta/contexto/` excluido de `evaluarDiff` y de Git (ver §3, 6b).
6. El entorno ampliado se aplica solo al subproceso `agy`. Un entorno limpio no impide que el agente lea archivos con sus herramientas.
7. El texto devuelto por el modelo es informativo; los gates se reejecutan por el motor (ADR 011).
8. Registrar en `events.jsonl` los argumentos usados (sin el prompt completo si contiene datos sensibles) y el uso de tokens reportado.
9. Riesgo residual aceptado: lecturas fuera del worktree sin control técnico (incluye `.env` del árbol raíz y la sesión en `~/.gemini/`). Operativamente, usar Batuta solo sobre repos sin secretos de producción legibles. Mejoras (usuario de SO aislado, contenedor/WSL, worktrees fuera del repo) quedan para un ADR posterior.

## 7. Pruebas requeridas

**Unitarias (sin invocar `agy` real):** un ejecutable falso inyectable (`binPath`) que simule:
- éxito con `structured_output` válido;
- `structured_output` ausente o inválido → error tipado;
- `status` de nivel superior `SUCCESS` con `structured_output` inválido → debe fallar;
- salida con cuota agotada → pausa, no fallo;
- timeout → árbol de procesos terminado, sin huérfanos;
- construcción de argumentos: inyección en prompt/ruta no altera el arreglo ni usa shell;
- entorno: contiene exactamente la lista blanca + las tres variables, y ninguna otra del padre;
- `cwd` fuera del worktree → rechazo;
- parseo de `/usage` con fixtures reales (incluyendo `0.0014`) y con un `id` de bucket desconocido (no debe romper);
- ambos buckets del par bajo el umbral → se usa el `reset_time` más tardío;
- salida no-cero con `/usage` bajo umbral → pausa; salida no-cero con `/usage` sano → error; `/usage` fallando → error real;
- `.batuta/contexto/` no aparece en `evaluarDiff` ni en el diff del worktree;
- el entorno incluye `HOME` en plataformas no Windows y las tres variables en `win32` (parametrizar `process.platform`).

**De integración (marcada y omitida por defecto, ejecutable manualmente):** una llamada real a `gemini-3.8-flash-low` que cree un archivo dentro de un worktree desechable.

Normalizar CRLF/LF y rutas en las aserciones (CI en Ubuntu y Windows).

## 8. Estado de los puntos abiertos

| # | Tema | Estado |
|---|---|---|
| 1 | Cuota reactiva | **Resuelto:** consulta a `/usage` tras salida no-cero; no depende del formato del error |
| 2 | Alcance de `--sandbox` | **Verificado, con hallazgo:** restringe terminal; no confina disco (ver §6) |
| 3 | Prompts largos en Windows | **Resuelto:** prompt corto + contexto en `.batuta/contexto/` |
| 4 | Linux/macOS | **No verificado:** `$HOME/.gemini/` es una suposición; el CI de Ubuntu solo cubre tests con ejecutable simulado |
| 5 | Buckets de `/usage` | **Resuelto:** cuatro buckets conocidos; esquema tolerante |
| 6 | Términos de Servicio | **Decisión humana pendiente:** confirmar formalmente antes de uso intensivo |

Pendientes menores: probar si el sandbox se comporta igual con rutas absolutas y si el error de terminal es estable o intermitente.

## 9. Criterios de aceptación

- [ ] `npm run verify` en verde (lint, typecheck, tests, build) en Windows y en el CI de Ubuntu.
- [ ] Ninguna llamada a `exec` con cadenas interpoladas; todo `spawn` con arreglo y `shell: false`.
- [ ] `--dangerously-skip-permissions` no aparece en el código salvo en tests que verifican su ausencia.
- [ ] El runner devuelve datos solo de `structured_output` validado por Zod.
- [ ] `ejecucion_pausada_por_cuota` emitido con `reset_time`; `batuta resume` reanuda correctamente (test con motor y ejecutable falso).
- [ ] `batuta.yaml` de ejemplo actualizado y validado por el esquema; modelos no hardcodeados.
- [ ] ADR 021 incorporado en `docs/decisiones/` y consistente con lo implementado (si el código se aparta del ADR, actualizar el ADR).
- [ ] Documentado el límite de contención de `--sandbox` y el riesgo residual en el ADR y en el README del runner.
- [ ] Una corrida manual end-to-end documentada (brief → spec → plan → una subtarea → gates) con tokens consumidos por paso.

## 10. Entrega

- Commits pequeños y atómicos, Conventional Commits (`feat(core):`, `test(core):`, `docs:`).
- Decisiones de bajo nivel no especificadas aquí: registrarlas como ADR (017+), sin ampliar el alcance.
- Si surge una decisión crítica o destructiva no cubierta: detenerse y devolver `NEEDS_INPUT`.
- PR hacia `main`; la fusión (H3) la aprueba el humano tras revisión independiente desde clon limpio.
