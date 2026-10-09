# ADR 007: Política de versionado de esquemas

## Contexto
La recomendación del hito 1 pide una versión de esquema en eventos, estado y configuración para evolucionarlos sin romper ejecuciones anteriores. El registro es append-only y `state.json` debe poder reconstruirse desde `events.jsonl`.

## Opciones consideradas
1. **Campo `version_esquema` entero con valor por defecto `1` en evento, estado, plan y configuración**: Los documentos antiguos sin versión se leen como versión 1; los cambios compatibles rellenan con `default`, los incompatibles suben el entero.
2. **Versión por documento sin valor por defecto (obligatoria)**: Rechaza documentos antiguos y obliga a migrar todo el historial para leerlo.
3. **Sin versión (inferir por campos)**: Frágil; dos versiones con los mismos campos opcionales son indistinguibles.

## Decisión
Añadir **`version_esquema: entero >= 1` con `default(1)`** en los esquemas de evento, estado, plan y configuración. Reglas: solo se sube ante un cambio incompatible (campo obligatorio nuevo, eliminación o cambio de tipo); los cambios compatibles (campo opcional nuevo, valores por defecto) mantienen el número. `AgentInput`/`AgentOutput` no llevan versión porque el diseño fija sus campos y el contrato se valida por llamada.

## Consecuencias
- **Positivas**: Lectura tolerante de historial sin versión; evolución explícita; las pruebas pueden fijar `version_esquema: 1`.
- **Negativas**: El código lector de futuras versiones 2+ deberá ramificar por versión (pendiente del hito que introduzca el cambio).
