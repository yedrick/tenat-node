---
'@tenancy-node/admin-api': minor
'@tenancy-node/admin-ui': minor
---

Panel más completo y con diseño nuevo:

- `admin-api`: opción `tenantUsers` para listar y crear los usuarios de la app en cada tenant (`GET`/`POST /tenants/:id/users`), con auditoría sin contraseñas y solo los campos conocidos en la respuesta.
- `admin-ui`: pestaña "Usuarios" en cada tenant (buscar, crear con contraseña generada, "Entrar como"), botón "Entrar" de un clic en la lista y en el detalle, rediseño completo (navegación con íconos, buscador rápido, modo oscuro, estados en castellano, menú en celulares) y diálogos que mantienen el foco al escribir.
