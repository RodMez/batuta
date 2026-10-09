# ADR 008: Forma canónica de gates, eventos y valores por defecto de configuración

## Contexto
La sección 7 muestra `gates` como lista de cadenas y la sección 18 (que fija los campos del piloto) como objetos `{ nombre, comando, timeout_seg }`. Además hay que definir los tipos de evento del ciclo de vida y qué campos de configuración son obligatorios para que el YAML mínimo del piloto cargue.

## Opciones consideradas
1. **Gates como objetos obligatorios + eventos con 21 tipos en español + solo `proyecto` y `gates` obligatorios**: Unifica en la forma del piloto (la más expresiva); los 21 tipos cubren ciclo de vida, gates, reintentos, aprobaciones, límites, reanudación y resumen; los demás campos toman los valores de la sección 7 por defecto.
2. **Aceptar ambas formas de gates (cadena u objeto)**: Complica la validación (una cadena no tiene `comando` ni `timeout_seg`) y deja ambigua la unicidad de nombres.
3. **Exigir la configuración completa sin valores por defecto**: El YAML del piloto no cargaría y violaría el CA-2.

## Decisión
Adoptar **gates como objetos `{ nombre, comando, timeout_seg }` con `timeout_seg` positivo y nombres únicos** (la forma de la sección 18; la lista de cadenas de la sección 7 queda como abreviatura documental); definir **21 tipos de evento** (`ejecucion_iniciada`, `spec_creada`, `plan_creado`, `subtarea_iniciada`, `agente_completado`, `gate_ejecutado`, `reintento_programado`, `depuracion_iniciada`, `checkpoint_creado`, `revision_completada`, `pr_creada`, `aprobacion_solicitada`, `aprobacion_otorgada`, `limite_alcanzado`, `entrada_requerida`, `entrada_recibida`, `ejecucion_reanudada`, `contexto_resumido`, `ejecucion_completada`, `ejecucion_fallida`, `ejecucion_abortada`); y hacer **obligatorios solo `proyecto` y `gates`**, con el resto (ejecutor, modelos, límites, aprobaciones, política de comandos, notificaciones) con los valores de la sección 7 por defecto y validación cruzada de alias de modelo. `payload` del evento es un objeto libre para no acoplar el hito 1 a los hitos de motor.

## Consecuencias
- **Positivas**: El piloto carga sin errores; los cinco casos mínimos del CA-3 fallan con la ruta del campo; los eventos cubren todo lo pedido sin lógica de flujo.
- **Negativas**: Propuesta de cambio al diseño: aclarar que la forma canónica de `gates` es el objeto (ver informe). Los alias/modelos por defecto son marcadores (`rapido`, `medio`, …) que una ejecución real debe sobrescribir.
