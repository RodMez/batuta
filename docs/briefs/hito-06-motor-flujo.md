# Hito 6: motor de flujo con agentes simulados

Rama: `hito/06-motor-flujo` (créala desde `main` actualizada)

## Contexto

Lee `AGENTS.md`, las secciones 3.1 a 3.5, 4, 5, 8, 14 y 19 de `docs/diseno.md` y los registros de decisiones 009 a 017. Este hito une todo lo construido: el registro de eventos y el estado (hito 2), los gates y la política de diff (hito 3), Git y los worktrees (hito 4) y la capa de agentes (hito 5). Es el hito más grande y el que de verdad convierte a Batuta en un orquestador. Aquí la especificación y el plan los escribe una persona a mano, y los agentes se simulan: no se gasta un solo token.

## Ajustes previos del hito 5 (primeros commits de la rama)

1. **Separar el prompt con `--`.** Un flag variádico como `--tools` o `--allowed-tools` consume el argumento posicional que lo sigue. Lo comprobé con la CLI 2.1.282: `claude --print ... --tools Read,Grep,Glob "hola"` falla con "Input must be provided", y con `-- "hola"` funciona. Pasa siempre el prompt después de `--`, lo que además evita que un texto que empiece por guiones se interprete como un flag. Añade pruebas para el caso sin prompt de sistema ni esquema y para un prompt que empieza por `--`.
2. **Permisos coherentes en los roles con escritura.** En modo headless, editar y escribir requieren permiso previo. Hoy `--allowed-tools` solo se pasa si hay comandos permitidos, así que sin ellos un rol con escritura no podría editar. Deriva `--tools` y `--allowed-tools` de la misma fuente: siempre se pasa `--allowed-tools` en los roles con escritura, y `Bash` solo aparece en `--tools` si hay comandos permitidos. Prueba la invocación para los tres casos (sin comandos, con comandos, solo lectura).
3. **Script de captura.** `scripts/capturar-claude.js` no está tipado y pasa permisos con una forma incorrecta (`{ lectura, escritura }` en vez de `PermisosRol`, que usa `soloLectura`), así que trataría al `architect` como rol de escritura. Pásalo a TypeScript o añade una prueba de humo con un `claude` falso. Que el modelo se lea de la variable de entorno `BATUTA_MODELO` (valor por defecto: `claude-haiku-5-5`), porque el nombre fijo actual es antiguo y con un proxy el nombre debe ser el que este entienda. Documenta en el README cómo ejecutarlo con y sin proxy.
4. Registra las decisiones.

## Objetivo

En `@batuta/core`: un motor de flujo que ejecuta una ejecución completa de principio a fin con dependencias inyectables (runner de agentes, Git, ejecutor de comandos, registro y estado, reloj, notificador), se pausa en las puertas humanas y en las esperas, y puede reanudarse tras una interrupción.

## Qué debe existir

1. **Arranque de una ejecución.** Recibe la configuración, una especificación (`spec.md`) y un plan (`plan.json`) escritos a mano, valida el plan con su esquema, crea la ejecución en disco y el worktree desde una referencia base, y ejecuta los comandos de `preparacion` de la configuración dentro del worktree. Si la preparación falla, la ejecución falla con un mensaje claro.
2. **Puertas humanas por archivo.** H0 (presupuesto y límites), H1 (especificación), H2 (plan, opcional) y H3 (fusión final), según la configuración `aprobaciones`. Al llegar a una puerta, el motor deja el estado en `AWAITING_APPROVAL`, escribe una solicitud legible en la carpeta de la ejecución y **termina su llamada devolviendo la pausa**, sin quedarse esperando. Hay funciones para registrar una aprobación o un rechazo y para reanudar. La aprobación guarda el hash de `spec.md` o `plan.json`; si el documento cambia después, hace falta aprobar de nuevo. Un rechazo termina la ejecución en `ABORTED`.
3. **Bucle de subtareas.** Por cada subtarea del plan: implementar, evaluar y confirmar.
   - **Implementar:** llama al runner con el rol `software-engineer`, el modelo que corresponda y un prompt armado con las plantillas del hito 5 (subtarea, spec, reglas del repositorio, archivos permitidos y, en los reintentos, el informe de fallo).
   - **Evaluar:** primero la política de diff sobre los cambios del worktree; si pasa, los gates de la configuración. La política de diff va antes porque es barata.
   - **Confirmar:** si todo pasa, hace el commit de la subtarea, guarda un checkpoint y sigue con la siguiente.
4. **Política de reintentos** (sección 3.5): máximo `intentos_por_subtarea`. El segundo intento del implementador sube de modelo (`escalar_modelo_en_reintento`); tras el segundo fallo entra el rol `debugger` con el modelo fuerte; tras agotar los intentos la subtarea falla, el worktree vuelve al último commit confirmado y la ejecución termina en `FAILED` con el motivo. Si el mismo error se repite dos veces seguidas (compara una firma del fallo: gate y primeras líneas relevantes), escala de inmediato al `debugger`. Una violación de la política de diff cuenta como intento fallido y devuelve el worktree al último commit antes de reintentar, con las violaciones como retroalimentación.
5. **Informe de fallo recortado** para los reintentos: gate, comando, código de salida y las últimas líneas relevantes de la salida, con un tamaño máximo.
6. **Selección de modelo** como función pura: dado el rol, la complejidad de la subtarea, el número de intento y la configuración, devuelve el alias y el nombre completo del modelo (`modelos`, `alias_modelos`).
7. **`NEEDS_INPUT`.** El estado pasa a `WAITING_INPUT` con la pregunta, el motor termina su llamada devolviendo la pausa, y una función registra la respuesta. Al reanudar, la respuesta se incluye en el prompt. Respeta el máximo de preguntas bloqueantes por ejecución.
8. **`NEEDS_CONTINUATION`.** El motor lanza una sesión nueva con el resumen de lo hecho y las `continuation_notes`, con un máximo configurable de continuaciones por subtarea.
9. **Límites de la ejecución.** Tokens y minutos por ejecución, y dólares cuando los precios de los alias se conocen (si no, solo tokens, con un evento de advertencia). El presupuesto y los pasos por agente se pasan al runner. Al superar un límite la ejecución termina en `FAILED` con el motivo.
10. **Abortar.** Termina en `ABORTED`, elimina el worktree y la rama, y la rama principal queda idéntica.
11. **Reanudación.** Tras una interrupción (el proceso muere, se pierde la máquina) se reconstruye el estado, el worktree vuelve al último commit confirmado y se repite la subtarea en curso. El intento interrumpido no cuenta contra el límite de intentos. Usa la recuperación de bloqueos del hito 3.
12. **Cierre.** Al terminar todas las subtareas, genera `summary.md` en la carpeta de la ejecución (qué se hizo, intentos por subtarea, gates que fallaron, uso y costo por rol, duración), pasa por H3 y termina en `DONE`. No hace `push`.
13. **Notificador** inyectable (interfaz) con una implementación nula. El motor lo invoca en las pausas, los fallos y el final. Telegram llega en la Fase 2.
14. **Configuración.** Si faltan en el esquema, añade como opcionales con valor por defecto: `preguntas_bloqueantes` (3), `continuaciones_por_subtarea` (2) y `timeout_preparacion_seg` (600). Una plantilla de prompt para el rol `debugger`.

## Restricciones

- Solo cambia `@batuta/core` y los prompts. No hay CLI de Batuta, agente `architect` real, revisores, OpenCode ni avisos.
- Los agentes se simulan con `FakeRunner`. Las pruebas usan repositorios Git temporales reales (hito 4) y no llaman a ningún modelo.
- El motor solo dirige las transiciones que el reductor del hito 2 admite. Si falta alguna transición necesaria, propónla en el informe y aplícala mientras no contradiga el diseño.
- Ningún texto que pueda venir de un agente se interpola en una línea de comandos.
- Todo debe funcionar en Windows y en Linux.

## Pautas del planificador

- Separa la lógica de decisión (qué hacer a continuación) de los efectos. Una función pura que, dado el estado y la configuración, diga cuál es el siguiente paso hace muy fácil probar todos los escenarios.
- Para simular interrupciones en las pruebas, inyecta un fallo en un punto concreto (por ejemplo, un `FakeRunner` o un registro que lanza una excepción tras cierto evento), en lugar de matar procesos reales.
- El resultado de una llamada al motor debe decir por qué terminó: pausa por aprobación, pausa por respuesta, terminada o fallida, y con qué datos.
- Los puntos de aprobación y las esperas no deben bloquear el proceso: el estado vive en el disco y el proceso puede terminar y volver a arrancar.
- Si la estructura de los esquemas del hito 1 (por ejemplo, el plan) no basta para algo de este hito, propón el cambio en el informe y aplícalo mientras sea compatible.
- Es un hito grande. Entrega por partes con commits pequeños y pruebas por escenario, y registra en un ADR el diseño del motor.

## Criterios de aceptación

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | Los ajustes previos del hito 5 están aplicados y probados | Pruebas |
| CA-2 | Camino feliz con repositorio Git temporal y `FakeRunner`: dos subtareas que pasan, H0, H1 y H3 aprobadas, termina en `DONE`, hay un commit por subtarea en la rama de la ejecución y la rama principal queda intacta | Prueba de integración |
| CA-3 | En cada puerta el motor se pausa y devuelve la pausa; reanuda tras aprobar. Si la spec cambia después de aprobarla, pide aprobar de nuevo. Un rechazo termina en `ABORTED` | Pruebas |
| CA-4 | Un fallo de gates provoca un segundo intento con un modelo de nivel superior (se comprueban los modelos usados en las llamadas) | Prueba |
| CA-5 | Tras dos fallos entra el `debugger` con el modelo fuerte, y si resuelve la subtarea el flujo continúa | Prueba |
| CA-6 | Tras agotar los intentos la subtarea falla, el worktree vuelve al último commit, la ejecución termina en `FAILED` con el motivo y la rama principal queda intacta | Prueba |
| CA-7 | El mismo error dos veces seguidas escala de inmediato al `debugger` | Prueba |
| CA-8 | Un cambio en una ruta prohibida cuenta como intento fallido, el worktree vuelve al último commit y la siguiente llamada recibe las violaciones | Prueba |
| CA-9 | `NEEDS_INPUT` pausa en `WAITING_INPUT`; tras responder, la reanudación incluye la respuesta en el prompt; se respeta el máximo de preguntas | Pruebas |
| CA-10 | `NEEDS_CONTINUATION` lanza una sesión nueva con el resumen y las notas, con un máximo de continuaciones | Prueba |
| CA-11 | Superar el límite de tokens, de minutos o de dólares (cuando hay precios) termina en `FAILED` con el motivo; sin precios, solo tokens y una advertencia | Pruebas |
| CA-12 | Abortar elimina worktree y rama y deja la rama principal idéntica | Prueba |
| CA-13 | Reanudación: tras una interrupción simulada en cada fase (después de una aprobación, a mitad de implementar, a mitad de evaluar, tras el commit y antes del checkpoint) el estado final es el mismo que sin interrupción, y el intento interrumpido no cuenta | Pruebas |
| CA-14 | La preparación del worktree ejecuta los comandos de la configuración y, si falla, la ejecución falla con un mensaje claro | Prueba |
| CA-15 | La selección de modelo cubre una tabla de rol, complejidad e intento | Pruebas |
| CA-16 | Se genera `summary.md` con los datos pedidos | Prueba |
| CA-17 | `npm run verify` pasa desde un clon limpio y el CI pasa en Linux y en Windows | `npm run verify` y CI |
| CA-18 | El registro de decisiones está al día, con un ADR del diseño del motor | Revisión |

## Fuera de alcance

CLI de Batuta, agente `architect`, revisores, `OpenCodeRunner`, avisos por Telegram, push al remoto y PR.

## Entrega

Informe en el formato de `AGENTS.md`.
