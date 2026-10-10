# ADR 014: Ejecutor de gates con informe estructurado Zod y payload de evento

## Contexto
El hito 3 requiere que Batuta ejecute la lista de quality gates definidos en la configuración (`batuta.yaml`), en orden secuencial, produciendo un informe JSON estructurado y validado con Zod (`InformeGatesSchema`), deteniéndose en el primer fallo por defecto y permitiendo opcionalmente continuar tras un fallo. Asimismo, se debe tipar el payload del evento `gate_ejecutado` para el registro inmutable de eventos.

## Opciones consideradas
1. **Módulo de ejecución de gates con esquemas Zod e inyección de dependencias**:
   - `ResultadoGateSchema` e `InformeGatesSchema` para validar la estructura del informe (nombre, comando, resultado "pasa"/"falla", código de salida, duración, timeout vencido y salidas truncadas).
   - `GateEjecutadoPayloadSchema` para registrar cada gate en `events.jsonl` como evento `gate_ejecutado`.
   - Inyección de `EjecutorComandos` para poder probar toda la lógica de orden, parada temprana y reintentos sin spawnear procesos del SO.
2. **Ejecución embebida en el motor de estados**:
   - Acoplaría la ejecución de verificaciones deterministas al reductor y máquina de estados, dificultando su uso independiente en CLI o scripts.

## Decisión
Adoptar la opción 1: función `ejecutarGates` en `@batuta/core` desacoplada del motor de flujo, con esquemas Zod estrictos, parada en primer fallo por defecto y tipado explícito del evento `gate_ejecutado`.

## Consecuencias
- **Positivas**: Cumple CA-7; validación estricta en tiempo de ejecución; pruebas rápidas y deterministas mediante simulación; listo para integrarse en el bucle del motor en hitos posteriores.
- **Negativas**: Ninguna identificada.
