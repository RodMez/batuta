# ADR 013: Ejecutor de comandos con terminación de árbol de procesos y entorno limpio

## Contexto
El hito 3 exige ejecutar comandos de verificación deterministas (los quality gates configurados por el usuario) devolviendo código de salida, stdout, stderr, duración y timeout; terminar el árbol completo de procesos (incluidos nietos) al vencer el timeout; limitar la memoria de captura truncando en streaming; ejecutar en un entorno limpio sin filtrar secretos del usuario; devolver errores claros sin lanzar excepciones ante comandos o rutas inexistentes; y ejecutar `npm --version` de forma portable en Linux y Windows.

En versiones recientes de Node (Node 22+), la ejecución de archivos `.cmd` como `npm` en Windows sin shell falla con `EINVAL` por protecciones de seguridad del runtime.

## Opciones consideradas
1. **Implementación nativa sin dependencias**:
   - `BufferTruncado`: clase acumuladora que divide la cuota en cabeza y cola rodante, desechando chunks intermedios en tiempo real para mantener el uso de memoria en `O(límite)`.
   - `matarArbolProcesos`: en Windows `taskkill /PID <pid> /T /F` (elimina el proceso y todos sus subprocesos forzosamente); en Linux/POSIX proceso lanzado con `detached: true` y envío de señal `SIGKILL` al grupo `-pid`.
   - Shell controlado para los gates de configuración: como los comandos provienen de `batuta.yaml` escrito por el desarrollador (de confianza) y no de agentes, ejecutarlos con shell habilitado permite resolver ejecutables `.cmd` en Windows y comandos de pipeline en Linux con seguridad.
   - Lista blanca de variables de entorno (`VARIABLES_ENTORNO_PERMITIDAS`) + extras (`entorno_gates`).
2. **Dependencias externas (`execa`, `tree-kill`)**:
   - Añadirían complejidad y paquetes al monorepo para resolver comportamientos que Node y las utilidades estándar del sistema resuelven de forma directa y comprobada.
3. **Matar solo el proceso padre con `kill()`**:
   - Dejaría procesos nietos o herramientas en segundo plano huérfanas consumiendo CPU y memoria.

## Decisión
Adoptar la opción 1: `EjecutorComandosReal` bajo la interfaz inyectable `EjecutorComandos`, con terminación de árbol de procesos diferenciada (`taskkill /T /F` en Windows y grupos de procesos en POSIX), acumulador de salida `BufferTruncado`, entorno limpio por lista blanca, `shell: false` por defecto como endurecimiento de seguridad, y `shell: true` explícito en `ejecutarGates` para los comandos de confianza de la configuración.

### Límite de terminación y mitigación futura
- **Comportamiento normal**: En ejecuciones estándar (scripts que arrancan compiladores, pruebas o linters), los procesos hijos y nietos heredan el grupo de procesos y son terminados en bloque por `process.kill(-pid, "SIGKILL")` en POSIX y por `taskkill /T /F` en Windows.
- **Límite en POSIX**: Si un subproceso se desacopla a propósito (mediante `setsid()` o `child_process.spawn(..., { detached: true })`), el kernel le asigna una nueva sesión y grupo de procesos propio, escapando de la señal enviada a `-pid`. En Windows, `taskkill /T` sigue la relación padre-hijo en el kernel y sí lo alcanza.
- **Mitigación completa**: En la Fase 3, el aislamiento de procesos y comandos de agentes se ejecutará dentro de contenedores Docker (o cgroups), lo que evitará que cualquier proceso desacoplado pueda sobrevivir al ciclo de vida del contenedor.
- **Procesos zombi en Linux**: Al matar el árbol en Linux, un proceso puede permanecer unos instantes en estado zombi (`Z`) en la tabla del kernel antes de ser recolectado por `init`, lo que causaría que `process.kill(pid, 0)` responda `true`. `existeProceso` examina `/proc/<pid>/stat` para descartar procesos en estado `Z`, complementado con sondeo temporal.

## Consecuencias
- **Positivas**: Sin dependencias adicionales; garantiza la eliminación total de procesos huérfanos (CA-2); memoria estrictamente acotada (CA-3); aislamiento del entorno contra filtración de secretos (CA-4); ejecución segura sin shell por defecto con soporte explícito para gates de configuración (CA-6); compatibilidad probada con `npm` en Windows y Linux.
- **Negativas**: `taskkill` en Windows requiere que la utilidad estándar esté en el `PATH` del sistema (presente por defecto en todas las instalaciones de Windows). En entornos POSIX sin contenedor, un proceso que invoque `setsid()` explícitamente requiere la Fase 3 (Docker) para un confinamiento absoluto.
