import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type DefaultTheme } from 'vitepress';

const apiSidebarFile = fileURLToPath(new URL('../referencia/api/typedoc-sidebar.json', import.meta.url));
// La generan `pnpm api` (TypeDoc) antes de compilar el sitio.
const apiSidebar: DefaultTheme.SidebarItem[] = existsSync(apiSidebarFile)
  ? JSON.parse(readFileSync(apiSidebarFile, 'utf8'))
  : [];

const guide: DefaultTheme.SidebarItem[] = [
  {
    text: 'Empezar',
    items: [
      { text: 'Introducción', link: '/guia/introduccion' },
      { text: 'Primeros pasos', link: '/guia/empezar' },
      { text: 'Conceptos', link: '/guia/conceptos' },
      { text: 'Frameworks', link: '/guia/frameworks' },
    ],
  },
  {
    text: 'Datos',
    items: [
      { text: 'Base de datos', link: '/guia/base-de-datos' },
      { text: 'ORMs', link: '/guia/orm' },
      { text: 'Mover tenants', link: '/guia/mover-tenants' },
    ],
  },
  {
    text: 'Recursos por tenant',
    items: [
      { text: 'Caché, archivos y colas', link: '/guia/cache-archivos-colas' },
      { text: 'Tema', link: '/guia/tema' },
      { text: 'Eventos', link: '/guia/eventos' },
    ],
  },
  {
    text: 'Operación',
    items: [
      { text: 'Panel de administración', link: '/guia/panel' },
      { text: 'Observabilidad', link: '/guia/observabilidad' },
      { text: 'Producción', link: '/guia/produccion' },
      { text: 'Tests', link: '/guia/testing' },
      { text: 'CLI', link: '/guia/cli' },
    ],
  },
  {
    text: 'Más',
    items: [
      { text: 'Ejemplos', link: '/ejemplos' },
      { text: 'Rendimiento', link: '/rendimiento' },
      { text: 'Hoja de ruta', link: '/hoja-de-ruta' },
    ],
  },
];

export default defineConfig({
  lang: 'es',
  title: 'tenancy-node',
  description: 'Multi-tenancy para Node.js: una base (o un schema) por tenant, independiente del framework y con observabilidad por tenant.',
  base: '/tenat-node/',
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: [/^\/referencia\/api\//],
  head: [['link', { rel: 'icon', href: '/tenat-node/favicon.svg', type: 'image/svg+xml' }]],
  themeConfig: {
    logo: '/favicon.svg',
    nav: [
      { text: 'Guía', link: '/guia/introduccion', activeMatch: '/guia/' },
      { text: 'Referencia', link: '/referencia/api/', activeMatch: '/referencia/' },
      { text: 'Decisiones', link: '/adr/', activeMatch: '/adr/' },
      { text: 'v0.8', items: [{ text: 'Hoja de ruta', link: '/hoja-de-ruta' }, { text: 'npm', link: 'https://www.npmjs.com/org/tenancy-node' }] },
    ],
    sidebar: {
      '/guia/': guide,
      '/ejemplos': guide,
      '/rendimiento': guide,
      '/hoja-de-ruta': guide,
      '/referencia/': [{ text: 'Referencia de la API', link: '/referencia/api/' }, ...apiSidebar],
      '/adr/': [{ text: 'Decisiones', items: [{ text: 'Índice', link: '/adr/' }] }],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/yedrick/tenat-node' }],
    editLink: { pattern: 'https://github.com/yedrick/tenat-node/edit/main/site/:path', text: 'Editar esta página' },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: 'Buscar', buttonAriaLabel: 'Buscar' },
          modal: { noResultsText: 'Sin resultados para', resetButtonTitle: 'Limpiar', footer: { selectText: 'elegir', navigateText: 'moverse', closeText: 'cerrar' } },
        },
      },
    },
    outline: { label: 'En esta página', level: [2, 3] },
    docFooter: { prev: 'Anterior', next: 'Siguiente' },
    lastUpdated: { text: 'Actualizado' },
    returnToTopLabel: 'Volver arriba',
    sidebarMenuLabel: 'Menú',
    darkModeSwitchLabel: 'Tema',
    footer: { message: 'Publicado bajo la licencia MIT.', copyright: 'tenancy-node' },
  },
});
