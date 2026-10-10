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

1. **Versión de la CLI documentada**:
   - Se trabaja y verifica contra **Claude Code 2.1.282**.

2. **Construcción pura de invocación (`construirInvocacionClaudeCode`)**:
   - Parámetros por vector de argumentos:
     - `-p` / `--print`: ejecución no interactiva.
     - `--output-format json`: entrega de resultado en formato estructurado JSON.
     - `--no-session-persistence`: evita guardar sesiones persistentes en disco.
     - `--model <modelo>`: modelo resuelto con nombre completo.
     - `--max-budget-usd <usd>`: tope de gasto pasado como argumento.
     - `--json-schema <esquema>`: esquema JSON de `AgentOutput` para validación forzada en la herramienta.
     - `--tools` / `--allowed-tools`: aislamiento estricto de herramientas según rol.

3. **Permisos según el rol**:
   - *Roles de solo lectura* (`scout`, `architect`, revisores): se configuran exclusivamente con herramientas de inspección (`--tools "Read,Grep,Glob"`), sin capacidad de editar archivos ni ejecutar comandos Bash.
   - *Roles con escritura* (`software-engineer`, `debugger`): se habilitan herramientas de edición (`Read, Grep, Glob, Edit, Write`) y se limitan los comandos ejecutables con `--allowed-tools` a la lista blanca de `comandosPermitidos`.

4. **Entorno limpio y `variables_modelo`**:
   - El proceso se ejecuta en un entorno filtrado (`construirEntornoLimpio`) que contiene solo la lista blanca básica del sistema operativo más los nombres de variables especificados en `variables_modelo` de `batuta.yaml` (ej. `ANTHROPIC_API_KEY`). Ningún otro secreto del entorno del usuario es transferido al subproceso.

5. **Regla de contrato y reintento único**:
   - La salida se valida contra `AgentOutputSchema` con Zod. Si el formato o contenido es inválido, se reintenta exactamente una vez adjuntando el mensaje de error de validación. Si el segundo intento falla, se devuelve `motivoFallo: "salida_invalida"`.

6. **Estimación determinista de costos**:
   - El costo se calcula a partir de los tokens de entrada y salida consumidos y la tabla de precios del alias (`alias_modelos`). Si el alias no define precios, se reporta explícitamente como desconocido (`desconocido: true, montoUsd: null`), evitando inconsistencias de proxies o terceros.

7. **Límites impuestos por Batuta**:
   - Batuta aplica sus propios límites duros: si se supera `max_steps` (`num_turns > max_steps`), la ejecución se marca como fallida por `turnos_agotados`. Si el comando supera el timeout configurado, Batuta termina el árbol de procesos y devuelve `timeout`.

8. **Protección de credenciales en logs**:
   - Antes de escribir el log de la llamada en disco (`.batuta/runs/<run_id>/logs/`), se aplica `ofuscarSecretos`, reemplazando claves de API (OpenAI, Anthropic), tokens (GitHub, Slack), credenciales AWS y bloques de claves privadas por `[REDACTADO]`.

9. **Plantillas de prompt versionadas**:
   - Se desacoplan las instrucciones de rol en archivos Markdown versionados (`packages/core/prompts/`), sustituyendo variables (`{{subtarea}}`, `{{spec}}`, `{{reglas_repo}}`, `{{archivos_permitidos}}`, `{{esquema_salida}}`).

## Consecuencias
- **Positivas**: Interfaz agnóstica `AgentRunner` que permite simular ejecuciones instantáneas con `FakeRunner` y operar en producción con `ClaudeCodeRunner`; guardarraíles estrictos de seguridad y costos; total compatibilidad multiplataforma (Windows y Linux).
- **Negativas**: El runner real depende de la disponibilidad del ejecutable `claude` en el PATH y de credenciales válidas en `variables_modelo`.
