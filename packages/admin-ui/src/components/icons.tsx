import type { SVGProps } from 'react';

/** Íconos de trazo (24×24, estilo Lucide) sin dependencias: heredan el color del texto. */
function icon(paths: string[]) {
  return function Icon(props: SVGProps<SVGSVGElement>) {
    return (
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    );
  };
}

export const IconDashboard = icon([
  'M3 13h8V3H3z',
  'M13 21h8v-8h-8z',
  'M13 3v6h8V3z',
  'M3 21h8v-4H3z',
]);
export const IconBuilding = icon([
  'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16',
  'M16 9h2a2 2 0 0 1 2 2v10',
  'M3 21h18',
  'M8 7h4M8 11h4M8 15h4',
]);
export const IconWebhook = icon([
  'M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2',
  'm6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06',
  'm12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8',
]);
export const IconActivity = icon(['M22 12h-4l-3 9L9 3l-3 9H2']);
export const IconUsers = icon([
  'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
  'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  'M22 21v-2a4 4 0 0 0-3-3.87',
  'M16 3.13a4 4 0 0 1 0 7.75',
]);
export const IconShield = icon(['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4']);
export const IconLogout = icon([
  'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4',
  'm16 17 5-5-5-5',
  'M21 12H9',
]);
export const IconLogin = icon([
  'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4',
  'm10 17 5-5-5-5',
  'M15 12H3',
]);
export const IconSearch = icon(['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3']);
export const IconPlus = icon(['M12 5v14', 'M5 12h14']);
export const IconExternal = icon([
  'M15 3h6v6',
  'M10 14 21 3',
  'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
]);
export const IconMoon = icon(['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z']);
export const IconSun = icon([
  'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
]);
export const IconMenu = icon(['M4 6h16', 'M4 12h16', 'M4 18h16']);
export const IconX = icon(['M18 6 6 18', 'm6 6 12 12']);
export const IconChevronLeft = icon(['m15 18-6-6 6-6']);
export const IconChevronRight = icon(['m9 18 6-6-6-6']);
export const IconGlobe = icon([
  'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  'M2 12h20',
  'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
]);
export const IconDatabase = icon([
  'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3z',
  'M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5',
  'M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3',
]);
export const IconAlert = icon([
  'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z',
  'M12 9v4',
  'M12 17h.01',
]);
export const IconCheck = icon(['M20 6 9 17l-5-5']);
export const IconCopy = icon([
  'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z',
  'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
]);
export const IconKey = icon([
  'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78z',
  'M15.5 7.5l3 3L22 7l-3-3',
]);
export const IconSparkles = icon(['M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z']);
export const IconUser = icon([
  'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2',
  'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
]);
export const IconLayers = icon(['m12 2 10 5-10 5L2 7z', 'm2 17 10 5 10-5', 'm2 12 10 5 10-5']);
export const IconInbox = icon([
  'M22 12h-6l-2 3h-4l-2-3H2',
  'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
]);
export const IconTrash = icon([
  'M3 6h18',
  'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
  'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
]);
export const IconBell = icon([
  'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9',
  'M10.3 21a1.94 1.94 0 0 0 3.4 0',
]);
export const IconWallet = icon([
  'M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1',
  'M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4',
]);
export const IconSend = icon(['m22 2-7 20-4-9-9-4z', 'M22 2 11 13']);
