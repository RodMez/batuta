# Hito 7: CLI de Batuta

Rama: `hito/07-cli` (créala desde `main` actualizada)

## Contexto

Lee `AGENTS.md`, las secciones 4, 6, 8, 14 y 19 de `docs/diseno.md` (en especial la lista de comandos de la sección 4) y los registros de decisiones 012 a 019. Este hito pone una interfaz de terminal sobre el motor del hito 6, de modo que se pueda recorrer un flujo completo a mano: arrancar, aprobar, responder, reanudar y abortar. Es la primera vez que una persona puede usar Batuta de verdad. Con una especificación y un plan escritos a mano y la herramienta de agentes configurada, ya se puede hacer una ejecución real sobre un repositorio desechable.

## Ajustes previos del hito 6 (primeros commits de la rama)

1. **Dividir `motor.ts`** (unas 1.500 líneas) por responsabilidades (por ejemplo, aprobaciones, bucle de subtareas, límites y resumen), sin cambiar el comportamiento. Las pruebas existentes deben seguir pasando sin modificarse. Es un commit aparte.
2. **Documentar el límite conocido** del motor en el ADR 019: un cambio de spec o plan después de superar su puerta solo invalida la aprobación, sin volver a solicitarla. Confirmo también el evento `advertencia`, que se queda.

## Objetivo

En `@batuta/cli`: una CLI delgada, en español, sobre el motor de `@batuta/core`, con los comandos `run`, `status`, `approve`, `answer`, `resume`, `abort` y `doctor`. Cambia `@batuta/core` solo para exponer lo que la CLI necesite (por ejemplo, listar ejecuciones o leer su estado).

## Qué debe existir

1. **`batuta run --spec <spec.md> --plan <plan.json>`**, con `--config` (por defecto `batuta.yaml` en el directorio del repositorio), `--repo` (por defecto el directorio actual) y `--base` (referencia de Git de la que parte el worktree). Valida, hace el preflight, crea la ejecución y la ejecuta en primer plano hasta la siguiente pausa o el final. Al terminar indica qué ha pasado y cuál es el siguiente comando (por ejemplo, la ruta de la solicitud de aprobación y la orden `batuta approve ...`). Más adelante, el agente `architect` permitirá `batuta run brief.md`, así que diseña el comando para que eso se pueda añadir sin romper nada.
2. **`--simulado <guion.json>`** en `run` (y en los comandos que continúan la ejecución): usa `FakeRunner` guionado por un archivo, para pruebas y demostraciones sin gastar nada. Define el formato del guion (esquema Zod), incluida una espera opcional por llamada que permita matar el proceso a mitad en las pruebas. Con la configuración `ejecutor: claude-code` y sin esta opción, se usa `ClaudeCodeRunner`.
3. **`batuta status [run_id]`**: estado, puerta o pregunta pendiente, avance por subtarea, tokens y costo, último evento y rutas útiles. Sin identificador, lista las ejecuciones. Con `--json`, una salida estable y validada con un esquema.
4. **`batuta approve <run_id> <puerta>`** (con `--rechazar` y `--comentario`): muestra qué se aprueba (por ejemplo, el presupuesto y los límites en H0, la ruta de la spec y su hash en H1), registra la decisión y **continúa la ejecución** hasta la siguiente pausa. `--solo-registrar` registra sin continuar.
5. **`batuta answer <run_id> <texto>`**: registra la respuesta a una duda crítica y continúa.
6. **`batuta resume <run_id>`**: reanuda tras una interrupción.
7. **`batuta abort <run_id>`**: aborta y limpia el worktree y la rama. Pide confirmación; en modo no interactivo exige `--yes`.
8. **`batuta doctor`** y el preflight que ejecuta `run`: comprueba que el directorio es un repositorio Git, la versión de Git, que el árbol está limpio (sin contar `.batuta/`), que la referencia base existe, que la configuración es válida, que la herramienta de agentes está disponible y es compatible (solo si se usará), si faltan precios en `alias_modelos` (advertencia: sin precios no hay límite en dólares) y si las variables de `variables_modelo` están definidas en el entorno (solo se muestran los nombres, nunca los valores).
9. **Exclusión de `.batuta/`**: `run` añade `.batuta/` al archivo `.git/info/exclude` del repositorio si falta, de modo que la carpeta de ejecuciones no ensucie el árbol de trabajo ni haga fallar la comprobación de árbol limpio.
10. **Códigos de salida** documentados: 0 terminada, 10 pausa por aprobación, 11 pausa por una respuesta, 1 fallida y 2 error de uso o de configuración.
11. **Salida y errores:** mensajes en español, claros y accionables. Sin rastros de pila por defecto; con `--debug` se muestran. Nunca se imprimen secretos ni valores de variables de entorno.
12. **Demostración incluida:** una carpeta `examples/demo/` con una spec, un plan, un guion y una configuración con gates triviales, y un README que explique paso a paso cómo recorrer el flujo completo con un repositorio desechable.

## Restricciones

- La CLI es una capa delgada: analiza argumentos, llama al núcleo y da formato a la salida. Ninguna lógica de flujo en `@batuta/cli`.
- Cambia `@batuta/core` solo para exponer lo necesario, sin alterar el comportamiento del motor.
- Ningún texto que pueda venir de un agente o de un archivo se interpola en una línea de comandos.
- Todo debe funcionar en Windows y en Linux, incluidas las pruebas con procesos reales.

## Pautas del planificador

- Separa la construcción del programa (`createProgram`) de su ejecución, para probar los manejadores con dependencias inyectadas, como propuso el agente en el hito 0.
- Las pruebas de extremo a extremo deben lanzar el binario compilado como proceso real, con un repositorio Git temporal, el guion simulado y configuración con gates triviales (`node -e`). Cubren el flujo completo con todas las puertas activadas, el caso de una duda crítica, abortar y reanudar tras matar el proceso a mitad.
- Para la prueba de reanudación, mata el proceso mientras el guion espera dentro de una llamada, y comprueba después que `resume` termina con el mismo estado final que una ejecución sin interrupción. Cuida que no queden procesos ni worktrees huérfanos.
- Define cómo se presenta cada pausa para que quien la ve sepa exactamente qué hacer.
- Un comando que continúa la ejecución puede tardar mucho. Muestra el avance de forma sobria (por ejemplo, una línea por evento relevante) sin inundar la terminal.
- Registra en un ADR el diseño de la CLI y el formato del guion.

## Criterios de aceptación

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | Los ajustes previos del hito 6 están aplicados: `motor.ts` dividido sin cambios de comportamiento y el ADR 019 actualizado | Pruebas existentes sin modificar y revisión |
| CA-2 | Flujo completo desde la terminal con agentes simulados y las cuatro puertas activadas: `run` termina con código 10 en cada pausa, cada `approve` continúa, y la última aprobación termina con código 0 en `DONE` | Prueba de extremo a extremo con el binario real |
| CA-3 | `status` muestra el estado, la puerta pendiente y el avance, y con `--json` produce una salida válida; sin identificador lista las ejecuciones | Pruebas |
| CA-4 | Una duda crítica pausa con código 11 y `answer` la responde y continúa | Prueba de extremo a extremo |
| CA-5 | Matar el proceso a mitad de una subtarea y ejecutar `resume` completa la ejecución con el mismo estado final que sin interrupción, sin worktrees ni procesos huérfanos | Prueba de extremo a extremo, en ambos sistemas |
| CA-6 | `abort --yes` elimina el worktree y la rama y deja la rama principal idéntica; sin `--yes` y sin terminal interactiva, se niega con código 2 | Pruebas |
| CA-7 | `doctor` y el preflight detectan: no es un repositorio, árbol sucio, referencia base inexistente, configuración ausente o inválida, herramienta de agentes ausente (cuando aplica), faltan precios (advertencia) y variables de modelo no definidas (solo nombres) | Pruebas |
| CA-8 | `.batuta/` queda excluida mediante `.git/info/exclude` y no hace que el árbol aparezca sucio | Prueba |
| CA-9 | Los códigos de salida son los documentados | Pruebas |
| CA-10 | Los errores no muestran rastros de pila salvo con `--debug`, y ninguna salida contiene secretos | Pruebas |
| CA-11 | La ayuda de todos los comandos está en español y `examples/demo/` se puede recorrer siguiendo su README | Revisión y prueba del demo |
| CA-12 | `npm run verify` pasa desde un clon limpio y el CI pasa en Linux y en Windows, incluidas las pruebas con procesos reales | `npm run verify` y CI |
| CA-13 | El registro de decisiones está al día con un ADR de la CLI y del formato del guion | Revisión |
| CA-14 | Ejecución real de `run` con `ClaudeCodeRunner` sobre un repositorio desechable, con una spec y un plan triviales, límites bajos y las credenciales del usuario. El informe incluye los comandos usados y el resultado sin datos sensibles. Si no hay credenciales, queda pendiente | Verificación manual |

## Fuera de alcance

El agente `architect` y `batuta run brief.md`, los revisores, `OpenCodeRunner`, `batuta init`, los avisos por Telegram, el push al remoto, los PR y Docker.

## Entrega

Informe en el formato de `AGENTS.md`.
