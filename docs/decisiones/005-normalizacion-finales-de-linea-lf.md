# ADR 005: Normalización de finales de línea LF en el repositorio

## Contexto
El criterio CA-5 de aceptación del Hito 0 exige que ningún archivo en el índice de Git tenga finales de línea CRLF (`git ls-files --eol` sin `i/crlf`), garantizando consistencia idéntica entre Windows y Linux.

## Opciones consideradas
1. **Archivo `.gitattributes` explícito con `* text=auto eol=lf`**: Regla estándar que Git respeta en todos los entornos sin depender de la configuración global del desarrollador.
2. **Depender de `core.autocrlf` en el entorno del usuario**: Inseguro y frágil, ya que varía de una máquina a otra.

## Decisión
Definir un archivo `.gitattributes` en la raíz del repositorio normalizando todos los archivos de texto a finales de línea `lf`.

## Consecuencias
- **Positivas**: El índice de Git almacena siempre `i/lf` independientemente de si el clon o la edición ocurre en Windows o en Linux.
- **Negativas**: Ninguna.
