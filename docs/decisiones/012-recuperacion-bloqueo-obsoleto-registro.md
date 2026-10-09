# ADR 012: Recuperación automática de bloqueos obsoletos del registro

## Contexto
En el hito 2, el archivo `.lock` de una ejecución guardaba únicamente el PID del proceso y exigía borrado manual si el proceso terminaba abruptamente. Esto impedía cumplir el objetivo de reanudar la ejecución de forma desatendida (`batuta resume`) tras matar un proceso o ante una caída imprevista. Se necesita almacenar información suficiente (PID, equipo y hora), detectar si el bloqueo proviene del mismo equipo y si el proceso sigue vivo de forma portable (Windows y Linux), y en caso de que el proceso ya no exista, considerar el bloqueo obsoleto, recuperarlo y dejar constancia en el registro de eventos.

## Opciones consideradas
1. **Formato estructurado `{ pid, equipo, hora }` + comprobación portable `process.kill(pid, 0)` + constancia en `events.jsonl`**:
   El `.lock` almacena JSON estructurado. Al fallar `escribirExclusivo`, se lee el archivo:
   - Si pertenece a otro equipo, falla inmediatamente para evitar colisiones distribuidas o en sistemas de archivos compartidos.
   - Si pertenece al mismo equipo, se comprueba la existencia del proceso mediante `process.kill(pid, 0)` (que en POSIX y en Windows con Node comprueba la existencia del proceso sin enviar señal letal, diferenciando `ESRCH` de existencia). Si el proceso aún vive, falla con mensaje descriptivo.
   - Si no existe, se considera obsoleto, se sobrescribe el bloqueo y se deja constancia tanto en el registro de eventos (`events.jsonl` mediante `ejecucion_reanudada` con payload detallado) como en el log de bloqueos (`logs/bloqueos.log`).
2. **Expiración por tiempo (TTL / heartbeat)**:
   Si una tarea tarda más de lo previsto en escribir un evento, un TTL podría considerar obsoleto por error un proceso aún activo y provocar corrupción de datos.
3. **Mantener borrado manual obligatorio**:
   Incompatible con la reanudación autónoma tras fallos.

## Decisión
Adoptar la opción 1: formato JSON `{ pid, equipo, hora }` (con compatibilidad hacia atrás si se encuentra un número simple), validación de equipo, comprobación de existencia con `existeProceso(pid)` inyectable, recuperación automática si el PID ya no existe en el mismo equipo y constancia en el registro de eventos mediante `ejecucion_reanudada` con la información del bloqueo recuperado, además de registro en `logs/bloqueos.log`. Adicionalmente, simplificar la función pura `leerTextoRegistro` eliminando la bifurcación ternaria redundante.

## Consecuencias
- **Positivas**: Reanudación desatendida y segura tras caídas; protección estricta contra concurrencia si el proceso aún está vivo o si el bloqueo es de otro host; comprobación portable en Windows y Linux; trazabilidad completa en el registro de eventos.
- **Negativas**: Si un sistema operativo recicla inmediatamente el PID antes de que se intente recuperar el bloqueo, podría interpretarse erróneamente que el proceso original sigue vivo (mitigado porque los PIDs no se reciclan al instante y el equipo coincide).
