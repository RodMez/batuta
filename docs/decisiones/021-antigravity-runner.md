# ADR 021 — Runner basado en Antigravity CLI (`agy`): permisos, entorno, cuota y límites de contención

- **Estado:** Propuesto (pendiente de revisión humana)
- **Fecha:** octubre de 2026
- **Relacionados:** 002 (Zod), 005 (roles), 007 (worktrees frente a Docker), 009 (modelo fijo por llamada), 010 (escalado), 011 (cero confianza en autoinformes), 012 (lock), 013 (árbol de procesos), 015 (política de diff), 016 (worktrees), 017 (capa de agentes y runner de Claude Code), 019 (motor de flujo)

## Contexto

La validación de extremo a extremo con Claude Code CLI a través de un proxy local hacia Gemini falló por tres causas: la suscripción Google AI Pro no otorga cuota de API (el free tier se agota en minutos con `HTTP 429`), `claude --bare` deshabilita las herramientas de edición, y el modo automático seguía pidiendo confirmaciones en headless.

Se evaluó el binario oficial `agy`, que usa la sesión OAuth de la suscripción del usuario. Las pruebas de humo y las verificaciones posteriores establecieron que:

- `agy` es un ejecutable nativo (`agy.exe`), invocable con `shell: false`.
- `--output-format json` y `--json-schema <archivo>` devuelven el resultado del agente en `structured_output`; el esquema real `AgentOutput` valida con `parseAgentOutput`.
- Hay dos bolsas de cuota independientes (Gemini y terceros: Claude/GPT), cada una con ventana semanal y ventana móvil de 5 horas. `agy -p /usage --output-format json` devuelve los buckets `gemini-weekly`, `gemini-5h`, `3p-weekly` y `3p-5h`, cada uno con `remaining_fraction` y `reset_time` (ISO 8601). Un caso real mostró `remaining_fraction = 0.0014`, que la tabla de texto redondea a "0%" aunque la cuenta seguía operando.
- `--sandbox` permite crear y modificar archivos en el workspace sin `--dangerously-skip-permissions`.
- **Prueba de contención de `--sandbox`:** dentro del sandbox, el agente (a) escribió con éxito en `../fuera.txt`, fuera del workspace; (b) leyó con éxito `../secreto-externo.txt`, fuera del workspace; (c) falló al ejecutar `node -v` con `connecting to sandbox server: EOF`. Solo se probaron rutas relativas con `../`; no se probaron rutas absolutas, aunque no hay motivo para esperar un comportamiento distinto.

## Decisión

1. **Runner oficial:** `AntigravityRunner` invoca solo el binario oficial `agy` mediante su CLI documentada. No se usan plugins ni wrappers que extraigan tokens OAuth (prohibido por los Términos de Servicio de Google).
2. **Permisos:** se usa siempre `--sandbox`; queda prohibido `--dangerously-skip-permissions`. Alcance real de `--sandbox`: restringe la ejecución de comandos de terminal (observado), pero **no confina el sistema de archivos**. No se considera un control de seguridad de disco.
3. **Proceso:** `spawn` con `shell: false` y argumentos como `string[]`, sin interpolación; `cwd` obligatorio dentro de `.batuta/worktrees/<RUN_ID>` (cualquier otro se rechaza); terminación del árbol de procesos por timeout según ADR 013.
4. **Entorno del subproceso:** lista blanca del motor (`PATH`, `PATHEXT`, `SystemRoot`, `ComSpec`, `TEMP`, `TMP`) más las variables de sesión según plataforma: en `win32`, `USERPROFILE`, `APPDATA` y `LOCALAPPDATA`; en el resto, `HOME`. La ampliación aplica **solo al runner**; los gates mantienen el entorno limpio más `entorno_gates`.
5. **Contrato de salida:** el runner ignora el `status` de nivel superior de `agy` (resultado de la CLI) y lee exclusivamente `structured_output`, validado con Zod. Ausente o inválido equivale a fallo del paso (ADR 002 y 011). El esquema se escribe a un archivo temporal y se pasa con `--json-schema <ruta>` para evitar problemas de escape en Windows.
6. **Prompts cortos y contexto en archivos:** el prompt enviado a `agy` contiene solo la instrucción puntual y las rutas a consultar (menos de ~500 caracteres), lejos del límite de línea de comandos de Windows. `spec.md`, `plan.json` y el feedback de los gates se escriben en `.batuta/contexto/` dentro del worktree. Ese directorio se añade a `.git/info/exclude` del worktree y se excluye explícitamente en `evaluarDiff`, para que no cuente como cambio del agente ni llegue al PR.
7. **Modelos configurables:** los nombres de modelo de `agy` viven en `batuta.yaml`, no en el código. Catálogo observado: `gemini-3.8-flash-high|medium|low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. El revisor usa `gpt-oss-120b-medium` para mantener revisión cruzada con otra familia.
8. **Cuota como señal determinista:**
   - Los buckets se parsean con `id: z.string()`, de modo que un identificador nuevo no rompe el parseo. Cada modelo se mapea a su par de buckets: Gemini → (`gemini-5h`, `gemini-weekly`); Claude/GPT → (`3p-5h`, `3p-weekly`).
   - **Proactiva:** antes de cada llamada se consulta `/usage`. Si alguno de los dos buckets del modelo tiene `remaining_fraction < umbral_cuota` (configurable, 0.05 por defecto), no se lanza la llamada: se emite `ejecucion_pausada_por_cuota` y el motor pasa a `WAITING_QUOTA`. La hora de reanudación es el `reset_time` **más tardío** entre los buckets que están bajo el umbral. La reanudación es con `batuta resume`; no cuenta como fallo de tarea.
   - **Reactiva:** ante cualquier salida no-cero de `agy`, el runner consulta `/usage` de inmediato; si algún bucket relevante cae bajo el umbral, se trata como pausa por cuota. Si `/usage` también falla, se lanza **error real**, no pausa.
9. **Capas de defensa tras cada paso del agente:** `evaluarDiff` (ADR 015), `rutas_prohibidas`, y verificación de que la rama `main` y el árbol de trabajo del usuario no cambiaron. Los gates se reejecutan siempre por el motor.
10. **Presupuesto:** cada invocación tiene una carga base de ~13k–25k tokens de entrada; la planificación de subtareas y las ventanas de 5 horas deben contarla.

## Límites de contención (declaración honesta)

El flag `--sandbox` restringe comandos de terminal, pero no impide lecturas ni escrituras fuera del `cwd` por rutas relativas. La protección de Batuta es una combinación de capas, y esas capas tienen límites que este ADR reconoce:

- **Lecturas fuera del worktree: sin control técnico.** El agente puede leer cualquier archivo accesible al usuario del sistema operativo. Dado que el worktree vive dentro del repositorio (`.batuta/worktrees/`), `../` alcanza el árbol raíz, incluidos archivos como `.env` ignorados por Git, y también la sesión OAuth en `~/.gemini/`. Lo que el agente lea pasa a su contexto y viaja al proveedor del modelo.
- **Escrituras fuera del worktree: detección parcial.** `evaluarDiff` y `rutas_prohibidas` solo ven el diff del worktree. La verificación de `main` y del árbol raíz (hash de `main`, `git status`) detecta cambios en archivos rastreados o nuevos sin ignorar, pero **no** en archivos ignorados por Git ni en rutas fuera del repositorio.
- **El bloqueo de terminal no es una garantía de diseño.** El error observado (`connecting to sandbox server: EOF`) podría deberse a un fallo del servidor del sandbox y no a una política estable. No se debe apoyar ninguna defensa en él.
- **Consecuencia práctica:** con terminal bloqueada, el agente no puede ejecutar pruebas por sí mismo. Los prompts no deben pedirle correr tests o comandos; la verificación corresponde exclusivamente a los gates del motor. El runner debe distinguir este error de fallos de otra naturaleza.
- **El entorno limpio no impide leer archivos:** limita lo que hereda el proceso, no lo que el agente puede abrir con sus herramientas de archivo.

**Riesgo residual aceptado para este hito.** Mitigación operativa: ejecutar Batuta solo sobre repositorios cuyo árbol raíz no contenga secretos de producción legibles (usar fixtures en `.env`). Mejoras a evaluar en un ADR posterior (no forman parte de este hito): ejecutar `agy` bajo un usuario del sistema operativo sin acceso a secretos, en contenedor o WSL (reabre la decisión del ADR 007), y ubicar los worktrees fuera del árbol del repositorio.

## Consecuencias

**Positivas**
- Sin API keys de pago; acceso a Gemini y a modelos de terceros bajo la suscripción.
- Salida estructurada nativa validada por Zod; sin parseo de texto libre.
- Pausas por cuota deterministas y reanudables, con hora de reanudación exacta, en lugar de fallos opacos.
- Comando de lanzamiento corto y portable (contexto en archivos).

**Negativas / riesgos aceptados**
- Dependencia de un binario de tercero y de sus nombres de modelo (mitigado con configuración y `batuta doctor`).
- Contención de disco débil (ver sección anterior).
- El entorno del runner expone `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` (o `HOME`), más amplio que el de los gates.
- La consulta de `/usage` consume una invocación adicional por paso; conviene cachearla en intervalos cortos.
- Latencias medidas (2–4 s) corresponden a prompts triviales; las tareas reales serán más lentas.

## Alternativas descartadas

- **Claude Code CLI + proxy hacia Gemini:** cuota gratuita insuficiente y herramientas de edición ausentes en `--bare`.
- **API de Gemini con facturación:** implica pago por token; contrario al objetivo de usar la suscripción existente.
- **`--dangerously-skip-permissions`:** innecesario; `--sandbox` cubre la escritura en el workspace sin omitir todos los permisos.
- **Wrappers comunitarios con tokens OAuth de Antigravity:** riesgo de suspensión permanente según los ToS.
- **Detectar cuota parseando mensajes de error:** frágil frente a `/usage` en JSON.

## Pendientes

1. **No verificado empíricamente (Linux/macOS):** que `agy` mantenga la sesión en `$HOME/.gemini/` y que `HOME` sea la única variable necesaria. Es una suposición hasta probar en un equipo real. El CI de Ubuntu solo cubre tests con ejecutable simulado.
2. **Decisión humana pendiente:** confirmar formalmente, leyendo los Términos de Servicio de Antigravity y de la suscripción, que el uso automatizado y desatendido del binario oficial cumple lo permitido. Hasta entonces no se da por resuelto.
3. **Por probar:** si el comportamiento del sandbox es el mismo con rutas absolutas, y si el error `connecting to sandbox server: EOF` es estable o intermitente.
4. **Opcional:** verificación de archivos ignorados relevantes del árbol raíz (por ejemplo, snapshot de ruta y fecha de modificación de `.env*`) para reducir el punto ciego de escrituras no rastreadas.
