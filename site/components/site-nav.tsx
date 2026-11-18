"use client";
// The header's page links, drawn as the app's switcher-bar chips. A client component so every
// page boots Denext's client runtime: its Links (and the server-rendered ones) then navigate
// softly, and the current page's chip follows the URL.

import { Link, usePathname } from "denext";

const PAGES = [
  { href: "/features", label: "Features" },
  { href: "/download", label: "Download" },
  { href: "/changelog", label: "Changelog" },
];

export function SiteNav({ github }: { github: string }) {
  const path = usePathname();
  return (
    <nav aria-label="Site">
      <ul class="chips">
        {PAGES.map((p) => (
          <li key={p.href}>
            <Link
              class="chip"
              href={p.href}
              aria-current={path === p.href ? "page" : undefined}
            >
              {p.label}
            </Link>
          </li>
        ))}
        <li>
          <a class="chip" href={github} rel="noopener">
            GitHub
          </a>
        </li>
      </ul>
    </nav>
  );
}
