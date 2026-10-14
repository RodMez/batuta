# ADR 021 — Runner basado en Antigravity CLI (`agy`): sandbox, entorno acotado y cuota explícita

- **Estado:** Propuesto (borrador, pendiente de completar con los puntos abiertos al implementar)
- **Fecha:** octubre de 2026
- **Relacionados:** ADR 002 (Zod), 005 (roles), 009 (modelo fijo por llamada), 010 (escalado), 011 (cero confianza en autoinformes), 012 (lock), 013 (árbol de procesos), 015 (política de diff)

## Contexto

La validación de extremo a extremo con Claude Code CLI a través de un proxy local hacia Gemini falló por tres causas: la suscripción Google AI Pro no otorga cuota de API (el free tier se agota en minutos con `HTTP 429`), `claude --bare` deshabilita las herramientas de edición, y el modo automático seguía pidiendo confirmaciones en headless.

Se evaluó el binario oficial `agy`, que usa la sesión OAuth de la suscripción del usuario. Cuatro pruebas de humo y cinco verificaciones posteriores confirmaron que:

- `agy` es un ejecutable nativo (`agy.exe`), invocable con `shell: false`.
- `--output-format json` y `--json-schema <archivo>` devuelven el resultado del agente en `structured_output`, y el esquema real `AgentOutput` valida con `parseAgentOutput`.
- Existen dos bolsas de cuota independientes (Gemini y terceros: Claude/GPT), cada una con ventana semanal y ventana móvil de 5 horas, consultables con `agy -p /usage --output-format json` (`remaining_fraction` y `reset_time` en ISO 8601).
- `--sandbox` permite crear y modificar archivos en el workspace sin `--dangerously-skip-permissions`.

## Decisión

1. **Runner único oficial:** `AntigravityRunner` invoca solo el binario oficial `agy` mediante su CLI documentada. No se usan plugins ni wrappers que extraigan tokens OAuth (prohibido por los Términos de Servicio de Google).
2. **Permisos:** se usa siempre `--sandbox`. Queda prohibido `--dangerously-skip-permissions`.
3. **Aislamiento de proceso:**
   - `spawn` con `shell: false` y argumentos como `string[]` (sin interpolación).
   - `cwd` obligatorio dentro de `.batuta/worktrees/<RUN_ID>`; cualquier otro `cwd` se rechaza.
   - Terminación del árbol de procesos por timeout según ADR 013.
4. **Entorno del subproceso:** lista blanca del motor (`PATH`, `PATHEXT`, `SystemRoot`, `ComSpec`, `TEMP`, `TMP`) más `USERPROFILE`, `APPDATA` y `LOCALAPPDATA`, necesarias para localizar la sesión OAuth en `~/.gemini/`. La ampliación aplica **solo al runner**; los gates mantienen el entorno limpio más `entorno_gates`.
5. **Contrato de salida:** el runner ignora el `status` de nivel superior de `agy` (resultado de la CLI) y lee exclusivamente `structured_output`, validado con Zod. Ausente o inválido equivale a fallo del paso (ADR 002 y 011).
6. **Esquema por archivo:** el JSON Schema se escribe a un archivo temporal y se pasa con `--json-schema <ruta>`, para evitar problemas de escape en la shell de Windows.
7. **Modelos configurables:** los nombres de modelo de `agy` viven en `batuta.yaml`, no en el código. Catálogo observado: `gemini-3.8-flash-high|medium|low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. El revisor usa `gpt-oss-120b-medium` para mantener la revisión cruzada con otra familia.
8. **Cuota como señal determinista:**
   - Antes de cada llamada se consulta `/usage` en JSON; si `remaining_fraction` del bucket relevante es menor que `umbral_cuota` (configurable), no se lanza la llamada.
   - Se emite `ejecucion_pausada_por_cuota` con el `reset_time` y el motor pasa a `WAITING_QUOTA`. La reanudación es con `batuta resume`; no cuenta como fallo de tarea.
   - Una caída por agotamiento durante una llamada se trata igualmente como pausa (formato del fallo por confirmar).
9. **Defensas obligatorias tras cada paso:** `evaluarDiff` (ADR 015), `rutas_prohibidas`, y verificación de que `main` y el árbol de trabajo del usuario no cambiaron. Los gates se reejecutan siempre por el motor.
10. **Presupuesto:** cada invocación tiene una carga base de ~13k–25k tokens de entrada; la planificación de subtareas y las ventanas de 5 horas deben contarla.

## Consecuencias

**Positivas**
- Sin API keys de pago; acceso a Gemini y a modelos de terceros bajo la suscripción.
- Salida estructurada nativa, validada por Zod; sin parseo de texto libre.
- Pausas por cuota deterministas y reanudables en lugar de fallos opacos.
- Superficie de ejecución menor que con permisos omitidos por completo.

**Negativas / riesgos aceptados**
- Dependencia de un binario de un tercero y de sus nombres de modelo (mitigado con configuración y `batuta doctor`).
- El worktree aísla la rama, no el disco. `--sandbox` restringe el terminal, pero su alcance exacto no está totalmente caracterizado (ver pendientes); la defensa real combina `cwd`, sandbox, auditoría de diff y verificación de `main`.
- El entorno del runner expone al agente `USERPROFILE`, `APPDATA` y `LOCALAPPDATA`, más amplio que el de los gates.
- La consulta de `/usage` consume una invocación adicional.
- Latencias medidas (2–4 s) corresponden a prompts triviales; tareas reales serán más lentas.

## Alternativas descartadas

- **Claude Code CLI + proxy hacia Gemini:** cuota gratuita insuficiente y herramientas de edición ausentes en `--bare`.
- **API de Gemini con facturación:** implica pago por token; contrario al objetivo de usar la suscripción existente.
- **`--dangerously-skip-permissions`:** innecesario dado que `--sandbox` cubre el caso de escritura en el workspace.
- **Wrappers comunitarios con tokens OAuth de Antigravity:** riesgo de suspensión permanente de la cuenta según los ToS.
- **Parsear mensajes de error de consola para detectar cuota:** frágil frente a `/usage` en JSON.

## Pendientes por resolver durante la implementación

1. Formato exacto del fallo por cuota agotada (exit code, `status`, mensaje) y fixture correspondiente.
2. Alcance real de `--sandbox`: escritura fuera del `cwd`, lectura fuera del worktree, comandos permitidos (por ejemplo, si el agente puede ejecutar `npm test`).
3. Prompts largos en Windows (límite de línea de comandos): stdin, archivo o referencia a un archivo en el worktree.
4. Variables de entorno equivalentes en Linux/macOS (`HOME`, etc.); hasta verificarlo, el soporte POSIX real queda sin garantizar.
5. Confirmación de que el uso automatizado y desatendido del binario oficial con una suscripción de consumo cumple los Términos de Servicio de Google.
6. `id` reales de los buckets de `/usage` (solo se conoce `3p-weekly`).
