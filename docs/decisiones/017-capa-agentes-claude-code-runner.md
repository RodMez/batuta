# ADR 017: Capa de agentes, FakeRunner y adaptador ClaudeCodeRunner

## Contexto
El hito 5 dota a Batuta de la capacidad de invocar agentes de IA mediante una CLI headless (`claude`), aislando permisos, controlando costos y turnos, validando salidas estructuradas y registrando la actividad de forma segura.

## Opciones consideradas
1. **Llamadas directas por API / SDK (`@anthropic-ai/sdk`)**:
   - Ofrece control directo de peticiones, pero viola la restricción arquitectónica del MVP (sección 20 de `docs/diseno.md`), que exige utilizar la CLI headless de Claude Code para aprovechar sus herramientas nativas (lectura, edición, bash) y preparar el terreno para OpenCode en la Fase 2.
2. **Invocación de la CLI headless mediante `EjecutorComandos.ejecutarArgs`**:
   - Cumple con la regla de diseño v0.16 de invocación por vector de argumentos sin interpolación de comandos.
   - Oculta las particularidades de la herramienta detrás de la interfaz inyectable `AgentRunner`.

## Decisión
Se implementan `AgentRunner`, `FakeRunner` y `ClaudeCodeRunner` en `@batuta/core` con las siguientes decisiones:

1. **Versión de la CLI documentada y ausencia de `--max-turns`**:
   - Se trabaja y verifica contra **Claude Code 2.1.282**.
   - Tras comprobar las opciones con `claude --help`, se constata que Claude Code **no dispone del flag `--max-turns`**. Evaluar los turnos únicamente al finalizar la ejecución no limita el gasto ni el tiempo durante la ejecución activa.

2. **Límite de turnos real mediante streaming y terminación de procesos**:
   - Se utiliza la salida en streaming: `--output-format stream-json`.
   - **Requisito de la CLI**: al combinar `-p` / `--print` con `--output-format=stream-json`, Claude Code exige de forma obligatoria el flag `--verbose` (de lo contrario aborta con `Error: When using --print, --output-format=stream-json requires --verbose`).
   - El ejecutor de comandos procesa la salida línea por línea en tiempo real (`onStdoutLine`). Cada evento de respuesta del asistente (`type: "assistant"`) incrementa el conteo de pasos del agente.
   - Al superar `pasos_por_agente` (`maxSteps`), Batuta termina inmediatamente el árbol de procesos del subproceso (`matarArbolProcesos`) y devuelve `motivoFallo: "turnos_agotados"`.
   - Se mantienen el tope de gasto en dólares (`--max-budget-usd`) y el timeout de ejecución en milisegundos (`timeoutMs`).

3. **Aislamiento de la configuración del usuario y modo `--bare`**:
   - Por defecto, Claude Code carga configuraciones del usuario (`~/.claude.json`), memoria persistente, archivos `CLAUDE.md`, hooks de plugins y permisos locales, lo que vulneraría el principio de entorno limpio y aislamiento.
   - Se incorpora el flag `--bare` en la invocación:
     - Omite hooks de plugins y configuraciones de usuario, LSP, sincronización de plugins y memoria.
     - No lee archivos `CLAUDE.md` del usuario ni del proyecto.
   - El contexto del repositorio y las directivas de rol se suministran de forma explícita mediante `--append-system-prompt` (o `--system-prompt`).
   - **Autenticación en modo `--bare` y proxy local (`ANTHROPIC_BASE_URL`)**:
     - Con `--bare`, Claude Code restringe la autenticación exclusivamente a variables de entorno (`ANTHROPIC_API_KEY`) o `apiKeyHelper` mediante `--settings`. Las sesiones interactivas OAuth y los llaveros del sistema nunca se consultan.
     - Para entornos donde el usuario canaliza el tráfico del modelo a través de un proxy o gateway local (por ejemplo `http://127.0.0.1:1337`), se define `variables_modelo: [ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL]`. Al figurar en la lista blanca de variables del modelo en el entorno limpio, `ANTHROPIC_BASE_URL` se reenvía al subproceso de Claude Code, redirigiendo las peticiones al proxy local de forma transparente sin alterar la máquina del desarrollador.

4. **Definición explícita de herramientas según rol**:
   - *Roles de solo lectura* (`scout`, `architect`, revisores): se configuran exclusivamente con herramientas de inspección (`--tools "Read,Grep,Glob"`), sin capacidad de editar archivos ni ejecutar comandos Bash.
   - *Roles con escritura* (`software-engineer`, `debugger`): se declara el conjunto de herramientas disponibles con `--tools "Bash,Edit,Write,Read,Grep,Glob"`. Si la configuración define `comandosPermitidos`, se delimitan además los comandos Bash autorizados mediante `--allowed-tools "Read Grep Glob Edit Write Bash(cmd1) Bash(cmd2)..."`.

5. **Entorno limpio y `variables_modelo`**:
   - El proceso se ejecuta en un entorno filtrado (`construirEntornoLimpio`) que contiene solo la lista blanca básica del sistema operativo más los nombres de variables especificados en `variables_modelo` de `batuta.yaml`. Ningún otro secreto del entorno del usuario es transferido al subproceso.

6. **Regla de contrato y reintento único**:
   - La salida se valida contra `AgentOutputSchema` con Zod. Si el formato o contenido es inválido, se reintenta exactamente una vez adjuntando el mensaje de error de validación. Si el segundo intento falla, se devuelve `motivoFallo: "salida_invalida"`.

7. **Estimación determinista de costos**:
   - El costo se calcula a partir de los tokens de entrada y salida consumidos y la tabla de precios del alias (`alias_modelos`). Si el alias no define precios, se reporta explícitamente como desconocido (`desconocido: true, montoUsd: null`).

8. **Protección de credenciales en logs**:
   - Antes de escribir el log de la llamada en disco (`.batuta/runs/<run_id>/logs/`), se aplica `ofuscarSecretos`, reemplazando claves de API (OpenAI, Anthropic), tokens (GitHub, Slack), credenciales AWS y bloques de claves privadas por `[REDACTADO]`.

9. **Ejemplos de salidas sintéticos y captura real**:
   - Los fixtures de prueba unitaria sin conexión a red se ubican en `packages/core/test/fixtures/claude-outputs/sinteticos/` con notas explícitas de su naturaleza sintética.
   - Se provee el comando manual `npm run capturar-claude` (aislado de `npm run verify`) para generar capturas reales en `fixtures/claude-outputs/reales/` en repositorios desechables una vez configuradas las credenciales de modelo o proxy.

## Consecuencias
- **Positivas**: Interfaz agnóstica `AgentRunner` que permite simular ejecuciones instantáneas con `FakeRunner` y operar en producción con `ClaudeCodeRunner`; guardarraíles estrictos de seguridad y costos; límite real de turnos mediante terminación activa del subproceso; aislamiento hermético con `--bare` y compatibilidad con proxies locales vía `ANTHROPIC_BASE_URL`.
- **Negativas**: Requiere que el entorno del sistema disponga del ejecutable `claude` en el PATH y que variables requeridas figuren en `variables_modelo`.
