// Root layout — denext supplies <html>/<head>/<body>; the app paints the whole window itself.
import type { LayoutProps } from "denext/server";

// The built-in skins' stylesheets come after the app's own, each scoped under
// `:root[data-skin="<id>"]` (lib/skins/builtin.ts), so they do nothing until that skin is picked.
export const metadata = {
  title: "Qutty",
  description: "A terminal workspace that sizes tiles by recency.",
  head:
    `<link rel="icon" type="image/png" href="/favicon.png"><link rel="stylesheet" href="/xterm.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/skins/classic/skin.css">`,
};

export default function RootLayout({ children }: LayoutProps) {
  return <>{children}</>;
}
