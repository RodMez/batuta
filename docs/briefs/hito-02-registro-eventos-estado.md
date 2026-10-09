# Hito 2: registro de eventos y estado

Rama: `hito/02-registro-eventos-estado`

## Contexto

Lee `AGENTS.md`, las secciones 3.1, 4, 11 y 19 de `docs/diseno.md` y los registros de decisiones 006 a 008. Este hito es la base de la reanudación: todo el estado de una ejecución debe poder reconstruirse desde el registro de eventos.

## Objetivo

En `@batuta/core`: guardar el registro de eventos en disco, derivar el estado con una función pura y guardar y recuperar checkpoints.

## Ajustes previos del hito 1 (primer commit de la rama)

1. **Sin precios inventados.** Los alias de modelo por defecto no deben llevar precios inventados. `entrada` y `salida` pasan a ser opcionales: si faltan, el costo en USD no se puede calcular. Un hito posterior hará que el preflight lo advierta.
2. **Estado de espera de aprobación.** Añade a `RunState` el estado `AWAITING_APPROVAL` y un campo que indique qué puerta está pendiente (H0, H1, H2 o H3).
3. Actualiza las pruebas y registra la decisión.

## Qué debe existir

1. **Escritor del registro.** Agrega eventos a `events.jsonl`, una línea por evento y validada antes de escribir. Nunca reescribe lo anterior. Solo un proceso escribe el registro de una ejecución: evita escrituras concurrentes (por ejemplo con un archivo de bloqueo) y documenta cómo lo garantizas.
2. **Lector.** Lee y valida todo el registro. Tolera una última línea cortada (la descarta e informa de ello). Cualquier otra línea inválida es un error que indica el número de línea.
3. **Reductor puro.** Una función `(estado, evento) => estado` que reconstruye el `RunState` desde cero. Tipa los payloads de los eventos que usa (cambios de estado, presupuesto, modelo activo, aprobaciones y límites). Los demás payloads pueden seguir siendo libres hasta el hito 6. Las transiciones imposibles según la sección 4 fallan con un error explícito.
4. **`state.json`.** Se escribe de forma atómica y siempre se puede reconstruir desde `events.jsonl`. Si faltan o discrepan, gana el registro.
5. **Checkpoints.** Al completar una subtarea se guarda un checkpoint con el estado serializado, el índice del último evento incluido y una referencia opaca al commit de Git (un texto; Git llega en el hito 4). `restore` reconstruye desde el último checkpoint válido y reproduce los eventos posteriores.
6. **Estructura en disco** por ejecución, en `.batuta/runs/<run_id>/`: `events.jsonl`, `state.json`, `checkpoints/` y `logs/`. Incluye la generación del `run_id` con el formato `RUN-AAAA-MM-DD-NNN`.

## Restricciones

- Solo cambia `@batuta/core`. No hay Git real, motor de flujo, agentes, ejecución de comandos ni CLI.
- El reloj y la entrada y salida de archivos son inyectables, para poder probar sin depender del disco real ni de la hora.
- Las funciones puras no leen reloj ni disco.
- Todo debe pasar en Windows y en Linux (rutas con `node:path`, finales de línea LF).

## Criterios de aceptación

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | Añadir eventos y volver a leerlos devuelve la misma secuencia, validada | Pruebas |
| CA-2 | Un registro con la última línea cortada se lee sin error, descartando esa línea e informándolo. Una línea inválida en medio falla indicando su número | Pruebas |
| CA-3 | Reconstruir el estado desde todos los eventos coincide con `state.json` y con el checkpoint más los eventos posteriores, en una secuencia de ejemplo que recorra el ciclo de vida completo (incluidos un reintento, una espera de entrada y una espera de aprobación) | Pruebas |
| CA-4 | Las transiciones inválidas se rechazan con un mensaje claro | Pruebas |
| CA-5 | Simulación de caída: para cada tipo de evento relevante, cortar el registro después de él, restaurar y continuar da el mismo estado final que sin corte | Pruebas |
| CA-6 | `state.json` se escribe de forma atómica y, si se borra, se reconstruye | Pruebas |
| CA-7 | Los alias por defecto no llevan precios inventados y existe `AWAITING_APPROVAL` con su puerta pendiente | Pruebas |
| CA-8 | `npm run verify` pasa desde un clon limpio y el CI pasa en Linux y Windows | `npm run verify` y CI |
| CA-9 | El registro de decisiones está al día | Revisión |

## Pautas del planificador

- Los identificadores de evento deben poder ordenarse en el tiempo. Decide el formato y regístralo.
- Mantén `payload` libre para los eventos que el reductor no necesita.
- Si detectas una transición necesaria que la sección 4 no contempla, propónla en el informe y aplícala mientras no contradiga el diseño.

## Fuera de alcance

Motor de flujo, Git real, ejecución de comandos, agentes y CLI.

## Entrega

Informe en el formato de `AGENTS.md`.
