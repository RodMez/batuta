# ADR 006: Esquemas Zod como fuente única de verdad y YAML para configuración

## Contexto
El hito 1 exige que los tipos de TypeScript se deriven de los esquemas (no al revés), que la configuración se cargue desde `batuta.yaml` con validación y valores por defecto, y que el JSON Schema de `AgentOutput` se exporte para herramientas que lo admiten. Las dependencias deben ser pocas y bien mantenidas.

## Opciones consideradas
1. **Zod + `yaml` con JSON Schema nativo (`z.toJSONSchema`)**: Zod define el esquema y deriva los tipos con `z.infer`; `yaml` parsea el archivo; el JSON Schema sale de la misma definición sin librerías extra.
2. **Zod + `zod-to-json-schema` + `js-yaml`**: Añade una dependencia solo para el JSON Schema y otra alternativa de YAML con API similar.
3. **Validadores manuales + JSON Schema escrito a mano**: Duplica la fuente de verdad (esquema TS y JSON Schema divergen) y exige mantener mensajes de error con rutas a mano.

## Decisión
Usar **Zod 4** (`zod`) para todos los esquemas (`AgentInput`, `AgentOutput`, evento, estado, plan, configuración) con objetos estrictos (`.strict()` / `strictObject`), tipos derivados con `z.infer`, y errores formateados como `ruta: mensaje`; usar **`yaml`** para parsear `batuta.yaml`; generar el JSON Schema con el nativo **`z.toJSONSchema`** sin dependencias adicionales.

## Consecuencias
- **Positivas**: Una sola definición por esquema; el JSON Schema no puede divergir; mensajes de error con la ruta del campo; solo dos dependencias de producción (`zod`, `yaml`), ambas puras JS y compatibles con Windows y Linux.
- **Negativas**: Se asume la API de Zod 4 (`z.iso.datetime`, `z.toJSONSchema`); si una herramienta exige otro dialecto de JSON Schema habrá que adaptar la exportación.
