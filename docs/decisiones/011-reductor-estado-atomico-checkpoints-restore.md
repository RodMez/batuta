# ADR 011: Reductor puro, estado atómico y checkpoints con restore

## Contexto
Todo el estado debe reconstruirse desde el registro: hace falta `(estado, evento) => estado` con transiciones según la sección 4, `state.json` siempre derivable, checkpoints por subtarea y `restore` que reanude tras matar el proceso.

## Opciones consideradas
1. **Reductor con payloads tipados solo donde se usan + tabla explícita + `state.json` vía tmp+rename + checkpoint `{estado, ultimo_evento, commit}` + restore**: Las aprobaciones avanzan por puerta (H0→INTAKE, H1→SPEC, H2→PLAN, H3→FINALIZE); la entrada recibida exige `retomar_en` no terminal; el límite lleva a FAILED; `state.json` ausente o discrepante se reconstruye (gana el registro); el checkpoint guarda el índice para no replegar todo; `restore` descarta la cola cortada, parte del último checkpoint válido, registra `ejecucion_reanudada` y es no-op si ya hay terminal.
2. **Máquina de estados con librería**: Añade dependencia para una tabla que cabe en un `switch` explícito y testeable.
3. **Checkpoint como copia del registro**: Duplica bytes; el índice + replegado parcial basta y se verifica con pruebas.

## Decisión
Reductor puro que sella `actualizada_en` con el `ts` del evento (determinista), suma presupuestos redondeados a 6 decimales y rechaza transiciones imposibles con mensaje explícito; `agregar` revalida la transición antes de escribir; `checkpoint` atómico por índice; `restore` como se describe arriba.

## Consecuencias
- **Positivas**: Reproducibilidad total desde `events.jsonl`; matriz de caída verde (cortar tras cada evento + continuar = mismo final); `payload` sigue libre donde el reductor no lo necesita (hasta el hito 6).
- **Negativas**: `agregar` replega todo el registro (O(n²) acumulado); aceptado para el MVP, el motor podrá mantener el estado en memoria.
