# ADR 004: Implementación de CLI con Commander y versionado acoplado al núcleo

## Contexto
El Hito 0 requiere que la CLI sea una capa delgada sobre el núcleo y que el comando `node packages/cli/dist/index.js --version` retorne la versión del programa.

## Opciones consideradas
1. **Commander.js**: Recomendado en `AGENTS.md` y `diseno.md`. Posee 0 dependencias transitivas, soporte robusto para banderas estándar (`-v`, `--version`, `-h`, subcomandos) y API ergonómica.
2. **`node:util.parseArgs`**: Nativo en Node.js, pero más verboso para manejar subcomandos, formateo de ayuda y versionado automático.
3. **Yargs**: Más pesado, incluye múltiples dependencias transitivas innecesarias.

## Decisión
Usar **Commander.js** en `packages/cli` y sincronizar la versión consumiendo directamente la constante expuesta por `@batuta/core`.

## Consecuencias
- **Positivas**: Cero dependencias transitivas añadidas; salida limpia de versión; base sólida y extensible para los futuros comandos de Batuta (`run`, `status`, `approve`, etc.).
- **Negativas**: Añade la dependencia directa de producción `commander` en `packages/cli`.
