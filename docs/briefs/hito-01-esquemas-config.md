# Hito 1: esquemas y configuración

Rama: `hito/01-esquemas-config`

## Contexto

Lee `AGENTS.md` y las secciones 3.1, 3.3, 3.4, 4, 5, 7, 8 y 18 de `docs/diseno.md`. Este hito define los datos que usarán todos los hitos siguientes. Los esquemas son la fuente única de verdad de los tipos.

## Objetivo

En `@batuta/core`, definir y probar los esquemas de datos de Batuta y el cargador de configuración, sin lógica de flujo todavía.

## Qué debe existir

1. **`AgentInput` y `AgentOutput`** (sección 5), con los cuatro estados de salida.
2. **Eventos del registro** (sección 3.1): una estructura común y los tipos de evento que cubran el ciclo de vida (sección 4), los gates, los reintentos, las aprobaciones, los límites y la reanudación. Decide tú qué tipos hacen falta.
3. **Estado de la ejecución** (`state.json`, secciones 3.1 y 4), con los estados del ciclo de vida.
4. **Plan** (`plan.json`, sección 3.3): subtareas con sus archivos, criterios asociados y complejidad.
5. **Configuración** (`batuta.yaml`, secciones 7, 14, 15 y 18): carga desde un archivo YAML, validación y valores por defecto.
6. **Exportación a JSON Schema** del esquema de `AgentOutput`, para pasarlo a las herramientas que lo admiten.

## Restricciones

- Solo cambia `@batuta/core`. La CLI no cambia, y no hay lógica de motor, Git ni ejecución de comandos.
- Los tipos de TypeScript se derivan de los esquemas, no al revés.
- La única entrada y salida permitida es leer el archivo de configuración.
- El diseño (secciones 4 y 5) fija los nombres de los estados y los campos del contrato, y la sección 18 fija los campos de la configuración del piloto. Si necesitas cambiar alguno, propónlo en el informe.

## Criterios de aceptación

| # | Criterio | Verificación |
|---|---|---|
| CA-1 | Existen los esquemas de `AgentInput`, `AgentOutput`, evento, estado, plan y configuración, exportados desde `@batuta/core` | Pruebas |
| CA-2 | La configuración del piloto de la sección 18 del diseño se carga sin errores y produce los valores esperados | Prueba con ese YAML como ejemplo |
| CA-3 | Las configuraciones inválidas fallan con mensajes que indican la ruta del campo. Casos mínimos: falta un gate, un timeout no positivo, un rol que apunta a un alias de modelo no definido, nombres de gate repetidos y un campo desconocido | Pruebas |
| CA-4 | Una salida de agente válida pasa y una inválida falla (estado desconocido o campo faltante) | Pruebas |
| CA-5 | Una línea del registro de eventos se serializa y se vuelve a leer validada, y un tipo de evento desconocido se rechaza | Pruebas |
| CA-6 | El JSON Schema exportado de `AgentOutput` incluye los campos obligatorios y los cuatro estados | Prueba |
| CA-7 | `npm run verify` pasa desde un clon limpio y el CI pasa en Linux y en Windows | `npm run verify` y CI |
| CA-8 | El registro de decisiones está al día (por ejemplo, la política de versionado de esquemas) | Revisión |

## Recomendación (no es una restricción)

Considera incluir una versión de esquema en los eventos, el estado y la configuración, para poder evolucionarlos sin romper ejecuciones anteriores.

## Fuera de alcance

Escribir o leer el registro de eventos en disco, la máquina de estados, el motor de flujo, Git, la ejecución de comandos y la CLI.

## Entrega

Informe en el formato de `AGENTS.md`.
