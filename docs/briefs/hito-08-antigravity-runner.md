# Brief — Hito 8: `AntigravityRunner` (runner sobre Google Antigravity CLI)

> Rama: `feat/antigravity-runner` · Base: `main` · ADR asociado: `021`
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
| Permisos | `--sandbox` permite crear/modificar archivos en el workspace sin `--dangerously-skip-permissions` |
| Entorno | Además de `PATH`, `PATHEXT`, `SystemRoot`, `ComSpec`, `TEMP`, `TMP`, requiere `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` (sesión OAuth en `~/.gemini/`) |
| Cuota | `agy -p /usage --output-format json` devuelve buckets con `id`, `remaining_fraction` (0.0–1.0) y `reset_time` (ISO 8601). Ejemplo visto: `id: "3p-weekly"`, `remaining_fraction: 0.0014` |
| Coste base | ~13k–25k tokens de entrada por invocación |

## 3. Alcance

### Incluido
1. `AntigravityRunner` implementando la interfaz `AgentRunner` **tal como existe hoy en el código** (el doc de diseño menciona `ejecutarPaso`/`runTask`; manda el código, no el doc).
2. Construcción de argumentos como `string[]`, sin interpolación en shell (`04_LECCIONES §1`).
3. Escritura del JSON Schema a un archivo temporal por llamada, y limpieza posterior.
4. Parseo: leer solo `structured_output` y validar con `parseAgentOutput` (Zod). Si falta o no valida → error tipado, no éxito.
5. Entorno del subproceso: lista blanca del motor + `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, **solo para el runner** (los gates conservan su entorno limpio + `entorno_gates`).
6. `cwd` obligatorio dentro de `.batuta/worktrees/<RUN_ID>`; el runner rechaza cualquier otro `cwd`.
7. Flag `--sandbox` siempre presente. **Nunca** `--dangerously-skip-permissions`.
8. Timeout propio (`timeoutMs`, por defecto 5 min) con terminación del árbol de procesos según ADR 013 (`taskkill /T /F` en Windows; grupo de procesos en POSIX).
9. Módulo de cuota: función que consulta `/usage` en JSON y devuelve buckets tipados con Zod.
10. Pausa por cuota: nuevo evento `ejecucion_pausada_por_cuota` (con `reset_time`) y estado `WAITING_QUOTA`; la reanudación sigue siendo `batuta resume`.
11. Extensión de `batuta.yaml` (Zod) para mapear roles/complejidad a nombres de modelo de `agy` y configurar el runner.
12. Tests (ver §7) y ADR 021 registrado en el repo.

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
- **Reactiva:** si una llamada falla por agotamiento, tratar el fallo como pausa y no como error de tarea. Esto exige conocer el formato real del fallo (ver §8, punto 1).
- Los buckets se identifican por `id`. Solo se conoce `3p-weekly` (Claude/GPT, semanal); el implementador debe enumerar los `id` reales de las ventanas de 5 horas y de Gemini y guardar la respuesta como fixture.
- La consulta de `/usage` consume una invocación de `agy`; cachear el resultado por un intervalo corto dentro de un mismo paso.

## 6. Seguridad (obligatorio)

1. `shell: false` y argumentos como arreglo, siempre.
2. `cwd` = worktree del run; verificar con ruta normalizada a `/`.
3. Tras cada paso del agente, el motor ejecuta `evaluarDiff` y `rutas_prohibidas` (ya existen; el runner no debe omitirlos ni duplicarlos).
4. Tras cada paso, comprobar que `main` y el árbol de trabajo del usuario no cambiaron (hash de `main` y `git status` del árbol raíz).
5. El texto devuelto por el modelo es informativo; los gates se reejecutan por el motor (ADR 011).
6. El entorno ampliado se aplica solo al subproceso `agy`.
7. Registrar en `events.jsonl` los argumentos usados (sin el prompt completo si contiene datos sensibles) y el uso de tokens reportado.

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
- parseo de `/usage` con fixtures reales (incluyendo `0.0014`).

**De integración (marcada y omitida por defecto, ejecutable manualmente):** una llamada real a `gemini-3.8-flash-low` que cree un archivo dentro de un worktree desechable.

Normalizar CRLF/LF y rutas en las aserciones (CI en Ubuntu y Windows).

## 8. Puntos abiertos que el implementador debe resolver y documentar en el ADR

1. **Formato exacto del fallo por cuota agotada** (exit code, `status`, mensaje). Provocarlo o localizarlo en documentación y guardar fixture. Sin esto la pausa reactiva no es confiable.
2. **Alcance real de `--sandbox`:** verificar con una prueba manual si impide escribir fuera del `cwd`, leer fuera del worktree o ejecutar ciertos comandos (por ejemplo `npm test` lanzado por el propio agente). Documentar lo que **no** protege.
3. **Prompts largos en Windows:** el límite de línea de comandos (~32k caracteres) puede romperse con spec + plan + feedback de gates. Comprobar si `agy` acepta prompt por stdin o por archivo; si no, definir una estrategia (por ejemplo, escribir el contexto en un archivo dentro del worktree y referenciarlo en el prompt) y documentarla.
4. **POSIX:** solo se verificó Windows. Definir qué variables del equivalente (`HOME`, etc.) necesita `agy` en Linux; si no se puede verificar, dejarlo como pendiente explícito y que el CI de Ubuntu cubra únicamente los tests con ejecutable falso.
5. **Términos de servicio:** confirmar que el uso automatizado y desatendido del binario oficial con suscripción de consumo está permitido. Si hay duda, anotarla en el ADR; la decisión es del humano.

## 9. Criterios de aceptación

- [ ] `npm run verify` en verde (lint, typecheck, tests, build) en Windows y en el CI de Ubuntu.
- [ ] Ninguna llamada a `exec` con cadenas interpoladas; todo `spawn` con arreglo y `shell: false`.
- [ ] `--dangerously-skip-permissions` no aparece en el código salvo en tests que verifican su ausencia.
- [ ] El runner devuelve datos solo de `structured_output` validado por Zod.
- [ ] `ejecucion_pausada_por_cuota` emitido con `reset_time`; `batuta resume` reanuda correctamente (test con motor y ejecutable falso).
- [ ] `batuta.yaml` de ejemplo actualizado y validado por el esquema; modelos no hardcodeados.
- [ ] ADR 021 completado con el resultado de los puntos abiertos de §8.
- [ ] Una corrida manual end-to-end documentada (brief → spec → plan → una subtarea → gates) con tokens consumidos por paso.

## 10. Entrega

- Commits pequeños y atómicos, Conventional Commits (`feat(core):`, `test(core):`, `docs:`).
- Decisiones de bajo nivel no especificadas aquí: registrarlas como ADR (017+), sin ampliar el alcance.
- Si surge una decisión crítica o destructiva no cubierta: detenerse y devolver `NEEDS_INPUT`.
- PR hacia `main`; la fusión (H3) la aprueba el humano tras revisión independiente desde clon limpio.
