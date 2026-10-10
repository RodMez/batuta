# ADR 015: Política de diff pura con guardarraíles y detección de secretos

## Contexto
El hito 3 exige una política de diff como función pura (sin acceso a disco ni a Git) que reciba los cambios por archivo (ruta, líneas añadidas, eliminadas y texto añadido) y una política de restricciones (rutas prohibidas, archivos permitidos opcionales, límite de líneas de diff y detección de secretos). Debe aplicar las rutas prohibidas del piloto (sección 18), normalizar rutas de Windows (`\`) y detectar secretos mediante heurísticas acotadas sin falsos positivos en datos de prueba.

## Opciones consideradas
1. **Función pura en TypeScript sin dependencias**:
   - `normalizarRutaDiff`: convierte `\` a `/` y elimina prefijos `./`.
   - `coincideRutaProhibida`: semántica documentada donde una barra final indica directorio (`drizzle/`, `data/`, `.github/workflows/`), `*` comodín glob (`.env*`) y nombres exactos (`Dockerfile`, `package-lock.json`, etc.).
   - `detectarSecretoEnLinea`: escaneo de claves privadas (`BEGIN PRIVATE KEY`), tokens conocidos (GitHub, Slack, OpenAI, AWS) y asignaciones a literales con filtro de exclusión para valores de test (`test`, `dummy`, `example`, `placeholder`, `fake`, etc.) y longitud mínima.
   - `evaluarDiff`: agrega violaciones tipadas (`ViolacionDiff[]`).
2. **Delegar en herramientas externas (Gitleaks, Trufflehog)**:
   - Exigiría binarios externos o procesos en cada verificación de diff, rompiendo la exigencia de que la política de diff sea una función pura de `@batuta/core`.

## Decisión
Adoptar la opción 1: función pura `evaluarDiff` en `@batuta/core`, sin dependencias externas, con semántica explícita para rutas de Windows y directorios, y heurística de secretos diseñada para maximizar la detección sin penalizar fixtures de prueba.

## Consecuencias
- **Positivas**: Cumple CA-8; ejecución instantánea en memoria; sin dependencias externas; totalmente portable Windows/Linux.
- **Negativas**: Como toda heurística estática, no detecta secretos altamente ofuscados o divididos en múltiples concatenaciones (asumido en el diseño del hito).
