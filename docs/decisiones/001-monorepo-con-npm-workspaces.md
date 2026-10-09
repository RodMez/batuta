# ADR 001: Monorepo con npm workspaces

## Contexto
El proyecto requiere separar el núcleo (`core`) de la interfaz de línea de comandos (`cli`) desde el inicio, permitiendo que futuros componentes (como una interfaz de usuario `ui`) se agreguen como paquetes adicionales sin acoplar la lógica.

## Opciones consideradas
1. **npm workspaces**: Soporte nativo en Node.js/npm sin dependencias externas ni herramientas adicionales de orquestación.
2. **pnpm workspaces**: Más rápido y eficiente en disco con enlaces duros, pero introduce una dependencia de gestor de paquetes diferente en los entornos del usuario y CI.
3. **Turborepo / Nx**: Herramientas pesadas con capas extra de configuración que exceden las necesidades del MVP.

## Decisión
Adoptar **npm workspaces** con la configuración `"workspaces": ["packages/*"]` en el `package.json` raíz.

## Consecuencias
- **Positivas**: Cero dependencias adicionales de gestión de monorepo; compatible inmediatamente con Node 22+ y npm 10+ tanto en Windows como en Linux.
- **Negativas**: `npm ci` instala las dependencias de forma centralizada sin caché avanzada de compilación entre paquetes (mitigado por la ligereza del proyecto).
