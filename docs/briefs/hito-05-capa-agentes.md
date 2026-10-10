# Hito 5: capa de agentes

Rama: `hito/05-capa-agentes` (créala desde `main` actualizada)

## Contexto

Lee `AGENTS.md`, las secciones 3.4, 5, 8, 14, 17 y 19 de `docs/diseno.md` y los registros de decisiones 012 a 016. Este hito da a Batuta la capacidad de invocar a un agente de IA mediante una CLI headless, con límites y salida validada. Es el primero que puede gastar dinero real, así que los límites y el entorno limpio son críticos.

## Ajuste previo obligatorio del hito 4 (primeros commits de la rama)

La revisión del hito 4 encontró un fallo de seguridad. `ModuloGitReal` arma los comandos como texto (por ejemplo `git commit -m "${mensaje}"`) y el ejecutor vuelve a separarlos en argumentos. Un mensaje con comillas puede inyectar argumentos. Lo comprobé: el mensaje `subtarea" --no-verify -m "extra` saltó un hook de pre-commit que sí bloquea un commit normal. Esos textos vendrán de lo que genere un agente (títulos de subtareas), así que es una vía de ataque real. Además, en Windows una ruta entre comillas que termina en `\` se interpreta mal.

1. **Ejecución por vector de argumentos.** Añade al ejecutor de comandos un método que reciba el ejecutable y una lista de argumentos, sin volver a interpretar ningún texto. Los gates de la configuración (escritos por el usuario) pueden seguir usando la línea de comandos con shell.
2. **Migra `ModuloGitReal`** a ese método. Ningún mensaje, referencia, ruta, nombre o identidad se interpola en un texto de comando. Usa `--end-of-options` o `--` antes de referencias y rutas cuando Git lo admita.
3. **Pruebas de inyección** (en Linux y en Windows): un mensaje con comillas, saltos de línea y barras invertidas se guarda tal cual como mensaje del commit; una referencia base hostil (empieza por `-` o contiene comillas) se rechaza o se trata como dato; una identidad con comillas no altera el comando; rutas con espacios y, en Linux, con comillas; y un hook de pre-commit que bloquea sigue bloqueando aunque el mensaje intente `--no-verify`.
4. Registra la decisión (puedes ampliar el ADR 016).

## Objetivo

En `@batuta/core`: la interfaz `AgentRunner`, un `FakeRunner` guionado para probar el motor sin gastar nada, y un `ClaudeCodeRunner` que invoca la CLI de Claude Code en modo headless con el modelo, los permisos y los límites de cada rol, valida la salida y cuenta tokens y costo.

## Qué debe existir

1. **Interfaz `AgentRunner`**: recibe un `AgentInput` y el contexto de la llamada (directorio de trabajo, rol, modelo ya resuelto, límites, permisos, entorno y prompt) y devuelve un resultado con: la `AgentOutput` validada o un motivo de fallo (completado, timeout, presupuesto o turnos agotados, salida inválida, error de la herramienta), el uso (tokens de entrada y salida), el costo estimado, el modelo efectivo, la duración y la ruta del registro de la llamada.
2. **`FakeRunner`**: guionable por llamada o por rol. Debe poder simular éxito, `FAILED`, `NEEDS_INPUT`, `NEEDS_CONTINUATION`, JSON inválido, timeout y presupuesto agotado, y registrar las llamadas recibidas para hacer afirmaciones en las pruebas.
3. **`ClaudeCodeRunner`**, con estas responsabilidades:
   - Construir la invocación como ejecutable más argumentos: modelo con nombre completo, límite de turnos, tope de gasto, permisos de herramientas, formato de salida estructurado y el esquema JSON de `AgentOutput` (el exportado en el hito 1). Verifica en la CLI instalada cuáles son los flags exactos y registra en el ADR la versión contra la que trabajas.
   - **Permisos por tipo de rol** (sección 5): los roles de solo lectura pueden leer y buscar pero no editar ni ejecutar comandos; los roles con escritura pueden editar y ejecutar solo los comandos permitidos de la configuración. Define cómo se traducen a los permisos de la herramienta.
   - **Entorno limpio**: el proceso recibe la lista blanca básica más solo las variables que indique el nuevo campo opcional `variables_modelo` de la configuración (nombres de variables que se reenvían desde el entorno del usuario). Nada más.
   - Leer la salida, extraer la `AgentOutput`, validarla con Zod y calcular el uso.
   - **Reintento por salida inválida**: una sola vez, indicando el error de validación; si falla otra vez, devuelve un fallo (sección 5, regla de contrato).
   - **Registro de la llamada** en `logs/` de la ejecución, ocultando los patrones de claves conocidos (reutiliza los de la política de diff) antes de guardarlo.
4. **Costo**: se estima con los tokens y los precios de `alias_modelos`. Si el alias no tiene precios, el costo es desconocido y se marca así. No se confía en el costo que informe la herramienta, porque con modelos de terceros por un proxy puede ser erróneo.
5. **Preflight del ejecutor**: detectar si la CLI está instalada, su versión y si admite los flags que se necesitan; si no, un mensaje claro.
6. **Plantillas de prompt por rol**, como archivos de texto versionados en el repositorio (no embebidos en el código), con variables sustituibles (subtarea, spec, reglas del repositorio, archivos permitidos y esquema de salida). Empieza por `software-engineer` y `architect`; el resto llegará en hitos posteriores.

## Restricciones

- Solo cambia `@batuta/core` y los archivos de prompts. No hay motor de flujo, CLI de Batuta ni OpenCode (llega en la Fase 2).
- Batuta aplica sus propios límites (timeout y turnos) aunque la herramienta los ignore.
- Ningún texto que pueda venir de un agente se interpola en una línea de comandos: todo va como argumentos.
- Las pruebas automáticas no llaman a ningún modelo real ni usan la red. Solo la verificación manual del criterio CA-11 lo hace.
- Todo debe funcionar en Windows y en Linux.

## Pautas del planificador

- Las CLI cambian. Guarda como ejemplos de prueba las salidas reales (éxito, error por turnos agotados, salida estructurada inválida y presupuesto agotado si puedes provocarlo), sin datos sensibles, y haz que las pruebas lean esos ejemplos.
- Los prompts de rol deben indicar: trabajar solo con los archivos permitidos, terminar devolviendo la `AgentOutput` en el formato exacto, registrar los supuestos, y devolver `NEEDS_INPUT` solo ante una duda que afecte a seguridad, datos o acciones irreversibles (sección 4, manejo de ambigüedad).
- Separa la construcción de la invocación (función pura, fácil de probar) de su ejecución.
- La llamada real de CA-11 debe hacerse en un repositorio desechable con una tarea trivial y límites bajos (por ejemplo, 2 turnos y pocos centavos). Si `claude` no está instalado en tu entorno, indícalo en el informe y deja ese criterio pendiente; no instales nada global.

## Criterios de aceptación

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | El ajuste del hito 4 está aplicado: el ejecutor tiene el método por vector de argumentos, `ModuloGitReal` lo usa y las pruebas de inyección pasan en Linux y en Windows | Pruebas |
| CA-2 | `FakeRunner` simula éxito, `FAILED`, `NEEDS_INPUT`, `NEEDS_CONTINUATION`, JSON inválido, timeout y presupuesto agotado, y registra las llamadas | Pruebas |
| CA-3 | La invocación de `ClaudeCodeRunner` es la esperada, como lista de argumentos, para tres casos: rol de solo lectura, rol con escritura y comandos permitidos, y salida estructurada con esquema | Pruebas |
| CA-4 | Las salidas reales grabadas (éxito, turnos agotados, salida inválida) se convierten en el resultado correcto | Pruebas con ejemplos |
| CA-5 | Una salida inválida provoca un solo reintento con el error de validación y, si vuelve a fallar, un fallo | Pruebas |
| CA-6 | El proceso del agente solo recibe la lista blanca y las variables de `variables_modelo` | Pruebas |
| CA-7 | El costo se calcula con los precios del alias y es desconocido (marcado) cuando no hay precios | Pruebas |
| CA-8 | Batuta aplica el timeout y el límite de turnos aunque la herramienta no lo haga | Pruebas con un programa de prueba |
| CA-9 | El registro de la llamada oculta patrones de claves conocidos | Prueba |
| CA-10 | El preflight detecta una CLI ausente o con una versión o flags no admitidos, con mensajes claros | Pruebas |
| CA-11 | Una llamada real de `ClaudeCodeRunner` sobre un repositorio desechable funciona, y el informe incluye el comando, la salida sin datos sensibles y el ejemplo guardado | Verificación manual |
| CA-12 | `npm run verify` pasa desde un clon limpio y el CI pasa en Linux y en Windows | `npm run verify` y CI |
| CA-13 | El registro de decisiones está al día, incluida la versión de la CLI usada | Revisión |

## Fuera de alcance

Motor de flujo, CLI de Batuta, `OpenCodeRunner`, revisores, enrutamiento por complejidad y avisos.

## Entrega

Informe en el formato de `AGENTS.md`.
