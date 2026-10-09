# ADR 002: Estrategia de compilación con TypeScript Project References

## Contexto
El paquete `packages/cli` depende de `packages/core`. Se necesita una estrategia de construcción que compile los paquetes en el orden correcto, genere archivos de declaración `.d.ts` y permita navegación y verificación estricta de tipos sin dependencias de bundlers.

## Opciones consideradas
1. **TypeScript Project References (`tsc --build` / `tsc -b`)**: Soporte nativo de `tsc` mediante `composite: true` y referencias en `tsconfig.json`.
2. **Bundlers (`tsup`, `esbuild`, `unbuild`)**: Agregan dependencias externas y complejidad de configuración para un proyecto que genera código ejecutable Node.js estándar.
3. **Scripts ad-hoc de compilación secuencial**: Frágiles y propensos a desincronizaciones entre paquetes.

## Decisión
Usar **TypeScript Project References** nativo (`tsc --build`) con un `tsconfig.json` raíz que orquesta los `tsconfig.json` de cada paquete.

## Consecuencias
- **Positivas**: No requiere bundlers de terceros; compilación incremental nativa; genera archivos de declaración y mapas de fuentes; valida dependencias entre paquetes durante el typecheck.
- **Negativas**: Exige mantener la configuración `composite: true` y las referencias explícitas en los `tsconfig.json` de los paquetes dependientes.
